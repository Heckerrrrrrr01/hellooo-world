/* =========================================================
   ui.js — All DOM rendering, dice animation, tokens, confetti.
   No game-logic decisions live here; UI requests actions from main.js.
   ========================================================= */
(function () {
  'use strict';

  const B = window.LudoBoard;

  // ------------- screens ---------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById('screen-' + id);
    if (el) el.classList.add('active');
  }

  function toast(msg, ms = 2200) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ------------- board build -----------
  function buildBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';

    // 1. background cells (15x15 grid)
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const el = document.createElement('div');
        el.className = 'cell';
        el.style.gridColumn = (c + 1);
        el.style.gridRow = (r + 1);
        el.dataset.col = c;
        el.dataset.row = r;
        board.appendChild(el);
      }
    }

    // 2. mark main-path cells
    B.PATH.forEach(([c, r], i) => {
      const cell = cellAt(c, r);
      if (cell) {
        cell.classList.add('path');
        if (B.SAFE_PATH_INDICES.has(i)) cell.classList.add('safe');
      }
    });

    // 3. mark home stretches and start cells
    for (const color of B.COLORS) {
      // start
      const [sc, sr] = B.PATH[B.START_INDEX[color]];
      const sCell = cellAt(sc, sr);
      if (sCell) {
        sCell.classList.add('start', 'start-' + color);
      }
      // home stretch
      for (const [c, r] of B.HOME_STRETCH[color]) {
        const cell = cellAt(c, r);
        if (cell) cell.classList.add('home-' + color);
      }
    }

    // 4. corner bases (overlay 6x6 colored zones)
    for (const color of B.COLORS) {
      const base = document.createElement('div');
      base.className = 'base ' + color;
      // 4 home slots inside the white inner box
      for (let i = 0; i < 4; i++) {
        const slot = document.createElement('div');
        slot.className = 'home-slot';
        base.appendChild(slot);
      }
      board.appendChild(base);
    }

    // 5. center triangles
    const center = document.createElement('div');
    center.className = 'center';
    for (const c of ['red', 'blue', 'green', 'yellow']) {
      const tri = document.createElement('div');
      tri.className = 'tri t-' + c;
      center.appendChild(tri);
    }
    board.appendChild(center);
  }

  function cellAt(c, r) {
    return document.querySelector(`.cell[data-col="${c}"][data-row="${r}"]`);
  }

  // ------------- tokens ---------------
  /**
   * Render all tokens for current state.  We compute slot offsets when multiple
   * tokens share a cell.
   */
  function renderTokens(state, opts = {}) {
    const board = document.getElementById('board');
    const cellPx = parseFloat(getComputedStyle(board).getPropertyValue('--cell')) || 38;

    // cleanup old tokens
    board.querySelectorAll('.token').forEach(el => el.remove());

    // group tokens by cell (state+idx) for stacking offsets
    const groups = new Map();
    for (const color of B.COLORS) {
      state.tokens[color].forEach((tok, i) => {
        const key = `${tok.state}:${tok.idx === undefined ? '' : tok.idx}:${tok.state === 'yard' || tok.state === 'finished' ? color : ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ color, i, tok });
      });
    }

    for (const list of groups.values()) {
      list.forEach((entry, slot) => {
        const { color, i, tok } = entry;
        const isYardOrFinish = tok.state === 'yard' || tok.state === 'finished';
        const stackSlot = isYardOrFinish ? 0 : slot;
        const [cx, cy] = B.tokenCoord(color, tok.state, tok.idx, stackSlot);
        const el = document.createElement('div');
        el.className = `token ${color}`;
        el.dataset.color = color;
        el.dataset.idx = i;
        if (tok.state === 'finished' || tok.state === 'home') el.classList.add('home');
        // center the token at (cx, cy) cell-units
        const size = cellPx * 0.7;
        el.style.left = `${cx * cellPx - size / 2}px`;
        el.style.top  = `${cy * cellPx - size / 2}px`;
        el.textContent = (i + 1).toString();
        board.appendChild(el);
      });
    }
  }

  /**
   * Animate a single token from its current rendered position to its new state.
   * Uses CSS transition; for path moves we hop through intermediate cells.
   */
  async function animateMove(state, color, tokenIdx, prevState, prevIdx, fullPath) {
    const board = document.getElementById('board');
    const cellPx = parseFloat(getComputedStyle(board).getPropertyValue('--cell')) || 38;

    // find DOM token
    let tokenEl = board.querySelector(`.token[data-color="${color}"][data-idx="${tokenIdx}"]`);
    if (!tokenEl) {
      // not present (shouldn't happen) — just rerender
      renderTokens(state);
      return;
    }

    // step through fullPath positions one by one
    const size = cellPx * 0.7;
    for (const step of fullPath) {
      const [cx, cy] = B.tokenCoord(color, step.state, step.idx, 0);
      tokenEl.style.left = `${cx * cellPx - size / 2}px`;
      tokenEl.style.top  = `${cy * cellPx - size / 2}px`;
      tokenEl.classList.add('hopping');
      await sleep(280);
      tokenEl.classList.remove('hopping');
      await sleep(40);
    }
    // final rerender to fix stacking offsets
    renderTokens(state);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Build the list of intermediate steps a token passes through (for hop animation).
   */
  function buildPathSteps(color, fromState, fromIdx, dice) {
    const steps = [];
    let s = { state: fromState, idx: fromIdx };
    if (s.state === 'yard') {
      // single hop to start
      steps.push({ state: 'path', idx: B.START_INDEX[color] });
      return steps;
    }
    // step by 1 each iteration, computing next using advance with dice=1
    for (let k = 0; k < dice; k++) {
      const next = B.advance(color, s, 1);
      if (!next) break;
      steps.push(next);
      s = next;
    }
    return steps;
  }

  // ------------- dice ---------------
  /**
   * Animate dice rolling, finally landing on `value`.
   */
  async function rollDiceAnim(value) {
    const dice = document.getElementById('dice');
    const mbDice = document.getElementById('mb-dice');
    [dice, mbDice].forEach(d => {
      if (!d) return;
      d.classList.add('rolling');
      d.classList.remove('show-1','show-2','show-3','show-4','show-5','show-6');
    });
    // flicker through values during animation
    const flickerMs = 70;
    const total = 700;
    const start = performance.now();
    while (performance.now() - start < total - flickerMs) {
      const v = 1 + Math.floor(Math.random() * 6);
      [dice, mbDice].forEach(d => {
        if (!d) return;
        d.classList.remove('show-1','show-2','show-3','show-4','show-5','show-6');
        d.classList.add('show-' + v);
      });
      await sleep(flickerMs);
    }
    [dice, mbDice].forEach(d => {
      if (!d) return;
      d.classList.remove('rolling');
      d.classList.remove('show-1','show-2','show-3','show-4','show-5','show-6');
      d.classList.add('show-' + value);
    });
  }

  function setDiceFace(value) {
    const v = value || 1;
    [document.getElementById('dice'), document.getElementById('mb-dice')].forEach(d => {
      if (!d) return;
      d.classList.remove('show-1','show-2','show-3','show-4','show-5','show-6');
      d.classList.add('show-' + v);
    });
  }

  function setDiceEnabled(on) {
    [document.getElementById('dice'), document.getElementById('mb-dice')].forEach(d => {
      if (!d) return;
      d.classList.toggle('disabled', !on);
      d.classList.toggle('glow', on);
    });
  }

  function setDiceHint(text) {
    const h = document.getElementById('dice-hint');
    if (h) h.textContent = text;
  }

  // ------------- player panel -----
  function renderPlayers(state, localColor) {
    const panel = document.querySelector('.left-panel');
    panel.querySelectorAll('.player-card').forEach(card => {
      card.style.display = 'none';
      card.classList.remove('active', 'winner', 'eliminated');
    });
    state.players.forEach((p, i) => {
      const card = panel.querySelector(`.player-card[data-color="${p.color}"]`);
      if (!card) return;
      card.style.display = '';
      card.querySelector('.pname').textContent = p.name + (p.color === localColor ? ' (you)' : '') + (p.kind === 'bot' ? ' 🤖' : '');
      const home = state.tokens[p.color].filter(t => t.state === 'finished').length;
      card.querySelector('.phome').textContent = `${home}/4`;
      if (i === state.turn && state.phase !== 'ended') card.classList.add('active');
      if (state.winner === i) card.classList.add('winner');
    });

    const cur = state.players[state.turn];
    if (cur) {
      const tn = document.getElementById('turn-name');
      tn.textContent = cur.name;
      tn.className = 'turn-name ' + cur.color;
      const mb = document.getElementById('mb-turn');
      if (mb) {
        mb.textContent = cur.name + "'s turn";
        mb.style.color = `var(--c-${cur.color})`;
      }
    }
  }

  // ------------- selectable tokens -----
  function setSelectable(state, indices) {
    const cur = state.players[state.turn];
    document.querySelectorAll('.token.selectable').forEach(t => t.classList.remove('selectable'));
    if (!cur) return;
    indices.forEach(i => {
      const el = document.querySelector(`.token[data-color="${cur.color}"][data-idx="${i}"]`);
      if (el) el.classList.add('selectable');
    });
  }

  function clearSelectable() {
    document.querySelectorAll('.token.selectable').forEach(t => t.classList.remove('selectable'));
  }

  // ------------- log ---------------
  function renderLog(state) {
    const box = document.getElementById('game-log');
    if (!box) return;
    const last = state.log.slice(-30);
    box.innerHTML = last.map(entry => formatLog(entry, state)).join('');
    box.scrollTop = box.scrollHeight;
  }

  function formatLog(entry, state) {
    const c = entry.color;
    const cName = (color) => {
      const p = state.players.find(p => p.color === color);
      return p ? p.name : color;
    };
    const tag = c ? `<span class="lc ${c}">${cName(c)}</span>` : '';
    let body = '';
    let highlight = false;
    switch (entry.type) {
      case 'roll': body = `${tag} rolled <b>${entry.value}</b>`; highlight = entry.value === 6; break;
      case 'move': body = `${tag} moved a token`; break;
      case 'capture': body = `${tag} captured ${entry.count} token${entry.count>1?'s':''}!`; highlight = true; break;
      case 'home': body = `${tag} brought a token home 🏠`; highlight = true; break;
      case 'no-move': body = `${tag} has no legal move`; break;
      case 'three-sixes': body = `${tag} rolled three 6s — turn lost`; break;
      case 'win': body = `${tag} wins! 🏆`; highlight = true; break;
      default: body = JSON.stringify(entry);
    }
    return `<div class="log-line ${highlight?'highlight':''}">${body}</div>`;
  }

  // ------------- confetti ----------
  let confettiActive = false;
  function startConfetti() {
    if (confettiActive) return;
    confettiActive = true;
    const canvas = document.getElementById('confetti');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const COLORS = ['#ef4444', '#22c55e', '#eab308', '#3b82f6', '#a78bfa', '#f472b6'];
    const pieces = [];
    for (let i = 0; i < 160; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height,
        r: 4 + Math.random() * 6,
        vx: -3 + Math.random() * 6,
        vy: 2 + Math.random() * 5,
        rot: Math.random() * Math.PI * 2,
        vr: -0.2 + Math.random() * 0.4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]
      });
    }
    const onResize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    window.addEventListener('resize', onResize);
    function frame() {
      if (!confettiActive) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of pieces) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.05;
        if (p.y > canvas.height + 20) { p.y = -20; p.x = Math.random() * canvas.width; p.vy = 2 + Math.random() * 5; }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.r/2, -p.r/2, p.r, p.r * 0.6);
        ctx.restore();
      }
      requestAnimationFrame(frame);
    }
    frame();
  }

  function stopConfetti() {
    confettiActive = false;
    const canvas = document.getElementById('confetti');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  // ------------- conn status -----
  function setConnStatus(text, ok = true) {
    const el = document.getElementById('conn-status');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('bad', !ok);
  }

  window.LudoUI = {
    showScreen, toast, buildBoard, renderTokens, animateMove, buildPathSteps,
    rollDiceAnim, setDiceFace, setDiceEnabled, setDiceHint,
    renderPlayers, setSelectable, clearSelectable, renderLog,
    startConfetti, stopConfetti, setConnStatus, sleep
  };
})();
