/* =========================================================
   大鱼吃小鱼 · Fish Eats Fish — 规则层（v1.1）
   纯函数，无副作用、无 DOM、无计时器。
   浏览器：window.FishRules     Node：require('./rules.js')
   对应 PRD：第 5 章 R1–R6、第 6 章决策表、附录 A / B / 4.4
   ========================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FishRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 数值配置（附录 A） ---------------- */
  const CFG = Object.freeze({
    startR: 16,
    maxR: 92,
    minFishR: 6,
    maxFishR: 130,
    fishCount: 22,
    eatBias: 1.06,
    lives: 3,
    playerAccel: 2600,
    playerSpeed: 470,
    invulnTime: 1.8,
    scoreFactor: 1.6,
    growthFactor: 0.12,
    contactFactor: 0.72,
    restartHoldMs: 800,
    startFish: 12,
    startFishRMin: 7,
    startFishRMax: 13,
    dtCap: 0.05,
    overDecayMs: 3000,
    overFps: 15,
    // 僵持推力的冷却时间：规格写「推开 +90」，若每帧都加会叠成一发满速弹射
    stallCooldown: 0.25,
    // B4-7：HUD 不出现科学计数法，落盘值必须有上界
    bestCeiling: 1e9
  });

  /* ---------------- 四档生成分布（R3 + D11） ---------------- */
  const BUCKETS = Object.freeze([
    { name: 'small', p: 0.56, lo: 0.22, hi: 0.60 },
    { name: 'mid', p: 0.28, lo: 0.66, hi: 0.94 },
    { name: 'same', p: 0.06, lo: 1.00, hi: 1.04 },
    { name: 'big', p: 0.10, lo: 1.12, hi: 1.90 }
  ]);

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** 依据 [0,1) 均匀随机数选出档位，不消耗额外随机数 */
  function pickBucket(t) {
    let acc = 0;
    for (const b of BUCKETS) {
      acc += b.p;
      if (t < acc) return b;
    }
    return BUCKETS[BUCKETS.length - 1];
  }

  /**
   * 生成一条鱼的半径（R3 规则 2）
   * @param {number} P 玩家半径
   * @param {() => number} rnd 返回 [0,1) 的随机函数
   * @returns {{r:number, bucket:string}}
   */
  function spawnFishRadius(P, rnd) {
    const bucket = pickBucket(rnd());
    const u = rnd();
    const raw = P * (bucket.lo + (bucket.hi - bucket.lo) * u);
    return { r: clamp(raw, CFG.minFishR, CFG.maxFishR), bucket: bucket.name };
  }

  /* ---------------- 三态判定（R4 + 6.1） ---------------- */
  /**
   * 判定接触结果。ε 唯一来源是 CFG.eatBias —— 视觉编码与判定必须共用它（B4-6）。
   * @param {number} P 玩家半径
   * @param {number} F 鱼半径
   * @param {{invulnerable?:boolean}} [opts] 无敌期内一律按僵持处理（B4-3）
   * @returns {'eat'|'hurt'|'stall'}
   */
  function classify(P, F, opts) {
    const invuln = !!(opts && opts.invulnerable);
    if (P >= F * CFG.eatBias) return 'eat';
    if (!invuln && F >= P * CFG.eatBias) return 'hurt';
    return 'stall';
  }

  /** 得分：round(1.6F)，与玩家体型无关（B4-1） */
  const scoreGain = (F) => Math.round(CFG.scoreFactor * F);

  /** 成长：P += 0.12F，封顶 maxR（B4-2） */
  const grow = (P, F) => Math.min(CFG.maxR, P + CFG.growthFactor * F);

  /** 接触阈值 d < P + 0.72F（附录 A 接触系数 / 6.2） */
  const contactDist = (P, F) => P + CFG.contactFactor * F;

  /** 是否接触（严格小于） */
  const isContact = (P, F, d) => d < contactDist(P, F);

  /**
   * 一次接触的完整结果，供游戏层直接消费。
   * @returns {{kind:'eat'|'hurt'|'stall', score:number, nextP:number}}
   */
  function interact(P, F, opts) {
    const kind = classify(P, F, opts);
    if (kind === 'eat') return { kind, score: scoreGain(F), nextP: grow(P, F) };
    return { kind, score: 0, nextP: P };
  }

  /* ---------------- 鱼速（R3 规则 4） ---------------- */
  const fishSpawnSpeed = (r) => Math.max(30, 108 - 0.55 * r);
  const fishMaxSpeed = (r) => Math.max(34, 118 - 0.6 * r);
  const fishMinSpeed = (r) => fishMaxSpeed(r) * 0.45;

  /* ---------------- R 键长按门控（D12 / B6-4 / B6-7） ---------------- */
  /**
   * 800ms 长按门控。计时从 keydown 起算，重复 keydown 不累积，keyup 取消。
   * holdRequired=false（非 PLAYING 态）时按下即触发（AC6-4c）。
   */
  function createRestartGate(holdMs) {
    const need = holdMs === undefined ? CFG.restartHoldMs : holdMs;
    let armedAt = null;
    let fired = false;
    return {
      /** @returns {'fire'|'armed'|null} */
      down(t, holdRequired) {
        if (!holdRequired) { fired = true; return 'fire'; }
        if (armedAt === null) { armedAt = t; fired = false; }
        return 'armed';
      },
      /** 每帧轮询 @returns {'fire'|null} */
      tick(t) {
        if (armedAt === null || fired) return null;
        if (t - armedAt >= need) { fired = true; return 'fire'; }
        return null;
      },
      /** @returns {'cancelled'|null} */
      up() {
        const wasArmed = armedAt !== null && !fired;
        armedAt = null;
        return wasArmed ? 'cancelled' : null;
      },
      reset() { armedAt = null; fired = false; },
      get armed() { return armedAt !== null && !fired; },
      get progress() {
        return armedAt === null ? 0 : clamp((performance_now() - armedAt) / need, 0, 1);
      }
    };
  }
  // 供 gate.progress 使用；Node 下退化为 0，不影响判定
  function performance_now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
  }

  /* ---------------- 本地存储值清洗（B1-6 / E-5） ---------------- */
  /** 非数字 / NaN / 负数 / 非有限 → 0；合法值取整并封顶（B4-7 不得出现科学计数法） */
  function sanitizeBest(raw) {
    if (raw === null || raw === undefined || raw === '') return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), CFG.bestCeiling);
  }

  /** 多标签页合并：取较大值（B1-7 / E-6） */
  const mergeBest = (local, incoming) => Math.max(sanitizeBest(local), sanitizeBest(incoming));

  /* ---------------- 颜色与对比度（4.4 / N10 / AC4-9d） ---------------- */
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  /** 把带 alpha 的前景叠到不透明背景上 */
  function blend(fg, alpha, bg) {
    return [
      fg[0] * alpha + bg[0] * (1 - alpha),
      fg[1] * alpha + bg[1] * (1 - alpha),
      fg[2] * alpha + bg[2] * (1 - alpha)
    ];
  }

  function relativeLuminance(rgb) {
    const ch = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function contrastRatio(rgbA, rgbB) {
    const la = relativeLuminance(rgbA);
    const lb = relativeLuminance(rgbB);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** 三态描边规范（4.4）。stall 必须无描边。
   *  注意 1：4.4 同时要求「外扩 3px / 2px」与「外扩 ≤ 半径的 40%」，
   *  两者在 r=6 时冲突（3px = 50%r）。取后者为硬约束，前者为常规值。
   *  注意 2：实测 #ff5b5b 即便 alpha=1.0，在渐变顶部 #1d5273 上对比度仅 2.72:1，
   *  单靠提高不透明度无法达到 3:1。故按图 3 的目标描述「暗色打底 + 提高不透明度」
   *  增加一层深色衬底（BACKING），使有效对比度发生在描边与衬底之间。 */
  const BACKING = Object.freeze({
    rgb: Object.freeze([4, 18, 27]),
    alpha: 0.55,
    pad: 2
  });

  const STROKE = Object.freeze({
    danger: Object.freeze({
      rgb: Object.freeze([255, 91, 91]),
      alpha: 0.85,
      dash: Object.freeze([4, 3]),
      offset: (r) => Math.min(3, 0.4 * r),
      width: (r) => Math.max(2, 0.05 * r)
    }),
    prey: Object.freeze({
      rgb: Object.freeze([255, 255, 255]),
      alpha: 0.55,
      dash: Object.freeze([]),
      offset: (r) => Math.min(2, 0.4 * r),
      // AC4-9c 要求 r=6 时线宽 ≥2px，与 4.4 表格的 1.5 冲突，取 AC 为硬约束
      width: (r) => Math.max(2, 0.04 * r)
    }),
    stall: null
  });

  /** 描边合成后的实际颜色（用于对比度验收） */
  const strokeColor = (which, bgRgb) => {
    const s = STROKE[which];
    return blend(s.rgb, s.alpha, bgRgb);
  };

  /** 深色衬底叠在背景上的实际颜色 */
  const backingColor = (bgRgb) => blend(BACKING.rgb, BACKING.alpha, bgRgb);

  /** 描边叠在衬底上的最终颜色（WCAG 1.4.11 的比较对象） */
  const strokeColorOnBacking = (which, bgRgb) => blend(STROKE[which].rgb, STROKE[which].alpha, backingColor(bgRgb));

  /** 判定该鱼应使用的视觉状态 */
  function visualState(P, F) {
    const kind = classify(P, F);
    return kind === 'eat' ? 'prey' : kind === 'hurt' ? 'danger' : 'stall';
  }

  /* ---------------- 不变量（0.5 节） ---------------- */
  /**
   * @param {{score:number,best:number,lives:number,P:number,fishCount:number,stateName:string,dt:number}} s
   * @returns {string[]} 违反项 ID 列表，空数组表示全部成立
   */
  function checkInvariants(s) {
    const bad = [];
    if (!(s.best >= s.score)) bad.push('I1');
    if (!(s.lives >= 0 && s.lives <= CFG.lives)) bad.push('I2');
    if (!(s.P >= CFG.startR && s.P <= CFG.maxR)) bad.push('I3');
    if (s.fishCount !== CFG.fishCount) bad.push('I4');
    if (!['IDLE', 'PLAYING', 'PAUSED', 'OVER', 'QUIT'].includes(s.stateName)) bad.push('I5');
    if (!(s.dt <= CFG.dtCap)) bad.push('I7');
    return bad;
  }

  /** 任意 F>0 必落入三态之一（I6），僵持区宽度约为 11.7% */
  const stallZoneWidth = (P) => P * CFG.eatBias - P / CFG.eatBias;

  return {
    CFG,
    BUCKETS,
    clamp,
    pickBucket,
    spawnFishRadius,
    classify,
    scoreGain,
    grow,
    contactDist,
    isContact,
    interact,
    fishSpawnSpeed,
    fishMaxSpeed,
    fishMinSpeed,
    createRestartGate,
    sanitizeBest,
    mergeBest,
    hexToRgb,
    blend,
    relativeLuminance,
    contrastRatio,
    STROKE,
    BACKING,
    strokeColor,
    backingColor,
    strokeColorOnBacking,
    visualState,
    checkInvariants,
    stallZoneWidth
  };
});
