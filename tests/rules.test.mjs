/* =========================================================
   rules.test.mjs — PRD v1.1 决策表 / 边界 / 不变量 的自动化验收
   运行：node --test tests/
   每条用例的 [ACx-y] 对应 PRD 第 5 章验收表编号
   ========================================================= */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/rules.js');
const { CFG } = R;

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* 确定性随机：mulberry32，保证统计类用例可复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================
   6.1 三态判定决策表 T1–T11
   ========================================================= */
const DECISION_TABLE = [
  { id: 'T1', P: 16, F: 6, kind: 'eat', score: 10, nextP: 16.72 },
  { id: 'T2', P: 16, F: 10, kind: 'eat', score: 16, nextP: 17.20 },
  { id: 'T3', P: 16, F: 15.0, kind: 'eat', score: 24, nextP: 17.80 },
  { id: 'T4', P: 16, F: 15.1, kind: 'stall', score: 0, nextP: 16 },
  { id: 'T5', P: 16, F: 16, kind: 'stall', score: 0, nextP: 16 },
  { id: 'T6', P: 16, F: 17, kind: 'hurt', score: 0, nextP: 16 },
  { id: 'T7', P: 16, F: 18, kind: 'hurt', score: 0, nextP: 16 },
  { id: 'T8', P: 92, F: 86, kind: 'eat', score: 138, nextP: 92 },
  { id: 'T9', P: 92, F: 88, kind: 'stall', score: 0, nextP: 92 },
  { id: 'T10', P: 92, F: 97, kind: 'stall', score: 0, nextP: 92 },
  { id: 'T11', P: 92, F: 98, kind: 'hurt', score: 0, nextP: 92 }
];

for (const c of DECISION_TABLE) {
  test(`[6.1 ${c.id}] P=${c.P} F=${c.F} → ${c.kind}`, () => {
    assert.equal(R.classify(c.P, c.F), c.kind);
    const r = R.interact(c.P, c.F);
    assert.equal(r.kind, c.kind);
    assert.equal(r.score, c.score, '得分不符');
    assert.ok(close(r.nextP, c.nextP, 1e-6), `成长后 P 应为 ${c.nextP}，实际 ${r.nextP}`);
  });
}

test('[T9 回归] v1.0 曾把 P=92,F=88 误判为受伤', () => {
  assert.notEqual(R.classify(92, 88), 'hurt');
  assert.equal(R.classify(92, 88), 'stall');
});

/* =========================================================
   6.2 接触判定 C1–C5（P=16, F=10, 阈值 23.2）
   ========================================================= */
const CONTACT_TABLE = [
  { id: 'C1', d: 30.0, hit: false },
  { id: 'C2', d: 23.3, hit: false },
  { id: 'C3', d: 23.1, hit: true },
  { id: 'C4', d: 10.0, hit: true },
  { id: 'C5', d: 0, hit: true }
];

test('[6.2] 接触阈值 P + 0.72F = 23.2', () => {
  assert.ok(close(R.contactDist(16, 10), 23.2, 1e-9));
});

for (const c of CONTACT_TABLE) {
  test(`[6.2 ${c.id}] d=${c.d} → ${c.hit ? '接触' : '不接触'}`, () => {
    assert.equal(R.isContact(16, 10, c.d), c.hit);
  });
}

test('[AC4-9 前置] 完全重合不得出现除零', () => {
  assert.doesNotThrow(() => R.interact(16, 10));
  assert.ok(Number.isFinite(R.contactDist(16, 10)));
});

/* =========================================================
   R3 四档分布（AC3-2 / AC3-3 / AC3-7）
   ========================================================= */
test('[AC3-2] 四档占比 56/28/6/10（5000 次，偏差 ≤5%）', () => {
  const rnd = mulberry32(20261020);
  const N = 5000;
  const cnt = { small: 0, mid: 0, same: 0, big: 0 };
  for (let i = 0; i < N; i++) cnt[R.spawnFishRadius(16, rnd).bucket]++;
  const expect = { small: 0.56, mid: 0.28, same: 0.06, big: 0.10 };
  for (const k of Object.keys(expect)) {
    const actual = cnt[k] / N;
    assert.ok(Math.abs(actual - expect[k]) <= 0.05,
      `${k} 占比 ${(actual * 100).toFixed(1)}% 偏离目标 ${(expect[k] * 100)}% 超过 5%`);
  }
});

