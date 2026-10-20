/* =========================================================
   probe.stress.mjs — 阶段 1 证据采集（不是测试，不改代码）
   目的：在没有明确 bug 报告时，用真实运行时复现高风险路径，
        记录「哪一层断了」，而不是猜测原因。
   运行：node tests/probe.stress.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/* ---------------- 与 runtime.sim.mjs 相同的桩 ---------------- */
function makeClassList() {
  const s = new Set();
  return {
    add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
    toggle: (c, v) => { if (v === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { v ? s.add(c) : s.delete(c); } },
    _set: s
  };
}
function makeEl(id) {
  return { id, textContent: '', innerHTML: '', hidden: false, style: {}, classList: makeClassList(),
    attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {}, removeEventListener() {} };
}
function makeCtx() {
  const grad = { addColorStop() {} };
  const base = {
    canvas: null,
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, clip() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {},
    fill() {}, stroke() {}, fillRect() {}, fillText() {}, setLineDash() {}
  };
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : () => {}; }, set(t, p, v) { t[p] = v; return true; } });
}

function buildSandbox(opts = {}) {
  const rafQueue = [];
  let clock = 0;
  const handlers = { window: {}, document: {}, canvas: {} };
  const storage = new Map(Object.entries(opts.storage || {}));

  const els = {};
  ['score', 'size', 'music', 'overlay', 'ov-kicker', 'ov-title', 'ov-text', 'ov-meta',
    'ov-btn', 'ov-exit', 'mute', 'btn-pause', 'btn-restart', 'btn-quit', 'build']
    .forEach((id) => { els[id] = makeEl(id); });
  const hearts = [makeEl('h1'), makeEl('h2'), makeEl('h3')];

  const canvas = makeEl('game');
  canvas.clientWidth = opts.w || 1440;
  canvas.clientHeight = opts.h || 900;
  canvas.getContext = () => makeCtx();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight });
  canvas.setPointerCapture = () => {};
  canvas.addEventListener = (t, f) => { handlers.canvas[t] = f; };
  canvas.releasePointerCapture = () => {};
  els.game = canvas;

  const body = makeEl('body');
  const document = {
    getElementById: (id) => els[id] || makeEl(id),
    querySelector: (sel) => (sel.includes('meta') ? { content: '1.1.0' } : makeEl(sel)),
    querySelectorAll: (sel) => (sel.includes('heart') ? hearts : []),
    addEventListener: (t, f) => { handlers.document[t] = f; },
    body, hidden: false
  };

  const sandbox = {
    console, Math, Date, JSON, Object, Array, Number, String, Boolean, Set, Map,
    isFinite, isNaN, parseInt, parseFloat, document,
    performance: { now: () => clock },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    Path2D: class { moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} },
    addEventListener: (t, f) => { handlers.window[t] = f; },
    innerWidth: opts.w || 1440, innerHeight: opts.h || 900
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.devicePixelRatio = opts.dpr || 1;

  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  load('src/rules.js');
  load('src/game.js');

  const step = (ms = 16.7) => { clock += ms; const cb = rafQueue.shift(); if (cb) cb(clock); };
  const frames = (n, ms = 16.7) => { for (let i = 0; i < n; i++) step(ms); };

  return { sandbox, handlers, step, frames, storage, hearts, els, canvas, document, body,
    get clock() { return clock; }, setClock: (v) => { clock = v; } };
}

/* ---------------- 探测 ---------------- */
const findings = [];
const note = (id, ok, detail) => { findings.push({ id, ok, detail }); };

function boot(opts) {
  const env = buildSandbox(opts);
  env.frames(1);
  return { env, G: env.sandbox.__fishGame, R: env.sandbox.FishRules };
}

