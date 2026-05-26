// game-logic.jsx — Pure game logic, no React. Exposed via window.

const COLS = 7;
const ROWS = 12;

// ─── Letter generation ───────────────────────────────────────
const VOWELS = "AAEEEIIIOU".split("");
const CONS = "BCCDDFFGGHKLLLMMNNPPRRRSSTTTW".split("");

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateDiceLetters() {
  // 2-3 vowels per dice for playability
  const numVowels = Math.random() < 0.55 ? 2 : 3;
  const letters = [];
  for (let i = 0; i < numVowels; i++) letters.push(pick(VOWELS));
  while (letters.length < 6) letters.push(pick(CONS));
  return shuffle(letters);
}

// ─── 3D dice face state ──────────────────────────────────────
// 6 face positions: F=front, B=back, U=up (top), D=down (bottom), L=left, R=right
// Each holds an index into the dice's letters array (0-5).

function initialFaceState() {
  return { F: 0, B: 1, U: 2, D: 3, L: 4, R: 5 };
}

// swipe-right: cube spins so the right face comes to front.
// after rotation: new F = old R, new B = old L, new L = old F, new R = old B
function rotateRight(s) {
  return { F: s.R, B: s.L, L: s.F, R: s.B, U: s.U, D: s.D };
}
// swipe-left: left face comes to front.
function rotateLeft(s) {
  return { F: s.L, B: s.R, L: s.B, R: s.F, U: s.U, D: s.D };
}
// swipe-up: top face comes to front.
function rotateUp(s) {
  return { F: s.U, B: s.D, U: s.B, D: s.F, L: s.L, R: s.R };
}
// rotate-down: bottom face comes to front.
function rotateDown(s) {
  return { F: s.D, B: s.U, U: s.F, D: s.B, L: s.L, R: s.R };
}

// ─── Board operations ────────────────────────────────────────

function makeEmptyBoard() {
  const board = [];
  for (let r = 0; r < ROWS; r++) {
    board.push(new Array(COLS).fill(null));
  }
  return board;
}

// Find the lowest empty row in a column starting from a given row.
function findDropRow(board, col, fromRow = 0) {
  for (let r = fromRow; r < ROWS; r++) {
    if (board[r] && board[r][col] !== null) return r - 1;
  }
  return ROWS - 1;
}

// Apply gravity: in each column, settle non-null cells to the bottom.
function applyGravity(board) {
  const newBoard = makeEmptyBoard();
  for (let c = 0; c < COLS; c++) {
    const stack = [];
    for (let r = 0; r < ROWS; r++) {
      if (board[r][c] !== null) stack.push(board[r][c]);
    }
    // place from bottom up
    for (let i = 0; i < stack.length; i++) {
      newBoard[ROWS - 1 - i][c] = stack[stack.length - 1 - i];
    }
  }
  return newBoard;
}

// ─── Word finding ────────────────────────────────────────────

const DIRS = [
  [0, 1, "H"],    // horizontal: read left→right
  [1, 0, "V"],    // vertical: read top→bottom
  [1, 1, "D1"],   // diagonal ↘: read top-left→bottom-right
  [-1, 1, "D2"],  // diagonal ↗: read bottom-left→top-right
];

// Find all valid words that include the cell (r0, c0).
// Words are only valid READ FORWARD: left-to-right, top-to-bottom, ↘, or ↗.
// Backwards (right-to-left, bottom-to-top, etc.) does NOT count.
// Returns: array of { word, cells: [[r,c],...], dir }
function findWordsThrough(board, r0, c0, wordSet) {
  if (!board[r0][c0]) return [];
  const found = [];

  for (const [dr, dc, dirLabel] of DIRS) {
    // Walk back from (r0,c0) to start of the contiguous run
    let sr = r0, sc = c0;
    while (true) {
      const nr = sr - dr, nc = sc - dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
      if (board[nr][nc] === null) break;
      sr = nr; sc = nc;
    }
    // Walk forward to end
    let er = r0, ec = c0;
    while (true) {
      const nr = er + dr, nc = ec + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
      if (board[nr][nc] === null) break;
      er = nr; ec = nc;
    }
    // Build cells array from (sr,sc) to (er,ec) — always in forward (dr,dc) direction
    const cells = [];
    let cr = sr, cc = sc;
    while (true) {
      cells.push([cr, cc, board[cr][cc]]);
      if (cr === er && cc === ec) break;
      cr += dr; cc += dc;
    }
    if (cells.length < 3) continue;

    const newTileIdx = cells.findIndex(([rr, cc]) => rr === r0 && cc === c0);

    // Only check word reading in the FORWARD direction (no reversed)
    for (let len = cells.length; len >= 3; len--) {
      for (let start = 0; start + len <= cells.length; start++) {
        if (start > newTileIdx) break;
        if (start + len <= newTileIdx) continue;
        const segment = cells.slice(start, start + len);
        const wordStr = segment.map(c => c[2]).join("");
        if (wordSet.has(wordStr)) {
          found.push({
            word: wordStr,
            cells: segment.map(c => [c[0], c[1]]),
            dir: dirLabel,
          });
        }
      }
    }
  }

  // Dedupe + prefer longest per direction
  const result = [];
  found.sort((a, b) => b.cells.length - a.cells.length);
  const consumed = new Map();
  for (const w of found) {
    const key = (rr, cc) => `${w.dir}-${rr}-${cc}`;
    const allConsumed = w.cells.every(([r, c]) => consumed.has(key(r, c)));
    if (allConsumed) continue;
    for (const [r, c] of w.cells) consumed.set(key(r, c), true);
    result.push(w);
  }
  return result;
}

