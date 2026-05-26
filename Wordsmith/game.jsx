// game.jsx — Main React game component

const { useState, useEffect, useRef, useCallback, useMemo } = React;
const G = window.GameLogic;
const { COLS, ROWS } = G;

const CELL = 50;
const BOARD_W = COLS * CELL;
const BOARD_H = ROWS * CELL;

// Tunable speeds
const FALL_INTERVAL_MS = 850; // ms per row of natural fall
const SOFT_DROP_FALL_MS = 70;
const HARD_DROP_FALL_MS = 18;

// ─── Letter tinting ──────────────────────────────────────────
// Map each letter A-Z to a hue (0-360). Subtle tint applied to tiles/dice faces.
function letterHue(letter) {
  if (!letter) return 40;
  const code = letter.toUpperCase().charCodeAt(0) - 65;
  // Coprime multiplier spreads hues distinctly; phase shift keeps it warm-leaning
  return ((code * 53) + 30) % 360;
}

// ─── Active block state shape ────────────────────────────────
// {
//   col: number, row: number,
//   letters: string[6],
//   perm: { F, B, U, D, L, R },  // face indices
//   rotX: number, rotY: number,  // accumulated CSS rotation
//   hardDrop: boolean,
// }

function makeNewActiveBlock(startCol) {
  if (startCol === undefined) startCol = Math.floor(Math.random() * COLS);
  return {
    col: startCol,
    row: 0,
    letters: G.generateDiceLetters(),
    perm: G.initialFaceState(),
    rotX: 0,
    rotY: 0,
    hardDrop: false,
    id: Date.now() + Math.random(),
  };
}

function frontLetterOf(block) {
  return block.letters[block.perm.F];
}

// Pick the best letter for a wild tile at (r, c): tries each letter A-Z,
// returns the one yielding the highest word score (with modifier respected).
function findBestWildLetter(board, r, c, modifier) {
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  let bestLetter = "E";
  let bestScore = -1;
  for (const l of LETTERS) {
    const testBoard = board.map(row => [...row]);
    testBoard[r][c] = l;
    const words = G.findWordsThrough(testBoard, r, c, window.WORDS);
    const valid = words.filter(w => G.wordPassesModifier(w.word, modifier));
    const score = valid.reduce((s, w) => s + G.scoreForWord(w.word), 0);
    if (score > bestScore) {
      bestScore = score;
      bestLetter = l;
    }
  }
  return bestLetter;
}

// ─── Tile entry (locked block on board) ──────────────────────
// We render locked tiles as objects { letter, key, entering }
// stored in a map by `${r}-${c}` so positions can change (gravity) with animation.