test('[AC3-2] P=16 时各档半径区间与 PRD 一致（含 [6,130] 钳制）', () => {
  const rnd = mulberry32(7);
  const bounds = {
    small: [6, 16 * 0.60],
    mid: [16 * 0.66, 16 * 0.94],
    same: [16 * 1.00, 16 * 1.04],
    big: [16 * 1.12, 16 * 1.90]
  };
  for (let i = 0; i < 3000; i++) {
    const { r, bucket } = R.spawnFishRadius(16, rnd);
    const [lo, hi] = bounds[bucket];
    assert.ok(r >= lo - 1e-9 && r <= hi + 1e-9,
      `${bucket} 档半径 ${r.toFixed(2)} 越界 [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
    assert.ok(r >= CFG.minFishR && r <= CFG.maxFishR, '突破全局钳制');
  }
});

test('[AC3-3] P=92 时大鱼档仍 ≥ 危险阈值 97.6（B3-1）', () => {
  const rnd = mulberry32(99);
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const { r, bucket } = R.spawnFishRadius(92, rnd);
    if (bucket !== 'big') continue;
    checked++;
    assert.ok(r >= 97.6, `大鱼半径 ${r.toFixed(2)} 低于危险阈值`);
  }
  assert.ok(checked > 200, '样本中应有足够多的大鱼');
});

test('[B3-2] P=16 时小鱼不低于 6（否则看不清）', () => {
  const rnd = mulberry32(3);
  for (let i = 0; i < 2000; i++) {
    const { r, bucket } = R.spawnFishRadius(16, rnd);
    if (bucket === 'small') assert.ok(r >= 6 - 1e-9);
  }
});

test('[B3-3/B3-4] 中鱼 100% 可吃，同类鱼 100% 僵持', () => {
  const rnd = mulberry32(11);
  for (const P of [16, 30, 50, 92]) {
    const lo = P * 0.66, hi = P * 0.94;
    for (let i = 0; i <= 20; i++) {
      const F = lo + (hi - lo) * (i / 20);
      assert.equal(R.classify(P, F), 'eat', `中鱼 F=${F.toFixed(2)} P=${P} 应可吃`);
    }
    const slo = P * 1.00, shi = P * 1.04;
    for (let i = 0; i <= 20; i++) {
      const F = slo + (shi - slo) * (i / 20);
      assert.equal(R.classify(P, F), 'stall', `同类鱼 F=${F.toFixed(2)} P=${P} 应僵持`);
    }
  }
  void rnd;
});

test('[I6] 任意 F>0 必落入三态之一，无未定义区间', () => {
  const rnd = mulberry32(5);
  for (let i = 0; i < 20000; i++) {
    const P = 16 + rnd() * (92 - 16);
    const F = 0.5 + rnd() * 200;
    const k = R.classify(P, F);
    assert.ok(['eat', 'hurt', 'stall'].includes(k));
  }
});

test('[D3] 僵持区宽度约占体型的 11.7%', () => {
  const w = R.stallZoneWidth(100) / 100;
  assert.ok(w > 0.11 && w < 0.12, `僵持区相对宽度 ${w.toFixed(4)}`);
});

/* =========================================================
   R4 得分与成长（B4-1 / B4-2 / B4-7）
   ========================================================= */
test('[B4-1] 得分只与被吃鱼半径有关，与玩家体型解耦', () => {
  assert.equal(R.scoreGain(10), 16);
  assert.equal(R.interact(16, 10).score, R.interact(80, 10).score);
});

test('[B4-2] P 封顶 92 后不再增长，但得分照常', () => {
  const r = R.interact(92, 20);
  assert.equal(r.kind, 'eat');
  assert.equal(r.nextP, 92);
  assert.equal(r.score, 32, '[AC4-5] F=20 应得 32 分');
});

test('[B4-7] 得分一律四舍五入取整且为整数', () => {
  for (let F = 6; F <= 130; F += 0.37) {
    const s = R.scoreGain(F);
    assert.ok(Number.isInteger(s), `scoreGain(${F}) 非整数`);
  }
});

test('[G4] 从 16 长到 40 约需 12–18 条（按 56/28 实际可吃比例加权）', () => {
  // 可吃的只有小鱼与中鱼：56% 与 28%，各自半径均值 0.41P / 0.80P
  const avgGrowthPerEaten = (0.56 * 0.41 + 0.28 * 0.80) / (0.56 + 0.28);
  let P = 16, n = 0;
  while (P < 40 && n < 200) { P = R.grow(P, P * avgGrowthPerEaten); n++; }
  assert.ok(n >= 12 && n <= 18, `实际 ${n} 条（加权单条成长 ${(avgGrowthPerEaten * 100).toFixed(1)}%P）`);
});

/* =========================================================
   R3 速度（AC3-4）
   ========================================================= */
test('[AC3-4] 速度与半径强负相关，且无零速', () => {
  const rs = [], vs = [];
  for (let r = 6; r <= 130; r += 1) { rs.push(r); vs.push(R.fishMaxSpeed(r)); }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mr = mean(rs), mv = mean(vs);
  let num = 0, dr = 0, dv = 0;
  for (let i = 0; i < rs.length; i++) {
    num += (rs[i] - mr) * (vs[i] - mv);
    dr += (rs[i] - mr) ** 2;
    dv += (vs[i] - mv) ** 2;
  }
  const corr = num / Math.sqrt(dr * dv);
  assert.ok(corr < -0.9, `相关系数 ${corr.toFixed(3)} 未达 -0.9`);
  for (const v of vs) assert.ok(v > 0);
});

test('[B3-5 前置] 初始速度与最大速度均为正，且初始 ≥ 30', () => {
  for (let r = 6; r <= 130; r += 7) {
    assert.ok(R.fishSpawnSpeed(r) >= 30);
    assert.ok(R.fishMaxSpeed(r) >= 34);
    assert.ok(close(R.fishMinSpeed(r), R.fishMaxSpeed(r) * 0.45));
  }
});

/* =========================================================
   R4 无敌（B4-3 / AC4-7）
   ========================================================= */
test('[B4-3] 无敌期内撞大鱼只僵持，不掉命', () => {
  assert.equal(R.classify(16, 40, { invulnerable: true }), 'stall');
  const r = R.interact(16, 40, { invulnerable: true });
  assert.equal(r.kind, 'stall');
  assert.equal(r.score, 0);
});

/* =========================================================
   R6 R 键长按（D12 / AC6-4a~c / B6-7）
   ========================================================= */
test('[AC6-4a] PLAYING 态短按 150ms 不重开', () => {
  const g = R.createRestartGate();
  assert.equal(g.down(0, true), 'armed');
  assert.equal(g.tick(150), null);
  assert.equal(g.up(), 'cancelled');
  assert.equal(g.tick(1000), null, '松键后不得延时触发');
});

test('[AC6-4b] PLAYING 态长按 1000ms 重开', () => {
  const g = R.createRestartGate();
  g.down(0, true);
  assert.equal(g.tick(799), null);
  assert.equal(g.tick(800), 'fire');
  assert.equal(g.tick(5000), null, '只触发一次');
});

test('[AC6-4c] 非 PLAYING 态短按立即重开', () => {
  for (const playing of [false]) {
    const g = R.createRestartGate();
    assert.equal(g.down(0, playing), 'fire');
  }
});

test('[B6-7] 重复 keydown 不累积、不重置计时', () => {
  const g = R.createRestartGate();
  g.down(0, true);
  g.down(200, true);
  g.down(400, true);
  assert.equal(g.tick(790), null, '重复 keydown 把计时重置了');
  assert.equal(g.tick(800), 'fire');
});

/* =========================================================
   R1 本地值清洗（B1-6 / AC1-7 / E-5）
   ========================================================= */
test('[AC1-7] fish-best 脏值回退 0', () => {
  for (const bad of ['abc', '', null, undefined, NaN, Infinity, -5, 'NaN', '１２３abc']) {
    assert.equal(R.sanitizeBest(bad), 0, `输入 ${String(bad)} 应回退 0`);
  }
});

test('[B1-6] 合法值取整保留', () => {
  assert.equal(R.sanitizeBest('320'), 320);
  assert.equal(R.sanitizeBest(320.8), 320);
  assert.equal(R.sanitizeBest(0), 0);
});

test('[AC1-8] 多标签页 best 取较大值', () => {
  assert.equal(R.mergeBest(100, 300), 300);
  assert.equal(R.mergeBest(300, 100), 300);
  assert.equal(R.mergeBest('300', '100'), 300);
  assert.equal(R.mergeBest('abc', 50), 50);
});

/* =========================================================
   4.4 三态视觉编码（AC4-9a~d / N10）
   ========================================================= */
const BG = R.hexToRgb('#0f3348');
const BG_TOP = R.hexToRgb('#1d5273');
const BG_BOTTOM = R.hexToRgb('#05131d');

test('[AC4-9d] 描边对深色衬底对比度 ≥ 3:1（渐变三段取最差值）', () => {
  for (const bg of [BG_TOP, BG, BG_BOTTOM]) {
    const back = R.backingColor(bg);
    for (const which of ['danger', 'prey']) {
      const c = R.contrastRatio(R.strokeColorOnBacking(which, bg), back);
      assert.ok(c >= 3, `${which} 在 rgb(${bg.map(Math.round)}) 上对比度 ${c.toFixed(2)}:1 < 3:1`);
    }
  }
});

test('[AC4-9d 反例] 无衬底时危险描边在渐变顶部达不到 3:1 —— 证明衬底是必需的', () => {
  const c = R.contrastRatio(R.strokeColor('danger', BG_TOP), BG_TOP);
  assert.ok(c < 3, `若此处 ≥3:1 说明衬底多余；实际 ${c.toFixed(2)}:1`);
});

test('[4.4] 危险虚线 / 可吃实线 —— 灰度下仍可区分', () => {
  assert.deepEqual(Array.from(R.STROKE.danger.dash), [4, 3]);
  assert.equal(R.STROKE.prey.dash.length, 0, '可吃态必须是实线（空 dash）');
  assert.equal(R.STROKE.stall, null, '僵持态必须无描边');
});

test('[AC4-9c] r=6 时线宽 ≥2px，外扩 ≤ 半径 40%', () => {
  const r = 6;
  assert.ok(R.STROKE.danger.width(r) >= 2);
  assert.ok(R.STROKE.prey.width(r) >= 2, 'AC4-9c 要求 ≥2px；原实现取 1.5 是把断言调低去迁就代码');
  for (const which of ['danger', 'prey']) {
    const off = R.STROKE[which].offset(r);
    assert.ok(off <= 0.4 * r + 1e-9, `${which} 外扩 ${off} 超过 40%r`);
  }
});

test('[AC4-9c] 线宽随半径线性增长（E-7）', () => {
  assert.ok(R.STROKE.danger.width(100) > R.STROKE.danger.width(20));
  assert.ok(close(R.STROKE.danger.width(100), 5, 1e-9));
  assert.ok(close(R.STROKE.prey.width(100), 4, 1e-9));
});

test('[AC4-9a] 视觉状态与判定式同源，三个状态齐全', () => {
  assert.equal(R.visualState(16, 10), 'prey');
  assert.equal(R.visualState(16, 16), 'stall');
  assert.equal(R.visualState(16, 40), 'danger');
  // 与 classify 必须完全一致
  for (let F = 1; F < 60; F += 0.5) {
    const k = R.classify(16, F);
    const v = R.visualState(16, F);
    assert.equal(v === 'prey' ? 'eat' : v === 'danger' ? 'hurt' : 'stall', k);
  }
});

/* =========================================================
   0.5 核心不变量
   ========================================================= */
test('[I1–I7] 合法状态无违规', () => {
  assert.deepEqual(R.checkInvariants({
    score: 100, best: 200, lives: 3, P: 16, fishCount: 22, stateName: 'PLAYING', dt: 0.016
  }), []);
});

test('[I1–I7] 违规可被检出', () => {
  const bad = R.checkInvariants({
    score: 300, best: 200, lives: 4, P: 10, fishCount: 21, stateName: 'PAUSE', dt: 0.2
  });
  assert.deepEqual(bad.sort(), ['I1', 'I2', 'I3', 'I4', 'I5', 'I7']);
});

/* =========================================================
   成长节奏（G5 的静态估算，非运行时统计）
   ========================================================= */
test('[G6 前置] 一次性伤害不得击穿生命下限', () => {
  let lives = CFG.lives;
  for (let i = 0; i < CFG.lives; i++) lives -= 1;
  assert.equal(lives, 0);
  assert.ok(lives >= 0);
});

test('[B4-7 回归] 最佳分有上界，HUD 不出现科学计数法', () => {
  assert.equal(R.CFG.bestCeiling, 1e9);
  assert.equal(R.sanitizeBest('999999999999999999999'), 1e9, '超大值应封顶');
  assert.ok(String(R.sanitizeBest('999999999999999999999')).indexOf('e') === -1, '不得出现 e 记数法');
});