// ─── Scoring ─────────────────────────────────────────────────

function scoreForWord(word) {
  const len = word.length;
  if (len === 3) return 30;
  if (len === 4) return 70;
  if (len === 5) return 140;
  if (len === 6) return 250;
  if (len === 7) return 400;
  return 600;
}

// ─── Level definitions ───────────────────────────────────────

// extrasMax     = max number of simultaneous auto-falling letters alongside the dice
// extrasSpawnMs = how often a new extra appears (spaced out)
// extrasFallMs  = how long each row-drop takes for an extra
const LEVELS = [
  { id: 1, name: "WARM-UP", target: 100, blocks: 18, time: 120, fallMs: 900, sparkles: 5, modifier: null,
    extrasMax: 0, extrasSpawnMs: 0, extrasFallMs: 0 },
  { id: 2, name: "FLOW", target: 220, blocks: 22, time: 115, fallMs: 800, sparkles: 6, modifier: null,
    extrasMax: 1, extrasSpawnMs: 7500, extrasFallMs: 1700 },
  { id: 3, name: "BOSS: VERBALIZE", target: 180, blocks: 18, time: 100, fallMs: 720, sparkles: 6, modifier: "verbs",
    modifierLabel: "Verbs only", modifierDesc: "Only verbs count toward your score.",
    extrasMax: 1, extrasSpawnMs: 6000, extrasFallMs: 1500 },
  { id: 4, name: "ACCELERATE", target: 320, blocks: 24, time: 100, fallMs: 620, sparkles: 7, modifier: null,
    extrasMax: 2, extrasSpawnMs: 5000, extrasFallMs: 1400 },
  { id: 5, name: "BOSS: WILDERNESS", target: 220, blocks: 20, time: 100, fallMs: 580, sparkles: 7, modifier: "nature",
    modifierLabel: "Nature only", modifierDesc: "Only nature-themed words count.",
    extrasMax: 2, extrasSpawnMs: 4500, extrasFallMs: 1300 },
  { id: 6, name: "MASTERY", target: 500, blocks: 26, time: 95, fallMs: 500, sparkles: 8, modifier: null,
    extrasMax: 3, extrasSpawnMs: 3800, extrasFallMs: 1200 },
];

// Pool used when auto-spawning extras — vowel-rich for playability.
function pickExtraLetter() {
  if (Math.random() < 0.45) return pick(VOWELS);
  return pick(CONS);
}

function getLevel(idx) {
  return LEVELS[Math.min(idx, LEVELS.length - 1)];
}

// ─── Sparkle seed letters ────────────────────────────────────
// Place N sparkle letters at the bottom of random columns.
// Returns array of { row, col, letter }.

const SPARKLE_POOL = "AAEEEIIOOURRSSTTNNLLDCMP".split("");

function generateSparkles(count) {
  const cols = shuffle([...Array(COLS).keys()]); // 0..COLS-1 shuffled
  const sparkles = [];
  // Sprinkle across columns; if count > COLS, allow some columns to have 2 stacked
  for (let i = 0; i < count; i++) {
    const c = cols[i % cols.length];
    // For stacked sparkles, row goes up
    const stackIdx = Math.floor(i / cols.length);
    const r = ROWS - 1 - stackIdx;
    if (r < ROWS - 3) break; // don't seed too high
    sparkles.push({ r, c, letter: pick(SPARKLE_POOL) });
  }
  return sparkles;
}

// ─── Filter words by modifier ────────────────────────────────

function wordPassesModifier(word, modifier) {
  if (!modifier) return true;
  if (modifier === "verbs") return window.VERB_SET.has(word);
  if (modifier === "nature") return window.NATURE_SET.has(word);
  return true;
}

// Export
window.GameLogic = {
  COLS, ROWS,
  generateDiceLetters, shuffle, pick,
  initialFaceState, rotateRight, rotateLeft, rotateUp, rotateDown,
  makeEmptyBoard, findDropRow, applyGravity,
  findWordsThrough, scoreForWord,
  LEVELS, getLevel, wordPassesModifier,
  generateSparkles, pickExtraLetter,
};