function App() {
  const [phase, setPhase] = useState("start"); // start | playing | level-clear | game-over | boss-intro
  const [levelIdx, setLevelIdx] = useState(0);
  const [board, setBoard] = useState(G.makeEmptyBoard()); // 2D array of letter or null
  const [tileIds, setTileIds] = useState(() => {
    // parallel structure tracking React keys per cell
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  });
  const [active, setActive] = useState(null);
  const [nextQueue, setNextQueue] = useState([]);
  const [score, setScore] = useState(0);
  const [blocksLeft, setBlocksLeft] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0);
  const [foundWords, setFoundWords] = useState([]); // all words found this run, for game over screen
  const [highlightCells, setHighlightCells] = useState(new Set()); // "r-c" strings
  const [dissolvingCells, setDissolvingCells] = useState(new Set());
  const [callouts, setCallouts] = useState([]);
  const [scorePops, setScorePops] = useState([]);
  const [powerups, setPowerups] = useState({ destroy: 2, scramble: 2, bomb: 1, move: 1, time: 1, magic: 1 });
  const [coins, setCoins] = useState(0);
  const [armedPower, setArmedPower] = useState(null); // null | 'destroy' | 'bomb' | 'move'
  const [selectedTile, setSelectedTile] = useState(null); // for move powerup: { r, c }
  const [frozenUntil, setFrozenUntil] = useState(0); // for visual freeze indicator
  const [lockFlash, setLockFlash] = useState(null);
  const [particles, setParticles] = useState([]);
  const [showHint, setShowHint] = useState(false);
  const [wordFlash, setWordFlash] = useState(null);
  const [draggingTile, setDraggingTile] = useState(null); // { fromR, fromC, targetCol }
  const [extras, setExtras] = useState([]); // [{ id, letter, col, row, lastFall }] — auto-falling letters alongside the dice

  // refs for input tracking
  const touchRef = useRef(null);
  const fallIntervalRef = useRef(null);
  const timerRef = useRef(null);
  const lockedRef = useRef(false);
  const rotatingRef = useRef(false);
  const frozenRef = useRef(0);
  const powerupsRef = useRef({});
  const lastFallTimeRef = useRef(0);
  const boardRef = useRef(board);
  const activeRef = useRef(active);
  const phaseRef = useRef(phase);
  const levelRef = useRef(levelIdx);
  const blocksLeftRef = useRef(0);
  const nextQueueRef = useRef([]);
  const scoreRef = useRef(0);
  const extrasRef = useRef([]);
  const lastExtraSpawnRef = useRef(0);

  useEffect(() => { extrasRef.current = extras; }, [extras]);
  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { levelRef.current = levelIdx; }, [levelIdx]);
  useEffect(() => { blocksLeftRef.current = blocksLeft; }, [blocksLeft]);
  useEffect(() => { nextQueueRef.current = nextQueue; }, [nextQueue]);
  useEffect(() => { scoreRef.current = score; }, [score]);
  useEffect(() => { powerupsRef.current = powerups; }, [powerups]);

  const level = G.getLevel(levelIdx);

  // ─── Start / level management ──────────────────────────────
  const startLevel = useCallback((idx) => {
    const lvl = G.getLevel(idx);
    const newBoard = G.makeEmptyBoard();
    const newTileIds = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

    // Seed sparkle letters at the bottom — tileIds prefixed with "sparkle-"
    const sparkles = G.generateSparkles(lvl.sparkles || 0);
    sparkles.forEach(({ r, c, letter }) => {
      newBoard[r][c] = letter;
      newTileIds[r][c] = `sparkle-${r}-${c}-${Date.now()}-${Math.random()}`;
    });

    setBoard(newBoard);
    boardRef.current = newBoard;
    setTileIds(newTileIds);
    setActive(makeNewActiveBlock());
    setNextQueue([makeNewActiveBlock(), makeNewActiveBlock()]);
    setBlocksLeft(lvl.blocks - 1); // we already created the first active block
    setTimeLeft(lvl.time);
    setHighlightCells(new Set());
    setDissolvingCells(new Set());
    setCallouts([]);
    setArmedPower(null);
    setSelectedTile(null);
    setFrozenUntil(0);
    frozenRef.current = 0;
    setScore(0);
    scoreRef.current = 0;
    lockedRef.current = false;
    setExtras([]);
    extrasRef.current = [];
    // Delay first extra spawn so the player isn't ambushed at level start.
    lastExtraSpawnRef.current = Date.now() + 2500;
    setPhase("playing");
  }, []);

  const startGame = useCallback(() => {
    setLevelIdx(0);
    setScore(0);
    setFoundWords([]);
    setPowerups({ destroy: 2, scramble: 2, bomb: 1 });
    // show boss intro if level 0 is a boss (it isn't), else just start
    const lvl = G.getLevel(0);
    if (lvl.modifier) {
      setPhase("boss-intro");
    } else {
      startLevel(0);
    }
  }, [startLevel]);

  const nextLevel = useCallback(() => {
    // Award coins based on this level's score + flat bonus
    const lvl = G.getLevel(levelRef.current);
    const earned = Math.floor(scoreRef.current / 8) + 5;
    setCoins(c => c + earned);
    setPhase("shop");
  }, []);

  const continueFromShop = useCallback(() => {
    const nextIdx = levelIdx + 1;
    const nextLvl = G.getLevel(nextIdx);
    setLevelIdx(nextIdx);
    if (nextLvl.modifier) {
      setPhase("boss-intro");
    } else {
      startLevel(nextIdx);
    }
  }, [levelIdx, startLevel]);

  const buyItem = useCallback((name, cost) => {
    if (coins < cost) return;
    setCoins(c => c - cost);
    setPowerups(p => ({ ...p, [name]: (p[name] || 0) + 1 }));
  }, [coins]);

  // ─── Block falling tick ────────────────────────────────────
  // Independent of `active` changes (so rotations don't reset the fall timer).
  useEffect(() => {
    if (phase !== "playing") return;
    lastFallTimeRef.current = Date.now();
    let lastBlockId = null;

    const tick = () => {
      const a = activeRef.current;
      if (!a || lockedRef.current) return;

      // Freeze (stop-time powerup): skip ticks until expired
      if (frozenRef.current && Date.now() < frozenRef.current) {
        lastFallTimeRef.current = Date.now();
        return;
      }

      // Pause natural fall while user is dragging the dice
      if (a.pixelX !== undefined) {
        lastFallTimeRef.current = Date.now();
        return;
      }

      // Reset timer when a new block spawns — start ALMOST ready to fall (instant feel)
      if (lastBlockId !== a.id) {
        lastBlockId = a.id;
        const lvl = G.getLevel(levelRef.current);
        const fallMs = lvl.fallMs || 850;
        lastFallTimeRef.current = Date.now() - fallMs + 80;
      }

      const now = Date.now();
      const lvl = G.getLevel(levelRef.current);
      const fallMs = a.hardDrop ? HARD_DROP_FALL_MS : (lvl.fallMs || 850);

      if (now - lastFallTimeRef.current >= fallMs) {
        lastFallTimeRef.current = now;
        const curBoard = boardRef.current;
        const nextRow = a.row + 1;
        const extraAtTarget = nextRow < ROWS && extrasRef.current.some(x => x.row === nextRow && x.col === a.col);
        if (nextRow >= ROWS || curBoard[nextRow][a.col] !== null || extraAtTarget) {
          if (a.row < 0 || curBoard[a.row][a.col] !== null) {
            setPhase("game-over");
            return;
          }
          lockBlock(a);
        } else {
          setActive(prev => prev ? { ...prev, row: nextRow } : prev);
        }
      }
    };

    const intervalId = setInterval(tick, 40);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line
  }, [phase]);

  // ─── Extras (auto-falling letters) tick ────────────────────
  // Independent of `active`. Spawns letters from the top at a level-defined cadence,
  // each falling on its own timer, locking on collision into the board.
  useEffect(() => {
    if (phase !== "playing") return;
    let stopped = false;

    const lockExtraIntoBoard = (ext, settleRow) => {
      const cur = boardRef.current.map(row => [...row]);
      cur[settleRow][ext.col] = ext.letter;
      boardRef.current = cur;
      setBoard(cur);
      setTileIds(prev => {
        const nt = prev.map(row => [...row]);
        nt[settleRow][ext.col] = `extra-${ext.id}`;
        return nt;
      });
      // brief flash like main lock
      setLockFlash({ row: settleRow, col: ext.col, key: Date.now() + Math.random() });
      setTimeout(() => setLockFlash(prev => (prev && prev.row === settleRow && prev.col === ext.col) ? null : prev), 320);
      // word check — non-blocking
      setTimeout(() => {
        const modifier = G.getLevel(levelRef.current).modifier;
        const ws = G.findWordsThrough(boardRef.current, settleRow, ext.col, window.WORDS)
          .filter(w => G.wordPassesModifier(w.word, modifier));
        if (ws.length > 0) processWordsAt(settleRow, ext.col, boardRef.current);
      }, 60);
    };

    const tick = () => {
      if (stopped) return;
      if (frozenRef.current && Date.now() < frozenRef.current) return;
      const lvl = G.getLevel(levelRef.current);
      const maxExtras = lvl.extrasMax || 0;
      const fallMs = lvl.extrasFallMs || 1500;
      const spawnMs = lvl.extrasSpawnMs || 0;
      const now = Date.now();

      // 1) Spawn? Only while there are still primary blocks to draw, room on board.
      if (maxExtras > 0 && spawnMs > 0
          && extrasRef.current.length < maxExtras
          && blocksLeftRef.current > 0
          && now - lastExtraSpawnRef.current >= spawnMs) {
        const a = activeRef.current;
        // Prefer columns NOT occupied by the active dice and with a free top row
        const candidates = [];
        for (let c = 0; c < COLS; c++) {
          if (boardRef.current[0][c] !== null) continue;
          if (extrasRef.current.some(x => x.col === c && x.row <= 1)) continue;
          if (a && a.col === c && a.row <= 1) continue;
          candidates.push(c);
        }
        if (candidates.length > 0) {
          const col = candidates[Math.floor(Math.random() * candidates.length)];
          const newExtra = {
            id: `${now}-${Math.random().toString(36).slice(2, 6)}`,
            letter: G.pickExtraLetter(),
            col,
            row: 0,
            lastFall: now,
          };
          extrasRef.current = [...extrasRef.current, newExtra];
          setExtras(extrasRef.current);
          lastExtraSpawnRef.current = now;
        }
      }

      // 2) Advance each extra and lock when it can't go further.
      let changed = false;
      const stillFalling = [];
      for (const ext of extrasRef.current) {
        if (now - ext.lastFall < fallMs) {
          stillFalling.push(ext);
          continue;
        }
        const nextRow = ext.row + 1;
        const a = activeRef.current;
        const blockedByActive = a && a.col === ext.col && a.row === nextRow;
        const blockedByOtherExtra = extrasRef.current.some(o => o !== ext && o.col === ext.col && o.row === nextRow);
        if (nextRow >= ROWS || boardRef.current[nextRow][ext.col] !== null || blockedByActive || blockedByOtherExtra) {
          // Lock at current row (if valid), else discard.
          if (ext.row >= 0 && boardRef.current[ext.row][ext.col] === null) {
            lockExtraIntoBoard(ext, ext.row);
          }
          changed = true;
        } else {
          stillFalling.push({ ...ext, row: nextRow, lastFall: now });
          changed = true;
        }
      }
      if (changed) {
        extrasRef.current = stillFalling;
        setExtras(stillFalling);
      }
    };

    const id = setInterval(tick, 60);
    return () => { stopped = true; clearInterval(id); };
    // eslint-disable-next-line
  }, [phase]);

  // ─── Timer ─────────────────────────────────────────────────
  // Uses refs for score/level so it doesn't restart on every score change.
  useEffect(() => {
    if (phase !== "playing") return;
    const t = setInterval(() => {
      // Honour stop-time freeze
      if (frozenRef.current && Date.now() < frozenRef.current) return;
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(t);
          const lvl = G.getLevel(levelRef.current);
          if (scoreRef.current >= lvl.target) {
            setPhase("level-clear");
          } else {
            setPhase("game-over");
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  const spawnNextBlock = useCallback(() => {
    if (blocksLeftRef.current <= 0) {
      setActive(null);
      return false;
    }
    const nq = nextQueueRef.current;
    setActive(nq[0]);
    setNextQueue(prev => [...prev.slice(1), makeNewActiveBlock()]);
    setBlocksLeft(prev => prev - 1);
    return true;
  }, []);

  const checkLevelEnd = useCallback(() => {
    const lvl = G.getLevel(levelRef.current);
    if (scoreRef.current >= lvl.target) {
      setTimeout(() => setPhase("level-clear"), 350);
      return true;
    }
    if (blocksLeftRef.current <= 0) {
      // No blocks left; if there's also no active falling block, it's game over
      setTimeout(() => {
        if (!activeRef.current && scoreRef.current < lvl.target) {
          setPhase("game-over");
        }
      }, 600);
      return false;
    }
    return false;
  }, []);

  // ─── Lock block, find words, score ─────────────────────────
  const lockBlock = useCallback((blk) => {
    if (lockedRef.current) return;
    lockedRef.current = true;

    const r = blk.row, c = blk.col;
    let letter;
    if (blk.isWild) {
      const modifier = G.getLevel(levelRef.current).modifier;
      letter = findBestWildLetter(boardRef.current, r, c, modifier);
    } else {
      letter = frontLetterOf(blk);
    }

    setLockFlash({ row: r, col: c, key: Date.now() });
    setTimeout(() => setLockFlash(null), 400);

    const newBoard = boardRef.current.map(row => [...row]);
    newBoard[r][c] = letter;
    boardRef.current = newBoard;
    setBoard(newBoard);

    setTileIds(prev => {
      const nt = prev.map(row => [...row]);
      nt[r][c] = blk.isWild
        ? `magic-${Date.now()}-${Math.random()}`
        : `tile-${Date.now()}-${Math.random()}`;
      return nt;
    });

    // Continuous fall: spawn the next block IMMEDIATELY so the player always has one falling.
    spawnNextBlock();
    lockedRef.current = false;

    // Process words in the background — doesn't block the next block.
    setTimeout(() => {
      processWordsAt(r, c, newBoard);
    }, 50);
  }, [spawnNextBlock]);

  // Process word formation, scoring, gravity. Recurses if gravity creates new words.
  const processWordsAt = useCallback((r, c, currentBoard) => {
    const modifier = G.getLevel(levelRef.current).modifier;
    const allWords = G.findWordsThrough(currentBoard, r, c, window.WORDS);
    // Filter by modifier
    const validWords = allWords.filter(w => G.wordPassesModifier(w.word, modifier));

    if (validWords.length === 0) {
      // No words — just advance to next block
      finalizeLock();
      return;
    }

    // Highlight tiles
    const cellsToHighlight = new Set();
    validWords.forEach(w => w.cells.forEach(([rr, cc]) => cellsToHighlight.add(`${rr}-${cc}`)));
    setHighlightCells(cellsToHighlight);

    // Calculate score with multi-word multiplier
    let total = validWords.reduce((s, w) => s + G.scoreForWord(w.word), 0);
    if (validWords.length >= 2) total = Math.round(total * 1.5);
    if (validWords.length >= 3) total = Math.round(total * 1.3);

    // Add callouts for each word
    const newCallouts = validWords.map((w, i) => {
      const midCell = w.cells[Math.floor(w.cells.length / 2)];
      const px = midCell[1] * CELL + CELL / 2;
      const py = midCell[0] * CELL - 8;
      return {
        id: Date.now() + i,
        word: w.word,
        pts: G.scoreForWord(w.word),
        x: px,
        y: py,
      };
    });
    setCallouts(prev => [...prev, ...newCallouts]);
    setTimeout(() => {
      setCallouts(prev => prev.filter(c => !newCallouts.find(n => n.id === c.id)));
    }, 1700);

    // Score pop in HUD
    const popId = Date.now();
    setScorePops(prev => [...prev, { id: popId, value: total }]);
    setTimeout(() => setScorePops(prev => prev.filter(p => p.id !== popId)), 1200);

    setScore(s => s + total);
    setFoundWords(prev => [...prev, ...validWords.map(w => w.word)]);

    // Trigger multicolor background flash — intensity scales with words count + length
    const maxLen = validWords.reduce((m, w) => Math.max(m, w.cells.length), 0);
    const flashIntensity = Math.min(3, Math.max(1, Math.floor(maxLen / 2) + validWords.length - 1));
    const flashId = Date.now() + Math.random();
    setWordFlash({ id: flashId, intensity: flashIntensity });
    setTimeout(() => setWordFlash(prev => prev && prev.id === flashId ? null : prev), 950);

    // Spawn particles
    const newParts = [];
    cellsToHighlight.forEach(key => {
      const [rr, cc] = key.split("-").map(Number);
      const cx = cc * CELL + CELL / 2;
      const cy = rr * CELL + CELL / 2;
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2 + Math.random();
        const dist = 28 + Math.random() * 20;
        newParts.push({
          id: `${popId}-${rr}-${cc}-${i}`,
          x: cx,
          y: cy,
          dx: Math.cos(angle) * dist,
          dy: Math.sin(angle) * dist,
          color: i % 2 ? "#ffd166" : "#ff7a59",
        });
      }
    });
    setParticles(prev => [...prev, ...newParts]);
    setTimeout(() => {
      setParticles(prev => prev.filter(p => !newParts.find(n => n.id === p.id)));
    }, 1000);

    // After 550ms, dissolve and apply gravity
    setTimeout(() => {
      setHighlightCells(new Set());
      setDissolvingCells(cellsToHighlight);

      setTimeout(() => {
        // remove tiles, apply gravity
        const cleared = currentBoard.map(row => [...row]);
        cellsToHighlight.forEach(key => {
          const [rr, cc] = key.split("-").map(Number);
          cleared[rr][cc] = null;
        });
        const settled = G.applyGravity(cleared);

        // Also settle tileIds in parallel
        setTileIds(prevIds => {
          const idsCleared = prevIds.map(row => [...row]);
          cellsToHighlight.forEach(key => {
            const [rr, cc] = key.split("-").map(Number);
            idsCleared[rr][cc] = null;
          });
          // apply gravity to IDs identically
          const newIds = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
          for (let cc = 0; cc < COLS; cc++) {
            const stack = [];
            for (let rr = 0; rr < ROWS; rr++) {
              if (idsCleared[rr][cc] !== null) stack.push(idsCleared[rr][cc]);
            }
            for (let i = 0; i < stack.length; i++) {
              newIds[ROWS - 1 - i][cc] = stack[stack.length - 1 - i];
            }
          }
          return newIds;
        });

        setBoard(settled);
        boardRef.current = settled;
        setDissolvingCells(new Set());

        // After gravity settles, check if new words formed at any cell
        setTimeout(() => {
          // Look for words at any cell that has letters around it (simplest: scan ALL cells)
          const chainWords = findAllWords(settled, modifier);
          if (chainWords.length > 0) {
            // Pick one cell from any of them and process (kicks off chain reaction)
            const cell = chainWords[0].cells[0];
            processWordsAt(cell[0], cell[1], settled);
          } else {
            finalizeLock();
          }
        }, 350);
      }, 500);
    }, 550);
  }, []);

  // Find ALL valid words on board (used to detect chains after gravity)
  const findAllWords = (b, modifier) => {
    const seen = new Set();
    const all = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (b[r][c]) {
          const ws = G.findWordsThrough(b, r, c, window.WORDS);
          for (const w of ws) {
            if (!G.wordPassesModifier(w.word, modifier)) continue;
            const key = w.dir + "-" + w.cells.map(x => x.join(",")).join("|");
            if (!seen.has(key)) {
              seen.add(key);
              all.push(w);
            }
          }
        }
      }
    }
    return all;
  };

  const finalizeLock = useCallback(() => {
    // Next-block spawning happens immediately on lockBlock now (continuous fall).
    // This just checks whether the level should end.
    checkLevelEnd();
  }, [checkLevelEnd]);

  // ─── Input handling (all stable callbacks reading from refs) ─────

  const moveColumn = useCallback((dir) => {
    if (phaseRef.current !== "playing") return;
    const a = activeRef.current;
    if (!a || a.hardDrop) return;
    setActive(prev => {
      if (!prev) return prev;
      const newCol = Math.max(0, Math.min(COLS - 1, prev.col + dir));
      if (prev.row >= 0 && boardRef.current[prev.row][newCol] !== null) return prev;
      return { ...prev, col: newCol };
    });
  }, []);

  const moveToColumn = useCallback((col) => {
    if (phaseRef.current !== "playing") return;
    const a = activeRef.current;
    if (!a || a.hardDrop) return;
    setActive(prev => {
      if (!prev) return prev;
      const newCol = Math.max(0, Math.min(COLS - 1, col));
      if (newCol === prev.col) return prev;
      if (prev.row >= 0 && boardRef.current[prev.row][newCol] !== null) return prev;
      return { ...prev, col: newCol };
    });
  }, []);

  const rotateDice = useCallback((dir) => {
    if (phaseRef.current !== "playing") return;
    const a = activeRef.current;
    if (!a || a.hardDrop) return;
    if (rotatingRef.current) return;
    rotatingRef.current = true;

    // Direction mapping: the visible front face moves IN the swipe direction,
    // and a new face slides in from the opposite side.
    //   swipe LEFT → front face slides left, what was on the RIGHT comes to front
    //   swipe RIGHT → front face slides right, what was on the LEFT comes to front
    //   swipe UP → front face slides up, what was on the BOTTOM comes to front
    let targetX = 0, targetY = 0;
    if (dir === "right") targetY = 90;    // cube animates +90 around Y
    else if (dir === "left") targetY = -90;
    else if (dir === "up") targetX = 90;

    setActive(prev => prev ? { ...prev, rotX: targetX, rotY: targetY, snapping: false } : prev);

    setTimeout(() => {
      setActive(prev => {
        if (!prev) return prev;
        let perm = prev.perm;
        // After the visual animation, update the perm to reflect the new front face.
        // For swipe LEFT (face moves left, RIGHT face comes forward) we use rotateRight perm.
        if (dir === "left") perm = G.rotateRight(perm);
        else if (dir === "right") perm = G.rotateLeft(perm);
        else if (dir === "up") perm = G.rotateDown(perm);
        return { ...prev, perm, rotX: 0, rotY: 0, snapping: true };
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setActive(prev => prev ? { ...prev, snapping: false } : prev);
          rotatingRef.current = false;
        });
      });
    }, 420);
  }, []);

  const hardDrop = useCallback(() => {
    if (phaseRef.current !== "playing") return;
    const a = activeRef.current;
    if (!a || a.hardDrop) return;
    setActive(prev => prev ? { ...prev, hardDrop: true } : prev);
  }, []);

  // Swap the currently falling dice's letters with one of the upcoming ones.
  // Preserves the active block's position/row/col so it just morphs into the chosen letters.
  const swapWithNext = useCallback((idx) => {
    if (phaseRef.current !== "playing") return;
    const a = activeRef.current;
    if (!a || a.hardDrop) return;
    const nq = nextQueueRef.current;
    if (idx < 0 || idx >= nq.length) return;
    const target = nq[idx];
    if (!target) return;
    setActive(prev => prev ? {
      ...prev,
      letters: [...target.letters],
      perm: G.initialFaceState(),
      isWild: false,
      // brief snap state to play the squish/glow CSS transition
      snapping: true,
    } : prev);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setActive(prev => prev ? { ...prev, snapping: false } : prev);
      });
    });
    setNextQueue(prev => prev.map((b, i) => i === idx
      ? { ...b, letters: [...a.letters] }
      : b));
  }, []);

  const swapTiles = useCallback((r1, c1, r2, c2) => {
    const cur = boardRef.current;
    const a = cur[r1] && cur[r1][c1];
    const b = cur[r2] && cur[r2][c2];
    if (!a || !b) return;
    const newBoard = cur.map(row => [...row]);
    newBoard[r1][c1] = b;
    newBoard[r2][c2] = a;
    setBoard(newBoard);
    boardRef.current = newBoard;
    setTileIds(prev => {
      const ids = prev.map(row => [...row]);
      const idA = ids[r1][c1];
      ids[r1][c1] = ids[r2][c2];
      ids[r2][c2] = idA;
      return ids;
    });
    // After swap, scan for newly formed words at both positions
    setTimeout(() => {
      const modifier = G.getLevel(levelRef.current).modifier;
      const w1 = G.findWordsThrough(newBoard, r1, c1, window.WORDS)
        .filter(w => G.wordPassesModifier(w.word, modifier));
      const w2 = G.findWordsThrough(newBoard, r2, c2, window.WORDS)
        .filter(w => G.wordPassesModifier(w.word, modifier));
      if (w1.length > 0) processWordsAt(r1, c1, newBoard);
      else if (w2.length > 0) processWordsAt(r2, c2, newBoard);
    }, 200);
  }, []);

  const moveTileToColumn = useCallback((fromR, fromC, toC) => {
    if (phaseRef.current !== "playing") return;
    if (fromC === toC) return;
    const cur = boardRef.current;
    if (!cur[fromR] || cur[fromR][fromC] === null) return;
    const letter = cur[fromR][fromC];
    const movedBoard = cur.map(row => [...row]);
    movedBoard[fromR][fromC] = null;
    let dropR = ROWS - 1;
    while (dropR >= 0 && movedBoard[dropR][toC] !== null) dropR--;
    if (dropR < 0) return;
    movedBoard[dropR][toC] = letter;
    const settled = G.applyGravity(movedBoard);
    setBoard(settled);
    boardRef.current = settled;
    setTileIds(prev => {
      const ids = prev.map(row => [...row]);
      const movedId = ids[fromR][fromC];
      ids[fromR][fromC] = null;
      ids[dropR][toC] = movedId;
      const newIds = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
      for (let cc = 0; cc < COLS; cc++) {
        const stack = [];
        for (let rr = 0; rr < ROWS; rr++) if (ids[rr][cc] !== null) stack.push(ids[rr][cc]);
        for (let i = 0; i < stack.length; i++) newIds[ROWS - 1 - i][cc] = stack[stack.length - 1 - i];
      }
      return newIds;
    });
    // After move + gravity, check for words at the new tile position
    setTimeout(() => {
      const finalBoard = boardRef.current;
      // Find the moved letter's final position in the target column (after gravity)
      let finalRow = dropR;
      for (let rr = ROWS - 1; rr >= 0; rr--) {
        if (finalBoard[rr] && finalBoard[rr][toC] === letter) {
          finalRow = rr;
          break;
        }
      }
      const modifier = G.getLevel(levelRef.current).modifier;
      const words = G.findWordsThrough(finalBoard, finalRow, toC, window.WORDS)
        .filter(w => G.wordPassesModifier(w.word, modifier));
      if (words.length > 0) processWordsAt(finalRow, toC, finalBoard);
    }, 200);
  }, []);

  // Touch input on board — physics drag: any touch can pick up the dice or a tile.
  useEffect(() => {
    const layer = touchRef.current;
    if (!layer) return;
    let mode = null;
    let dragTile = null;
    let lastCol = -1;
    let tapCandidate = null;
    // Cache the layer's rect so we don't trigger layout on every move event
    let cachedRect = null;
    let cachedCellW = 0;
    let cachedCellH = 0;
    const refreshRect = () => {
      cachedRect = layer.getBoundingClientRect();
      cachedCellW = cachedRect.width / COLS;
      cachedCellH = cachedRect.height / ROWS;
    };

    const pointFromClient = (clientX, clientY) => {
      if (!cachedRect) refreshRect();
      const localX = clientX - cachedRect.left;
      const localY = clientY - cachedRect.top;
      const scaleX = (COLS * CELL) / cachedRect.width;
      const scaleY = (ROWS * CELL) / cachedRect.height;
      return {
        x: localX * scaleX,
        y: localY * scaleY,
        col: Math.max(0, Math.min(COLS - 1, Math.floor(localX / cachedCellW))),
        row: Math.max(0, Math.min(ROWS - 1, Math.floor(localY / cachedCellH))),
      };
    };
    const tileAtPoint = (p) => {
      if (boardRef.current[p.row] && boardRef.current[p.row][p.col]) {
        return { r: p.row, c: p.col };
      }
      return null;
    };
    const isOnActive = (p) => {
      const a = activeRef.current;
      if (!a) return false;
      // If the touch is in the same column as the active block AND within ±1 row of it, treat as dice-drag.
      return p.col === a.col && Math.abs(p.row - a.row) <= 1;
    };

    const onStart = (e) => {
      const t = e.touches ? e.touches[0] : e;
      if (!t) return;
      refreshRect();
      const p = pointFromClient(t.clientX, t.clientY);
      // If touch starts on a locked tile, pick it up.
      const tile = tileAtPoint(p);
      if (tile) {
        mode = "tile";
        dragTile = { fromR: tile.r, fromC: tile.c, targetCol: tile.c, targetRow: tile.r, x: p.x, y: p.y };
        setDraggingTile({ ...dragTile });
        if (e.cancelable) e.preventDefault();
        return;
      }
      // Otherwise: this is a dice interaction. Could be a tap (rotate) or drag.
      // Wait for movement to decide.
      if (activeRef.current) {
        mode = "dice-pending";
        tapCandidate = { startX: t.clientX, startY: t.clientY, startT: Date.now(), p };
      }
      if (e.cancelable) e.preventDefault();
    };

    // rAF-throttled move handler: pointer events can fire at 120-240Hz, but we only
    // need to update React state once per animation frame. Without this, on fast drags
    // the renderer falls behind and the dice appears to freeze between snaps.
    let pendingMove = null;
    let rafScheduled = false;

    const processMove = (clientX, clientY) => {
      const p = pointFromClient(clientX, clientY);
      if (mode === "dice-pending") {
        const dx = clientX - tapCandidate.startX;
        const dy = clientY - tapCandidate.startY;
        if (Math.hypot(dx, dy) > 6) {
          mode = "dice";
          tapCandidate = null;
          setActive(prev => prev ? {
            ...prev,
            pixelX: p.x - CELL / 2,
            pixelY: p.y - CELL / 2,
          } : prev);
        }
        return;
      }
      if (mode === "dice") {
        setActive(prev => prev ? {
          ...prev,
          pixelX: p.x - CELL / 2,
          pixelY: p.y - CELL / 2,
        } : prev);
        return;
      }
      if (mode === "tile" && dragTile) {
        dragTile.targetCol = p.col;
        dragTile.targetRow = p.row;
        dragTile.x = p.x;
        dragTile.y = p.y;
        setDraggingTile({ ...dragTile });
        return;
      }
    };

    const onMove = (e) => {
      const t = e.touches ? e.touches[0] : e;
      if (!t) return;
      pendingMove = { clientX: t.clientX, clientY: t.clientY };
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        const m = pendingMove;
        pendingMove = null;
        if (!m) return;
        processMove(m.clientX, m.clientY);
      });
    };

    const onEnd = (e) => {
      if (mode === "dice-pending") {
        // No drag — treat as tap → rotate
        const dt = Date.now() - tapCandidate.startT;
        if (dt < 350) rotateDice("up");
        tapCandidate = null;
        mode = null;
        return;
      }
      if (mode === "dice") {
        // Snap fast: set pixelX/Y to the snap target (still in drag mode → no transition),
        // then clear them next frame so natural fall resumes from the snapped position.
        let snappedCol = null, snappedRow = null;
        setActive(prev => {
          if (!prev) return prev;
          const px = prev.pixelX !== undefined ? prev.pixelX + CELL / 2 : prev.col * CELL + CELL / 2;
          const py = prev.pixelY !== undefined ? prev.pixelY + CELL / 2 : prev.row * CELL + CELL / 2;
          let newCol = Math.max(0, Math.min(COLS - 1, Math.floor(px / CELL)));
          let newRow = Math.max(0, Math.min(ROWS - 1, Math.floor(py / CELL)));
          const b = boardRef.current;
          if (b[newRow][newCol] !== null) {
            while (newRow > 0 && b[newRow][newCol] !== null) newRow--;
            if (b[newRow][newCol] !== null) {
              newCol = prev.col;
              newRow = Math.max(0, prev.row);
            }
          }
          snappedCol = newCol;
          snappedRow = newRow;
          // Keep pixelX/Y set to the snap target — still no transition (instant snap)
          return {
            ...prev,
            col: newCol,
            row: newRow,
            pixelX: newCol * CELL,
            pixelY: newRow * CELL,
          };
        });
        // Two rAFs later, drop pixelX/Y so the next gravity tick can resume natural fall transition
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setActive(prev => prev ? { ...prev, pixelX: undefined, pixelY: undefined } : prev);
          });
        });
        // Trigger the next fall tick almost immediately so the dice keeps moving without a long pause
        const lvl = G.getLevel(levelRef.current);
        const fallMs = lvl.fallMs || 850;
        lastFallTimeRef.current = Date.now() - fallMs + 60;
        mode = null;
      } else if (mode === "tile" && dragTile) {
        const { fromR, fromC, targetCol, targetRow } = dragTile;
        if (targetCol !== fromC || targetRow !== fromR) {
          const cur = boardRef.current;
          // Swap with the falling letter if dragged onto the active block's cell
          const a = activeRef.current;
          if (a && targetCol === a.col && targetRow === a.row) {
            const fallingLetter = a.letters[a.perm.F];
            const draggedLetter = cur[fromR][fromC];
            if (draggedLetter && fallingLetter) {
              setActive(prev => {
                if (!prev) return prev;
                const newLetters = [...prev.letters];
                newLetters[prev.perm.F] = draggedLetter;
                return { ...prev, letters: newLetters };
              });
              const newBoard = cur.map(row => [...row]);
              newBoard[fromR][fromC] = fallingLetter;
              setBoard(newBoard);
              boardRef.current = newBoard;
              // Check for words at the swapped position
              setTimeout(() => {
                const modifier = G.getLevel(levelRef.current).modifier;
                const ws = G.findWordsThrough(boardRef.current, fromR, fromC, window.WORDS)
                  .filter(w => G.wordPassesModifier(w.word, modifier));
                if (ws.length > 0) processWordsAt(fromR, fromC, boardRef.current);
              }, 80);
            }
          } else {
            const targetLetter = cur[targetRow] ? cur[targetRow][targetCol] : null;
            if (targetLetter !== null) {
              swapTiles(fromR, fromC, targetRow, targetCol);
            } else {
              moveTileToColumn(fromR, fromC, targetCol);
            }
          }
        }
        dragTile = null;
        setDraggingTile(null);
        mode = null;
      }
    };

    layer.addEventListener("touchstart", onStart, { passive: false });
    layer.addEventListener("touchmove", onMove, { passive: false });
    layer.addEventListener("touchend", onEnd);
    layer.addEventListener("touchcancel", onEnd);
    layer.addEventListener("mousedown", onStart);
    const mm = (e) => { if (e.buttons) onMove(e); };
    const mu = (e) => onEnd(e);
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);

    return () => {
      layer.removeEventListener("touchstart", onStart);
      layer.removeEventListener("touchmove", onMove);
      layer.removeEventListener("touchend", onEnd);
      layer.removeEventListener("touchcancel", onEnd);
      layer.removeEventListener("mousedown", onStart);
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [moveToColumn, phase, moveTileToColumn, rotateDice, swapTiles]);

  // Keyboard input
  useEffect(() => {
    const onKey = (e) => {
      if (phase !== "playing") return;
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") { moveColumn(-1); e.preventDefault(); }
      else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") { moveColumn(1); e.preventDefault(); }
      else if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") { rotateDice("up"); e.preventDefault(); }
      else if (e.key === "q" || e.key === "Q") { rotateDice("left"); e.preventDefault(); }
      else if (e.key === "e" || e.key === "E") { rotateDice("right"); e.preventDefault(); }
      else if (e.key === "ArrowDown" || e.key === " ") { hardDrop(); e.preventDefault(); }
      else if (e.key === "1") usePower("destroy");
      else if (e.key === "2") usePower("scramble");
      else if (e.key === "3") usePower("bomb");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [phase, moveColumn, rotateDice, hardDrop]);

  // ─── Powerups ─────────────────────────────────────────────

  const usePower = useCallback((name) => {
    if (phase !== "playing") return;
    if ((powerups[name] || 0) <= 0) return;
    // Cost in points (deducted from current level score)
    const COSTS = { destroy: 20, scramble: 10, bomb: 40, move: 30, time: 40, magic: 50 };
    const cost = COSTS[name] || 0;
    if (scoreRef.current < cost) return; // not enough points
    if (name === "scramble") {
      if (!active || active.hardDrop) return;
      setActive(prev => prev ? {
        ...prev,
        letters: G.generateDiceLetters(),
        perm: G.initialFaceState(),
        rotX: prev.rotX,
        rotY: prev.rotY,
      } : prev);
      setPowerups(p => ({ ...p, scramble: p.scramble - 1 }));
      setScore(s => Math.max(0, s - cost));
    } else if (name === "destroy" || name === "bomb" || name === "move") {
      setArmedPower(prev => prev === name ? null : name);
      setSelectedTile(null);
    } else if (name === "time") {
      const until = Date.now() + 8000;
      frozenRef.current = until;
      setFrozenUntil(until);
      setPowerups(p => ({ ...p, time: p.time - 1 }));
      setScore(s => Math.max(0, s - cost));
      setTimeout(() => {
        setFrozenUntil(prev => prev === until ? 0 : prev);
        if (frozenRef.current === until) frozenRef.current = 0;
      }, 8000);
    } else if (name === "magic") {
      if (!activeRef.current || activeRef.current.hardDrop) return;
      setActive(prev => prev ? {
        ...prev,
        isWild: true,
        letters: ["★", "★", "★", "★", "★", "★"],
        perm: G.initialFaceState(),
      } : prev);
      setPowerups(p => ({ ...p, magic: p.magic - 1 }));
      setScore(s => Math.max(0, s - cost));
    }
  }, [phase, powerups, active]);

  const handleBoardCellClick = useCallback((r, c) => {
    if (armedPower === "move") {
      // First click: select a tile. Second click: drop into the target column.
      if (selectedTile === null) {
        if (board[r][c] === null) return;
        setSelectedTile({ r, c });
        return;
      }
      // Deselect if same tile
      if (selectedTile.r === r && selectedTile.c === c) {
        setSelectedTile(null);
        return;
      }
      // Move: take the selected tile's letter, drop it into the clicked column.
      const sr = selectedTile.r, sc = selectedTile.c;
      const letter = board[sr][sc];
      if (!letter) { setSelectedTile(null); return; }
      const movedBoard = board.map(row => [...row]);
      movedBoard[sr][sc] = null;
      // Find lowest empty row in target column c
      let dropR = ROWS - 1;
      while (dropR >= 0 && movedBoard[dropR][c] !== null) dropR--;
      if (dropR < 0) { setSelectedTile(null); setArmedPower(null); return; }
      movedBoard[dropR][c] = letter;
      const settled = G.applyGravity(movedBoard);
      setBoard(settled);
      boardRef.current = settled;
      setTileIds(prev => {
        const ids = prev.map(row => [...row]);
        const movedId = ids[sr][sc] || `moved-${Date.now()}-${Math.random()}`;
        ids[sr][sc] = null;
        ids[dropR][c] = movedId;
        const newIds = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
        for (let cc = 0; cc < COLS; cc++) {
          const stack = [];
          for (let rr = 0; rr < ROWS; rr++) if (ids[rr][cc] !== null) stack.push(ids[rr][cc]);
          for (let i = 0; i < stack.length; i++) newIds[ROWS - 1 - i][cc] = stack[stack.length - 1 - i];
        }
        return newIds;
      });
      setPowerups(p => ({ ...p, move: p.move - 1 }));
      setSelectedTile(null);
      setArmedPower(null);
      return;
    }
    if (armedPower === "destroy") {
      if (board[r][c] === null) return;
      const newBoard = board.map(row => [...row]);
      newBoard[r][c] = null;
      const settled = G.applyGravity(newBoard);
      setBoard(settled);
      boardRef.current = settled;
      setTileIds(prev => {
        const idsCleared = prev.map(row => [...row]);
        idsCleared[r][c] = null;
        const newIds = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
        for (let cc = 0; cc < COLS; cc++) {
          const stack = [];
          for (let rr = 0; rr < ROWS; rr++) {
            if (idsCleared[rr][cc] !== null) stack.push(idsCleared[rr][cc]);
          }
          for (let i = 0; i < stack.length; i++) {
            newIds[ROWS - 1 - i][cc] = stack[stack.length - 1 - i];
          }
        }
        return newIds;
      });
      setPowerups(p => ({ ...p, destroy: p.destroy - 1 }));
      setArmedPower(null);
    } else if (armedPower === "bomb") {
      if (board[r][c] === null) return;
      // Clear the entire row
      const newBoard = board.map(row => [...row]);
      for (let cc = 0; cc < COLS; cc++) {
        newBoard[r][cc] = null;
      }
      const settled = G.applyGravity(newBoard);
      setBoard(settled);
      boardRef.current = settled;
      setTileIds(prev => {
        const idsCleared = prev.map(row => [...row]);
        for (let cc = 0; cc < COLS; cc++) idsCleared[r][cc] = null;
        const newIds = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
        for (let cc = 0; cc < COLS; cc++) {
          const stack = [];
          for (let rr = 0; rr < ROWS; rr++) {
            if (idsCleared[rr][cc] !== null) stack.push(idsCleared[rr][cc]);
          }
          for (let i = 0; i < stack.length; i++) {
            newIds[ROWS - 1 - i][cc] = stack[stack.length - 1 - i];
          }
        }
        return newIds;
      });
      setPowerups(p => ({ ...p, bomb: p.bomb - 1 }));
      setArmedPower(null);
    }
  }, [armedPower, board, selectedTile]);

  // ─── Render ────────────────────────────────────────────────

  // computed: where would a hard drop land?
  const dropPreviewRow = useMemo(() => {
    if (!active || phase !== "playing") return null;
    const b = boardRef.current;
    for (let r = active.row + 1; r < ROWS; r++) {
      if (r >= 0 && b[r][active.col] !== null) return r - 1;
    }
    return ROWS - 1;
  }, [active, phase, board]);

  return (
    <div className="game-screen" style={{ "--cell": CELL + "px" }}>
      {/* Multicolor word-formation flash overlay */}
      {wordFlash && (
        <div
          key={wordFlash.id}
          className={`word-flash word-flash-${wordFlash.intensity}`}
        />
      )}

      {/* Stop-time freeze overlay */}
      {frozenUntil > Date.now() && (
        <>
          <div className="freeze-overlay" />
          <div className="freeze-label">⏸ Time stopped</div>
        </>
      )}

      {phase === "start" && <StartScreen onStart={startGame} />}

      {phase === "boss-intro" && (
        <BossIntroOverlay level={level} onBegin={() => startLevel(levelIdx)} />
      )}

      {phase === "level-clear" && (
        <LevelClearOverlay level={level} score={score} blocksLeft={blocksLeft} onNext={nextLevel} />
      )}

      {phase === "shop" && (
        <ShopOverlay coins={coins} powerups={powerups} onBuy={buyItem} onContinue={continueFromShop} />
      )}

      {phase === "game-over" && (
        <GameOverOverlay score={score} foundWords={foundWords} level={level} levelIdx={levelIdx} onRetry={() => startLevel(levelIdx)} onHome={() => setPhase("start")} />
      )}

      {(phase === "playing" || phase === "level-clear" || phase === "game-over" || phase === "boss-intro") && (
        <>
          <Hud
            level={level}
            score={score}
            timeLeft={timeLeft}
            blocksLeft={blocksLeft}
            scorePops={scorePops}
          />

          {level.modifier && (
            <div className={`level-banner boss`}>
              <div className="banner-icon">!</div>
              <div style={{ flex: 1 }}>
                <div className="banner-text">{level.modifierLabel}</div>
                <div className="banner-subtext">{level.modifierDesc}</div>
              </div>
            </div>
          )}

          {!level.modifier && (
            <div className="level-banner">
              <div className="banner-icon">{level.id}</div>
              <div style={{ flex: 1 }}>
                <div className="banner-text">Level {level.id} · {level.name}</div>
              </div>
              <div className="banner-subtext">{score} / {level.target}</div>
            </div>
          )}

          <div className="goal-progress">
            <div className="goal-progress-track">
              <div
                className={`goal-progress-fill ${score >= level.target ? "complete" : ""}`}
                style={{ width: Math.min(100, (score / level.target) * 100) + "%" }}
              />
              {/* tick marks for visual reference */}
              <div className="goal-tick" style={{ left: "25%" }} />
              <div className="goal-tick" style={{ left: "50%" }} />
              <div className="goal-tick" style={{ left: "75%" }} />
              {/* goal flag */}
              <div className="goal-flag">
                <span>{level.target}</span>
              </div>
            </div>
          </div>

          <div className="next-bar">
            <span className="next-bar-label">NEXT · tap to swap</span>
            <div className="next-bar-blocks">
              {nextQueue.slice(0, 3).map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  className={`next-bar-block swappable ${i > 0 ? "upcoming" : ""}`}
                  onClick={() => swapWithNext(i)}
                  aria-label={`Swap with upcoming letter ${b.letters[0]}`}
                >
                  {b.letters[0]}
                </button>
              ))}
            </div>
          </div>

          <div className="board-area">
            <Board
              board={board}
              tileIds={tileIds}
              active={active}
              extras={extras}
              extrasFallMs={level.extrasFallMs || 1500}
              highlightCells={highlightCells}
              dissolvingCells={dissolvingCells}
              dropPreviewRow={dropPreviewRow}
              callouts={callouts}
              particles={particles}
              lockFlash={lockFlash}
              armedPower={armedPower}
              onCellClick={handleBoardCellClick}
              onRotate={rotateDice}
              onHardDrop={hardDrop}
              touchRef={touchRef}
              fallMs={level.fallMs || 850}
              draggingTile={draggingTile}
              showHint={phase === "playing" && levelIdx === 0 && (blocksLeft >= (level.blocks - 2))}
            />
          </div>

          <ControlPanel
            powerups={powerups}
            armedPower={armedPower}
            onUsePower={usePower}
            nextQueue={nextQueue}
            level={level}
            score={score}
            frozenActive={frozenUntil > Date.now()}
            activeIsWild={!!(active && active.isWild)}
          />
        </>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────

function Hud({ level, score, timeLeft, blocksLeft, scorePops }) {
  const timeClass = timeLeft <= 10 ? "danger" : timeLeft <= 30 ? "warn" : "";
  return (
    <div className="hud">
      <div className="hud-pill" style={{ flex: 1 }}>
        <div className="hud-label">SCORE</div>
        <div className="hud-value" style={{ position: "relative" }}>
          {score.toLocaleString()}
          {scorePops.map(p => (
            <span key={p.id} className="score-pop" style={{ left: 0, top: 0 }}>+{p.value}</span>
          ))}
        </div>
      </div>
      <div className="hud-pill">
        <div className="hud-label">TIME</div>
        <div className={`hud-value ${timeClass}`}>
          {Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, "0")}
        </div>
      </div>
      <div className="hud-pill">
        <div className="hud-label">BLOCKS</div>
        <div className="hud-value">{blocksLeft}</div>
      </div>
    </div>
  );
}

function Board({ board, tileIds, active, extras, extrasFallMs, highlightCells, dissolvingCells, dropPreviewRow, callouts, particles, lockFlash, armedPower, onCellClick, onRotate, onHardDrop, touchRef, showHint, fallMs, draggingTile }) {
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const letter = board[r][c];
      const id = tileIds[r][c];
      if (letter && id) {
        const key = `${r}-${c}`;
        const inWord = highlightCells.has(key);
        const dissolving = dissolvingCells.has(key);
        const isSparkle = typeof id === "string" && id.startsWith("sparkle-");
        const isWild = typeof id === "string" && id.startsWith("magic-");
        const isBeingDragged = draggingTile && draggingTile.fromR === r && draggingTile.fromC === c;
        const dragX = isBeingDragged ? draggingTile.x - CELL / 2 : null;
        const dragY = isBeingDragged ? draggingTile.y - CELL / 2 : null;
        cells.push(
          <div
            key={id}
            className={`tile ${inWord ? "in-word" : ""} ${dissolving ? "dissolving" : ""} ${armedPower ? "targeting" : ""} ${isSparkle ? "sparkle" : ""} ${isWild ? "wild" : ""} ${isBeingDragged ? "dragging" : ""}`}
            style={{
              top: isBeingDragged ? dragY : r * CELL,
              left: isBeingDragged ? dragX : c * CELL,
              "--letter-hue": letterHue(letter),
              transition: isBeingDragged ? "none" : undefined,
              zIndex: isBeingDragged ? 12 : undefined,
            }}
            onClick={(e) => { e.stopPropagation(); onCellClick(r, c); }}
          >
            <div className="tile-inner">
              <span className="tile-letter">{letter}</span>
            </div>
            {isSparkle && <div className="sparkle-glow" />}
          </div>
        );
      }
    }
  }

  return (
    <div className="board-frame">
      <div className="board" style={{ width: BOARD_W, height: BOARD_H }}>
        <div className="board-grid" />

        {/* column highlight under active block — follows finger when dragging */}
        {active && (
          <div className="col-highlight" style={{
            left: active.pixelX !== undefined
              ? Math.max(0, Math.min((COLS - 1) * CELL, Math.floor((active.pixelX + CELL / 2) / CELL) * CELL))
              : active.col * CELL
          }} />
        )}

        {/* target column highlight when dragging a tile */}
        {draggingTile && draggingTile.targetCol !== draggingTile.fromC && (
          <div className="tile-drop-target" style={{ left: draggingTile.targetCol * CELL }} />
        )}

        {/* drop preview */}
        {active && dropPreviewRow !== null && dropPreviewRow > active.row && (
          <div
            className="drop-preview"
            style={{
              left: active.col * CELL,
              top: dropPreviewRow * CELL + CELL - 4,
            }}
          />
        )}

        {/* locked tiles */}
        {cells}

        {/* active 3D dice — key forces remount per block so spawn doesn't animate from old position */}
        {active && (
          <Dice key={active.id} active={active} onRotate={onRotate} fallMs={fallMs} />
        )}

        {/* auto-falling "extra" letters (progressive difficulty) */}
        {extras && extras.map(ext => (
          <div
            key={ext.id}
            className="extra-tile"
            style={{
              left: ext.col * CELL,
              top: ext.row * CELL,
              "--letter-hue": letterHue(ext.letter),
              transition: `top ${(extrasFallMs || 1500) / 1000}s linear`,
            }}
          >
            <span className="extra-letter">{ext.letter}</span>
          </div>
        ))}

        {/* word callouts */}
        {callouts.map(c => (
          <div key={c.id} className="word-callout" style={{ left: c.x, top: c.y }}>
            {c.word}<span className="pts">+{c.pts}</span>
          </div>
        ))}

        {/* particles */}
        {particles.map(p => (
          <div
            key={p.id}
            className="particle"
            style={{
              left: p.x, top: p.y,
              background: p.color,
              "--dx": p.dx + "px",
              "--dy": p.dy + "px",
              boxShadow: `0 0 6px ${p.color}`,
            }}
          />
        ))}

        {/* lock flash */}
        {lockFlash && (
          <div
            key={lockFlash.key}
            className="lock-flash"
            style={{
              left: lockFlash.col * CELL + 3,
              top: lockFlash.row * CELL + 3,
              width: CELL - 6,
              height: CELL - 6,
            }}
          />
        )}

        {/* touch interaction layer — always present; pointer-events off when targeting */}
        <div
          className="touch-layer"
          ref={touchRef}
          style={{ pointerEvents: armedPower ? "none" : "auto" }}
        />

        {/* targeting hint */}
        {armedPower && (
          <div style={{
            position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
            background: "rgba(255, 77, 109, 0.95)", color: "#fff",
            padding: "4px 10px", borderRadius: 8, fontSize: 10, fontWeight: 700,
            letterSpacing: "0.06em", textTransform: "uppercase",
            zIndex: 15, pointerEvents: "none",
          }}>
            Tap a tile to {armedPower === "bomb" ? "clear the row" : armedPower === "move" ? "select / drop" : "destroy"}
          </div>
        )}

        {/* one-time hint overlay */}
        {showHint && active && active.row < 1 && (
          <div style={{
            position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
            background: "rgba(20,8,32,0.85)", color: "rgba(255,245,220,0.8)",
            padding: "8px 12px", borderRadius: 10, fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.04em",
            zIndex: 14, textAlign: "center", lineHeight: 1.5, pointerEvents: "none",
            border: "1px solid rgba(255,245,220,0.1)",
          }}>
            drag anywhere to position · swipe ON dice to rotate · swipe down to drop
          </div>
        )}
      </div>
    </div>
  );
}

