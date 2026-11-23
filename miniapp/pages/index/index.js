const app = getApp();
const profileUtil = require('../../utils/profile');
const daily = require('../../utils/daily');

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
    apiBase: 'http://localhost:3000'
  },

  onShow() {
    const p = profileUtil.load() || {};
    this.setData({
      profile: p,
      showProfile: false,
      apiBase: wx.getStorageSync('apiBase') || app.globalData.apiBase || 'http://localhost:3000'
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

  // 后端地址：填一次就存本地，之后不用再改代码。留空 = 回到默认 http://localhost:3000
  toggleServer() { this.setData({ showServer: !this.data.showServer }); },

  onApiBase(e) { this.setData({ apiBase: e.detail.value }); },

  saveApiBase() {
    let v = (this.data.apiBase || '').trim().replace(/\/+$/, '');
    if (!v) {
      wx.removeStorageSync('apiBase');
      app.globalData.apiBase = '';
      this.setData({ apiBase: 'http://localhost:3000' });
      wx.showToast({ title: '已恢复默认', icon: 'none' });
      return;
    }
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    wx.setStorageSync('apiBase', v);
    app.globalData.apiBase = v;
    this.setData({ apiBase: v });
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

  analyze() {
    if (this.data.loading) return;
    if (!this.data.images.length) return wx.showToast({ title: '先拍一张', icon: 'none' });
    this.setData({ loading: true });

    const apiBase = this.data.apiBase || wx.getStorageSync('apiBase') || app.globalData.apiBase || 'http://localhost:3000';
    const fsm = wx.getFileSystemManager();
    // 1) 一次把全部照片拼成一个 multipart 请求发给后端，模型一次看全
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
              else reject(new Error('没识别出菜'));
            },
            fail: reject
          });
        });
      })
      .then(data => {
        app.globalData.lastResult = data;
        app.globalData.lastImages = this.data.images;
        wx.navigateTo({ url: '/pages/result/result' });
      })
      .catch(err => {
        console.error('[multipart analyze failed, fallback to single upload]', err);
        // 2) 兜底：拼包失败时退回逐张上传，取第一张有结果的（单张失败不拖垮其他张）
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
          app.globalData.lastResult = ok;
          app.globalData.lastImages = this.data.images;
          wx.navigateTo({ url: '/pages/result/result' });
        });
      })
      .catch(err => {
        console.error(err);
        wx.showModal({ title: '分析失败', content: '网络或服务异常，请稍后重试。', showCancel: false });
      })
      .finally(() => this.setData({ loading: false }));
  }
});