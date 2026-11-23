// 每日已记录合计，按自然日 key 存储，0 点清零（读取时比对日期）
const KEY = 'daily_v1';

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function load() {
  const rec = wx.getStorageSync(KEY);
  if (!rec || rec.date !== todayKey()) return { date: todayKey(), kcalMid: 0, items: [] };
  return rec;
}
function add(kcalMin, kcalMax, label) {
  const rec = load();
  const mid = Math.round((kcalMin + kcalMax) / 2);
  rec.kcalMid += mid;
  rec.items.push({ label, kcalMin, kcalMax, at: Date.now() });
  wx.setStorageSync(KEY, rec);
  return rec;
}
// 三档：<70 偏少 / 70-100 快到量 / >100 爆表
function level(recorded, budget) {
  const ratio = budget > 0 ? recorded / budget : 0;
  if (ratio < 0.7) return { key: 'low', ratio, text: '今天记得偏少——不过只算你拍过的，没拍的没算，真数只会更高，别拿这个数去加餐。' };
  if (ratio <= 1.0) return { key: 'ok', ratio, text: '快到量了，下一顿悠着点，别爆表。' };
  return { key: 'over', ratio, text: '爆表了，出去迈开步：溜溜狗、与情人散个步、原地深蹲五十次，挑一个。' };
}

module.exports = { todayKey, load, add, level };