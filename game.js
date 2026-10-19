/* =========================================================
   大鱼吃小鱼 · Fish Eats Fish
   纯 Canvas 2D,无任何依赖。
   ========================================================= */
(() => {
  'use strict';

  /* ---------------- 引用 ---------------- */
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

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
  };

  /* ---------------- 配置 ---------------- */
  const CFG = {
    startR: 16,
    maxR: 92,
    fishCount: 22,
    eatBias: 1.06,
    lives: 3,
    playerAccel: 2600,
    playerSpeed: 470,
    invulnTime: 1.8,
  };

  const FISH_COLORS = [
    '#5fd9b4', '#ffc24b', '#7fb2ff', '#c9a7ff',
    '#ff9f7a', '#8ee6c8', '#ffd166', '#94a9ff',
  ];

  /* ---------------- 工具 ---------------- */
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // 把十六进制颜色调亮(amt > 0)或调暗(amt < 0)
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

  /* ---------------- 尺寸与场景 ---------------- */
  let W = 0, H = 0;
  let seabedPath = null;
  let seaweeds = [];
  let plankton = [];
  let vignette = null;

  function resize() {
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const p = game.player;
    p.x = clamp(p.x || W / 2, p.r, W - p.r);
    p.y = clamp(p.y || H / 2, p.r, H - p.r);

    buildScenery();
    initBubbles();
  }

  function buildScenery() {
    // 海床轮廓
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

    // 海草
    seaweeds = [];
    const n = Math.max(6, Math.round(W / 190));
    for (let i = 0; i < n; i++) {
      seaweeds.push({
        x: (W / n) * i + rand(-26, 26),
        y: baseY + rand(-10, 6),
        h: rand(56, 150),
        w: rand(4, 9),
        ph: rand(0, Math.PI * 2),
        sp: rand(0.5, 1.0),
        tint: Math.random() < 0.35 ? 'rgba(120,120,180,0.22)' : 'rgba(36,120,108,0.30)',
      });
    }

    // 浮游微粒
    plankton = [];
    const count = Math.round((W * H) / 26000);
    for (let i = 0; i < count; i++) {
      plankton.push({
        x: rand(0, W), y: rand(0, H),
        r: rand(0.6, 1.7), sp: rand(4, 15),
        ph: rand(0, Math.PI * 2), a: rand(0.12, 0.45),
      });
    }

    // 暗角
    vignette = ctx.createRadialGradient(
      W / 2, H * 0.42, Math.min(W, H) * 0.28,
      W / 2, H * 0.5, Math.max(W, H) * 0.8
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
  }

  /* ---------------- 声音 ---------------- */
  let audioCtx = null;
  let muted = localStorage.getItem('fish-muted') === '1';

  function blip(freq, dur, type = 'sine', vol = 0.06) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
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
    } catch (e) { /* 声音不是核心功能,失败就静默 */ }
  }

  /* ---------------- 状态 ---------------- */
  const game = {
    running: false,
    over: false,
    paused: false,
    score: 0,
    best: Number(localStorage.getItem('fish-best') || 0),
    lives: CFG.lives,
    invuln: 0,
    shake: 0,
    time: 0,
    fish: [],
    bubbles: [],
    particles: [],
    player: { x: 0, y: 0, vx: 0, vy: 0, r: CFG.startR, angle: 0, seed: 1.3 },
  };

  const input = { px: 0, py: 0, active: false, keys: new Set(), hasPointer: false };

  /* ---------------- 实体 ---------------- */
  function initBubbles() {
    game.bubbles = [];
    const n = Math.round((W * H) / 90000);
    for (let i = 0; i < n; i++) {
      game.bubbles.push({
        x: rand(0, W), y: rand(0, H),
        r: rand(1.2, 4), sp: rand(12, 34), ph: rand(0, Math.PI * 2),
      });
    }
  }

  function spawnFish(forceR) {
    const p = game.player;
    let r;

    if (forceR) {
      r = forceR;
    } else {
      const t = Math.random();
      if (t < 0.58) r = p.r * rand(0.22, 0.6);
      else if (t < 0.86) r = p.r * rand(0.66, 0.94);
      else r = p.r * rand(1.12, 1.9);
      r = clamp(r, 6, 130);
    }

    const speed = Math.max(30, 108 - r * 0.55);
    // 七成从左右游进来,保证画面里以水平游动为主
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
      dir: Math.sign(vx) || 1,
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
        color,
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
    game.over = false;
    game.paused = false;
    game.fish = [];
    game.particles = [];

    const p = game.player;
    p.x = W / 2; p.y = H / 2; p.vx = 0; p.vy = 0; p.r = CFG.startR;

    for (let i = 0; i < 12; i++) {
      spawnFish(rand(7, 13));
      const f = game.fish[game.fish.length - 1];
      f.x = rand(0, W); f.y = rand(0, H);
    }
    updateHud();
  }

  function start() {
    resize();
    reset();
    game.running = true;
    hideOverlay();
    document.body.classList.add('playing');
    input.active = input.hasPointer;
  }

  function gameOver() {
    game.running = false;
    game.over = true;
    document.body.classList.remove('playing');

    if (game.score > game.best) {
      game.best = game.score;
      try { localStorage.setItem('fish-best', String(game.best)); } catch (e) {}
    }
    updateHud();

    showOverlay({
      kicker: 'GAME OVER',
      title: '被吃掉了',
      html: `你长到了 <b>${Math.round(game.player.r)}</b>,最后一条大鱼比你更大。<br />再来一局,这次先长个头。`,
      meta: `本局 <b>${game.score}</b> &nbsp;·&nbsp; 最佳 ${game.best}`,
      primary: '再来一局',
      secondary: '退出',
    });
    blip(180, 0.35, 'triangle', 0.08);
  }

  function pause() {
    if (!game.running) return;
    game.running = false;
    game.paused = true;
    document.body.classList.remove('playing');
    showOverlay({
      kicker: 'PAUSED',
      title: '暂停中',
      html: '进度保留着,随时可以继续。',
      meta: `当前分数 <b>${game.score}</b>`,
      primary: '继续',
      secondary: '退出',
    });
  }

  function resume() {
    game.paused = false;
    game.running = true;
    hideOverlay();
    document.body.classList.add('playing');
    input.active = input.hasPointer;
  }

  function quit() {
    game.running = false;
    game.paused = false;
    game.over = false;
    document.body.classList.remove('playing');
    showOverlay({
      kicker: 'BYE',
      title: '已退出',
      html: '游戏已停止,进度不会保留。<br />想玩的时候随时回来。',
      meta: '',
      primary: '回到游戏',
      secondary: '',
    });
    try { window.close(); } catch (e) { /* 多数浏览器不允许脚本关闭页面 */ }
  }

  /* ---------------- 更新 ---------------- */
  function update(dt) {
    game.time += dt;
    game.invuln = Math.max(0, game.invuln - dt);
    game.shake *= Math.pow(0.001, dt);

    updatePlayer(dt);
    updateFish(dt);
    collide();
    updateParticles(dt);
    updateBubbles(dt);

    while (game.fish.length < CFG.fishCount) spawnFish();
    updateHud();
  }

  function updatePlayer(dt) {
    const p = game.player;

    if (input.active) {
      const dx = input.px - p.x;
      const dy = input.py - p.y;
      const d = Math.hypot(dx, dy);
      if (d > 3) {
        const target = Math.min(CFG.playerSpeed, d * 8);
        const k = Math.min(1, dt * 9);
        p.vx += ((dx / d) * target - p.vx) * k;
        p.vy += ((dy / d) * target - p.vy) * k;
      } else {
        p.vx *= 0.82;
        p.vy *= 0.82;
      }
    }

    let kx = 0, ky = 0;
    const k = input.keys;
    if (k.has('arrowleft') || k.has('a')) kx -= 1;
    if (k.has('arrowright') || k.has('d')) kx += 1;
    if (k.has('arrowup') || k.has('w')) ky -= 1;
    if (k.has('arrowdown') || k.has('s')) ky += 1;
    if (kx || ky) {
      const len = Math.hypot(kx, ky) || 1;
      p.vx += (kx / len) * CFG.playerAccel * dt;
      p.vy += (ky / len) * CFG.playerAccel * dt;
      input.active = true;
      input.px = p.x + p.vx * 0.2;
      input.py = p.y + p.vy * 0.2;
    }

    const sp = Math.hypot(p.vx, p.vy);
    if (sp > CFG.playerSpeed) {
      p.vx = (p.vx / sp) * CFG.playerSpeed;
      p.vy = (p.vy / sp) * CFG.playerSpeed;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (p.x < p.r) { p.x = p.r; p.vx = Math.abs(p.vx) * 0.4; }
    if (p.x > W - p.r) { p.x = W - p.r; p.vx = -Math.abs(p.vx) * 0.4; }
    if (p.y < p.r) { p.y = p.r; p.vy = Math.abs(p.vy) * 0.4; }
    if (p.y > H - p.r) { p.y = H - p.r; p.vy = -Math.abs(p.vy) * 0.4; }

    if (Math.hypot(p.vx, p.vy) > 8) p.angle = Math.atan2(p.vy, p.vx);
  }

  function updateFish(dt) {
    const p = game.player;

    for (const f of game.fish) {
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      if (p.r > f.r * 1.05 && d < 210) {
        const flee = (1 - d / 210) * 150;
        f.vx += (dx / d) * flee * dt * 2.4;
        f.vy += (dy / d) * flee * dt * 2.4;
      }

      f.wob += dt * 1.7;
      f.vx += Math.cos(f.wob) * 6 * dt;
      f.vy += Math.sin(f.wob * 0.8) * 6 * dt;

      const maxSp = Math.max(34, 118 - f.r * 0.6);
      const sp = Math.hypot(f.vx, f.vy);
      if (sp > maxSp) {
        f.vx = (f.vx / sp) * maxSp;
        f.vy = (f.vy / sp) * maxSp;
      }
      if (sp < maxSp * 0.45) {
        const s = Math.hypot(f.vx, f.vy) || 1;
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
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      if (d > p.r + f.r * 0.72) continue;

      if (p.r >= f.r * CFG.eatBias) {
        game.score += Math.round(f.r * 1.6);
        p.r = Math.min(CFG.maxR, p.r + f.r * 0.12);
        burst(f.x, f.y, f.color, 14, 190);
        game.shake = Math.min(6, 2 + f.r * 0.06);
        blip(420 + Math.min(600, f.r * 8), 0.09, 'sine', 0.05);
        game.fish.splice(i, 1);
        spawnFish();
      } else if (f.r >= p.r * CFG.eatBias && game.invuln <= 0) {
        game.lives -= 1;
        game.invuln = CFG.invulnTime;
        game.shake = 18;
        burst(p.x, p.y, '#ff5b5b', 22, 240);
        blip(140, 0.3, 'sawtooth', 0.07);

        const nx = (p.x - f.x) / (d || 1);
        const ny = (p.y - f.y) / (d || 1);
        p.vx = nx * 420;
        p.vy = ny * 420;

        if (game.lives <= 0) gameOver();
      } else if (d > 0) {
        const nx = (p.x - f.x) / d;
        const ny = (p.y - f.y) / d;
        p.vx += nx * 90;
        p.vy += ny * 90;
        f.vx -= nx * 120;
        f.vy -= ny * 120;
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

  /* ---------------- 绘制:背景 ---------------- */
  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1d5273');
    g.addColorStop(0.42, '#0f3348');
    g.addColorStop(1, '#05131d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 光柱
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

    // 海床
    if (seabedPath) {
      ctx.fillStyle = '#04121b';
      ctx.fill(seabedPath);
    }

    drawSeaweeds();
    drawPlankton();
  }

  function drawSeaweeds() {
    for (const s of seaweeds) {
      const sway = Math.sin(game.time * s.sp + s.ph) * 26;
      const topX = s.x + sway;
      const topY = s.y - s.h;
      // 根部粗、梢部细:两段描边模拟锥度
      ctx.lineCap = 'round';
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

  /* ---------------- 绘制:鱼 ---------------- */
  function drawFish(f, isPlayer) {
    const p = game.player;
    const r = f.r;
    const danger = !isPlayer && r >= p.r * CFG.eatBias;
    const prey = !isPlayer && p.r >= r * CFG.eatBias;

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

    // 尾巴(分叉)
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

    // 身体(背深腹浅)
    const grad = ctx.createLinearGradient(0, -r * 0.7, 0, r * 0.7);
    grad.addColorStop(0, shade(base, -0.3));
    grad.addColorStop(0.45, base);
    grad.addColorStop(1, shade(base, 0.45));
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.64, 0, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // 高光,让身体有体积感
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

    // 胸鳍(摆动)
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

    // 眼睛(会眨)
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

    // 危险 / 可吃 的暗示
    if (danger) {
      ctx.beginPath();
      ctx.ellipse(0, 0, r + 3, r * 0.64 + 3, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,91,91,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (prey) {
      ctx.beginPath();
      ctx.ellipse(0, 0, r + 2, r * 0.64 + 2, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

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
    if (!input.hasPointer || !game.running) return;
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

    if (game.running || game.over) drawPlayer();

    drawParticles();
    drawPointer();

    // 暗角
    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();
  }

  /* ---------------- HUD / 遮罩 ---------------- */
  function updateHud() {
    ui.score.textContent = String(game.score);
    ui.size.textContent = String(Math.round(game.player.r));
    ui.best.textContent = String(game.best);
    ui.lives.forEach((el, i) => el.classList.toggle('off', i >= game.lives));
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

  canvas.addEventListener('pointermove', setPointer, { passive: true });
  canvas.addEventListener('pointerdown', (e) => {
    setPointer(e);
    canvas.setPointerCapture?.(e.pointerId);
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();

    if (k === 'p' || k === 'escape') {
      if (game.running) pause();
      else if (game.paused) resume();
      return;
    }
    if (k === 'r') {
      start();
      return;
    }
    input.keys.add(k);
  });

  window.addEventListener('keyup', (e) => input.keys.delete(e.key.toLowerCase()));

  window.addEventListener('blur', () => {
    input.keys.clear();
    if (game.running) pause();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.running) pause();
  });

  /* ---------------- 按钮 ---------------- */
  ui.btn.addEventListener('click', () => {
    if (game.paused) { resume(); blip(660, 0.08, 'sine', 0.04); }
    else { start(); blip(520, 0.1, 'sine', 0.05); }
  });

  ui.exit.addEventListener('click', quit);
  ui.quit.addEventListener('click', quit);
  ui.restart.addEventListener('click', () => { start(); blip(520, 0.1, 'sine', 0.05); });

  ui.pause.addEventListener('click', () => {
    if (game.running) pause();
    else if (game.paused) resume();
  });

  ui.mute.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('fish-muted', muted ? '1' : '0');
    ui.mute.classList.toggle('off', muted);
    ui.mute.textContent = muted ? '🔇' : '🔊';
  });

  /* ---------------- 主循环 ---------------- */
  let last = performance.now();

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (game.running && !game.paused) update(dt);
    render();

    requestAnimationFrame(frame);
  }

  /* ---------------- 启动 ---------------- */
  window.addEventListener('resize', resize);

  resize();
  updateHud();
  ui.mute.classList.toggle('off', muted);
  ui.mute.textContent = muted ? '🔇' : '🔊';

  showOverlay({
    kicker: 'FISH EATS FISH',
    title: '大鱼吃小鱼',
    html: '移动鼠标(或手指)控制鱼。<br />吃掉<b>比你小</b>的鱼会长大,碰到<b>比你大</b>的鱼会掉命。',
    meta: game.best > 0 ? `历史最佳 <b>${game.best}</b>` : '',
    primary: '开始游戏',
    secondary: '退出',
  });

  requestAnimationFrame(frame);

  // 便于调试:控制台可以读状态
  window.__fishGame = { game, start, quit, CFG };
})();
