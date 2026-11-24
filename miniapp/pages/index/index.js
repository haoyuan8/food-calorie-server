const app = getApp();
const profileUtil = require('../../utils/profile');
const daily = require('../../utils/daily');

// 微信云托管环境与服务名：前端默认走 callContainer（微信通道，免域名配置、免备案）
const CLOUD_ENV = 'prod-d4gvpo86x07c3b42c';
const CLOUD_SERVICE = 'food-calorie-server';

const ACTIVITY = [
  { label: '久坐', v: 1.2 }, { label: '轻活动', v: 1.375 },
  { label: '中活动', v: 1.55 }, { label: '高活动', v: 1.725 }
];
const GOAL = [{ label: '减重', v: 'lose' }, { label: '保持', v: 'keep' }, { label: '增肌', v: 'gain' }];

// 热量刻度色带（老钟 239/240 号定）：
// 黄(不到70%) / 绿(70-100%) / 红(超100%) 三段等长，各占总长 1/3；刻度到预算 150% 为止。
// 填色从左往右逐步填：只填到"今天已记录"那一点，右边留空；超过 150% 标记顶在最右端。
function bandOf(recorded, budget) {
  const ratio = budget > 0 ? recorded / budget : 0;
  // 每段内部填多少（0-1）
  const f1 = Math.min(1, Math.max(0, ratio / 0.7));
  const f2 = Math.min(1, Math.max(0, (ratio - 0.7) / 0.3));
  const f3 = Math.min(1, Math.max(0, (ratio - 1.0) / 0.5));
  // 整条色带上的填充进度 = 三段均已等长，取平均
  const mark = Math.min(1, (f1 + f2 + f3) / 3);
  return {
    bandF1: (f1 * 100).toFixed(1) + '%',
    bandF2: (f2 * 100).toFixed(1) + '%',
    bandF3: (f3 * 100).toFixed(1) + '%',
    bandMark: (mark * 100).toFixed(1) + '%',
    bandRatio: ratio
  };
}

// 把多张图片拼成一个 multipart/form-data 请求体，一次发给后端（后端一次收 3 张，模型一次看全）。
// 微信 wx.uploadFile 一次只能发一个文件，所以这里用 wx.request 手写 multipart。
function buildMultipart(files) {
  const boundary = '----foodcalorie' + Date.now().toString(36);
  const chunks = [];
  const enc = (s) => {
    const arr = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xff;
    return arr.buffer;
  };
  files.forEach(f => {
    chunks.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    chunks.push(f.buffer);
    chunks.push(enc('\r\n'));
  });
  chunks.push(enc(`--${boundary}--\r\n`));
  let total = 0;
  chunks.forEach(c => total += c.byteLength);
  const out = new Uint8Array(total);
  let off = 0;
  chunks.forEach(c => { out.set(new Uint8Array(c), off); off += c.byteLength; });
  return { body: out.buffer, boundary };
}

// 云托管通道：wx.cloud.callContainer 的 timeout 硬上限只有 15 秒，模型要 14–25 秒，
// 同步调用必被掐断。所以先提交任务拿 jobId（几百 KB 上传 + 立刻返回），再轮询结果。
function cloudRequest(path, method, data) {
  if (!wx.cloud) return Promise.reject(new Error('基础库不支持 wx.cloud'));
  if (!app.globalData.cloudReady) {
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    app.globalData.cloudReady = true;
  }
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path,
      method,
      header: { 'X-WX-SERVICE': CLOUD_SERVICE, 'content-type': 'application/json' },
      data: data || {},
      timeout: 15000, // callContainer 上限就是 15 秒，写大了也无效
      success: res => {
        let body = res.data;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch (e) { return reject(e); }
        }
        resolve({ statusCode: res.statusCode, body });
      },
      fail: reject
    });
  });
}

function callCloudAnalyze(base64List, tries) {
  const left = typeof tries === 'number' ? tries : 2;
  return cloudRequest('/api/analyze-async', 'POST', { images: base64List })
    .then(({ statusCode, body }) => {
      if (!body || !body.jobId) {
        throw new Error((body && (body.detail || body.error)) || `提交失败(${statusCode})`);
      }
      return body.jobId;
    })
    .catch(err => {
      // 微信侧偶发 -606001（实例重建/系统抖动）会自动重试，用户基本无感
      if (left <= 0) throw err;
      return new Promise(r => setTimeout(r, 1500)).then(() => callCloudAnalyze(base64List, left - 1));
    });
}

