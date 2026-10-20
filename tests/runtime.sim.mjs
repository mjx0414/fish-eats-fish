/* =========================================================
   runtime.sim.mjs — 无头运行时仿真
   用 DOM / Canvas / rAF 桩驱动真实的 src/game.js，
   验证状态机、碰撞三分支、鱼群不变量、结束态降帧、R 长按。
   运行：node --test tests/runtime.sim.mjs
   ========================================================= */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/* ---------------- 桩 ---------------- */
function makeClassList() {
  const s = new Set();
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    contains: (c) => s.has(c),
    toggle: (c, v) => { if (v === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { v ? s.add(c) : s.delete(c); } },
    _set: s
  };
}

function makeEl(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    hidden: false,
    style: {},
    classList: makeClassList(),
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {},
    removeEventListener() {}
  };
}

function makeCtx(counters) {
  const grad = { addColorStop() {} };
  const strokes = [];          // 每次 stroke 的上下文快照，用于审计线帽/虚线（I4）
  const stack = [];
  let dash = [];
  const base = {
    canvas: null,
    lineCap: 'butt', lineWidth: 1, strokeStyle: '',
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    setTransform() {},
    save() { stack.push({ cap: this.lineCap, dash: dash.slice() }); },
    restore() { const st = stack.pop(); if (st) { this.lineCap = st.cap; dash = st.dash; } },
    translate() {}, rotate() {}, scale() {}, clip() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, arc() {}, ellipse() {},
    fill() {},
    stroke() { strokes.push({ cap: this.lineCap, width: this.lineWidth, dash: dash.slice(), style: this.strokeStyle }); },
    fillRect() { counters.fillRect++; },
    fillText() {},
    setLineDash(d) { dash = (d || []).slice(); }
  };
  const ctx = new Proxy(base, {
    get(t, p) { return p in t ? t[p] : () => {}; },
    set(t, p, v) { t[p] = v; return true; }
  });
  ctx.__strokes = strokes;
  return ctx;
}

function buildSandbox(opts = {}) {
  const counters = { fillRect: 0 };
  const rafQueue = [];
  let clock = 0;
  const handlers = { window: {}, document: {}, canvas: {} };
  const storage = new Map();

  const els = {};
  ['score', 'size', 'best', 'music', 'overlay', 'ov-kicker', 'ov-title', 'ov-text', 'ov-meta',
    'ov-btn', 'ov-exit', 'mute', 'btn-pause', 'btn-restart', 'btn-quit', 'build', 'lives', 'controls', 'stage']
    .forEach((id) => { els[id] = makeEl(id); });

  const hearts = [makeEl('h1'), makeEl('h2'), makeEl('h3')];

  const canvas = makeEl('game');
  canvas.clientWidth = 1440;
  canvas.clientHeight = 900;
  const ctx = makeCtx(counters);
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 900 });
  canvas.setPointerCapture = () => {};
  canvas.addEventListener = (t, f) => { handlers.canvas[t] = f; };
  els.game = canvas;

  const body = makeEl('body');

  const document = {
    getElementById: (id) => els[id] || makeEl(id),
    querySelector: (sel) => (sel.includes('meta') ? { content: '1.1.0' } : makeEl(sel)),
    querySelectorAll: (sel) => (sel.includes('heart') ? hearts : []),
    addEventListener: (t, f) => { handlers.document[t] = f; },
    body,
    hidden: false
  };

  const audio = { osc: 0 };
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createOscillator() {
      audio.osc++;
      return {
        type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect(n) { return n; }, start() {}, stop() {}
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(n) { return n; } };
    }
  }

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Set,
    Map,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    document,
    performance: { now: () => clock },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    Path2D: class { moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} },
    AudioContext: FakeAudioContext,
    addEventListener: (t, f) => { handlers.window[t] = f; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.devicePixelRatio = opts.dpr || 1;

  vm.createContext(sandbox);

  const load = (rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  };
  load('src/rules.js');
  load('src/game.js');

  /** 推进一帧（16.7ms） */
  function step(ms = 16.7) {
    clock += ms;
    const cb = rafQueue.shift();
    if (cb) cb(clock);
  }
  function frames(n, ms = 16.7) {
    for (let i = 0; i < n; i++) step(ms);
  }

  return { sandbox, handlers, counters, audio, ctx, step, frames, storage, hearts, els, body, get clock() { return clock; }, setClock: (v) => { clock = v; } };
}

