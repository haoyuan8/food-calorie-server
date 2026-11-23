require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const dishes = require('./dishes.json');
const { SYSTEM_PROMPT } = require('./prompt');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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

app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL }));

app.post('/api/analyze', upload.array('images', 3), async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: '服务端未配置 DASHSCOPE_API_KEY' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '至少上传一张图片' });

    const imageParts = files.map(f => ({
      type: 'image_url',
      image_url: { url: bufToDataUrl(f.buffer, f.mimetype) }
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

    res.json({
      dishes: merged,
      total,
      advice: parsed.advice || '这盘看着挺实在，先吃七成、剩下的看心情。',
      disclaimer: '仅供参考'
    });
  } catch (err) {
    console.error('[analyze error]', err?.response?.data || err.message);
    res.status(500).json({ error: '分析失败，请重试', detail: err?.response?.data?.error?.message || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`food-calorie-server on :${PORT}`));