function Dice({ active, onRotate, fallMs = 850 }) {
  const diceRef = useRef(null);

  // No touch handlers on the dice — touches are handled by the board's touch-layer below.
  // This way, touching the dice directly enters drag mode immediately.

  // faces ordered: F, B, U, D, L, R — each rendered with its local transform
  const transforms = {
    F: "translateZ(25px)",
    B: "rotateY(180deg) translateZ(25px)",
    U: "rotateX(90deg) translateZ(25px)",
    D: "rotateX(-90deg) translateZ(25px)",
    L: "rotateY(-90deg) translateZ(25px)",
    R: "rotateY(90deg) translateZ(25px)",
  };
  const positions = ["F", "B", "U", "D", "L", "R"];

  // Free-drag positioning: if pixelX/pixelY are set, render at that absolute spot (no transition).
  const dragging = active.pixelX !== undefined;
  const leftPx = dragging ? active.pixelX : active.col * CELL;
  const topPx = dragging ? active.pixelY : active.row * CELL;

  return (
    <div
      ref={diceRef}
      className={`dice-wrap ${dragging ? "dragging" : ""}`}
      style={{
        left: leftPx,
        top: topPx,
        transition: dragging
          ? "none"
          : `left 0.02s linear, top ${fallMs / 1000}s linear`,
      }}
    >
      <div className="dice-aura" />
      <div
        className={`dice ${active.snapping ? "snapping" : ""} ${active.isWild ? "wild" : ""}`}
        style={{
          transform: `rotateX(${active.rotX}deg) rotateY(${active.rotY}deg)`,
        }}
      >
        {positions.map(pos => {
          const letterIdx = active.perm[pos];
          const letter = active.letters[letterIdx];
          return (
            <div
              key={pos}
              className="dice-face"
              style={{ transform: transforms[pos], "--letter-hue": letterHue(letter) }}
            >
              <span>{letter}</span>
            </div>
          );
        })}
      </div>
      <div className="dice-shadow" />
    </div>
  );
}

