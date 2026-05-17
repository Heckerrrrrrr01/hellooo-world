/* =========================================================
   board.js — Ludo board geometry
   ---------------------------------------------------------
   Standard 15x15 board with a 52-cell main loop.
   Coordinates are [col, row], 0-indexed from top-left.

   Layout reference:
     - Red base   : top-left   (rows 0..5, cols 0..5)
     - Green base : top-right  (rows 0..5, cols 9..14)
     - Yellow base: bot-right  (rows 9..14, cols 9..14)
     - Blue base  : bot-left   (rows 9..14, cols 0..5)

   Main path (52 cells) starts at red's start cell (col 1, row 6)
   and goes clockwise. Each color has its own START_INDEX on the
   main path and a HOME_ENTRY just before turning into the home stretch.

   Home stretch: 6 cells from the colored entry to the center.
   ========================================================= */
(function () {
  'use strict';

  // ----- the 52 main-track cells, in clockwise order, starting at RED's start -----
  // Red enters the board at (1, 6); path runs right along row 6 to (5,6), up to (5,0)... etc.
  const PATH = [
    // Bottom-left edge moving right along row 6 (from red start area)
    [1,6],[2,6],[3,6],[4,6],[5,6],
    // Up the left column at col 6
    [6,5],[6,4],[6,3],[6,2],[6,1],[6,0],
    // Top: col 7 at row 0, then row 0 col 8, then turn
    [7,0],
    [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],
    // Right: row 6 across cols 9..14
    [9,6],[10,6],[11,6],[12,6],[13,6],[14,6],
    // Down col 7 (rows 7..)
    [14,7],
    // Continue right side: rows 7..  (col 14 row 7 then 14,8?), but we move down col 14? Actually after (14,7)
    [14,8],[13,8],[12,8],[11,8],[10,8],[9,8],
    // Down col 8 to bottom
    [8,9],[8,10],[8,11],[8,12],[8,13],[8,14],
    // Bottom row across to col 6
    [7,14],
    [6,14],[6,13],[6,12],[6,11],[6,10],[6,9],
    // Left side row 8 from col 5 back to col 0
    [5,8],[4,8],[3,8],[2,8],[1,8],[0,8],
    // Up col 0 from row 8 -> row 7 -> row 6, then loop wraps to (1,6) = red start
    [0,7],[0,6]
  ];

  // sanity: must be 52 cells
  if (PATH.length !== 52) {
    console.error('Ludo PATH length is', PATH.length, 'expected 52');
  }

  // index in PATH where each color's token enters the board (start cell)
  const START_INDEX = {
    red: 0,      // (1,6)
    green: 13,   // (8,1)
    yellow: 26,  // (13,8)
    blue: 39     // (6,13)
  };

  // Path index of the LAST main-loop cell before each color diverts into its
  // home stretch. From this cell, the next step puts the token on home[0].
  // (start + 50) mod 52 — i.e. token traverses 51 main-loop cells then turns.
  const HOME_ENTRY = {
    red:    (START_INDEX.red    + 50) % 52, // 50 -> (0,7)
    green:  (START_INDEX.green  + 50) % 52, // 11 -> (7,0)
    yellow: (START_INDEX.yellow + 50) % 52, // 24 -> (14,7)
    blue:   (START_INDEX.blue   + 50) % 52  // 37 -> (7,14)
  };

  // home stretch coordinates for each color (6 cells leading to center)
  const HOME_STRETCH = {
    red:    [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
    green:  [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
    yellow: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
    blue:   [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]]
  };

  // safe cells: stars + each color's start cell
  const SAFE_PATH_INDICES = new Set([
    START_INDEX.red, START_INDEX.green, START_INDEX.yellow, START_INDEX.blue,
    // Classic Ludo stars (8 safe spots total, one is each start, plus 4 extras)
    8,  21, 34, 47
  ]);

  // home base "yard" slots (where tokens sit before entering board) — for each color, 4 spots
  const YARD = {
    red:    [[1.5, 1.5],[3.5, 1.5],[1.5, 3.5],[3.5, 3.5]],
    green:  [[10.5,1.5],[12.5,1.5],[10.5,3.5],[12.5,3.5]],
    yellow: [[10.5,10.5],[12.5,10.5],[10.5,12.5],[12.5,12.5]],
    blue:   [[1.5,10.5],[3.5,10.5],[1.5,12.5],[3.5,12.5]]
  };

  // center "home" position for tokens that finished
  const FINISH_CENTER = {
    red:    [6.5, 7.5],
    green:  [7.5, 6.5],
    yellow: [8.5, 7.5],
    blue:   [7.5, 8.5]
  };

  const COLORS = ['red', 'green', 'yellow', 'blue'];

  // ---- helpers ----
  /**
   * Convert a token's logical state {state, idx} into a board (col,row) coord.
   *  state: 'yard' | 'path' | 'home' | 'finished'
   *  idx:   yard slot (0..3), main-path index (0..51), home stretch (0..5), finished (0..3)
   */
  function tokenCoord(color, state, idx, slotInCell = 0) {
    let cx, cy;
    if (state === 'yard') {
      [cx, cy] = YARD[color][idx];
    } else if (state === 'path') {
      [cx, cy] = PATH[idx];
      cx += 0.5; cy += 0.5;
    } else if (state === 'home') {
      [cx, cy] = HOME_STRETCH[color][idx];
      cx += 0.5; cy += 0.5;
    } else if (state === 'finished') {
      [cx, cy] = FINISH_CENTER[color];
      // small ring around center per slotInCell
      const angle = (idx / 4) * Math.PI * 2;
      cx += Math.cos(angle) * 0.4;
      cy += Math.sin(angle) * 0.4;
    } else {
      cx = 7.5; cy = 7.5;
    }
    // multi-token offset within the same cell
    if (slotInCell > 0 && state !== 'yard' && state !== 'finished') {
      const dx = [0, 0.18, -0.18, 0.18, -0.18][slotInCell] || 0;
      const dy = [0, -0.18, -0.18, 0.18, 0.18][slotInCell] || 0;
      cx += dx; cy += dy;
    }
    return [cx, cy];
  }

  /**
   * Given a token currently at path index `from` belonging to `color`, and a
   * dice roll `steps`, return where it lands: { state, idx } or null if illegal.
   */
  function advance(color, token, steps) {
    if (token.state === 'yard') {
      if (steps === 6) {
        return { state: 'path', idx: START_INDEX[color] };
      }
      return null; // need 6 to come out
    }
    if (token.state === 'path') {
      // does this move take us through the HOME_ENTRY into the stretch?
      const start = START_INDEX[color];
      // distance already travelled on main loop (from this color's perspective)
      const traveled = (token.idx - start + 52) % 52;
      const newTraveled = traveled + steps;
      if (newTraveled < 51) {
        return { state: 'path', idx: (token.idx + steps) % 52 };
      } else if (newTraveled < 57) {
        // enter home stretch; cell index in stretch = newTraveled - 51
        return { state: 'home', idx: newTraveled - 51 };
      } else if (newTraveled === 57) {
        return { state: 'finished', idx: 0 }; // exact landing on center
      }
      return null; // overshoot
    }
    if (token.state === 'home') {
      const next = token.idx + steps;
      if (next < 6) return { state: 'home', idx: next };
      if (next === 6) return { state: 'finished', idx: 0 };
      return null;
    }
    return null;
  }

  function isSafe(state, idx) {
    if (state === 'home' || state === 'finished' || state === 'yard') return true;
    return SAFE_PATH_INDICES.has(idx);
  }

  window.LudoBoard = {
    PATH,
    START_INDEX,
    HOME_ENTRY,
    HOME_STRETCH,
    SAFE_PATH_INDICES,
    YARD,
    FINISH_CENTER,
    COLORS,
    tokenCoord,
    advance,
    isSafe
  };
})();