/* ---------------- 每个用例重新加载一次，互不干扰 ---------------- */
function boot() {
  const env = buildSandbox();
  env.frames(1);                     // 消费启动那一帧
  const G = env.sandbox.__fishGame;
  assert.ok(G, 'game.js 未挂载 __fishGame');
  return { env, G, R: env.sandbox.FishRules, counters: env.counters };
}

/* =========================================================
   R1 开局与 HUD
   ========================================================= */
test('[AC1-1] 初始为 IDLE，HUD 三数归零且 3 心全亮', () => {
  const { env, G } = boot();
  assert.equal(G.state, 'IDLE');
  assert.equal(env.els.score.textContent, '0');
  assert.equal(env.els.size.textContent, '16');
  assert.equal(env.els.best.textContent, '0');
  assert.equal(env.hearts.filter((h) => h.classList.contains('off')).length, 0);
});

test('[AC1-2] 开始后 12 条预置鱼全部在视口内', () => {
  const { env, G } = boot();
  G.start('IDLE');
  assert.equal(G.state, 'PLAYING');
  assert.equal(G.game.fish.length, 12);
  for (const f of G.game.fish) {
    assert.ok(f.x > 0 && f.x < 1440, `鱼 x=${f.x} 落在视口外`);
    assert.ok(f.y > 0 && f.y < 900, `鱼 y=${f.y} 落在视口外`);
  }
});

test('[AC1-4 / I4] 单帧内鱼数补满至 22 并稳定', () => {
  const { env, G, R } = boot();
  G.start('IDLE');
  env.frames(1);
  assert.equal(G.game.fish.length, 22);
  for (let i = 0; i < 60; i++) {
    env.step();
    assert.equal(G.game.fish.length, R.CFG.fishCount, `第 ${i} 帧鱼数漂移`);
  }
});

/* =========================================================
   R4 碰撞三分支
   ========================================================= */
function only(env, G, F) {
  G.game.fish.length = 0;
  G.game.fish.push({
    x: G.game.player.x, y: G.game.player.y, vx: 0, vy: 0, r: F,
    color: '#5fd9b4', wob: 0, seed: 1, striped: false, stallCd: 0, bucket: 'test'
  });
}

test('[AC4-1] 吃 F=15：得分 +24，体型 17.8', () => {
  const { env, G } = boot();
  G.start('IDLE');
  only(env, G, 15);
  env.step();
  assert.equal(G.game.score, 24);
  assert.ok(Math.abs(G.game.player.r - 17.8) < 1e-6);
  assert.equal(env.els.score.textContent, '24');
});

test('[AC4-2] 撞 F=17：掉 1 命并进入无敌，得分不变', () => {
  const { env, G, R } = boot();
  G.start('IDLE');
  only(env, G, 17);
  env.step();
  assert.equal(G.game.lives, 2);
  assert.ok(G.game.invuln > 0);
  assert.equal(G.game.score, 0);
  assert.equal(G.game.lives <= R.CFG.lives, true);
  assert.equal(env.hearts[2].classList.contains('off'), true, '第三颗心应变暗');
});

test('[AC4-3] 撞 F=16（同类）：僵持，不计分不掉命', () => {
  const { env, G } = boot();
  G.start('IDLE');
  only(env, G, 16);
  env.step();
  assert.equal(G.game.lives, 3);
  assert.equal(G.game.score, 0);
  assert.equal(G.game.invuln, 0, '僵持不得进入无敌');
});

test('[AC4-7 / B4-3] 无敌期内连撞 3 次只掉 1 命', () => {
  const { env, G } = boot();
  G.start('IDLE');
  only(env, G, 40);
  env.step();
  assert.equal(G.game.lives, 2);
  for (let i = 0; i < 3; i++) {
    only(env, G, 40);      // 无敌期内反复贴合
    env.step();
  }
  assert.equal(G.game.lives, 2, '无敌期被击穿');
});

/* =========================================================
   R5 终局
   ========================================================= */