function ControlPanel({ powerups, armedPower, onUsePower, nextQueue, level, score, frozenActive, activeIsWild }) {
  return (
    <div className="control-panel">
      <div className="power-row">
        <button
          className={`power-btn compact ${armedPower === "destroy" ? "active" : ""}`}
          disabled={powerups.destroy <= 0}
          onClick={() => onUsePower("destroy")}
          title="Destroy a single tile"
        >
          <div className="power-icon destroy">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="power-count">×{powerups.destroy}</div>
        </button>

        <button
          className={`power-btn compact ${armedPower === "scramble" ? "active" : ""}`}
          disabled={powerups.scramble <= 0}
          onClick={() => onUsePower("scramble")}
          title="Re-roll the active dice's letters"
        >
          <div className="power-icon scramble">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M2 3h6l4 4-4 4H2M9 3l3 4-3 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </div>
          <div className="power-count">×{powerups.scramble}</div>
        </button>

        <button
          className={`power-btn compact ${armedPower === "bomb" ? "active" : ""}`}
          disabled={powerups.bomb <= 0}
          onClick={() => onUsePower("bomb")}
          title="Clear an entire row"
        >
          <div className="power-icon bomb">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="8" r="4" fill="#fff"/>
              <path d="M9 5l2-2M11 3l1 1M10 3v1.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="power-count">×{powerups.bomb}</div>
        </button>

        <button
          className={`power-btn compact ${armedPower === "move" ? "active" : ""}`}
          disabled={powerups.move <= 0}
          onClick={() => onUsePower("move")}
          title="Move a letter to another column"
        >
          <div className="power-icon move">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M2 7h10M9 4l3 3-3 3M5 4L2 7l3 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </div>
          <div className="power-count">×{powerups.move}</div>
        </button>

        <button
          className={`power-btn compact ${frozenActive ? "active" : ""}`}
          disabled={powerups.time <= 0 || frozenActive}
          onClick={() => onUsePower("time")}
          title="Freeze fall + game timer for 8s"
        >
          <div className="power-icon time">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5" stroke="#fff" strokeWidth="1.4" fill="none"/>
              <path d="M7 4v3l2 1.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="power-count">×{powerups.time}</div>
        </button>

        <button
          className={`power-btn compact magic-btn ${(activeIsWild) ? "active" : ""}`}
          disabled={powerups.magic <= 0 || activeIsWild}
          onClick={() => onUsePower("magic")}
          title="Make next active block a wild letter"
        >
          <div className="power-icon magic">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M7 2l1.2 3.3 3.5.3-2.7 2.3.9 3.5L7 9.5l-3 1.9.9-3.5L2.3 5.6l3.5-.3z" fill="#fff"/>
            </svg>
          </div>
          <div className="power-count">×{powerups.magic}</div>
        </button>
      </div>
    </div>
  );
}

