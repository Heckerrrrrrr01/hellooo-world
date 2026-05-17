/* =========================================================
   ai.js — Simple Ludo bot.
   ---------------------------------------------------------
   Strategy (priority order):
     1. If a move finishes a token, do it.
     2. If a move captures an opponent, do it (prefer most-advanced opponent).
     3. If a move escapes from imminent danger (an opponent within 1..6 reach
        on a non-safe square), do it.
     4. If rolled a 6, prefer bringing a new token out of yard.
     5. Move the token furthest along (push toward home).
   ========================================================= */
(function () {
  'use strict';

  const B = window.LudoBoard;

  function chooseMove(state) {
    const G = window.LudoGame;
    const moves = G.legalMoves(state);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];

    const p = G.currentPlayer(state);
    const dice = state.dice;

    let best = moves[0];
    let bestScore = -Infinity;

    for (const idx of moves) {
      const tok = state.tokens[p.color][idx];
      const dest = B.advance(p.color, tok, dice);
      if (!dest) continue;

      let score = 0;

      // (1) finishing
      if (dest.state === 'finished') score += 1000;

      // (2) capture
      if (dest.state === 'path' && !B.SAFE_PATH_INDICES.has(dest.idx)) {
        for (const c of B.COLORS) {
          if (c === p.color) continue;
          for (let j = 0; j < 4; j++) {
            const t = state.tokens[c][j];
            if (t.state === 'path' && t.idx === dest.idx) {
              // capture! score by how far they had progressed
              const start = B.START_INDEX[c];
              const traveled = (t.idx - start + 52) % 52;
              score += 500 + traveled * 2;
            }
          }
        }
      }

      // (3) escape: penalize ending on a non-safe cell with enemies within 1..6 behind
      if (dest.state === 'path' && !B.SAFE_PATH_INDICES.has(dest.idx)) {
        for (const c of B.COLORS) {
          if (c === p.color) continue;
          for (const t of state.tokens[c]) {
            if (t.state !== 'path') continue;
            const dist = (dest.idx - t.idx + 52) % 52;
            if (dist >= 1 && dist <= 6) {
              score -= 30;
            }
          }
        }
      } else if (dest.state === 'path' && B.SAFE_PATH_INDICES.has(dest.idx)) {
        score += 20; // bonus for landing on safe
      }

      // (4) bringing token out on a 6
      if (tok.state === 'yard' && dice === 6) {
        // bonus, but smaller than capture/finish
        score += 80;
      }

      // (5) progress score: prefer advancing the most-progressed token a little
      let progress = 0;
      if (tok.state === 'path') {
        const start = B.START_INDEX[p.color];
        progress = (tok.idx - start + 52) % 52;
      } else if (tok.state === 'home') {
        progress = 51 + tok.idx;
      }
      score += progress * 0.5;

      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }

    return best;
  }

  window.LudoAI = { chooseMove };
})();