/* P1：长时间随机对局，逐帧巡检不变量 */
function p1_longRun() {
  const { env, G, R } = boot();
  G.start('IDLE');
  const bad = []; let maxFish = 0, minFish = 99, framesRun = 0, deaths = 0, prevLives = 3;
  for (let i = 0; i < 6000 && G.state === 'PLAYING'; i++) {
    if (i % 7 === 0) {
      const p = G.game.player;
      env.handlers.canvas.pointermove && env.handlers.canvas.pointermove({
        clientX: env.canvas.getBoundingClientRect().left + p.x + Math.sin(i) * 120,
        clientY: env.canvas.getBoundingClientRect().top + p.y + Math.cos(i * 1.3) * 90
      });
    }
    env.frames(1); framesRun++;
    const g = G.game;
    maxFish = Math.max(maxFish, g.fish.length);
    minFish = Math.min(minFish, g.fish.length);
    if (g.lives < prevLives) { deaths += prevLives - g.lives; prevLives = g.lives; }
    const v = R.checkInvariants({
      score: g.score, best: g.best, lives: g.lives, P: g.player.r,
      fishCount: g.fish.length, stateName: G.state, dt: 0.0167
    });
    if (v.length) { bad.push(`帧${framesRun}: ${v.join(',')}`); if (bad.length > 6) break; }
  }
  note('P1 长跑不变量', bad.length === 0,
    `跑了 ${framesRun} 帧后状态=${G.state}，鱼数 ${minFish}–${maxFish}，掉命 ${deaths}，违规 ${bad.length} 条 ${bad.slice(0, 3).join(' | ')}`);
}

/* P2：局中改窗口尺寸（320x480），看分数/生命/坐标
   注意：必须先把状态冻住（P 暂停），否则这 3 帧里的自然吃鱼会被误判成状态丢失。 */
function p2_resizeMidGame() {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(60);
  G.game.score = 500; G.game.lives = 2; G.game.player.r = 44;
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  const frozen = G.state === 'PAUSED';
  const before = { score: G.game.score, lives: G.game.lives, r: G.game.player.r };

  env.canvas.clientWidth = 320; env.canvas.clientHeight = 480;
  env.handlers.window.resize && env.handlers.window.resize();
  env.frames(3);

  const p = G.game.player;
  const oob = G.game.fish.filter((f) => f.x < -f.r * 4 || f.x > 320 + f.r * 4 || f.y < -f.r * 4 || f.y > 480 + f.r * 4);
  const kept = frozen && before.score === G.game.score && before.lives === G.game.lives && before.r === G.game.player.r;
  const inside = p.x >= p.r - 1 && p.x <= 320 - p.r + 1 && p.y >= p.r - 1 && p.y <= 480 - p.r + 1;
  note('P2 局中缩窗保状态', kept, `score ${before.score}->${G.game.score}, lives ${before.lives}->${G.game.lives}, r ${before.r}->${G.game.player.r.toFixed(2)}`);
  note('P2b 缩窗后玩家在界内', inside, `p=(${p.x.toFixed(1)},${p.y.toFixed(1)}) r=${p.r.toFixed(1)} 视口 320x480`);
  note('P2c 缩窗后鱼群未全部出界', oob.length < G.game.fish.length, `出界 ${oob.length}/${G.game.fish.length} 条`);
}

/* P3：PAUSED 下按 P 应继续；PAUSED 下按 R 是否也被门控 */
function p3_pauseSemantics() {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(30);
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  const s1 = G.state;
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  const s2 = G.state;
  note('P3 P→PAUSED→P→PLAYING', s1 === 'PAUSED' && s2 === 'PLAYING', `${s1} -> ${s2}`);

  // PAUSED 下按方向键是否污染按键集合
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  env.handlers.window.keydown({ key: 'ArrowRight', preventDefault() {} });
  const pausedKeys = G.input ? [...(G.input.keys || [])] : ['<no accessor>'];
  env.handlers.window.keydown({ key: 'p', preventDefault() {} });
  env.frames(20);
  const stillThere = G.input ? [...G.input.keys].filter((k) => k.startsWith('Arrow')) : [];
  note('P3b 暂停期间方向键不残留', stillThere.length === 0, `暂停中按下的键=${JSON.stringify(pausedKeys)}，恢复后残留=${JSON.stringify(stillThere)}`);
}

/* P4：存档脏值（NaN / 负数 / 极大 / 非数字） */
function p4_dirtyStorage() {
  for (const raw of ['NaN', '-5', 'abc', '1e309', '999999999999999999999', '', '12.7']) {
    const { G, R } = boot({ storage: { 'fish-best': raw } });
    const expect = R.sanitizeBest(raw);
    note(`P4 best 脏值 "${raw}"`, Number.isFinite(G.game.best) && G.game.best === expect && G.game.best >= 0,
      `读入 ${JSON.stringify(G.game.best)}，期望 ${JSON.stringify(expect)}`);
  }
}