// 轮询：每 1.5 秒问一次，最长 3 分钟；单次网络抖动不直接判失败
function pollCloudJob(jobId, onTick) {
  const started = Date.now();
  let netFail = 0;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - started > 180000) {
        return reject(new Error('分析超时，请重试'));
      }
      cloudRequest(`/api/job/${jobId}`, 'GET')
        .then(({ body }) => {
          netFail = 0;
          if (!body) return reject(new Error('轮询返回为空'));
          if (body.status === 'done' && body.result) return resolve(body.result);
          if (body.status === 'error') return reject(new Error(body.error || '分析失败'));
          if (body.status === 'notfound') return reject(new Error('任务不存在或已过期'));
          if (onTick) onTick();
          setTimeout(tick, 1500);
        })
        .catch(err => {
          netFail += 1;
          if (netFail >= 5) return reject(err);
          setTimeout(tick, 1500);
        });
    };
    tick();
  });
}

Page({
  data: {
    images: [],
    loading: false,
    showProfile: false,
    profile: {},
    activityLabels: ACTIVITY.map(a => a.label),
    activityIndex: 1,
    goalLabels: GOAL.map(g => g.label),
    goalIndex: 1,
    budgetText: '2000 kcal（通用）',
    recorded: 0,
    levelText: '',
    levelColor: '#6b7280',
    showServer: false,
    apiBase: '',
    usingCloud: true,
    statusBarH: 20,
    navBarH: 44
  },

  onLoad() {
    // 自定义导航栏（老钟 259 号：首页标题前要放 logo）：状态栏高度 + 导航栏高度按胶囊按钮实测算
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const statusBarH = info.statusBarHeight || 20;
      let navBarH = 44;
      const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
      if (menu && menu.top && menu.height) {
        navBarH = (menu.top - statusBarH) * 2 + menu.height;
      }
      this.setData({ statusBarH: statusBarH, navBarH: Math.round(navBarH) });
    } catch (e) {
      // 取不到就退回默认值，不影响使用
    }
  },

  onShow() {
    const p = profileUtil.load() || {};
    const saved = wx.getStorageSync('apiBase') || app.globalData.apiBase || '';
    this.setData({
      profile: p,
      showProfile: false,
      apiBase: saved,
      usingCloud: !saved
    });
    this.refreshDaily();
  },

  refreshDaily() {
    const rec = daily.load();
    const { budget, personalized, basis } = profileUtil.budgetOf(this.data.profile);
    const lv = daily.level(rec.kcalMid, budget);
    const color = lv.key === 'low' ? '#b45309' : lv.key === 'ok' ? '#15803d' : '#dc2626';
    const basisText = personalized ? '专属' : (basis === 'sex' ? '按性别' : '通用');
    this.setData(Object.assign({
      recorded: rec.kcalMid,
      budgetText: `${budget} kcal（${basisText}）`,
      levelText: lv.text,
      levelColor: color
    }, bandOf(rec.kcalMid, budget)));
  },

  toggleProfile() { this.setData({ showProfile: !this.data.showProfile }); },

  onProfile(e) {
    const k = e.currentTarget.dataset.k;
    const v = e.detail.value;
    this.setData({ [`profile.${k}`]: v });
  },
  onActivity(e) {
    const i = Number(e.detail.value);
    this.setData({ activityIndex: i, 'profile.activity': ACTIVITY[i].v });
  },
  onGoal(e) {
    const i = Number(e.detail.value);
    this.setData({ goalIndex: i, 'profile.goal': GOAL[i].v });
  },
  saveProfile() {
    profileUtil.save(this.data.profile);
    this.refreshDaily();
    wx.showToast({ title: '已保存' });
  },

  // 地址入口：留空 = 走云托管（默认）；填了 = 走自己填的服务器（局域网/自建）
  toggleServer() { this.setData({ showServer: !this.data.showServer }); },

  onApiBase(e) { this.setData({ apiBase: e.detail.value }); },

  saveApiBase() {
    let v = (this.data.apiBase || '').trim().replace(/\/+$/, '');
    if (!v) {
      wx.removeStorageSync('apiBase');
      app.globalData.apiBase = '';
      this.setData({ apiBase: '', usingCloud: true });
      wx.showToast({ title: '已恢复云托管', icon: 'none' });
      return;
    }
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    wx.setStorageSync('apiBase', v);
    app.globalData.apiBase = v;
    this.setData({ apiBase: v, usingCloud: false });
    wx.showToast({ title: '已保存' });
  },

  chooseImage() {
    wx.chooseMedia({
      count: 3 - this.data.images.length,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: res => {
        const paths = res.tempFiles.map(f => f.tempFilePath);
        this.setData({ images: this.data.images.concat(paths).slice(0, 3) });
      }
    });
  },
  removeImage(e) {
    const i = Number(e.currentTarget.dataset.index);
    const arr = this.data.images.slice();
    arr.splice(i, 1);
    this.setData({ images: arr });
  },

  // 读图成 base64（云托管通道用）。
  // 重要：callContainer 的 JSON 请求体硬上限是 100KiB，超了微信直接回 -606001 系统错误。
  // 所以这里按"每张图预算"逐级压缩，压到预算以内才上传（budget 单位是 base64 字符数≈字节数）。
  readBase64(path, budget) {
    const fsm = wx.getFileSystemManager();
    const read = p => new Promise((resolve, reject) => {
      fsm.readFile({ filePath: p, encoding: 'base64', success: r => resolve(r.data), fail: reject });
    });
    const compress = (p, w, q) => new Promise(resolve => {
      wx.compressImage({
        src: p,
        quality: q,
        compressedWidth: w,
        success: r => resolve(r.tempFilePath),
        fail: () => resolve(null)
      });
    });
    // 逐级降：先降质量，再降分辨率
    const steps = [[800, 60], [700, 55], [600, 50], [500, 45], [420, 40], [340, 35]];
    return read(path).then(b64 => {
      if (b64.length <= budget) return b64;
      let best = b64;
      const chain = i => {
        if (i >= steps.length) return best;
        const [w, q] = steps[i];
        return compress(path, w, q).then(p => {
          if (!p) return chain(i + 1);
          return read(p).then(next => {
            if (next.length < best.length) best = next;
            if (next.length <= budget) return next;
            return chain(i + 1);
          });
        });
      };
      return chain(0);
    });
  },

  analyze() {
    if (this.data.loading) return;
    if (!this.data.images.length) return wx.showToast({ title: '先拍一张', icon: 'none' });
    this.setData({ loading: true });
    let loadingTipTimer = null;

    const saved = this.data.apiBase || wx.getStorageSync('apiBase') || app.globalData.apiBase || '';
    const done = data => {
      app.globalData.lastResult = data;
      app.globalData.lastImages = this.data.images;
      wx.navigateTo({ url: '/pages/result/result' });
    };
    const fail = (err, tip) => {
      console.error('[analyze failed]', err);
      const detail = (err && (err.errMsg || err.message) || '').toString().slice(0, 120);
      wx.showModal({
        title: '分析失败',
        content: (tip || '网络或服务异常，请稍后重试。') + (detail ? `\n[${detail}]` : ''),
        showCancel: false
      });
    };

    // A. 没填地址 → 走云托管：先提交任务，再轮询（callContainer 单次只有 15 秒）
    if (!saved) {
      // JSON 请求体上限 100KiB，按张数均分预算（留 12KB 给外壳与 jobId 往返）
      const per = Math.floor(88000 / Math.max(1, this.data.images.length));
      Promise.all(this.data.images.map(p => this.readBase64(p, per)))
        .then(list => callCloudAnalyze(list))
        .then(jobId => pollCloudJob(jobId, () => {
          if (loadingTipTimer === null) {
            loadingTipTimer = setTimeout(() => {
              wx.showLoading({ title: '识别中，请稍候', mask: true });
            }, 3000);
          }
        }))
        .then(data => {
          if (loadingTipTimer) { clearTimeout(loadingTipTimer); loadingTipTimer = null; wx.hideLoading(); }
          done(data);
        })
        .catch(err => {
          if (loadingTipTimer) { clearTimeout(loadingTipTimer); loadingTipTimer = null; wx.hideLoading(); }
          fail(err, '云托管分析失败，请重试；若反复失败可在「服务端地址」填自建服务器地址。');
        })
        .finally(() => this.setData({ loading: false }));
      return;
    }

    // B. 填了地址 → 走 HTTP（原来的多图 multipart，失败退回逐张上传）
    const apiBase = saved;
    const fsm = wx.getFileSystemManager();
    const reads = this.data.images.map(p => new Promise((resolve, reject) => {
      fsm.readFile({ filePath: p, success: res => resolve(res.data), fail: reject });
    }));
    Promise.all(reads)
      .then(buffers => {
        const files = buffers.map((buf, i) => ({
          name: 'images', filename: `photo${i + 1}.jpg`, mime: 'image/jpeg', buffer: buf
        }));
        const { body, boundary } = buildMultipart(files);
        return new Promise((resolve, reject) => {
          wx.request({
            url: `${apiBase}/api/analyze`,
            method: 'POST',
            data: body,
            header: { 'content-type': `multipart/form-data; boundary=${boundary}` },
            success: res => {
              let data = res.data;
              if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) { return reject(e); }
              }
              if (data && data.dishes && data.dishes.length) resolve(data);
              else reject(new Error((data && (data.detail || data.error)) || '没识别出菜'));
            },
            fail: reject
          });
        });
      })
      .then(done)
      .catch(err => {
        console.error('[multipart analyze failed, fallback to single upload]', err);
        const tasks = this.data.images.map(p => new Promise(resolve => {
          wx.uploadFile({
            url: `${apiBase}/api/analyze`,
            filePath: p,
            name: 'images',
            success: r => {
              try { resolve(JSON.parse(r.data)); } catch (e) { resolve(null); }
            },
            fail: () => resolve(null)
          });
        }));
        return Promise.all(tasks).then(list => {
          const ok = list.find(d => d && d.dishes && d.dishes.length);
          if (!ok) throw new Error('没识别出菜');
          done(ok);
        });
      })
      .catch(err => fail(err))
      .finally(() => this.setData({ loading: false }));
  }
});