// ─── Overlays ──────────────────────────────────────────────

function StartScreen({ onStart }) {
  const title = "WORDFALL";
  return (
    <div className="overlay" style={{ animation: "none" }}>
      <div className="overlay-card start-card">
        <div className="start-preview">
          <div className="preview-dice d1">W</div>
          <div className="preview-dice d2">O</div>
          <div className="preview-dice d3">R</div>
        </div>
        <div className="start-logo">
          {title.split("").map((ch, i) => (
            <span key={i} style={{ display: "inline-block", marginRight: ch === "L" ? "2px" : 0 }}>{ch}</span>
          ))}
        </div>
        <div className="start-tag">SPELL · STACK · SURVIVE</div>

        <div className="start-controls">
          <div className="control-line">
            <span className="control-key">drag</span>
            <span>Drag anywhere to position the dice</span>
          </div>
          <div className="control-line">
            <span className="control-key">swipe</span>
            <span>On the dice — roll a different face up</span>
          </div>
          <div className="control-line">
            <span className="control-key">↓ on dice</span>
            <span>Hard drop</span>
          </div>
        </div>

        <button className="overlay-btn" onClick={onStart}>Begin</button>
      </div>
    </div>
  );
}

function BossIntroOverlay({ level, onBegin }) {
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="boss-warning">!</div>
        <div className="overlay-eyebrow boss">BOSS LEVEL</div>
        <h1 className="overlay-title">{level.modifierLabel}</h1>
        <p className="overlay-desc">{level.modifierDesc}<br/>Hit <strong>{level.target}</strong> points in <strong>{level.time}s</strong> with <strong>{level.blocks}</strong> blocks.</p>
        <button className="overlay-btn" onClick={onBegin}>Bring it</button>
      </div>
    </div>
  );
}

