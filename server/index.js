require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const dishes = require('./dishes.json');
const { SYSTEM_PROMPT } = require('./prompt');

const app = express();
app.use(cors());
// 云托管 callContainer 走 JSON + base64 传图，单张约 1–3MB base64，故放宽到 16MB
app.use(express.json({ limit: '16mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 3 } // 三张上限
});

const API_KEY = process.env.DASHSCOPE_API_KEY;
const BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.QWEN_MODEL || 'qwen-vl-max';

function bufToDataUrl(buf, mime) {
  return `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
}

// 从模型回复里抠 JSON
function extractJson(text) {
  if (!text) throw new Error('空回复');
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('回复里没有 JSON');
  return JSON.parse(raw.slice(s, e + 1));
}

// 模糊匹配营养表：菜名互相包含即命中，取最长命中
function matchTable(name) {
  if (!name) return null;
  let best = null;
  for (const key of Object.keys(dishes)) {
    const k = key.replace(/（.*?）/g, '');
    if (name.includes(k) || k.includes(name)) {
      if (!best || k.length > best.key.length) best = { key: k, data: dishes[key] };
    }
  }
  return best;
}

function mergeWithTable(modelDish) {
  const hit = matchTable(modelDish.name);
  if (hit) {
    const d = hit.data;
    return {
      name: modelDish.name,
      served: { min: d.served.min, max: d.served.max, unit: d.served.unit },
      kcal: d.kcal, protein_g: d.protein_g, carb_g: d.carb_g, fat_g: d.fat_g,
      source: '营养表', table_status: d.status
    };
  }
  return {
    name: modelDish.name,
    served: { min: modelDish.served_grams?.min ?? 0, max: modelDish.served_grams?.max ?? 0, unit: '克' },
    kcal: modelDish.kcal, protein_g: modelDish.protein_g, carb_g: modelDish.carb_g, fat_g: modelDish.fat_g,
    source: '模型估', table_status: null
  };
}

function sumRanges(list, field) {
  return list.reduce((acc, d) => ({
    min: acc.min + (d[field]?.min || 0),
    max: acc.max + (d[field]?.max || 0)
  }), { min: 0, max: 0 });
}

// 共用分析逻辑：入参是若干张图片的 Buffer，返回给前端的 result 对象
async function runAnalyze(buffers) {
  if (!API_KEY) {
    const err = new Error('服务端未配置 DASHSCOPE_API_KEY');
    err.status = 500;
    throw err;
  }
  if (!buffers || !buffers.length) {
    const err = new Error('至少上传一张图片');
    err.status = 400;
    throw err;
  }

  const imageParts = buffers.map(buf => ({
    type: 'image_url',
    image_url: { url: bufToDataUrl(buf, 'image/jpeg') }
  }));

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [...imageParts, { type: 'text', text: '请分析这些饭菜照片，按约定 JSON 输出。' }] }
    ],
    temperature: 0.3
  };

  const resp = await axios.post(`${BASE_URL}/chat/completions`, body, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 60000
  });

  const content = resp.data?.choices?.[0]?.message?.content;
  const parsed = extractJson(typeof content === 'string' ? content : JSON.stringify(content));

  const merged = (parsed.dishes || []).map(mergeWithTable);
  const total = {
    kcal: sumRanges(merged, 'kcal'),
    protein_g: sumRanges(merged, 'protein_g'),
    carb_g: sumRanges(merged, 'carb_g'),
    fat_g: sumRanges(merged, 'fat_g')
  };

  return {
    dishes: merged,
    total,
    advice: parsed.advice || '这盘看着挺实在，先吃七成、剩下的看心情。',
    disclaimer: '仅供参考'
  };
}

// 异步任务表：wx.cloud.callContainer 的 timeout 硬上限是 15 秒，
// 而视觉模型单次分析要 14–25 秒，同步返回必然被掐断。
// 所以改成「先建任务立刻回 jobId，前端轮询结果」。
const jobs = new Map();
const JOB_TTL = 10 * 60 * 1000;

function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL) jobs.delete(id);
  }
}
setInterval(sweepJobs, 60 * 1000).unref?.();

// ===== 使用量统计 =====
// 只记「时间 / 代号 / 张数 / 菜品数 / 成败」，绝不记照片内容、姓名、手机号、IP。
// 代号用微信云托管透传的 x-wx-openid（opaque ID，不是个人信息），拿不到就记 anonymous。
// 落日志用 setImmediate 推到响应之后，任何一个字节的 I/O 都不挡分析结果返回。
function uidOf(req) {
  const raw = req.headers['x-wx-openid'] ?? req.headers['X-WX-OPENID'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, 64) : 'anonymous';
}

function cstStamp(d) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' +08';
}

// ep: mp | json | async_submit | async_done
function usageLog(uid, ep, imgs, ok, extra) {
  const now = new Date();
  const obj = { ts: now.toISOString(), tscs: cstStamp(now), ep, uid, imgs, ok: !!ok };
  if (extra) Object.assign(obj, extra);
  const line = '[usage] ' + JSON.stringify(obj);
  setImmediate(() => console.log(line));
}

function sendError(res, err) {
  const status = err.status || 500;
  console.error('[analyze error]', err?.response?.data || err.message);
  res.status(status).json({
    error: status === 400 ? err.message : (status === 500 && err.message.includes('DASHSCOPE_API_KEY') ? err.message : '分析失败，请重试'),
    detail: err?.response?.data?.error?.message || err.message
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL }));

// 原来那条：multipart 上传（局域网/自建服务器用，keep 保留）
app.post('/api/analyze', upload.array('images', 3), async (req, res) => {
  const t0 = Date.now();
  const uid = uidOf(req);
  const files = req.files || [];
  let ok = false;
  try {
    const result = await runAnalyze(files.map(f => f.buffer));
    res.json(result);
    ok = true;
    usageLog(uid, 'mp', files.length, true, { dishes: result.dishes.length, ms: Date.now() - t0 });
  } catch (err) {
    sendError(res, err);
    usageLog(uid, 'mp', files.length, false, { ms: Date.now() - t0 });
  }
});

// JSON + base64（云托管 wx.cloud.callContainer 用，不支持 multipart 文件）
// 同步版：给能等 60 秒的通道（自建服务器/公网 https 调试）用
app.post('/api/analyze-json', async (req, res) => {
  const t0 = Date.now();
  const uid = uidOf(req);
  const list = Array.isArray(req.body?.images) ? req.body.images : [];
  let ok = false;
  let dishes = 0;
  try {
    if (list.length > 3) throw Object.assign(new Error('最多三张图'), { status: 400 });
    const buffers = list.map(item => {
      const b64 = typeof item === 'string' ? item : (item && item.data) || '';
      const clean = b64.replace(/^data:image\/\w+;base64,/, '');
      if (!clean) throw Object.assign(new Error('图片数据为空'), { status: 400 });
      return Buffer.from(clean, 'base64');
    });
    const result = await runAnalyze(buffers);
    res.json(result);
    ok = true;
    dishes = result.dishes.length;
  } catch (err) {
    sendError(res, err);
  } finally {
    usageLog(uid, 'json', list.length, ok, { dishes, ms: Date.now() - t0 });
  }
});

// 异步版（callContainer 正式路径）：立刻回 jobId，模型在后台跑，前端轮询 /api/job/:id
app.post('/api/analyze-async', (req, res) => {
  const t0 = Date.now();
  const uid = uidOf(req);
  let buffers;
  try {
    const list = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!list.length) throw Object.assign(new Error('至少上传一张图片'), { status: 400 });
    if (list.length > 3) throw Object.assign(new Error('最多三张图'), { status: 400 });
    buffers = list.map(item => {
      const b64 = typeof item === 'string' ? item : (item && item.data) || '';
      const clean = b64.replace(/^data:image\/\w+;base64,/, '');
      if (!clean) throw Object.assign(new Error('图片数据为空'), { status: 400 });
      return Buffer.from(clean, 'base64');
    });
  } catch (err) {
    usageLog(uid, 'async_submit', 0, false, { reason: 'bad_request', ms: Date.now() - t0 });
    return sendError(res, err);
  }

  const id = newJobId();
  const n = buffers.length;
  jobs.set(id, { status: 'pending', createdAt: Date.now() });
  // 用 200 而不是 202：callContainer 对非 200 的兼容性不稳，统一走 200 最保险
  res.status(200).json({ jobId: id, status: 'pending' });
  usageLog(uid, 'async_submit', n, true, { job: id });

  runAnalyze(buffers)
    .then(result => {
      jobs.set(id, { status: 'done', result, createdAt: Date.now() });
      usageLog(uid, 'async_done', n, true, { job: id, dishes: result.dishes.length, ms: Date.now() - t0 });
    })
    .catch(err => {
      console.error('[async job failed]', id, err?.response?.data || err.message);
      jobs.set(id, {
        status: 'error',
        error: err?.response?.data?.error?.message || err.message || '分析失败',
        createdAt: Date.now()
      });
      usageLog(uid, 'async_done', n, false, { job: id, ms: Date.now() - t0 });
    });
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: 'notfound', error: '任务不存在或已过期' });
  if (job.status === 'done') return res.json({ status: 'done', result: job.result });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });
  res.json({ status: 'pending' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`food-calorie-server on :${PORT}`));
