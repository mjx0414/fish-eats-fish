/* =========================================================
   大鱼吃小鱼 · game.js（v1.1）
   纯 Canvas 2D，无第三方依赖。规则判定全部走 FishRules。
   对应 PRD v1.1：R1–R6、附录 E（E-1 ~ E-10）
   ========================================================= */
(() => {
  'use strict';

  const R = window.FishRules;
  if (!R) { console.error('[fish] 缺少 rules.js'); return; }
  const CFG = R.CFG;

  /* ---------------- 引用 ---------------- */
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  let DPR = Math.min(window.devicePixelRatio || 1, 2); // B1-2：上限 2，resize 时重算

  const ui = {
    score: document.getElementById('score'),
    size: document.getElementById('size'),
    best: document.getElementById('best'),
    lives: Array.from(document.querySelectorAll('#lives .heart')),
    overlay: document.getElementById('overlay'),
    kicker: document.getElementById('ov-kicker'),
    title: document.getElementById('ov-title'),
    text: document.getElementById('ov-text'),
    meta: document.getElementById('ov-meta'),
    btn: document.getElementById('ov-btn'),
    exit: document.getElementById('ov-exit'),
    mute: document.getElementById('mute'),
    pause: document.getElementById('btn-pause'),
    restart: document.getElementById('btn-restart'),
    quit: document.getElementById('btn-quit'),
    build: document.getElementById('build')
  };

  /* ---------------- 版本号（E-9） ---------------- */
  const VERSION = (document.querySelector('meta[name="version"]') || {}).content || '1.0.0';
  if (ui.build) ui.build.textContent = 'v' + VERSION;

  /* ---------------- 安全存储（B1-6 / AC5-5） ---------------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); return true; } catch (e) { return false; } }
  };

  /* ---------------- 声音 ---------------- */
  let audioCtx = null;
  let muted = store.get('fish-muted') === '1';

  function blip(freq, dur, type = 'sine', vol = 0.06) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        const r = audioCtx.resume();
        if (r && typeof r.catch === 'function') r.catch(() => {});   // N8：静默降级
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.6, audioCtx.currentTime + dur);
      gain.gain.setValueAtTime(vol, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    } catch (e) { /* N8：声音失败静默降级 */ }
  }

  /* ---------------- 状态机（R6 / 6.3） ---------------- */
  const S = Object.freeze({ IDLE: 'IDLE', PLAYING: 'PLAYING', PAUSED: 'PAUSED', OVER: 'OVER', QUIT: 'QUIT' });
  let state = S.IDLE;

  const game = {
    score: 0,
    best: R.sanitizeBest(store.get('fish-best')),
    lives: CFG.lives,
    invuln: 0,
    shake: 0,
    time: 0,
    fish: [],
    bubbles: [],
    particles: [],
    player: { x: 0, y: 0, vx: 0, vy: 0, r: CFG.startR, angle: 0, seed: 1.3 }
  };

  const input = { px: 0, py: 0, active: false, keys: new Set(), hasPointer: false };
  const restartGate = R.createRestartGate(CFG.restartHoldMs);
  let overAt = 0;
  let lastRender = 0;

  /* ---------------- 尺寸与场景 ---------------- */
  const FISH_COLORS = ['#5fd9b4', '#ffc24b', '#7fb2ff', '#c9a7ff', '#ff9f7a', '#8ee6c8', '#ffd166', '#94a9ff'];
  const rand = (a, b) => a + Math.random() * (b - a);
  const hypot = (a, b) => Math.sqrt(a * a + b * b);   // 热点循环用 sqrt 代替 Math.hypot
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  let W = 0, H = 0;
  let seabedPath = null, seaweeds = [], plankton = [], vignette = null, bgGrad = null;

  function shade(hex, amt) {
    if (hex[0] !== '#') return hex;
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (amt >= 0) {
      r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt;
    } else {
      r *= 1 + amt; g *= 1 + amt; b *= 1 + amt;
    }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  function resize() {
    // 浏览器缩放（Ctrl+/-）会改变 devicePixelRatio 并触发 resize，
    // 若沿用加载时的值，缓冲区会按旧 DPR 分配，整屏变糊
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const p = game.player;
    p.x = R.clamp(Number.isFinite(p.x) ? p.x : W / 2, p.r, W - p.r);
    p.y = R.clamp(Number.isFinite(p.y) ? p.y : H / 2, p.r, H - p.r);

    buildScenery();
    initBubbles();
  }

  function buildScenery() {
    const baseY = H * 0.87;
    const path = new Path2D();
    path.moveTo(0, H);
    path.lineTo(0, baseY);
    const steps = 9;
    for (let i = 0; i < steps; i++) {
      const x0 = (W / steps) * i;
      const x1 = (W / steps) * (i + 1);
      const peak = baseY + Math.sin(i * 1.9) * 20 - 10;
      path.quadraticCurveTo((x0 + x1) / 2, peak, x1, baseY + Math.sin(i * 2.4) * 9);
    }
    path.lineTo(W, H);
    path.closePath();
    seabedPath = path;

    seaweeds = [];
    const n = Math.max(6, Math.round(W / 190));
    for (let i = 0; i < n; i++) {
      seaweeds.push({
        x: (W / n) * i + rand(-26, 26),
        y: baseY + rand(-10, 6),
        h: rand(56, 150), w: rand(4, 9),
        ph: rand(0, Math.PI * 2), sp: rand(0.5, 1.0),
        tint: Math.random() < 0.35 ? 'rgba(120,120,180,0.22)' : 'rgba(36,120,108,0.30)'
      });
    }

    plankton = [];
    const count = Math.round((W * H) / 26000);
    for (let i = 0; i < count; i++) {
      plankton.push({
        x: rand(0, W), y: rand(0, H),
        r: rand(0.6, 1.7), sp: rand(4, 15),
        ph: rand(0, Math.PI * 2), a: rand(0.12, 0.45)
      });
    }

    // RK-04：底色渐变只与 H 有关，缓存一次，别每帧重建
    bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#1d5273');
    bgGrad.addColorStop(0.42, '#0f3348');
    bgGrad.addColorStop(1, '#05131d');

    vignette = ctx.createRadialGradient(
      W / 2, H * 0.42, Math.min(W, H) * 0.28,
      W / 2, H * 0.5, Math.max(W, H) * 0.8
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
  }

  function initBubbles() {
    game.bubbles = [];
    const n = Math.round((W * H) / 90000);
    for (let i = 0; i < n; i++) {
      game.bubbles.push({
        x: rand(0, W), y: rand(0, H),
        r: rand(1.2, 4), sp: rand(12, 34), ph: rand(0, Math.PI * 2)
      });
    }
  }

  /* ---------------- 鱼群（R3） ---------------- */
  function spawnFish(forceR) {
    const p = game.player;
    let r, bucket = null;

    if (forceR) {
      r = forceR;                       // 开局预置鱼：固定在视口内
    } else {
      const res = R.spawnFishRadius(p.r, Math.random);
      r = res.r; bucket = res.bucket;
    }

    const speed = R.fishSpawnSpeed(r);
    // 七成从左右游入，保证画面以水平游动为主
    const side = Math.random() < 0.7 ? (Math.random() < 0.5 ? 0 : 1) : (Math.random() < 0.5 ? 2 : 3);
    let x, y, vx, vy;

    if (side === 0) {
      x = -r * 3; y = rand(0, H);
      vx = speed; vy = rand(-0.35, 0.35) * speed;
    } else if (side === 1) {
      x = W + r * 3; y = rand(0, H);
      vx = -speed; vy = rand(-0.35, 0.35) * speed;
    } else if (side === 2) {
      x = rand(0, W); y = -r * 3;
      vx = (Math.random() < 0.5 ? 1 : -1) * speed * 0.85;
      vy = speed * 0.55;
    } else {
      x = rand(0, W); y = H + r * 3;
      vx = (Math.random() < 0.5 ? 1 : -1) * speed * 0.85;
      vy = -speed * 0.55;
    }

    game.fish.push({
      x, y, vx, vy, r,
      color: pick(FISH_COLORS),
      wob: rand(0, Math.PI * 2),
      seed: rand(0, 10),
      striped: Math.random() < 0.45,
      stallCd: 0,
      bucket
    });
  }

  function burst(x, y, color, count, power) {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(0.25, 1) * power;
      game.particles.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        r: rand(1.5, 4.5),
        life: 0, max: rand(0.35, 0.8),
        color
      });
    }
  }

  /* ---------------- 流程 ---------------- */
  function reset() {
    game.score = 0;
    game.lives = CFG.lives;
    game.invuln = 0;
    game.shake = 0;
    game.time = 0;
    game.fish = [];
    game.particles = [];
    input.keys.clear();
    restartGate.reset();

    const p = game.player;
    p.x = W / 2; p.y = H / 2; p.vx = 0; p.vy = 0; p.r = CFG.startR;

    // B1-5：12 条预置鱼必须落在视口内
    for (let i = 0; i < CFG.startFish; i++) {
      spawnFish(rand(CFG.startFishRMin, CFG.startFishRMax));
      const f = game.fish[game.fish.length - 1];
      f.x = rand(f.r * 2, W - f.r * 2);
      f.y = rand(f.r * 2, H - f.r * 2);
    }
    updateHud();
  }

  function start(from) {
    resize();
    reset();
    state = S.PLAYING;
    hideOverlay();
    document.body.classList.add('playing');
    document.body.classList.remove('paused');
    input.active = input.hasPointer;
    log('run_start', { from: from || S.IDLE, restart: from === S.PLAYING });
  }

  function pause(trigger) {
    if (state !== S.PLAYING) return;
    state = S.PAUSED;
    document.body.classList.remove('playing');
    document.body.classList.add('paused');   // 暂停态仍保留 ↻/✕，6.3 的「PAUSED | R / ↻」才可达
    input.keys.clear();
    showOverlay({
      kicker: 'PAUSED',
      title: '暂停中',
      html: '进度保留着，随时可以继续。',
      meta: `当前分数 <b>${game.score}</b>`,
      primary: '继续',
      secondary: '退出'
    });
    log('pause', { trigger });
  }

  function resume() {
    if (state !== S.PAUSED) return;
    state = S.PLAYING;
    hideOverlay();
    document.body.classList.add('playing');
    document.body.classList.remove('paused');
    input.active = input.hasPointer;
  }

  function gameOver() {
    state = S.OVER;
    overAt = performance.now();
    document.body.classList.remove('playing');
    document.body.classList.remove('paused');

    // B5-3：仅此处落盘。
    // 注意比较对象必须是「已落盘的旧值」：game.best 在局中已被 I1 实时抬到 score，
    // 与它比较恒为假，会导致最佳分永远写不进去（AC5-3 必然失败）。
    if (game.score > game.best) game.best = game.score;
    const persisted = R.sanitizeBest(store.get('fish-best'));
    if (game.best > persisted) store.set('fish-best', game.best);
    updateHud();

    showOverlay({
      kicker: 'GAME OVER',
      title: '被吃掉了',
      html: `你长到了 <b>${Math.round(game.player.r)}</b>，最后一条大鱼比你更大。<br />再来一局，这次先长个头。`,
      meta: `本局 <b>${game.score}</b> &nbsp;·&nbsp; 最佳 ${game.best}`,
      primary: '再来一局',
      secondary: '退出'
    });
    blip(180, 0.35, 'triangle', 0.08);
    log('run_end', { score: game.score, lives: 0 });
  }

  function quit() {
    state = S.QUIT;
    document.body.classList.remove('playing');
    document.body.classList.remove('paused');
    showOverlay({
      kicker: 'BYE',
      title: '已退出',
      html: '游戏已停止，进度不会保留。<br />想玩的时候随时回来。',
      meta: '',
      primary: '回到游戏',
      secondary: ''
    });
    log('quit', { score: game.score });
    try { window.close(); } catch (e) { /* 多数浏览器不允许脚本关闭页面 */ }
  }

  /* ---------------- 埋点（第 8 章，仅内存 + console） ---------------- */
  const telemetry = [];
  function log(event, data) {
    telemetry.push({ t: Date.now(), event, data });
    if (telemetry.length > 500) telemetry.shift();
  }
  window.__fishLog = () => telemetry.slice();

  /* ---------------- 更新 ---------------- */
  function update(dt) {
    game.time += dt;
    game.invuln = Math.max(0, game.invuln - dt);

    updatePlayer(dt);
    updateFish(dt);
    collide();
    if (state !== S.PLAYING) return;   // 本帧已进入 OVER，停止生成与推进
    clampPlayerSpeed();                // 碰撞在限速之后写速度，必须再收一次（B2）
    updateParticles(dt);
    updateBubbles(dt);

    while (game.fish.length < CFG.fishCount) spawnFish();
    updateHud();
  }

  /** B2-3：任何输入方式不得突破 470，碰撞写速度后要再收一次 */
  function clampPlayerSpeed() {
    const p = game.player;
    const sp = hypot(p.vx, p.vy);
    if (sp > CFG.playerSpeed) {
      p.vx = (p.vx / sp) * CFG.playerSpeed;
      p.vy = (p.vy / sp) * CFG.playerSpeed;
    }
  }

  function updatePlayer(dt) {
    const p = game.player;

    if (input.active) {
      const dx = input.px - p.x;
      const dy = input.py - p.y;
      const d = hypot(dx, dy);
      if (d > 3) {
        const target = Math.min(CFG.playerSpeed, d * 8);
        const k = Math.min(1, dt * 9);
        p.vx += ((dx / d) * target - p.vx) * k;
        p.vy += ((dy / d) * target - p.vy) * k;
      } else {
        p.vx *= 0.82;
        p.vy *= 0.82;
      }
    } else {
      // 无指针输入（R 键开局、从未在画布上移动过指针）：击退与僵持带来的速度
      // 必须有阻尼，否则一次受伤就以 420px/s 一路漂到边界（B2-3 手感）
      const damp = Math.pow(0.02, dt);
      p.vx *= damp;
      p.vy *= damp;
    }

    let kx = 0, ky = 0;
    const k = input.keys;
    if (k.has('arrowleft') || k.has('a')) kx -= 1;
    if (k.has('arrowright') || k.has('d')) kx += 1;
    if (k.has('arrowup') || k.has('w')) ky -= 1;
    if (k.has('arrowdown') || k.has('s')) ky += 1;
    if (kx || ky) {
      const len = hypot(kx, ky) || 1;   // B2-2：对角线归一化
      p.vx += (kx / len) * CFG.playerAccel * dt;
      p.vy += (ky / len) * CFG.playerAccel * dt;
      // D5：键盘改写虚拟指针，避免被鼠标拽回
      input.active = true;
      input.px = p.x + p.vx * 0.2;
      input.py = p.y + p.vy * 0.2;
    }

    clampPlayerSpeed();

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // B2-4：触边钳制并软反弹
    if (p.x < p.r) { p.x = p.r; p.vx = Math.abs(p.vx) * 0.4; }
    if (p.x > W - p.r) { p.x = W - p.r; p.vx = -Math.abs(p.vx) * 0.4; }
    if (p.y < p.r) { p.y = p.r; p.vy = Math.abs(p.vy) * 0.4; }
    if (p.y > H - p.r) { p.y = H - p.r; p.vy = -Math.abs(p.vy) * 0.4; }

    if (hypot(p.vx, p.vy) > 8) p.angle = Math.atan2(p.vy, p.vx);
  }

  function updateFish(dt) {
    const p = game.player;

    for (const f of game.fish) {
      if (f.stallCd > 0) f.stallCd = Math.max(0, f.stallCd - dt);
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      const d = hypot(dx, dy) || 1;
      // R3 规则 5：能吃的鱼会怕你
      if (p.r > f.r * 1.05 && d < 210) {
        const flee = (1 - d / 210) * 150;
        f.vx += (dx / d) * flee * dt * 2.4;
        f.vy += (dy / d) * flee * dt * 2.4;
      }

      f.wob += dt * 1.7;
      f.vx += Math.cos(f.wob) * 6 * dt;
      f.vy += Math.sin(f.wob * 0.8) * 6 * dt;

      const maxSp = R.fishMaxSpeed(f.r);
      const sp = hypot(f.vx, f.vy);
      if (sp > maxSp) {
        f.vx = (f.vx / sp) * maxSp;
        f.vy = (f.vy / sp) * maxSp;
      } else if (sp < maxSp * 0.45) {
        const s = sp || 1;
        f.vx = (f.vx / s) * maxSp * 0.5;
        f.vy = (f.vy / s) * maxSp * 0.5;
      }

      f.x += f.vx * dt;
      f.y += f.vy * dt;

      const m = f.r * 2.2;
      if (f.x < -m) { f.x = -m; f.vx = Math.abs(f.vx); }
      if (f.x > W + m) { f.x = W + m; f.vx = -Math.abs(f.vx); }
      if (f.y < -m) { f.y = -m; f.vy = Math.abs(f.vy); }
      if (f.y > H + m) { f.y = H + m; f.vy = -Math.abs(f.vy); }
    }
  }

  function collide() {
    const p = game.player;

    for (let i = game.fish.length - 1; i >= 0; i--) {
      const f = game.fish[i];
      const d = hypot(f.x - p.x, f.y - p.y);
      if (!R.isContact(p.r, f.r, d)) continue;

      // B4-3：无敌期内一律按僵持处理
      const res = R.interact(p.r, f.r, { invulnerable: game.invuln > 0 });

      if (res.kind === 'eat') {
        const before = game.score;
        game.score = before + res.score;
        p.r = res.nextP;
        burst(f.x, f.y, f.color, 14, 190);
        game.shake = Math.min(6, 2 + f.r * 0.06);
        blip(420 + Math.min(600, f.r * 8), 0.09, 'sine', 0.05);
        game.fish.splice(i, 1);
        spawnFish();
        // I1：内存中的 best 必须实时 ≥ score；落盘仍只在 OVER 做（B5-3）
        if (game.score > game.best) game.best = game.score;
        log('eat', { fishR: f.r, playerR: p.r, score: game.score, gain: res.score });
      } else if (res.kind === 'hurt') {
        game.lives -= 1;
        game.invuln = CFG.invulnTime;
        game.shake = 18;
        burst(p.x, p.y, '#ff5b5b', 22, 240);
        blip(140, 0.3, 'sawtooth', 0.07);

        const nx = (p.x - f.x) / (d || 1);
        const ny = (p.y - f.y) / (d || 1);
        p.vx = nx * 420;
        p.vy = ny * 420;

        log('hurt', { fishR: f.r, playerR: p.r, lives: game.lives });

        if (game.lives <= 0) { gameOver(); return; }  // B5-1：立即返回，不再处理后续鱼
      } else {
        // 僵持：双方弹开，不计分、不掉命、不无敌、无音效（E-8）
        // 推力必须带冷却：规格写「玩家推开 +90」，逐帧叠加会变成一发满速弹射，
        // 实测 40 帧叠到 560px/s，直接突破 B2 的 470 上限
        if (!(f.stallCd > 0)) {
          const nx = (p.x - f.x) / (d || 1);
          const ny = (p.y - f.y) / (d || 1);
          p.vx += nx * 90;
          p.vy += ny * 90;
          f.vx -= nx * 120;
          f.vy -= ny * 120;
          f.stallCd = CFG.stallCooldown;
        }
        log('stall', { ratio: f.r / p.r });
      }
    }
  }

  function updateParticles(dt) {
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const q = game.particles[i];
      q.life += dt;
      if (q.life >= q.max) { game.particles.splice(i, 1); continue; }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vx *= Math.pow(0.15, dt);
      q.vy *= Math.pow(0.15, dt);
    }
  }

  function updateBubbles(dt) {
    for (const b of game.bubbles) {
      b.y -= b.sp * dt;
      b.ph += dt * 2;
      if (b.y < -10) { b.y = H + 10; b.x = rand(0, W); }
    }
  }

  /* ---------------- 绘制：背景 ---------------- */
  function drawBackground() {
    if (!bgGrad) return;
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const x = (W / 5) * i + Math.sin(game.time * 0.22 + i * 1.3) * 52 + W * 0.05;
      const gg = ctx.createLinearGradient(x, 0, x + 140, H * 0.95);
      gg.addColorStop(0, 'rgba(150,220,248,0.13)');
      gg.addColorStop(0.45, 'rgba(150,220,248,0.05)');
      gg.addColorStop(1, 'rgba(150,220,248,0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.moveTo(x - 62, 0);
      ctx.lineTo(x + 62, 0);
      ctx.lineTo(x + 240, H);
      ctx.lineTo(x + 30, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    if (seabedPath) {
      ctx.fillStyle = '#04121b';
      ctx.fill(seabedPath);
    }

    drawSeaweeds();
    drawPlankton();
  }

  function drawSeaweeds() {
    ctx.save();                       // 隔离 lineCap：否则 round 会漏进鱼的描边
    ctx.lineCap = 'round';
    for (const s of seaweeds) {
      const sway = Math.sin(game.time * s.sp + s.ph) * 26;
      const topX = s.x + sway;
      const topY = s.y - s.h;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(s.x + sway * 0.35, s.y - s.h * 0.5, topX, topY);
      ctx.strokeStyle = s.tint;
      ctx.lineWidth = s.w;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(s.x + sway * 0.3, s.y - s.h * 0.62);
      ctx.quadraticCurveTo(topX - sway * 0.2, s.y - s.h * 0.82, topX, topY);
      ctx.lineWidth = Math.max(1.2, s.w * 0.45);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlankton() {
    ctx.save();
    for (const q of plankton) {
      const y = (q.y - game.time * q.sp) % H;
      const yy = y < 0 ? y + H : y;
      ctx.globalAlpha = q.a * (0.6 + 0.4 * Math.sin(game.time + q.ph));
      ctx.fillStyle = '#bfe8f7';
      ctx.beginPath();
      ctx.arc(q.x + Math.sin(game.time * 0.5 + q.ph) * 6, yy, q.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBubbles() {
    ctx.save();
    ctx.strokeStyle = 'rgba(180,225,245,0.22)';
    ctx.lineWidth = 1;
    for (const b of game.bubbles) {
      ctx.beginPath();
      ctx.arc(b.x + Math.sin(b.ph) * 4, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 绘制：三态描边（4.4 / E-1 / E-7） ---------------- */
  function drawThreatRing(r, which) {
    const s = R.STROKE[which];
    if (!s) return;                          // 僵持态：什么都不画

    const off = s.offset(r);
    const rx = r + off;
    const ry = r * 0.64 + off;

    ctx.save();
    // 必须显式声明 butt：round 线帽会把 4px 短划撑成 6px、3px 间隙压成 1px，
    // r=6 时虚线占空比接近 86%，灰度下读不出「虚线 vs 实线」（AC4-9b）
    ctx.lineCap = 'butt';

    // 深色衬底：保证在任何背景与鱼身上都有稳定对比
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(${R.BACKING.rgb.join(',')},${R.BACKING.alpha})`;
    ctx.lineWidth = s.width(r) + R.BACKING.pad;
    ctx.stroke();

    // 主描边：危险虚线 / 可吃实线
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.setLineDash(s.dash.length ? s.dash : []);
    ctx.strokeStyle = `rgba(${s.rgb.join(',')},${s.alpha})`;
    ctx.lineWidth = s.width(r);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* ---------------- 绘制：鱼 ---------------- */
  function drawFish(f, isPlayer) {
    const p = game.player;
    const r = f.r;

    ctx.save();
    ctx.translate(f.x, f.y);

    const ang = isPlayer ? f.angle : Math.atan2(f.vy, f.vx);
    ctx.rotate(ang);
    if (Math.cos(ang) < 0) ctx.scale(1, -1);

    const t = isPlayer ? game.time : f.wob;
    const wag = Math.sin(t * 8.5) * 0.3;
    const squash = 1 + Math.sin(t * 8.5) * 0.03;
    ctx.scale(squash, 2 - squash);

    const base = isPlayer ? '#ff6fae' : f.color;

    // 尾巴
    ctx.beginPath();
    ctx.moveTo(-r * 0.72, 0);
    ctx.lineTo(-r * 1.62, -r * 0.62 + wag * r * 0.45);
    ctx.quadraticCurveTo(-r * 1.14, 0, -r * 1.62, r * 0.62 + wag * r * 0.45);
    ctx.closePath();
    ctx.fillStyle = isPlayer ? '#ff4d8d' : shade(base, -0.28);
    ctx.fill();

    // 背鳍
    ctx.beginPath();
    ctx.moveTo(-r * 0.34, -r * 0.5);
    ctx.quadraticCurveTo(-r * 0.02, -r * 1.14, r * 0.36, -r * 0.48);
    ctx.closePath();
    ctx.fillStyle = shade(base, -0.16);
    ctx.fill();

    // 腹鳍
    ctx.beginPath();
    ctx.moveTo(-r * 0.12, r * 0.52);
    ctx.quadraticCurveTo(-r * 0.28, r * 1.02, r * 0.2, r * 0.6);
    ctx.closePath();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = shade(base, -0.1);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 身体
    const grad = ctx.createLinearGradient(0, -r * 0.7, 0, r * 0.7);
    grad.addColorStop(0, shade(base, -0.3));
    grad.addColorStop(0.45, base);
    grad.addColorStop(1, shade(base, 0.45));
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.64, 0, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // 高光
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.64, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(-r * 0.12, -r * 0.3, r * 0.55, r * 0.16, -0.22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fill();
    ctx.restore();

    // 条纹
    if (f.striped) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.64, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = '#08161f';
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.ellipse(i * r * 0.42, 0, r * 0.085, r * 0.75, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 胸鳍
    const fin = Math.sin(t * 12) * 0.35;
    ctx.save();
    ctx.translate(r * 0.14, r * 0.3);
    ctx.rotate(0.5 + fin * 0.45);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.3, r * 0.115, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(base, -0.05);
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.restore();

    // 眼睛
    const blink = Math.sin(t * 0.9 + f.seed) > 0.985;
    const ex = r * 0.46, ey = -r * 0.13;
    const er = Math.max(1.8, r * 0.15);
    if (blink) {
      ctx.beginPath();
      ctx.moveTo(ex - er, ey);
      ctx.lineTo(ex + er, ey);
      ctx.strokeStyle = '#0d1e29';
      ctx.lineWidth = Math.max(1.2, r * 0.05);
      ctx.lineCap = 'round';
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + er * 0.3, ey, er * 0.52, 0, Math.PI * 2);
      ctx.fillStyle = '#10222c';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex - er * 0.2, ey - er * 0.32, er * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
    }

    // 三态威胁编码（B4-6：与判定式共用同一个可吃阈值）
    if (!isPlayer) drawThreatRing(r, R.visualState(p.r, r));

    ctx.restore();
  }

  function drawPlayer() {
    const p = game.player;
    if (game.invuln > 0 && Math.floor(game.invuln * 12) % 2 === 0) return;

    ctx.save();
    ctx.shadowColor = 'rgba(255,77,141,0.55)';
    ctx.shadowBlur = 26;
    drawFish(p, true);
    ctx.restore();
  }

  function drawParticles() {
    for (const q of game.particles) {
      const t = 1 - q.life / q.max;
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = q.color;
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.r * t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPointer() {
    if (!input.hasPointer || state !== S.PLAYING) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(input.px, input.py, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(input.px, input.py, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.restore();
  }

  function render() {
    ctx.save();

    if (game.shake > 0.4) {
      ctx.translate(rand(-game.shake, game.shake) * 0.5, rand(-game.shake, game.shake) * 0.5);
    }

    drawBackground();
    drawBubbles();

    const sorted = game.fish.slice().sort((a, b) => b.r - a.r);
    for (const f of sorted) drawFish(f, false);

    if (state === S.PLAYING || state === S.PAUSED || state === S.OVER) drawPlayer();

    drawParticles();
    drawPointer();

    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();
  }

  /* ---------------- HUD / 遮罩 ---------------- */
  const hudCache = { score: -1, size: -1, best: -1, lives: -1 };

  function updateHud() {
    if (hudCache.score !== game.score) { ui.score.textContent = String(game.score); hudCache.score = game.score; }
    const size = Math.round(game.player.r);
    if (hudCache.size !== size) { ui.size.textContent = String(size); hudCache.size = size; }
    if (hudCache.best !== game.best) { ui.best.textContent = String(game.best); hudCache.best = game.best; }
    if (hudCache.lives !== game.lives) {
      ui.lives.forEach((el, i) => el.classList.toggle('off', i >= game.lives));
      hudCache.lives = game.lives;
    }
  }

  function showOverlay({ kicker, title, html, meta, primary, secondary }) {
    ui.kicker.textContent = kicker;
    ui.title.textContent = title;
    ui.text.innerHTML = html;
    ui.meta.innerHTML = meta || '';
    ui.btn.textContent = primary;
    if (secondary) {
      ui.exit.hidden = false;
      ui.exit.textContent = secondary;
    } else {
      ui.exit.hidden = true;
    }
    ui.overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    ui.overlay.classList.add('hidden');
  }

  /* ---------------- 输入 ---------------- */
  function setPointer(e) {
    const rect = canvas.getBoundingClientRect();
    input.px = e.clientX - rect.left;
    input.py = e.clientY - rect.top;
    input.hasPointer = true;
    input.active = true;
  }

  // 右键/长按菜单会在 pointerdown 之后弹出，指针被留在菜单位置
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // 捕获丢失（系统手势、元素替换）后停止跟随，避免游向陈旧坐标
  canvas.addEventListener('pointercancel', () => { input.active = false; });

  canvas.addEventListener('pointermove', setPointer, { passive: true });
  canvas.addEventListener('pointerdown', (e) => {
    setPointer(e);
    canvas.setPointerCapture?.(e.pointerId);
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();

    if (k === 'p' || k === 'escape') {
      if (state === S.PLAYING) pause('key');
      else if (state === S.PAUSED) resume();
      return;
    }

    if (k === 'r') {
      // D12：PLAYING 态需长按 800ms，其余态单击即重开
      const needHold = state === S.PLAYING;
      const act = restartGate.down(performance.now(), needHold);
      if (act === 'fire') start(state);
      return;
    }

    input.keys.add(k);
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    input.keys.delete(k);
    if (k === 'r') restartGate.up();
  });

  // B2-5：失焦清空按键并自动暂停
  window.addEventListener('blur', () => {
    input.keys.clear();
    restartGate.reset();
    if (state === S.PLAYING) pause('blur');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      input.keys.clear();
      restartGate.reset();
      if (state === S.PLAYING) pause('hidden');
    }
  });

  /* ---------------- 多标签页同步（B1-7 / E-6） ---------------- */
  window.addEventListener('storage', (e) => {
    if (e.key !== 'fish-best') return;
    const merged = R.mergeBest(game.best, e.newValue);
    if (merged !== game.best) {
      game.best = merged;
      store.set('fish-best', merged);
      updateHud();
    }
  });

  /* ---------------- 按钮 ---------------- */
  ui.btn.addEventListener('click', () => {
    if (state === S.PAUSED) { resume(); blip(660, 0.08, 'sine', 0.04); }
    else { const from = state; start(from); blip(520, 0.1, 'sine', 0.05); }
  });

  ui.exit.addEventListener('click', quit);
  ui.quit.addEventListener('click', quit);
  ui.restart.addEventListener('click', () => { start(state); blip(520, 0.1, 'sine', 0.05); });

  ui.pause.addEventListener('click', () => {
    if (state === S.PLAYING) pause('button');
    else if (state === S.PAUSED) resume();
  });

  ui.mute.addEventListener('click', () => {
    muted = !muted;
    store.set('fish-muted', muted ? '1' : '0');
    renderMute();
    log('mute_toggle', { muted });
  });

  function renderMute() {
    ui.mute.classList.toggle('off', muted);
    ui.mute.textContent = muted ? '🔇' : '🔊';
    ui.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  /* ---------------- 主循环 ---------------- */
  let last = performance.now();

  function frame(now) {
    const dt = Math.min(CFG.dtCap, (now - last) / 1000);  // I7：dt 上限
    last = now;

    // 抖动衰减与状态无关：否则死亡瞬间的 shake=18 会永久冻结，
    // 遮罩背后的整个 canvas 会一直每帧平移（AC5-7「保留最后一帧」/ B6-1）
    const decayed = game.shake * Math.pow(0.001, dt);
    game.shake = decayed < 0.05 ? 0 : decayed;

    if (state === S.PLAYING) {
      if (restartGate.tick(now) === 'fire') { start(state); requestAnimationFrame(frame); return; }
      update(dt);
    } else if (state === S.PAUSED) {
      game.time += dt;        // B6-1：暂停时场景仍在动，但玩法不推进
      updateBubbles(dt);
    } else if (state === S.OVER) {
      updateParticles(dt);    // AC5-7：粒子自然消失，鱼群静止
    }

    // AC5-8 / N12：结束态 3 秒后降至 15fps，省电
    if (state === S.OVER && now - overAt > CFG.overDecayMs) {
      if (now - lastRender < 1000 / CFG.overFps) {
        requestAnimationFrame(frame);
        return;
      }
    }

    render();
    lastRender = now;

    requestAnimationFrame(frame);
  }

  /* ---------------- 启动 ---------------- */
  window.addEventListener('resize', resize);

  resize();
  updateHud();
  renderMute();

  showOverlay({
    kicker: 'FISH EATS FISH',
    title: '大鱼吃小鱼',
    html: '移动鼠标(或手指)控制鱼。<br />吃掉<b>比你小</b>的鱼会长大，碰到<b>比你大</b>的鱼会掉命。',
    meta: game.best > 0 ? `历史最佳 <b>${game.best}</b>` : '',
    primary: '开始游戏',
    secondary: '退出'
  });

  requestAnimationFrame(frame);

  // 调试接口：控制台可读状态与埋点
  window.__fishGame = {
    game, CFG, S,
    get state() { return state; },
    start, pause, resume, quit,
    rules: R
  };
})();