test('[AC5-1] 生命归零进入 OVER 并弹遮罩', () => {
  const { env, G } = boot();
  G.start('IDLE');
  G.game.lives = 1;
  only(env, G, 40);
  env.step();
  assert.equal(G.state, 'OVER');
  assert.equal(env.els['ov-title'].textContent, '被吃掉了');
  assert.equal(env.els.overlay.classList.contains('hidden'), false);
  assert.equal(G.game.lives, 0, '不得出现负生命');
});

test('[AC5-2] 结束后输入无效，生命不再下降', () => {
  const { env, G } = boot();
  G.start('IDLE');
  G.game.lives = 1;
  only(env, G, 40);
  env.step();
  const score = G.game.score;
  const x = G.game.player.x;
  for (let i = 0; i < 20; i++) {
    env.handlers.window.keydown({ key: 'ArrowUp', preventDefault() {} });
    env.step();
  }
  assert.equal(G.state, 'OVER');
  assert.equal(G.game.lives, 0);
  assert.equal(G.game.score, score);
  assert.equal(G.game.player.x, x, '结束后玩家仍在移动');
});

test('[AC5-3/C1] 最佳分：局中只更内存，终局落盘（走真实吞噬路径）', () => {
  const { env, G } = boot();
  G.start('IDLE');

  // 真实路径：连吃三条小鱼，best 由 collide() 而非测试代码抬高
  for (let i = 0; i < 3; i++) { only(env, G, 8); env.step(); }
  const score = G.game.score;
  assert.ok(score > 0, '应已通过吃鱼得分');
  assert.equal(G.game.best, score, 'I1：内存 best 实时跟随 score');
  assert.equal(env.storage.get('fish-best'), undefined, 'B5-3：局中不得落盘');

  // 撞死 → 终局
  G.game.lives = 1;
  only(env, G, 200);
  env.step(); env.step();
  assert.equal(G.state, 'OVER', '应进入终局');
  assert.ok(G.game.best >= G.game.score, 'I1 终局仍成立');
  assert.equal(env.storage.get('fish-best'), String(score),
    'C1 回归：终局必须把最佳分写进 localStorage（旧实现与内存 best 比较，恒不落盘）');
});

test('[AC5-8] 结束态 3 秒后帧率降至约 15fps', () => {
  const { env, G, counters } = boot();
  G.start('IDLE');
  G.game.lives = 1;
  only(env, G, 40);
  env.step();
  assert.equal(G.state, 'OVER');

  const measure = (seconds) => {
    const before = counters.fillRect;
    const n = Math.round((seconds * 1000) / 16.7);
    for (let i = 0; i < n; i++) env.step();
    return counters.fillRect - before;
  };

  measure(3.2);                       // 先过掉 3 秒窗口
  const perSec = measure(1);          // 计数 1 秒内的绘制次数（每帧 2 次 fillRect）
  const fps = perSec / 2;
  assert.ok(fps < 25, `结束态 1 秒内仍绘制 ${fps.toFixed(0)} 帧，未降频`);
  assert.ok(fps > 8, `降频过度，仅 ${fps.toFixed(0)} 帧`);
});

/* =========================================================
   R6 状态机与 R 键
   ========================================================= */
test('[AC6-1/AC6-2] P 键暂停与恢复幂等', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  assert.equal(G.state, 'PAUSED');
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  assert.equal(G.state, 'PLAYING');
});

test('[AC6-3] 暂停时方向键不移动鱼', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  const x = G.game.player.x;
  const y = G.game.player.y;
  for (let i = 0; i < 30; i++) {
    env.handlers.window.keydown({ key: 'ArrowRight', preventDefault() {} });
    env.step();
  }
  assert.equal(G.game.player.x, x);
  assert.equal(G.game.player.y, y);
});

test('[AC6-4a] PLAYING 态短按 R（150ms）不重开', () => {
  const { env, G } = boot();
  G.start('IDLE');
  G.game.score = 200;
  env.handlers.window.keydown({ key: 'r', preventDefault() {} });
  env.frames(9);                                  // ≈150ms
  env.handlers.window.keyup({ key: 'r' });
  assert.equal(G.state, 'PLAYING');
  assert.equal(G.game.score, 200, '短按导致重开');
});