/* P5：OVER 后 3 秒降帧 + 重开是否解除降帧 */
function p5_overFrameDrop() {
  const { env, G } = boot();
  G.start('IDLE');
  G.game.lives = 1;
  env.frames(5);
  // 直接触发终局：把一条鱼放大到 2 倍并压到玩家身上
  const big = G.game.fish.reduce((a, b) => (b.r > a.r ? b : a), G.game.fish[0]);
  big.r = G.game.player.r * 2;
  big.x = G.game.player.x; big.y = G.game.player.y; big.vx = 0; big.vy = 0;
  env.frames(2);
  const st = G.state;
  env.setClock(env.clock + 4000);
  env.frames(30);
  const overAt = G.overAt;
  G.start('OVER');
  env.frames(5);
  note('P5 终局→重开解除降帧', st === 'OVER' && G.state === 'PLAYING',
    `碰撞后状态=${st}，overAt=${overAt ? 'set' : 'unset'}，重开后=${G.state}`);
}

/* P6：dt 抖动（后台标签页返回，单帧 3s）是否穿墙 */
function p6_dtSpike() {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(10);
  const p = G.game.player;
  const x0 = p.x;
  env.frames(1, 3000);            // 一帧 3 秒
  const jump = Math.abs(p.x - x0);
  note('P6 3 秒单帧位移受限', jump <= 60, `单帧位移 ${jump.toFixed(1)}px（玩家极速 ${G.R ? '' : ''}470/s，未钳制应为 ~1410px）`);
}

/* P7：320px 宽度下 HUD 是否溢出（用 clientWidth 推断，非视觉） */
function p7_narrow() {
  const { env, G } = boot({ w: 320, h: 480 });
  G.start('IDLE');
  env.frames(5);
  const p = G.game.player;
  note('P7 320x480 开局玩家在界内', p.x >= 0 && p.x <= 320 && p.y >= 0 && p.y <= 480, `p=(${p.x.toFixed(1)},${p.y.toFixed(1)}) r=${p.r}`);
  const oob = G.game.fish.filter((f) => f.x < -f.r * 4 || f.x > 320 + f.r * 4).length;
  note('P7b 320px 下鱼群分布合理', oob < G.game.fish.length, `出界 ${oob}/${G.game.fish.length}`);
}

/* P8：键盘开局/重开走 R（6.3 状态机），不是 Enter/Space */
function p8_keyboardStart() {
  const { env, G } = boot();
  env.handlers.window.keydown({ key: 'r', preventDefault() {} });
  const fromIdle = G.state;
  env.frames(20);
  G.game.score = 300; G.game.lives = 1;
  // 打到 OVER
  const big = G.game.fish.reduce((a, b) => (b.r > a.r ? b : a), G.game.fish[0]);
  big.x = G.game.player.x; big.y = G.game.player.y; big.r = G.game.player.r * 2;
  env.frames(2);
  const overState = G.state;
  env.handlers.window.keydown({ key: 'r', preventDefault() {} });
  const fromOver = G.state;
  note('P8 R 键可从 IDLE 开局', fromIdle === 'PLAYING', `R→${fromIdle}`);
  note('P8b R 键可从 OVER 重开', overState === 'OVER' && fromOver === 'PLAYING', `${overState} --R--> ${fromOver}`);
}

/* P10：同帧多条大鱼重合，生命只能掉 1 */
function p10_sameFrameHits() {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(10);
  const p = G.game.player;
  // 只用「真实存在」的鱼，避免伪造对象缺字段导致坐标为 NaN、碰撞被静默跳过
  const bigs = G.game.fish.slice(0, 3);
  for (const b of bigs) {
    b.r = Math.max(b.r, p.r * 1.6);
    b.x = p.x; b.y = p.y; b.vx = 0; b.vy = 0;
  }
  const lives0 = G.game.lives;
  env.frames(2);
  const dropped = lives0 - G.game.lives;
  const nanCount = G.game.fish.filter((f) => !Number.isFinite(f.x) || !Number.isFinite(f.y)).length;
  note('P10 同帧多鱼只扣 1 命', (dropped === 1 || (dropped === 0 && G.state !== 'PLAYING')) && nanCount === 0,
    `life ${lives0}→${G.game.lives}（掉 ${dropped}），状态=${G.state}，重合 ${bigs.length} 条，NaN 坐标 ${nanCount} 条`);
}

