const app = getApp();
const daily = require('../../utils/daily');

Page({
  data: {
    result: null,
    ratioOptions: [
      { label: '全吃光', value: 100 },
      { label: '8 成', value: 80 },
      { label: '一半', value: 50 },
      { label: '几口', value: 20 },
      { label: '没动', value: 0 }
    ],
    ratio: null,
    eaten: null,
    isDefault: false
  },

  onLoad() {
    const r = app.globalData.lastResult;
    if (!r) return wx.navigateBack();
    this.setData({ result: r });
  },

  pickRatio(e) {
    const ratio = Number(e.currentTarget.dataset.value);
    const r = this.data.result;
    const f = ratio / 100;
    // 份量按全部菜加总（之前只取了第 1 道菜，多菜时显示偏小）
    const servedTotal = (r.dishes || []).reduce((acc, d) => ({
      min: acc.min + (d.served?.min || 0),
      max: acc.max + (d.served?.max || 0)
    }), { min: 0, max: 0 });
    const eaten = {
      kcal: { min: Math.round(r.total.kcal.min * f), max: Math.round(r.total.kcal.max * f) },
      served: {
        min: Math.round(servedTotal.min * f),
        max: Math.round(servedTotal.max * f)
      }
    };
    this.setData({ ratio, eaten, isDefault: ratio === 80 });
  },

  commit() {
    const r = this.data.result;
    if (!r) return;
    let ratio = this.data.ratio;
    let isDefault = false;
    if (ratio === null) { ratio = 80; isDefault = true; }
    const f = ratio / 100;
    const kcalMin = Math.round(r.total.kcal.min * f);
    const kcalMax = Math.round(r.total.kcal.max * f);
    const label = `${r.dishes.map(d => d.name).join('、')}（${ratio}%${isDefault ? '，8成估算未核实' : ''}）`;
    daily.add(kcalMin, kcalMax, label);
    wx.showToast({ title: '已记一笔', icon: 'success' });
    setTimeout(() => {
      app.globalData.lastResult = null;
      wx.reLaunch({ url: '/pages/index/index' });
    }, 600);
  },

  back() {
    app.globalData.lastResult = null;
    wx.navigateBack();
  }
});