test('[AC6-4b] PLAYING 态长按 R（1000ms）重开', () => {
  const { env, G } = boot();
  G.start('IDLE');
  G.game.score = 200;
  G.game.player.r = 40;
  env.handlers.window.keydown({ key: 'r', preventDefault() {} });
  env.frames(62);                                 // ≈1035ms
  assert.equal(G.state, 'PLAYING');
  // 重开后又开始正常游玩，故不能用 score===0 判定；用埋点与体型复位判定
  const started = env.sandbox.__fishLog().filter((e) => e.event === 'run_start');
  assert.ok(started.length >= 2, '长按未触发重开');
  assert.equal(started[started.length - 1].data.restart, true);
  assert.ok(G.game.score < 200, `分数未清零，仍为 ${G.game.score}`);
  assert.ok(G.game.player.r < 40, '体型未复位');
  assert.equal(G.game.lives, 3);
});

test('[AC6-4c] OVER 态短按 R 立即重开', () => {
  const { env, G } = boot();
  G.start('IDLE');
  G.game.lives = 1;
  only(env, G, 40);
  env.step();
  assert.equal(G.state, 'OVER');
  env.handlers.window.keydown({ key: 'r', preventDefault() {} });
  assert.equal(G.state, 'PLAYING', '结束态短按未重开');
  assert.equal(G.game.lives, 3);
});

test('[AC6-5] 失焦自动暂停并清空按键', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.handlers.window.keydown({ key: 'ArrowUp', preventDefault() {} });
  env.handlers.window.blur();
  assert.equal(G.state, 'PAUSED');
  env.handlers.window.keyup({ key: 'ArrowUp' });
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  const y = G.game.player.y;
  env.frames(10);
  assert.equal(G.game.player.y, y, '粘键导致解除暂停后自行移动');
});

test('[AC6-8] 退出进入 QUIT 态，可回到游戏', () => {
  const { env, G } = boot();
  G.start('IDLE');
  G.quit();
  assert.equal(G.state, 'QUIT');
  assert.equal(env.els['ov-title'].textContent, '已退出');
  env.els['ov-btn'].addEventListener = () => {};   // 桩不触发，直接调 start 验证可恢复
  G.start('QUIT');
  assert.equal(G.state, 'PLAYING');
});

/* =========================================================
   不变量长时间巡检
   ========================================================= */
test('[I1–I7] 连续 900 帧无不变量违规、无异常', () => {
  const { env, G, R } = boot();
  G.start('IDLE');
  for (let i = 0; i < 900; i++) {
    env.step();
    if (i % 60 === 0) {
      env.handlers.window.keydown({ key: 'ArrowRight', preventDefault() {} });
    }
    if (i % 60 === 30) {
      env.handlers.window.keyup({ key: 'ArrowRight' });
    }
    const bad = Array.from(R.checkInvariants({
      score: G.game.score,
      best: G.game.best,
      lives: G.game.lives,
      P: G.game.player.r,
      fishCount: G.game.fish.length,
      stateName: G.state,
      dt: 0.0167
    }));
    assert.equal(bad.length, 0, `第 ${i} 帧不变量违规: ${bad.join(',')}`);
  }
});

test('[B1-2] DPR 上限 2 —— 桩内 DPR=1 时缓冲区等于视口', () => {
  const { env, G } = boot();
  G.start('IDLE');
  const canvas = env.els.game;
  assert.equal(canvas.width, Math.round(1440 * 1));
  assert.equal(canvas.height, Math.round(900 * 1));
});

test('[B1-6/AC1-7] fish-best 脏值不产生 NaN', () => {
  const env = buildSandbox();
  env.storage.set('fish-best', 'abc');
  env.sandbox.localStorage = env.sandbox.localStorage;   // 保持
  // 重新加载 game.js 以走一遍初始化
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/game.js'), 'utf8'), env.sandbox, { filename: 'src/game.js' });
  assert.ok(Number.isFinite(env.sandbox.__fishGame.game.best));
  assert.equal(env.sandbox.__fishGame.game.best, 0);
});

/* =========================================================
   回归测试：针对代码评审 C1 / I1 / I2 / I4 / I8 / E-8 的修复
   每一条在修复前都会失败，防止同类问题再次静默复活
   ========================================================= */

/** 造一条与真实生成同形的鱼（缺字段会算出 NaN，碰撞会静默失效） */
function fishAt(G, x, y, r) {
  return { x, y, vx: 0, vy: 0, r, color: '#5fd9b4', wob: 0, seed: 1, striped: false, stallCd: 0, bucket: 'test' };
}

