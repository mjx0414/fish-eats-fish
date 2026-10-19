/* =========================================================
   大鱼吃小鱼 · Fish Eats Fish
   纯 Canvas 2D,无任何依赖。
   玩法:吃掉比你小的鱼,躲开比你大的鱼。
   ========================================================= */
(() => {
  'use strict';

  /* ---------------- 基础引用 ---------------- */
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
    mute: document.getElementById('mute'),
  };

  /* ---------------- 配置 ---------------- */
  const CFG = {
    startR: 16,          // 初始半径
    maxR: 92,            // 体型上限
    fishCount: 22,       // 场上鱼数量
    eatBias: 1.06,       // 大 6% 才能吃
    lives: 3,
    playerAccel: 2600,
    playerSpeed: 470,
    invulnTime: 1.8,
  };

  const FISH_COLORS = [
    '#5fd9b4', '#ffc24b', '#7fb2ff', '#c9a7ff',
    '#ff9f7a', '#8ee6c8', '#ffd166', '#94a9ff',
  ];

  /* ---------------- 尺寸 ---------------- */
  let W = 0, H = 0;
  function resize() {
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const p = game.player;
    p.x = clamp(p.x || W / 2, p.r, W - p.r);
    p.y = clamp(p.y || H / 2, p.r, H - p.r);
    initBubbles();
  }

  /* ---------------- 工具 ---------------- */
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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
    } catch (e) { /* 静默失败:声音不是核心功能 */ }
  }

  /* ---------------- 游戏状态 ---------------- */
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
    player: { x: 0, y: 0, vx: 0, vy: 0, r: CFG.startR, angle: 0 },
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
      if (t < 0.58) r = p.r * rand(0.22, 0.6);        // 食物
      else if (t < 0.86) r = p.r * rand(0.66, 0.94);  // 差不多大
      else r = p.r * rand(1.12, 1.9);                 // 威胁
      r = clamp(r, 6, 130);
    }

    const speed = Math.max(30, 108 - r * 0.55);
    // 七成从左右游进来,保证画面里以水平游动为主;剩下的斜着入场
    const side = Math.random() < 0.7 ? (Math.random() < 0.5 ? 0 : 1) : (Math.random() < 0.5 ? 2 : 3);
    let x, y, vx, vy;

    if (side === 0) {            // 左
      x = -r * 3; y = rand(0, H);
      vx = speed; vy = rand(-0.35, 0.35) * speed;
    } else if (side === 1) {     // 右
      x = W + r * 3; y = rand(0, H);
      vx = -speed; vy = rand(-0.35, 0.35) * speed;
    } else if (side === 2) {     // 上,斜着入场
      x = rand(0, W); y = -r * 3;
      vx = (Math.random() < 0.5 ? 1 : -1) * speed * 0.85;
      vy = speed * 0.55;
    } else {                     // 下,斜着入场
      x = rand(0, W); y = H + r * 3;
      vx = (Math.random() < 0.5 ? 1 : -1) * speed * 0.85;
      vy = -speed * 0.55;
    }

    game.fish.push({
      x, y, vx, vy, r,
      color: pick(FISH_COLORS),
      wob: rand(0, Math.PI * 2),
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

    // 开局先放一批小鱼,保证有东西可吃
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
    input.active = input.hasPointer;
  }

  function gameOver() {
    game.running = false;
    game.over = true;

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
      btn: '再来一局',
    });
    blip(180, 0.35, 'triangle', 0.08);
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

    // 保持场上鱼的数量
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

    // 键盘
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

    // 限速
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
      // 小鱼见到大鱼会逃
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      if (p.r > f.r * 1.05 && d < 210) {
        const flee = (1 - d / 210) * 150;
        f.vx += (dx / d) * flee * dt * 2.4;
        f.vy += (dy / d) * flee * dt * 2.4;
      }

      // 轻微摆动,让游动不呆板
      f.wob += dt * 1.7;
      f.vx += Math.cos(f.wob) * 6 * dt;
      f.vy += Math.sin(f.wob * 0.8) * 6 * dt;

      // 限速
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

      // 软边界
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
        // 吃掉
        game.score += Math.round(f.r * 1.6);
        p.r = Math.min(CFG.maxR, p.r + f.r * 0.12);
        burst(f.x, f.y, f.color, 14, 190);
        game.shake = Math.min(6, 2 + f.r * 0.06);
        blip(420 + Math.min(600, f.r * 8), 0.09, 'sine', 0.05);
        game.fish.splice(i, 1);
        spawnFish();
      } else if (f.r >= p.r * CFG.eatBias && game.invuln <= 0) {
        // 被撞
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
        // 体型接近,互相推开
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

  /* ---------------- 绘制 ---------------- */
  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#17435f');
    g.addColorStop(0.55, '#0e2c40');
    g.addColorStop(1, '#081a27');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 光柱
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const x = (W / 4) * i + Math.sin(game.time * 0.25 + i) * 40;
      const grad = ctx.createLinearGradient(x, 0, x + 90, H);
      grad.addColorStop(0, 'rgba(120,200,235,0.10)');
      grad.addColorStop(1, 'rgba(120,200,235,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x - 70, 0);
      ctx.lineTo(x + 70, 0);
      ctx.lineTo(x + 190, H);
      ctx.lineTo(x + 20, H);
      ctx.closePath();
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

  function drawFish(f, isPlayer) {
    const p = game.player;
    const danger = !isPlayer && f.r >= p.r * CFG.eatBias;
    const prey = !isPlayer && p.r >= f.r * CFG.eatBias;

    ctx.save();
    ctx.translate(f.x, f.y);
    let ang = Math.atan2(f.vy, f.vx);
    if (isPlayer) ang = f.angle;
    ctx.rotate(ang);
    if (Math.cos(ang) < 0) ctx.scale(1, -1);

    const r = f.r;
    const body = isPlayer ? '#ff6fae' : f.color;
    const tail = isPlayer ? '#ff4d8d' : 'rgba(0,0,0,0.22)';

    // 尾巴
    const wag = Math.sin((isPlayer ? game.time : f.wob) * 9) * 0.22 * r;
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, 0);
    ctx.lineTo(-r * 1.55, -r * 0.6 + wag);
    ctx.lineTo(-r * 1.55, r * 0.6 + wag);
    ctx.closePath();
    ctx.fillStyle = isPlayer ? '#ff4d8d' : body;
    ctx.globalAlpha = isPlayer ? 1 : 0.85;
    ctx.fill();

    // 身体
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.66, 0, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();

    // 背鳍
    ctx.beginPath();
    ctx.moveTo(-r * 0.15, -r * 0.6);
    ctx.quadraticCurveTo(0, -r * 1.05, r * 0.35, -r * 0.55);
    ctx.closePath();
    ctx.fillStyle = isPlayer ? '#ff4d8d' : body;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;

    // 眼睛
    ctx.beginPath();
    ctx.arc(r * 0.46, -r * 0.16, Math.max(2, r * 0.16), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(r * 0.5, -r * 0.16, Math.max(1, r * 0.075), 0, Math.PI * 2);
    ctx.fillStyle = '#10222c';
    ctx.fill();

    // 危险提示:比玩家大的鱼描红边
    if (danger) {
      ctx.beginPath();
      ctx.ellipse(0, 0, r + 3, r * 0.66 + 3, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,91,91,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 可吃的鱼:淡淡的描边,暗示可以下嘴
    if (prey) {
      ctx.beginPath();
      ctx.ellipse(0, 0, r + 2, r * 0.66 + 2, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawPlayer() {
    const p = game.player;

    // 无敌时闪烁
    if (game.invuln > 0 && Math.floor(game.invuln * 12) % 2 === 0) return;

    ctx.save();
    ctx.shadowColor = 'rgba(255,77,141,0.55)';
    ctx.shadowBlur = 24;
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
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
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

    // 小的画在前面,让层次清楚
    const sorted = game.fish.slice().sort((a, b) => b.r - a.r);
    for (const f of sorted) drawFish(f, false);

    if (game.running || game.over) drawPlayer();

    drawParticles();
    drawPointer();

    ctx.restore();
  }

  /* ---------------- HUD / 遮罩 ---------------- */
  function updateHud() {
    ui.score.textContent = String(game.score);
    ui.size.textContent = String(Math.round(game.player.r));
    ui.best.textContent = String(game.best);
    ui.lives.forEach((el, i) => el.classList.toggle('off', i >= game.lives));
  }

  function showOverlay({ kicker, title, html, meta, btn }) {
    ui.kicker.textContent = kicker;
    ui.title.textContent = title;
    ui.text.innerHTML = html;
    ui.meta.innerHTML = meta || '';
    ui.btn.textContent = btn;
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
      return;
    }
    if (k === 'r' && game.over) {
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

  function pause() {
    game.paused = true;
    game.running = false;
    showOverlay({
      kicker: 'PAUSED',
      title: '暂停中',
      html: '进度保留着,随时可以继续。',
      meta: `当前分数 <b>${game.score}</b>`,
      btn: '继续',
    });
  }

  /* ---------------- 按钮 ---------------- */
  ui.btn.addEventListener('click', () => {
    if (game.paused) {
      game.paused = false;
      game.running = true;
      hideOverlay();
      blip(660, 0.08, 'sine', 0.04);
    } else {
      start();
      blip(520, 0.1, 'sine', 0.05);
    }
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
    btn: '开始',
  });

  requestAnimationFrame(frame);

  // 便于调试与控制台观察(不影响游戏)
  window.__fishGame = { game, start, CFG };
})();