/* P11：无敌期 1.8s 内不得连续扣命；结束瞬间不能连锁掉命 */
function p11_invulnChain() {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(10);
  const p = G.game.player;
  const b = G.game.fish.reduce((a, c) => (c.r > a.r ? c : a), G.game.fish[0]);
  b.r = p.r * 2; b.vx = 0; b.vy = 0; b.x = p.x; b.y = p.y;
  const lives0 = G.game.lives;
  const events = [];
  let prev = lives0;
  for (let i = 0; i < 180; i++) {          // 3 秒 = 1.8s 无敌期 + 1.2s
    b.x = p.x; b.y = p.y;                  // 持续压在玩家身上
    env.frames(1);
    if (G.game.lives !== prev) { events.push({ frame: i, from: prev, to: G.game.lives }); prev = G.game.lives; }
    if (G.state !== 'PLAYING') break;
  }
  const firstHitAt = events.length ? events[0].frame : null;
  const secondHitAt = events.length > 1 ? events[1].frame : null;
  const gapMs = (firstHitAt !== null && secondHitAt !== null) ? (secondHitAt - firstHitAt) * 16.7 : null;
  note('P11 无敌期内不连扣', gapMs === null || gapMs >= 1750,
    `掉落记录 ${JSON.stringify(events)}，两次间隔 ${gapMs === null ? '仅一次/无' : gapMs.toFixed(0) + 'ms'}`);
}

/* P12：体型封顶 92 后仍得分、不再增长 */
function p12_growthCap() {
  const { env, G, R } = boot();
  G.start('IDLE');
  env.frames(5);
  G.game.player.r = CFG_MAX();
  const p = G.game.player;
  const small = G.game.fish.find((f) => f.r < p.r / 1.2);
  const score0 = G.game.score;
  if (small) { small.x = p.x; small.y = p.y; }
  env.frames(2);
  note('P12 封顶后仍可吃鱼得分、体型不涨', !small || (G.game.score > score0 && p.r === CFG_MAX()),
    `score ${score0}→${G.game.score}，r=${p.r}`);
}
function CFG_MAX() { return 92; }

/* P13：最佳分只在 OVER 时落盘（B5-3） */
function p13_bestPersistTiming() {
  const { env, G } = boot();
  G.start('IDLE');
  env.frames(5);
  G.game.score = 777;
  env.frames(30);                       // 局中得分超过历史最佳
  const duringPlay = env.storage.get('fish-best');
  G.game.lives = 1;
  const big = G.game.fish.reduce((a, b) => (b.r > a.r ? b : a), G.game.fish[0]);
  big.r = G.game.player.r * 2; big.x = G.game.player.x; big.y = G.game.player.y;
  env.frames(3);
  const afterOver = env.storage.get('fish-best');
  note('P13 局中不落盘 / 终局落盘', duringPlay !== '777' && Number(afterOver) >= 777,
    `局中存储=${JSON.stringify(duringPlay)}，终局后=${JSON.stringify(afterOver)}，内存 best=${G.game.best}`);
}

/* P9：多标签页 storage 同步（另一标签写入更大 best） */
function p9_storageSync() {
  const { env, G } = boot({ storage: { 'fish-best': '100' } });
  G.start('IDLE');
  G.game.score = 10;
  env.storage.set('fish-best', '9000');
  env.handlers.window.storage && env.handlers.window.storage({ key: 'fish-best', newValue: '9000' });
  note('P9 跨标签 best 取大', G.game.best >= 9000, `best=${G.game.best}（另一标签写入 9000）`);
}

for (const fn of [p1_longRun, p2_resizeMidGame, p3_pauseSemantics, p4_dirtyStorage, p5_overFrameDrop, p6_dtSpike, p7_narrow, p8_keyboardStart, p9_storageSync, p10_sameFrameHits, p11_invulnChain, p12_growthCap, p13_bestPersistTiming]) {
  try { fn(); } catch (e) { findings.push({ id: fn.name, ok: false, detail: '抛异常: ' + e.message }); }
}

const pass = findings.filter((f) => f.ok).length;
console.log('\n==== 阶段 1 证据采集 ====');
for (const f of findings) console.log(`${f.ok ? 'PASS' : 'FAIL'}  ${f.id}\n      ${f.detail}`);
console.log(`\n合计 ${findings.length} 项，通过 ${pass}，异常 ${findings.length - pass}`);
