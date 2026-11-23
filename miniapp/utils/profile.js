// 个人资料 + 每日预算（Mifflin-St Jeor）；留空按通用 2000 kcal
const KEY = 'profile_v1';

function load() {
  try { return wx.getStorageSync(KEY) || null; } catch (e) { return null; }
}
function save(p) { wx.setStorageSync(KEY, p); }

// 预算取法（老钟 239 号定）：
// 1. 资料齐全（性别+年龄+身高+体重）→ Mifflin-St Jeor 算专属预算
// 2. 只填了性别 → 男 2250 / 女 1800（中国居民膳食指南轻体力标准）
// 3. 连性别都没有 → 通用 2000
function budgetOf(p) {
  if (p && p.sex && p.age && p.height && p.weight) {
    const s = p.sex === 'male' ? 5 : -161;
    const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + s;
    const tdee = bmr * (p.activity || 1.375);
    let b = tdee;
    if (p.goal === 'lose') b = tdee - 400;
    if (p.goal === 'gain') b = tdee + 300;
    b = Math.max(1200, Math.round(b / 10) * 10);
    return { budget: b, personalized: true, basis: 'profile' };
  }
  if (p && p.sex) {
    return { budget: p.sex === 'male' ? 2250 : 1800, personalized: false, basis: 'sex' };
  }
  return { budget: 2000, personalized: false, basis: 'default' };
}

module.exports = { load, save, budgetOf };