test('[I1 回归] 终局后抖动必须衰减到 0（否则遮罩背后永久震动）', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(3);
  G.game.lives = 1;
  only(env, G, 200);
  env.step();
  assert.equal(G.state, 'OVER');
  assert.ok(G.game.shake > 0, '死亡瞬间应有抖动');
  env.frames(120);
  assert.ok(G.game.shake < 0.05, `3 秒后 shake 应为 0，实际 ${G.game.shake}`);
});

test('[I2 回归] 无指针输入时击退速度必须衰减', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(3);
  only(env, G, 200);
  env.step();                            // 受伤 → 击退 420
  const v0 = Math.hypot(G.game.player.vx, G.game.player.vy);
  assert.ok(v0 > 100, `应被击退，实际 ${v0}`);
  G.game.fish.length = 0;                // 移走鱼，单独观察阻尼
  env.frames(120);
  const v1 = Math.hypot(G.game.player.vx, G.game.player.vy);
  assert.ok(v1 < 5, `2 秒后应停住，实际 ${v1.toFixed(1)}px/s`);
});

test('[I2 回归] 僵持推力不得逐帧叠加突破 470 上限', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(3);
  const p = G.game.player;
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    G.game.fish.length = 0;
    G.game.fish.push(fishAt(G, p.x + p.r * 0.9, p.y, p.r * 1.02));  // 僵持区
    env.step();
    peak = Math.max(peak, Math.hypot(p.vx, p.vy));
  }
  assert.ok(peak > 0, '僵持应产生推力');
  assert.ok(peak <= 470.5, `僵持 40 帧峰值 ${peak.toFixed(0)}px/s 超过 B2 的 470 上限`);
});

test('[I4 回归] 危险描边必须显式 butt 线帽，否则虚线退化成实线', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(3);
  only(env, G, 60);                      // 大鱼 → 危险态
  env.step();
  const danger = env.ctx.__strokes.filter((s) => s.dash.length === 2 && s.dash[0] === 4);
  assert.ok(danger.length > 0, '应画出危险态虚线');
  for (const s of danger) {
    assert.equal(s.cap, 'butt', `危险虚线继承了 ${s.cap} 线帽（海草泄漏），短划会被撑粗`);
  }
});

test('[AC4-9c 回归] 可吃描边线宽在 r=6 时 ≥2px（渲染层实测）', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(3);
  const p = G.game.player;
  G.game.fish.length = 0;
  G.game.fish.push(fishAt(G, p.x + 220, p.y, 6));   // 远离玩家的小鱼 → 可吃态
  env.step();
  const prey = env.ctx.__strokes.filter((s) => String(s.style).includes('255,255,255'));
  assert.ok(prey.length > 0, '应画出可吃态描边');
  assert.ok(Math.min(...prey.map((s) => s.width)) >= 2,
    `可吃描边最细 ${Math.min(...prey.map((s) => s.width))}px < 2px`);
});

test('[AC1-6 回归] DPR=3 时缓冲区按 2 倍分配', () => {
  const env = buildSandbox({ dpr: 3 });
  env.frames(1);
  const c = env.els.game;
  assert.equal(c.width, Math.round(1440 * 2), `缓冲区宽 ${c.width}，应为视口×2`);
  assert.equal(c.height, Math.round(900 * 2));
});

test('[E-8 回归] 僵持不放音，吞噬放音（音频桩计数）', () => {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(3);
  only(env, G, G.game.player.r);         // 同尺寸 → 僵持
  const before = env.audio.osc;
  env.step();
  assert.equal(env.audio.osc, before, '僵持不应创建振荡器（E-8 无音效）');

  only(env, G, 8);                       // 小鱼 → 吞噬
  env.step();
  assert.ok(env.audio.osc > before, '吞噬应有音效');
});

test('[AC6-7 回归] 静音按钮不得被关在 .controls 内', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const controls = html.slice(html.indexOf('class="controls"'), html.indexOf('</div>', html.indexOf('class="controls"')));
  assert.ok(!controls.includes('id="mute"'),
    '.controls 在非 playing 态 pointer-events:none，静音键放进去就点不到');
  assert.ok(html.includes('class="sound"'), '静音键应位于独立的常驻层');
});