function ShopOverlay({ coins, powerups, onBuy, onContinue }) {
  const items = [
    { name: "destroy", label: "Destroy", desc: "Pick a tile, vaporise it", price: 8, color: "linear-gradient(135deg, #ff7a59, #ff4d6d)" },
    { name: "scramble", label: "Re-roll", desc: "New letters on the active dice", price: 5, color: "linear-gradient(135deg, #b496ff, #6e7aff)" },
    { name: "bomb", label: "Row Blast", desc: "Wipe an entire row", price: 12, color: "linear-gradient(135deg, #ffb958, #ff7a59)" },
    { name: "move", label: "Move", desc: "Relocate a tile to another column", price: 10, color: "linear-gradient(135deg, #6ee7a5, #2eb98a)" },
    { name: "time", label: "Stop Time", desc: "Freeze the board for 8 seconds", price: 14, color: "linear-gradient(135deg, #b8d8ff, #6e7aff)" },
    { name: "magic", label: "Magic Block", desc: "Next block is a wild letter", price: 16, color: "linear-gradient(135deg, #ff7ad9, #c860ff, #6e7aff)" },
  ];
  return (
    <div className="overlay">
      <div className="overlay-card shop-card">
        <div className="overlay-eyebrow">SHOP</div>
        <div className="shop-balance">
          <span className="coin-icon">●</span>
          <span className="coin-amount">{coins}</span>
          <span className="coin-label">coins</span>
        </div>
        <div className="shop-items">
          {items.map(item => (
            <button
              key={item.name}
              className="shop-item"
              disabled={coins < item.price}
              onClick={() => onBuy(item.name, item.price)}
            >
              <div className="shop-item-icon" style={{ background: item.color }}>
                {powerups[item.name] || 0}
              </div>
              <div className="shop-item-text">
                <div className="shop-item-label">{item.label}</div>
                <div className="shop-item-desc">{item.desc}</div>
              </div>
              <div className="shop-item-price">
                <span className="coin-icon-small">●</span> {item.price}
              </div>
            </button>
          ))}
        </div>
        <button className="overlay-btn" onClick={onContinue}>Continue →</button>
      </div>
    </div>
  );
}

