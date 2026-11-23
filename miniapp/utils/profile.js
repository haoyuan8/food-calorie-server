// 个人资料 + 每日预算（Mifflin-St Jeor）；留空按通用 2000 kcal
const KEY = 'profile_v1';

function load() {
  try { return wx.getStorageSync(KEY) || null; } catch (e) { return null; }
}
function save(p) { wx.setStorageSync(KEY, p); }

// activity: 1.2 久坐 / 1.375 轻活动 / 1.55 中活动 / 1.725 高活动
// goal: 'lose' | 'keep' | 'gain'
function budgetOf(p) {
  if (!p || !p.sex || !p.age || !p.height || !p.weight) return { budget: 2000, personalized: false };
  const s = p.sex === 'male' ? 5 : -161;
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + s;
  const tdee = bmr * (p.activity || 1.375);
  let b = tdee;
  if (p.goal === 'lose') b = tdee - 400;
  if (p.goal === 'gain') b = tdee + 300;
  b = Math.max(1200, Math.round(b / 10) * 10);
  return { budget: b, personalized: true };
}

module.exports = { load, save, budgetOf };