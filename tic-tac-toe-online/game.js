/* ============================================================
   Tic Tac Toe Online — multiplayer over WebRTC (PeerJS)
   - Host creates a room, gets a shareable link with ?room=ID
   - Joiner opens that link and connects directly P2P
   - All game state is synced via simple JSON messages
   ============================================================ */

(() => {
  'use strict';

  // ---------- Tiny helpers ----------
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screens = {
    home:       $('#screen-home'),
    waiting:    $('#screen-waiting'),
    connecting: $('#screen-connecting'),
    game:       $('#screen-game'),
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- Game logic ----------
  const WIN_LINES = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6],         // diagonals
  ];

  // Coordinates (in 0..300 viewBox) for the win line of each WIN_LINES entry
  // Each cell is 100x100 inside a 300x300 board (the SVG ignores the gap padding,
  // which is fine because the line is drawn relative to the board container).
  const LINE_COORDS = [
    [10,50,290,50], [10,150,290,150], [10,250,290,250],   // rows
    [50,10,50,290], [150,10,150,290], [250,10,250,290],   // cols
    [15,15,285,285], [285,15,15,285],                     // diagonals
  ];

  const state = {
    role: null,            // 'host' | 'guest'
    mySymbol: null,        // 'X' | 'O'
    oppSymbol: null,
    myName: '',
    oppName: '',
    board: Array(9).fill(null),
    turn: 'X',             // X always goes first each round
    gameOver: false,
    scores: { X: 0, O: 0 },
    roomId: null,
    peer: null,            // PeerJS instance
    conn: null,            // DataConnection
  };

  // ---------- Networking (PeerJS) ----------
  function makeRoomId() {
    // Short, URL-friendly id (avoid 0/O/1/I confusion)
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let id = 'ttt-';
    for (let i = 0; i < 8; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
    return id;
  }

  function newPeer(id) {
    const config = {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
          // Free TURN servers for when STUN fails (different networks/NAT)
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ]
      },
      debug: 0
    };
    return id ? new Peer(id, config) : new Peer(config);
  }

  function send(msg) {
    if (state.conn && state.conn.open) {
      state.conn.send(msg);
    }
  }

  function attachConnHandlers(conn) {
    state.conn = conn;

    conn.on('open', () => {
      $('#conn-status').textContent = 'Connected';
      $('#conn-status').classList.remove('disconnected');

      if (state.role === 'host') {
        // Host introduces itself; guest will respond with their name
        send({ type: 'hello', name: state.myName, hostSymbol: state.mySymbol });
      } else {
        // Guest sends its name once the channel opens
        send({ type: 'hello', name: state.myName });
      }
    });

    conn.on('data', (data) => handleMessage(data));

    conn.on('close', () => onDisconnect('Opponent disconnected'));
    conn.on('error', (e) => {
      console.error('conn error', e);
      onDisconnect('Connection error');
    });
  }

  function onDisconnect(reason) {
    $('#conn-status').textContent = reason;
    $('#conn-status').classList.add('disconnected');
    $('#status').textContent = reason;
    state.gameOver = true;
    $('#btn-rematch').disabled = true;
    disableBoard(true);
  }

  // ---------- Host flow ----------
  function createRoom() {
    const name = ($('#host-name').value || 'Host').trim().slice(0, 16);
    state.myName = name;
    state.role = 'host';
    state.mySymbol = 'X';   // host plays X
    state.oppSymbol = 'O';

    const roomId = makeRoomId();
    state.roomId = roomId;

    const peer = newPeer(roomId);
    state.peer = peer;

    peer.on('open', (id) => {
      const url = new URL(window.location.href);
      url.searchParams.set('room', id);
      url.hash = '';
      const shareUrl = url.toString();
      $('#share-link').value = shareUrl;
      $('#room-code').value = id;
      showScreen('waiting');
    });

    peer.on('connection', (conn) => {
      // Only allow first connection
      if (state.conn && state.conn.open) {
        conn.close();
        return;
      }
      attachConnHandlers(conn);
    });

    peer.on('error', (err) => {
      console.error('peer error', err);
      if (err.type === 'unavailable-id') {
        toast('Room id taken, retrying…');
        setTimeout(createRoom, 200);
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        toast('Network error. Check your connection.');
      } else {
        toast('Error: ' + err.type);
      }
    });
  }

  // ---------- Guest flow ----------
  function joinRoom(roomId, name) {
    state.myName = (name || 'Guest').trim().slice(0, 16);
    state.role = 'guest';
    state.mySymbol = 'O';   // guest plays O
    state.oppSymbol = 'X';
    state.roomId = roomId;

    showScreen('connecting');
    $('#connecting-msg').textContent = 'Reaching out to host…';

    const peer = newPeer(); // random id
    state.peer = peer;

    peer.on('open', () => {
      const conn = peer.connect(roomId, { reliable: true });
      attachConnHandlers(conn);

      // Timeout if host never accepts
      setTimeout(() => {
        if (!state.conn || !state.conn.open) {
          $('#connecting-msg').textContent = 'Could not reach host. The room may be closed.';
        }
      }, 8000);
    });

    peer.on('error', (err) => {
      console.error('peer error', err);
      if (err.type === 'peer-unavailable') {
        $('#connecting-msg').textContent = 'Room not found or host has left.';
      } else {
        $('#connecting-msg').textContent = 'Connection error: ' + err.type;
      }
    });
  }

  // ---------- Message handling ----------
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'hello': {
        state.oppName = msg.name || 'Opponent';
        if (state.role === 'host') {
          // Host now starts the game and tells guest the symbols + names
          send({
            type: 'start',
            hostName: state.myName,
            guestName: state.oppName,
          });
          startGame();
        }
        break;
      }
      case 'start': {
        // Guest receives game start
        state.oppName = msg.hostName;
        startGame();
        break;
      }
      case 'move': {
        // Apply opponent's move
        applyMove(msg.index, state.oppSymbol, /*fromRemote*/ true);
        break;
      }
      case 'rematch-request': {
        toast(state.oppName + ' wants a rematch');
        // Auto-confirm rematch on receive (both clicked)
        if (rematchRequested) {
          send({ type: 'rematch-start' });
          resetBoard();
        } else {
          rematchPending = true;
        }
        break;
      }
      case 'rematch-start': {
        resetBoard();
        break;
      }
      case 'leave': {
        onDisconnect(state.oppName + ' left the game');
        break;
      }
    }
  }

  // ---------- Game flow ----------
  function startGame() {
    // Reset
    state.board = Array(9).fill(null);
    state.turn = 'X';
    state.gameOver = false;
    state.scores = { X: 0, O: 0 };
    rematchRequested = false;
    rematchPending = false;

    // Names on UI
    if (state.role === 'host') {
      $('#name-x').textContent = state.myName + ' (you)';
      $('#name-o').textContent = state.oppName;
    } else {
      $('#name-x').textContent = state.oppName;
      $('#name-o').textContent = state.myName + ' (you)';
    }
    $('#score-x').textContent = '0';
    $('#score-o').textContent = '0';

    renderBoard();
    updateTurnUI();
    showScreen('game');
  }

  function resetBoard() {
    state.board = Array(9).fill(null);
    state.turn = 'X';
    state.gameOver = false;
    rematchRequested = false;
    rematchPending = false;
    $('#btn-rematch').disabled = true;
    $('#btn-rematch').textContent = 'Rematch';
    clearWinLine();
    renderBoard();
    updateTurnUI();
  }

  function applyMove(index, symbol, fromRemote) {
    if (state.gameOver) return;
    if (state.board[index]) return;
    if (state.turn !== symbol) return;

    state.board[index] = symbol;
    renderCell(index);

    const winInfo = checkWin(state.board);
    if (winInfo) {
      state.gameOver = true;
      state.scores[symbol]++;
      $('#score-' + symbol.toLowerCase()).textContent = state.scores[symbol];
      drawWinLine(winInfo.line);
      const status = $('#status');
      if (symbol === state.mySymbol) {
        status.textContent = '🎉 You won!';
        status.className = 'status win';
      } else {
        status.textContent = state.oppName + ' won';
        status.className = 'status lose';
      }
      $('#btn-rematch').disabled = false;
      disableBoard(true);
    } else if (state.board.every(c => c)) {
      state.gameOver = true;
      const status = $('#status');
      status.textContent = "It's a draw";
      status.className = 'status draw';
      $('#btn-rematch').disabled = false;
      disableBoard(true);
    } else {
      state.turn = (symbol === 'X') ? 'O' : 'X';
      updateTurnUI();
    }

    if (!fromRemote) {
      send({ type: 'move', index });
    }
  }

  function checkWin(board) {
    for (let i = 0; i < WIN_LINES.length; i++) {
      const [a,b,c] = WIN_LINES[i];
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return { symbol: board[a], line: i };
      }
    }
    return null;
  }

  function updateTurnUI() {
    $('#player-x').classList.toggle('active', state.turn === 'X' && !state.gameOver);
    $('#player-o').classList.toggle('active', state.turn === 'O' && !state.gameOver);

    if (state.gameOver) return;
    const status = $('#status');
    status.className = 'status';
    if (state.turn === state.mySymbol) {
      status.textContent = 'Your turn';
    } else {
      status.textContent = state.oppName + "'s turn";
    }
    disableBoard(state.turn !== state.mySymbol);
  }

  function disableBoard(disabled) {
    $$('.cell').forEach((cell, i) => {
      cell.disabled = disabled || !!state.board[i] || state.gameOver;
    });
  }

  function renderBoard() {
    $$('.cell').forEach((cell, i) => {
      cell.className = 'cell';
      cell.textContent = '';
      cell.disabled = false;
      if (state.board[i]) renderCell(i);
    });
    clearWinLine();
    disableBoard(state.turn !== state.mySymbol);
  }

  function renderCell(i) {
    const cell = $$('.cell')[i];
    const v = state.board[i];
    if (!v) return;
    cell.textContent = v;
    cell.classList.add('filled', v.toLowerCase());
    cell.disabled = true;
  }

  function drawWinLine(lineIndex) {
    const [x1,y1,x2,y2] = LINE_COORDS[lineIndex];
    const svg = $('#win-line');
    svg.innerHTML = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  }

  function clearWinLine() {
    $('#win-line').innerHTML = '';
  }

  // ---------- Rematch ----------
  let rematchRequested = false; // I clicked rematch
  let rematchPending   = false; // opponent already asked

  function requestRematch() {
    if (!state.gameOver) return;
    rematchRequested = true;
    $('#btn-rematch').disabled = true;
    $('#btn-rematch').textContent = 'Waiting…';
    send({ type: 'rematch-request' });

    if (rematchPending) {
      // Both want rematch
      send({ type: 'rematch-start' });
      resetBoard();
    } else {
      $('#status').textContent = 'Waiting for ' + state.oppName + '…';
    }
  }

  // ---------- Wire up UI ----------
  function bindUI() {
    $('#btn-create').addEventListener('click', createRoom);

    $('#btn-join').addEventListener('click', () => {
      const code = $('#join-code').value.trim();
      const name = $('#join-name').value.trim();
      if (!code) { toast('Enter a room code'); return; }
      joinRoom(code, name);
    });

    $('#btn-copy-link').addEventListener('click', async () => {
      const link = $('#share-link').value;
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied!');
      } catch {
        $('#share-link').select();
        document.execCommand && document.execCommand('copy');
        toast('Link copied!');
      }
    });

    $('#btn-copy-code').addEventListener('click', async () => {
      const code = $('#room-code').value;
      try {
        await navigator.clipboard.writeText(code);
        toast('Code copied!');
      } catch {
        $('#room-code').select();
        document.execCommand && document.execCommand('copy');
        toast('Code copied!');
      }
    });

    $('#btn-cancel-host').addEventListener('click', () => {
      cleanup();
      showScreen('home');
    });

    $('#btn-cancel-join').addEventListener('click', () => {
      cleanup();
      showScreen('home');
    });

    $('#btn-leave').addEventListener('click', () => {
      send({ type: 'leave' });
      cleanup();
      showScreen('home');
    });

    $('#btn-rematch').addEventListener('click', requestRematch);

    $$('.cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const i = Number(cell.dataset.i);
        if (state.gameOver) return;
        if (state.turn !== state.mySymbol) return;
        if (state.board[i]) return;
        applyMove(i, state.mySymbol, false);
      });
    });
  }

  function cleanup() {
    try { state.conn && state.conn.close(); } catch {}
    try { state.peer && state.peer.destroy(); } catch {}
    state.conn = null;
    state.peer = null;
  }

  // ---------- Auto-join when ?room= is in URL ----------
  function checkUrlForRoom() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
      // Pre-fill and prompt for a name on the home screen
      $('#join-code').value = room;
      $('#join-name').focus();
      // Scroll to the join section visually
      toast('Enter your name to join the game');
    }
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    checkUrlForRoom();
  });

  window.addEventListener('beforeunload', () => {
    try { send({ type: 'leave' }); } catch {}
    cleanup();
  });
})();
