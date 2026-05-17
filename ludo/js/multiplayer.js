/* =========================================================
   multiplayer.js — PeerJS-based room host/join.
   ---------------------------------------------------------
   Architecture:
     - Host holds the authoritative state. Clients send `intent`
       messages (rollDice, moveToken). Host applies them, then
       broadcasts the new state snapshot to all clients.
     - Lobby phase: host can assign seats to bots/humans, then start.

   Message types (host <-> client):
     hello       client -> host  { name }
     hello-ack   host   -> client { you: { color, slotIdx }, lobby }
     lobby       host   -> client { seats }
     start       host   -> client { state }
     state       host   -> client { state }
     intent      client -> host   { kind: 'roll'|'move', tokenIdx? }
     chat        either              { text }
     bye         either
   ========================================================= */
(function () {
  'use strict';

  const LUDO_PREFIX = 'ludo-';

  // Generate a short readable code (8 hex chars) used as part of peer ID
  function makeRoomCode() {
    return Math.random().toString(16).slice(2, 8).toUpperCase();
  }

  function createHost({ name, onPeerOpen, onClientJoin, onClientLeave, onIntent, onError }) {
    const code = makeRoomCode();
    const peerId = LUDO_PREFIX + code;
    const peer = new Peer(peerId, { debug: 1 });
    const conns = new Map(); // peerId -> conn

    peer.on('open', id => onPeerOpen && onPeerOpen(code, id));
    peer.on('error', err => {
      console.error('host peer error', err);
      onError && onError(err);
    });
    peer.on('connection', conn => {
      conn.on('open', () => {
        conns.set(conn.peer, conn);
        conn.on('data', msg => {
          if (!msg || !msg.type) return;
          if (msg.type === 'hello') {
            onClientJoin && onClientJoin(conn.peer, msg.payload || {}, conn);
          } else if (msg.type === 'intent') {
            onIntent && onIntent(conn.peer, msg.payload || {});
          }
        });
        conn.on('close', () => {
          conns.delete(conn.peer);
          onClientLeave && onClientLeave(conn.peer);
        });
        conn.on('error', e => console.warn('conn error', e));
      });
    });

    function broadcast(type, payload) {
      const msg = { type, payload };
      for (const c of conns.values()) {
        try { c.send(msg); } catch (e) { /* ignore */ }
      }
    }
    function sendTo(peerId, type, payload) {
      const c = conns.get(peerId);
      if (c) try { c.send({ type, payload }); } catch (e) {}
    }
    function destroy() {
      try { peer.destroy(); } catch (e) {}
      conns.clear();
    }

    return {
      code,
      peer,
      broadcast,
      sendTo,
      kick(peerId) { const c = conns.get(peerId); if (c) c.close(); },
      destroy
    };
  }

  function createClient({ code, name, onOpen, onMessage, onClose, onError }) {
    const peer = new Peer({ debug: 1 });
    let conn = null;
    let openHandled = false;

    peer.on('open', () => {
      try {
        conn = peer.connect(LUDO_PREFIX + code, { reliable: true });
        conn.on('open', () => {
          conn.send({ type: 'hello', payload: { name } });
          if (!openHandled) { openHandled = true; onOpen && onOpen(); }
        });
        conn.on('data', msg => {
          if (msg && msg.type) onMessage && onMessage(msg.type, msg.payload);
        });
        conn.on('close', () => onClose && onClose());
        conn.on('error', e => onError && onError(e));
      } catch (e) {
        onError && onError(e);
      }
    });
    peer.on('error', err => {
      console.error('client peer error', err);
      onError && onError(err);
    });

    function send(type, payload) {
      if (conn && conn.open) {
        try { conn.send({ type, payload }); } catch (e) {}
      }
    }
    function destroy() {
      try { peer.destroy(); } catch (e) {}
    }
    return { peer, send, destroy };
  }

  window.LudoNet = {
    createHost,
    createClient,
    makeRoomCode
  };
})();