function LevelClearOverlay({ level, score, blocksLeft, onNext }) {
  const timeBonus = blocksLeft * 25;
  const finalScore = score + timeBonus;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-eyebrow">LEVEL {level.id} CLEAR</div>
        <h1 className="overlay-title">Nicely done.</h1>
        <div className="overlay-stats">
          <div className="overlay-stat">
            <div className="overlay-stat-label">Score</div>
            <div className="overlay-stat-value">{score}</div>
          </div>
          <div className="overlay-stat">
            <div className="overlay-stat-label">Blocks left</div>
            <div className="overlay-stat-value">{blocksLeft}</div>
          </div>
        </div>
        <button className="overlay-btn" onClick={onNext}>Next level →</button>
      </div>
    </div>
  );
}

function GameOverOverlay({ score, foundWords, level, levelIdx, onRetry, onHome }) {
  const uniqueWords = [...new Set(foundWords)];
  const cleared = score >= level.target;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-eyebrow" style={{ color: cleared ? "#6ee7a5" : "#ff4d6d" }}>
          {cleared ? "RUN COMPLETE" : "GAME OVER"}
        </div>
        <h1 className="overlay-title large">{score}</h1>
        <p className="overlay-desc">
          {cleared ? "You hit the target!" : `Needed ${level.target} on level ${level.id}.`}
        </p>
        {uniqueWords.length > 0 && (
          <div className="go-words-list">
            {uniqueWords.slice(0, 14).map((w, i) => (
              <div key={i} className="go-word-chip">{w}</div>
            ))}
            {uniqueWords.length > 14 && <div className="go-word-chip">+{uniqueWords.length - 14}</div>}
          </div>
        )}
        <button className="overlay-btn" onClick={onRetry}>Try again</button>
        <button className="overlay-btn secondary" onClick={onHome}>Back to title</button>
      </div>
    </div>
  );
}

// ─── Mount ─────────────────────────────────────────────────

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
