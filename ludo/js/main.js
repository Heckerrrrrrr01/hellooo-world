/* =========================================================
   main.js — Controller for menus, game loop, and networking glue.
   ========================================================= */
(function () {
  'use strict';

  const UI = window.LudoUI;
  const G = window.LudoGame;
  const AI = window.LudoAI;
  const Net = window.LudoNet;
  const B = window.LudoBoard;

  // ===================== app state =====================
  /**
   * mode: 'solo' | 'local' | 'online-host' | 'online-client' | null
   * state: current LudoGame state (or null in lobby)
   * net:   { host?, client?, code? }
   * localColors: Set of colors this device controls (for online: 1; for local: all humans)
   */
  const App = {
    mode: null,
    state: null,
    net: { host: null, client: null, code: null, hostName: '' },
    localColors: new Set(),
    seats: [],     // [{color, name, kind:'human'|'bot'|'remote'|'empty', peerId?}]
    busy: false,   // animation in progress / waiting
  };

  // ===================== menu =====================
  function bindMenu() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = btn.dataset.mode;
        if (m === 'solo') openSetup('solo');
        else if (m === 'local') openSetup('local');
        else if (m === 'online-create') openHostScreen();
        else if (m === 'online-join') openJoinScreen();
      });
    });

    // If URL has ?room=CODE, jump to join screen
    const url = new URL(window.location.href);
    const room = url.searchParams.get('room');
    if (room) {
      setTimeout(() => {
        openJoinScreen();
        const inp = document.getElementById('join-code');
        if (inp) inp.value = room.toUpperCase();
      }, 50);
    }
  }

  // ===================== setup (solo / local) =====================
  let setupCount = 3;

  function openSetup(kind) {
    App.mode = kind;
    setupCount = (kind === 'solo') ? 4 : 3;
    document.getElementById('setup-title').textContent = kind === 'solo' ? 'Single Player' : 'Pass & Play';
    document.getElementById('setup-subtitle').textContent = kind === 'solo'
      ? 'You play one color. The rest are bots.'
      : 'Each player takes turns on this device.';

    document.querySelectorAll('.count-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.count, 10) === setupCount);
    });
    renderSetupSeats(kind);
    UI.showScreen('setup');
  }

  function renderSetupSeats(kind) {
    const list = document.getElementById('seat-list');
    list.innerHTML = '';
    const colors = B.COLORS.slice(0, setupCount);
    colors.forEach((color, i) => {
      const row = document.createElement('div');
      row.className = 'seat-row';
      row.innerHTML = `
        <span class="seat-color ${color}"></span>
        <input type="text" maxlength="14" placeholder="${color.charAt(0).toUpperCase() + color.slice(1)}" data-color="${color}" />
        ${kind === 'solo'
          ? `<select data-color="${color}">${i === 0 ? '<option value="human">You</option><option value="bot">Bot</option>' : '<option value="bot">Bot</option><option value="human">Human</option>'}</select>`
          : `<select data-color="${color}"><option value="human">Human</option><option value="bot">Bot</option></select>`
        }
      `;
      list.appendChild(row);
      const inp = row.querySelector('input');
      const sel = row.querySelector('select');
      if (kind === 'solo' && i !== 0) inp.value = ['', 'Bot Bee', 'Bot Cee', 'Bot Dee'][i] || 'Bot';
      if (kind === 'solo' && i === 0) inp.value = 'You';
      if (kind === 'local') inp.value = `Player ${i+1}`;
    });
  }

  document.addEventListener('click', e => {
    if (e.target.classList.contains('count-btn')) {
      setupCount = parseInt(e.target.dataset.count, 10);
      document.querySelectorAll('.count-btn').forEach(b => b.classList.toggle('active', b === e.target));
      renderSetupSeats(App.mode);
    }
  });

  document.getElementById('btn-setup-back').addEventListener('click', () => UI.showScreen('menu'));
  document.getElementById('btn-setup-start').addEventListener('click', () => {
    const rows = document.querySelectorAll('#seat-list .seat-row');
    const seats = [];
    rows.forEach(row => {
      const color = row.querySelector('input').dataset.color;
      const name  = row.querySelector('input').value.trim() || color;
      const kind  = row.querySelector('select').value;
      seats.push({ color, name, kind });
    });
    startGame(seats);
  });

  // ===================== online host =====================
  function openHostScreen() {
    App.mode = 'online-host';
    UI.showScreen('host');
    document.getElementById('host-name').value = localStorage.getItem('ludoName') || '';
    document.getElementById('room-code').value = 'creating…';
    document.getElementById('share-link').value = 'creating…';
    document.getElementById('btn-host-start').disabled = true;

    // create host as soon as user types name (or immediately)
    initHost();
  }

  function initHost() {
    const name = document.getElementById('host-name').value.trim() || 'Host';
    if (App.net.host) App.net.host.destroy();

    App.net.host = Net.createHost({
      name,
      onPeerOpen: (code) => {
        App.net.code = code;
        document.getElementById('room-code').value = code;
        const url = new URL(window.location.href);
        url.searchParams.set('room', code);
        document.getElementById('share-link').value = url.toString();
        // initialize lobby seats: host is red, others empty
        App.seats = [
          { color: 'red',    name, kind: 'human', isHost: true },
          { color: 'green',  name: '', kind: 'empty' },
          { color: 'yellow', name: '', kind: 'empty' },
          { color: 'blue',   name: '', kind: 'empty' }
        ];
        renderHostLobby();
      },
      onClientJoin: (peerId, payload, conn) => {
        // assign first empty seat
        const idx = App.seats.findIndex(s => s.kind === 'empty');
        if (idx === -1) {
          // room full — kick
          conn.close();
          return;
        }
        App.seats[idx] = {
          color: App.seats[idx].color,
          name: (payload.name || 'Player').slice(0, 14),
          kind: 'remote',
          peerId
        };
        // ack
        App.net.host.sendTo(peerId, 'hello-ack', { you: { color: App.seats[idx].color, slotIdx: idx } });
        renderHostLobby();
        broadcastLobby();
      },
      onClientLeave: (peerId) => {
        const i = App.seats.findIndex(s => s.peerId === peerId);
        if (i >= 0) {
          // if game has started, the player remains but is treated as disconnected (skip turn? bot fallback)
          if (App.state) {
            App.seats[i].kind = 'bot'; // hand off to AI
            UI.toast(App.seats[i].name + ' disconnected — bot takes over');
          } else {
            App.seats[i] = { color: App.seats[i].color, name: '', kind: 'empty' };
            renderHostLobby();
            broadcastLobby();
          }
        }
      },
      onIntent: (peerId, intent) => handleRemoteIntent(peerId, intent),
      onError: err => {
        UI.toast('Connection error: ' + (err.type || err.message || err));
      }
    });
  }

  function broadcastLobby() {
    if (!App.net.host) return;
    App.net.host.broadcast('lobby', { seats: App.seats.map(scrubSeat) });
  }
  function scrubSeat(s) {
    return { color: s.color, name: s.name, kind: s.kind === 'remote' ? 'remote' : s.kind };
  }

  function renderHostLobby() {
    const list = document.getElementById('lobby-seats');
    list.innerHTML = '';
    App.seats.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'lobby-seat';
      const tag = s.isHost ? '<span class="seat-tag">host</span>'
                : s.kind === 'remote' ? '<span class="seat-tag">online</span>'
                : '';
      const select = (s.isHost) ? '' : `
        <select data-idx="${i}">
          <option value="empty" ${s.kind==='empty'?'selected':''}>Empty</option>
          <option value="bot"   ${s.kind==='bot'?'selected':''}>Bot</option>
          ${s.kind==='remote'?'<option value="remote" selected>Online</option>':''}
        </select>`;
      row.innerHTML = `
        <span class="seat-color ${s.color}"></span>
        <span class="seat-name ${s.kind==='empty'?'empty':''}">${s.kind==='empty' ? 'open seat' : (s.name || s.color)}</span>
        ${tag}
        ${select}
      `;
      list.appendChild(row);
      const sel = row.querySelector('select');
      if (sel) sel.addEventListener('change', () => {
        const v = sel.value;
        if (s.kind === 'remote' && v !== 'remote') {
          // kick the remote player
          if (s.peerId) App.net.host.kick(s.peerId);
          App.seats[i] = { color: s.color, name: '', kind: v };
          if (v === 'bot') App.seats[i].name = 'Bot ' + s.color;
        } else {
          App.seats[i] = { color: s.color, name: v === 'bot' ? ('Bot ' + s.color) : '', kind: v };
        }
        renderHostLobby();
        broadcastLobby();
      });
    });
    // start enabled if at least 2 active seats (human/bot/remote)
    const active = App.seats.filter(s => s.kind !== 'empty').length;
    document.getElementById('btn-host-start').disabled = active < 2;
  }

  document.getElementById('host-name').addEventListener('input', () => {
    const n = document.getElementById('host-name').value.trim() || 'Host';
    localStorage.setItem('ludoName', n);
    if (App.seats[0]) {
      App.seats[0].name = n;
      renderHostLobby();
      broadcastLobby();
    }
  });
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const v = document.getElementById('room-code').value;
    if (v) { navigator.clipboard.writeText(v); UI.toast('Code copied'); }
  });
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const v = document.getElementById('share-link').value;
    if (v) { navigator.clipboard.writeText(v); UI.toast('Link copied'); }
  });
  document.getElementById('btn-host-cancel').addEventListener('click', () => {
    if (App.net.host) { App.net.host.destroy(); App.net.host = null; }
    UI.showScreen('menu');
  });
  document.getElementById('btn-host-start').addEventListener('click', () => {
    // ensure empty seats are dropped — keep only non-empty
    const playing = App.seats.filter(s => s.kind !== 'empty');
    startGame(playing.map(s => ({
      color: s.color,
      name: s.name || s.color,
      kind: s.kind, // 'human' for host, 'remote', 'bot'
      peerId: s.peerId
    })));
  });

  // ===================== online client =====================
  function openJoinScreen() {
    App.mode = 'online-client';
    UI.showScreen('join');
    document.getElementById('join-name').value = localStorage.getItem('ludoName') || '';
    document.getElementById('join-loader').hidden = true;
    document.getElementById('join-lobby-seats').innerHTML = '';
    document.getElementById('join-lobby-title').style.display = 'none';
    document.getElementById('btn-join-go').disabled = false;
  }

  document.getElementById('btn-join-cancel').addEventListener('click', () => {
    if (App.net.client) { App.net.client.destroy(); App.net.client = null; }
    UI.showScreen('menu');
  });

  document.getElementById('btn-join-go').addEventListener('click', () => {
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const name = document.getElementById('join-name').value.trim() || 'Player';
    localStorage.setItem('ludoName', name);
    if (!code) { UI.toast('Enter a room code'); return; }
    document.getElementById('join-loader').hidden = false;
    document.getElementById('btn-join-go').disabled = true;
    document.getElementById('join-msg').textContent = 'Connecting…';

    if (App.net.client) App.net.client.destroy();
    App.net.client = Net.createClient({
      code, name,
      onOpen: () => {
        document.getElementById('join-loader').hidden = true;
        document.getElementById('join-msg').textContent = 'Connected. Waiting for host to start…';
        document.getElementById('join-lobby-title').style.display = '';
      },
      onMessage: (type, payload) => handleHostMessage(type, payload),
      onClose: () => {
        UI.toast('Disconnected from host');
        if (App.state) UI.setConnStatus('Disconnected', false);
        else UI.showScreen('menu');
      },
      onError: (err) => {
        document.getElementById('join-loader').hidden = true;
        document.getElementById('btn-join-go').disabled = false;
        document.getElementById('join-msg').textContent = 'Could not connect — check the code.';
      }
    });
  });

  function renderJoinLobby(seats) {
    const list = document.getElementById('join-lobby-seats');
    list.innerHTML = '';
    seats.forEach(s => {
      const row = document.createElement('div');
      row.className = 'lobby-seat';
      row.innerHTML = `
        <span class="seat-color ${s.color}"></span>
        <span class="seat-name ${s.kind==='empty'?'empty':''}">${s.kind==='empty' ? 'open seat' : (s.name || s.color)}</span>
        <span class="seat-tag">${s.kind === 'bot' ? 'bot' : s.kind === 'remote' ? 'online' : s.kind === 'human' ? 'host' : ''}</span>
      `;
      list.appendChild(row);
    });
  }

  // ===================== online message handlers =====================
  let myColor = null; // for clients

  function handleHostMessage(type, payload) {
    switch (type) {
      case 'hello-ack':
        myColor = payload.you.color;
        UI.toast('Joined as ' + myColor);
        break;
      case 'lobby':
        renderJoinLobby(payload.seats);
        break;
      case 'start':
        // host says game is starting
        App.state = payload.state;
        App.localColors = new Set([myColor]);
        UI.showScreen('game');
        UI.buildBoard();
        UI.renderTokens(App.state);
        UI.renderPlayers(App.state, myColor);
        UI.renderLog(App.state);
        UI.setConnStatus('Connected', true);
        nextTurn();
        break;
      case 'state':
        // sync from host (after every action)
        applyRemoteState(payload.state, payload.action);
        break;
      case 'action': {
        // host echoes an action; we animate it on client
        animateAction(payload.action).then(() => {
          App.state = payload.state;
          UI.renderTokens(App.state);
          UI.renderPlayers(App.state, myColor);
          UI.renderLog(App.state);
          if (App.state.phase === 'ended') showWin();
          else nextTurn();
        });
        break;
      }
      case 'end':
        App.state = payload.state;
        showWin();
        break;
    }
  }

  function applyRemoteState(state, action) {
    App.state = state;
    UI.renderTokens(App.state);
    UI.renderPlayers(App.state, myColor);
    UI.renderLog(App.state);
    if (state.phase === 'ended') showWin();
    else nextTurn();
  }

  // Animate an action (rolled+moved) on a non-local screen
  async function animateAction(action) {
    if (action.dice) {
      await UI.rollDiceAnim(action.dice);
    }
    if (action.move) {
      const { color, tokenIdx, fromState, fromIdx, dice } = action.move;
      const path = UI.buildPathSteps(color, fromState, fromIdx, dice);
      await UI.animateMove(App.state, color, tokenIdx, fromState, fromIdx, path);
    }
  }

  function handleRemoteIntent(peerId, intent) {
    // host applies intent on behalf of remote player
    if (!App.state || App.state.phase === 'ended') return;
    const cur = App.state.players[App.state.turn];
    const seat = App.seats.find(s => s.peerId === peerId);
    if (!seat || seat.color !== cur.color) {
      // not their turn — ignore
      return;
    }
    if (intent.kind === 'roll') {
      doRollAndMaybeAutoMove();
    } else if (intent.kind === 'move' && typeof intent.tokenIdx === 'number') {
      doMoveToken(intent.tokenIdx);
    }
  }

  // ===================== start game =====================
  function startGame(seats) {
    App.seats = seats.slice();
    const players = seats.map(s => ({
      color: s.color,
      name: s.name || s.color,
      kind: s.kind,                  // 'human'|'bot'|'remote'
      peerId: s.peerId || null
    }));
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    App.state = G.newState(players, seed);

    // figure local colors
    App.localColors.clear();
    if (App.mode === 'solo' || App.mode === 'local') {
      seats.forEach(s => { if (s.kind === 'human') App.localColors.add(s.color); });
    } else if (App.mode === 'online-host') {
      seats.forEach(s => { if (s.kind === 'human') App.localColors.add(s.color); });
    }

    UI.showScreen('game');
    UI.buildBoard();
    UI.renderTokens(App.state);
    UI.renderPlayers(App.state, App.mode === 'online-client' ? myColor : null);
    UI.renderLog(App.state);
    UI.setConnStatus('');
    UI.stopConfetti();

    // host: broadcast start
    if (App.mode === 'online-host' && App.net.host) {
      App.net.host.broadcast('start', { state: App.state });
    }

    nextTurn();
  }

  // ===================== turn loop =====================
  function nextTurn() {
    if (!App.state || App.state.phase === 'ended') {
      if (App.state && App.state.phase === 'ended') showWin();
      return;
    }
    UI.renderPlayers(App.state, App.mode === 'online-client' ? myColor : null);
    UI.clearSelectable();

    const cur = G.currentPlayer(App.state);
    const isLocal = isLocalControlled(cur);

    if (App.state.phase === 'rolling') {
      UI.setDiceFace(null);
      if (isLocal) {
        UI.setDiceEnabled(true);
        UI.setDiceHint(`${cur.name}, click to roll`);
      } else {
        UI.setDiceEnabled(false);
        UI.setDiceHint(cur.kind === 'bot' ? `${cur.name} is thinking…` : `Waiting for ${cur.name}…`);
        if (cur.kind === 'bot' && (App.mode !== 'online-client')) {
          // bots only run on host (or solo/local). Clients wait for state push.
          setTimeout(() => doRollAndMaybeAutoMove(), 700);
        }
      }
    } else if (App.state.phase === 'choosing') {
      const moves = G.legalMoves(App.state);
      if (isLocal) {
        UI.setDiceEnabled(false);
        UI.setDiceHint(`Pick a token to move (${App.state.dice})`);
        UI.setSelectable(App.state, moves);
      } else if (cur.kind === 'bot' && App.mode !== 'online-client') {
        setTimeout(() => {
          const choice = AI.chooseMove(App.state);
          if (choice != null) doMoveToken(choice);
        }, 600);
      }
    }
  }

  function isLocalControlled(player) {
    if (App.mode === 'online-client') return player.color === myColor;
    return App.localColors.has(player.color);
  }

  // ===================== dice click =====================
  function bindDice() {
    const handler = () => {
      if (App.busy) return;
      if (!App.state || App.state.phase !== 'rolling') return;
      const cur = G.currentPlayer(App.state);
      if (!isLocalControlled(cur)) return;
      if (App.mode === 'online-client') {
        // ask host to roll
        App.net.client.send('intent', { kind: 'roll' });
        UI.setDiceEnabled(false);
        UI.setDiceHint('Rolling…');
      } else {
        doRollAndMaybeAutoMove();
      }
    };
    document.getElementById('dice').addEventListener('click', handler);
    document.getElementById('mb-dice').addEventListener('click', handler);
  }

  async function doRollAndMaybeAutoMove() {
    if (App.busy) return;
    App.busy = true;
    UI.setDiceEnabled(false);

    const beforePhase = App.state.phase;
    const beforeTurn = App.state.turn;
    const stateBefore = G.clone(App.state);
    G.rollDice(App.state);
    const value = stateBefore.phase === 'rolling' && App.state.dice != null
      ? App.state.dice
      : (stateBefore.phase === 'rolling' ? null : null);
    // We need the rolled value even if it was auto-passed. The log entry has it.
    const lastRoll = App.state.log.slice().reverse().find(l => l.type === 'roll');
    const rolled = lastRoll ? lastRoll.value : null;

    if (rolled != null) await UI.rollDiceAnim(rolled);

    // Broadcast roll action (host -> clients)
    if (App.mode === 'online-host' && App.net.host) {
      App.net.host.broadcast('action', {
        action: { dice: rolled, move: null },
        state: App.state
      });
    }

    UI.renderLog(App.state);

    if (App.state.phase === 'rolling') {
      // auto-passed (no legal move or three sixes), continue
      App.busy = false;
      nextTurn();
      return;
    }

    if (App.state.phase === 'choosing') {
      const moves = G.legalMoves(App.state);
      if (moves.length === 0) {
        App.busy = false;
        nextTurn();
        return;
      }
      // If only one legal move, auto-play it for snappy UX
      if (moves.length === 1) {
        App.busy = false;
        await doMoveToken(moves[0]);
        return;
      }
      // wait for selection
      App.busy = false;
      nextTurn();
    } else {
      App.busy = false;
      nextTurn();
    }
  }

  // ===================== token click =====================
  function bindTokenClicks() {
    document.getElementById('board').addEventListener('click', e => {
      const tok = e.target.closest('.token.selectable');
      if (!tok) return;
      if (App.busy || !App.state) return;
      const cur = G.currentPlayer(App.state);
      if (!isLocalControlled(cur)) return;
      const idx = parseInt(tok.dataset.idx, 10);
      if (App.mode === 'online-client') {
        App.net.client.send('intent', { kind: 'move', tokenIdx: idx });
        UI.clearSelectable();
        UI.setDiceHint('Moving…');
      } else {
        doMoveToken(idx);
      }
    });
  }

  async function doMoveToken(tokenIdx) {
    if (App.busy) return;
    App.busy = true;
    UI.clearSelectable();

    const cur = G.currentPlayer(App.state);
    const tok = App.state.tokens[cur.color][tokenIdx];
    const fromState = tok.state;
    const fromIdx = tok.idx;
    const dice = App.state.dice;
    const path = UI.buildPathSteps(cur.color, fromState, fromIdx, dice);

    const result = G.moveToken(App.state, tokenIdx);
    if (!result) {
      App.busy = false;
      nextTurn();
      return;
    }

    // animate token through path
    await UI.animateMove(App.state, cur.color, tokenIdx, fromState, fromIdx, path);

    // capture flair
    if (result.captured && result.captured.length) {
      result.captured.forEach(({ color, tokenIdx: ci }) => {
        const el = document.querySelector(`.token[data-color="${color}"][data-idx="${ci}"]`);
        if (el) {
          el.classList.add('captured');
          setTimeout(() => el.classList.remove('captured'), 400);
        }
      });
      UI.toast('Token captured!');
    }

    UI.renderTokens(App.state);
    UI.renderPlayers(App.state, App.mode === 'online-client' ? myColor : null);
    UI.renderLog(App.state);

    // broadcast action+state to clients
    if (App.mode === 'online-host' && App.net.host) {
      App.net.host.broadcast('action', {
        action: {
          dice: null,
          move: { color: cur.color, tokenIdx, fromState, fromIdx, dice }
        },
        state: App.state
      });
    }

    App.busy = false;

    if (App.state.phase === 'ended') {
      showWin();
      if (App.mode === 'online-host' && App.net.host) {
        App.net.host.broadcast('end', { state: App.state });
      }
      return;
    }
    nextTurn();
  }

  // ===================== win =====================
  function showWin() {
    const w = App.state.winner;
    const p = App.state.players[w];
    UI.showScreen('win');
    UI.startConfetti();
    document.getElementById('win-title').textContent = `${p.name} wins!`;
    document.getElementById('win-title').style.color = `var(--c-${p.color})`;
    document.getElementById('win-sub').textContent = p.kind === 'bot'
      ? 'A bot took it home this time. Rematch?'
      : 'First to bring all 4 tokens home.';
  }

  document.getElementById('btn-rematch').addEventListener('click', () => {
    UI.stopConfetti();
    if (App.mode === 'online-host') {
      // restart with same seats
      const seats = App.seats.filter(s => s.kind !== 'empty');
      startGame(seats.map(s => ({ color: s.color, name: s.name, kind: s.kind, peerId: s.peerId })));
    } else if (App.mode === 'online-client') {
      UI.toast('Waiting for host to start a new game…');
    } else {
      startGame(App.seats.slice());
    }
  });

  document.getElementById('btn-home').addEventListener('click', () => {
    UI.stopConfetti();
    leaveGame();
    UI.showScreen('menu');
  });

  document.getElementById('btn-leave').addEventListener('click', () => {
    leaveGame();
    UI.showScreen('menu');
  });

  function leaveGame() {
    App.state = null;
    App.localColors.clear();
    if (App.net.host) { App.net.host.destroy(); App.net.host = null; }
    if (App.net.client) { App.net.client.destroy(); App.net.client = null; }
    App.mode = null;
    App.seats = [];
  }

  // ===================== boot =====================
  function boot() {
    bindMenu();
    bindDice();
    bindTokenClicks();
    UI.showScreen('menu');
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
