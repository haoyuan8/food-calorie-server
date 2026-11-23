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

// 云托管通道：wx.cloud.callContainer 发 JSON + base64（该接口不支持 multipart 文件）
function callCloudAnalyze(base64List) {
  if (!wx.cloud) return Promise.reject(new Error('基础库不支持 wx.cloud'));
  if (!app.globalData.cloudReady) {
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    app.globalData.cloudReady = true;
  }
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path: '/api/analyze-json',
      method: 'POST',
      header: {
        'X-WX-SERVICE': CLOUD_SERVICE,
        'content-type': 'application/json'
      },
      data: { images: base64List },
      timeout: 60000,
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
    usingCloud: true
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
    const { budget, personalized } = profileUtil.budgetOf(this.data.profile);
    const lv = daily.level(rec.kcalMid, budget);
    const color = lv.key === 'low' ? '#b45309' : lv.key === 'ok' ? '#15803d' : '#dc2626';
    this.setData({
      recorded: rec.kcalMid,
      budgetText: `${budget} kcal（${personalized ? '专属' : '通用'}）`,
      levelText: lv.text,
      levelColor: color
    });
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

  // 读图成 base64（云托管通道用）；太大的先压一道，避免请求体过大
  readBase64(path) {
    const fsm = wx.getFileSystemManager();
    return new Promise((resolve, reject) => {
      fsm.getFileInfo({
        filePath: path,
        success: info => {
          const heavy = info.size > 900 * 1024;
          const go = p => fsm.readFile({
            filePath: p,
            encoding: 'base64',
            success: res => resolve(res.data),
            fail: reject
          });
          if (!heavy) return go(path);
          wx.compressImage({
            src: path,
            quality: 70,
            success: r => go(r.tempFilePath),
            fail: () => go(path)
          });
        },
        fail: reject
      });
    });
  },

  analyze() {
    if (this.data.loading) return;
    if (!this.data.images.length) return wx.showToast({ title: '先拍一张', icon: 'none' });
    this.setData({ loading: true });

    const saved = this.data.apiBase || wx.getStorageSync('apiBase') || app.globalData.apiBase || '';
    const done = data => {
      app.globalData.lastResult = data;
      app.globalData.lastImages = this.data.images;
      wx.navigateTo({ url: '/pages/result/result' });
    };
    const fail = (err, tip) => {
      console.error('[analyze failed]', err);
      wx.showModal({
        title: '分析失败',
        content: tip || '网络或服务异常，请稍后重试。',
        showCancel: false
      });
    };

    // A. 没填地址 → 走云托管 callContainer（正式路径）
    if (!saved) {
      Promise.all(this.data.images.map(p => this.readBase64(p)))
        .then(list => callCloudAnalyze(list))
        .then(done)
        .catch(err => fail(err, '云托管请求失败，可在「服务端地址」里填自建服务器地址重试。'))
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
