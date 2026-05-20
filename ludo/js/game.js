/* =========================================================
   game.js — Pure Ludo rules engine (no DOM, no networking).
   ---------------------------------------------------------
   State shape:
   {
     players: [{ color, name, kind: 'human'|'bot'|'remote', peerId? }, ...],
     turn: number,           // index into players
     dice: number|null,      // last roll (null = not rolled)
     rollsLeft: number,      // consecutive 6 counter (max 3 sixes loses turn)
     sixStreak: number,
     tokens: {
       red:    [{ state, idx }, x4],
       green:  [...], yellow: [...], blue: [...]
     },
     winner: number|null,
     finishOrder: [colorsInFinishOrder],
     phase: 'rolling'|'choosing'|'moving'|'ended',
     log: [strings],
     seed: number            // for deterministic shared randomness
   }

   The engine is fully deterministic given the seed + sequence of
   player decisions, so host/clients can stay in sync without
   re-broadcasting state — but in this app we broadcast actions
   (rollDice, moveToken) and let each side derive results.
   ========================================================= */
(function () {
  'use strict';

  const B = window.LudoBoard;

  // simple seeded PRNG (mulberry32) so dice rolls can be reproducible across peers
  function makeRng(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function newState(players, seed) {
    const tokens = {};
    for (const c of B.COLORS) {
      tokens[c] = [
        { state: 'yard', idx: 0 },
        { state: 'yard', idx: 1 },
        { state: 'yard', idx: 2 },
        { state: 'yard', idx: 3 }
      ];
    }
    return {
      players: players.slice(),
      turn: 0,
      dice: null,
      sixStreak: 0,
      tokens,
      winner: null,
      finishOrder: [],
      phase: 'rolling',
      log: [],
      seed: seed >>> 0,
      rollCount: 0
    };
  }

  function currentPlayer(state) {
    return state.players[state.turn];
  }

  function rollDice(state) {
    if (state.phase !== 'rolling') return state;
    const rng = makeRng(state.seed ^ (state.rollCount * 2654435761));
    state.rollCount++;
    const value = 1 + Math.floor(rng() * 6);
    state.dice = value;

    if (value === 6) {
      state.sixStreak++;
    } else {
      state.sixStreak = 0;
    }

    // log the roll first so the UI can always animate it
    state.log.push({ type: 'roll', color: currentPlayer(state).color, value });

    // Three sixes in a row -> lose turn
    if (state.sixStreak >= 3) {
      state.log.push({ type: 'three-sixes', color: currentPlayer(state).color });
      state.sixStreak = 0;
      state.dice = null;
      passTurn(state);
      return state;
    }

    state.phase = 'choosing';

    // If no legal move, auto-pass
    const moves = legalMoves(state);
    if (moves.length === 0) {
      state.log.push({ type: 'no-move', color: currentPlayer(state).color });
      state.dice = null;
      state.phase = 'rolling';
      // 6 still grants extra turn even if no legal move
      if (value !== 6) passTurn(state);
      else state.sixStreak = state.sixStreak; // keep streak; another roll
    }

    return state;
  }

  /**
   * Returns array of token indices (0..3) of the current player that can legally move.
   */
  function legalMoves(state) {
    const p = currentPlayer(state);
    if (state.dice == null) return [];
    const out = [];
    for (let i = 0; i < 4; i++) {
      const tok = state.tokens[p.color][i];
      const dest = B.advance(p.color, tok, state.dice);
      if (!dest) continue;
      // can't land on own token in a non-stack situation? Standard Ludo allows stacking own tokens,
      // so we permit. Just need to not overshoot (advance returns null then).
      out.push(i);
    }
    return out;
  }

  /**
   * Move the chosen token. Returns { captured: [...], finished: bool }.
   */
  function moveToken(state, tokenIdx) {
    const p = currentPlayer(state);
    const tok = state.tokens[p.color][tokenIdx];
    const dest = B.advance(p.color, tok, state.dice);
    if (!dest) return null;

    const captured = [];
    // capture: if landing on a main-path cell that's not safe and contains opponent token(s)
    if (dest.state === 'path' && !B.SAFE_PATH_INDICES.has(dest.idx)) {
      for (const c of B.COLORS) {
        if (c === p.color) continue;
        for (let j = 0; j < 4; j++) {
          const t = state.tokens[c][j];
          if (t.state === 'path' && t.idx === dest.idx) {
            // if there are 2+ opponent tokens stacked on a non-safe cell, they form a block
            // (cannot be captured). Detect block:
            const stack = state.tokens[c].filter(x => x.state === 'path' && x.idx === dest.idx).length;
            if (stack >= 2) {
              return null; // illegal: cannot land on a block — abort
            }
            t.state = 'yard';
            t.idx = j; // back to original yard slot
            captured.push({ color: c, tokenIdx: j });
          }
        }
      }
    }

    tok.state = dest.state;
    tok.idx = dest.idx;

    state.log.push({
      type: 'move',
      color: p.color,
      tokenIdx,
      to: { ...dest },
      captured
    });

    // captures grant a bonus roll
    let extraTurn = false;
    if (captured.length > 0) {
      extraTurn = true;
      state.log.push({ type: 'capture', color: p.color, count: captured.length });
    }

    // finishing a token also grants a bonus roll (common house rule, included here)
    if (dest.state === 'finished') {
      extraTurn = true;
      state.log.push({ type: 'home', color: p.color });
    }

    // Check win condition for current player
    const finishedCount = state.tokens[p.color].filter(t => t.state === 'finished').length;
    if (finishedCount === 4) {
      state.finishOrder.push(p.color);
      if (state.winner == null) state.winner = state.turn;
      state.log.push({ type: 'win', color: p.color });
      // game ends when first player completes (single-winner game)
      state.phase = 'ended';
      state.dice = null;
      return { captured, finished: true, extraTurn };
    }

    // Roll-of-6 grants extra turn
    if (state.dice === 6) extraTurn = true;

    state.dice = null;
    if (extraTurn) {
      state.phase = 'rolling';
    } else {
      passTurn(state);
    }

    return { captured, finished: false, extraTurn };
  }

  function passTurn(state) {
    if (state.phase === 'ended') return;
    state.sixStreak = 0;
    let next = state.turn;
    for (let i = 0; i < state.players.length; i++) {
      next = (next + 1) % state.players.length;
      // skip players whose color has finished (rare in single-winner mode but supported)
      const c = state.players[next].color;
      const finishedCount = state.tokens[c].filter(t => t.state === 'finished').length;
      if (finishedCount < 4) break;
    }
    state.turn = next;
    state.dice = null;
    state.phase = 'rolling';
  }

  // utility for replays / serialization
  function clone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  window.LudoGame = {
    newState,
    rollDice,
    moveToken,
    legalMoves,
    currentPlayer,
    passTurn,
    clone
  };
})();
