// Sokoban solver: answers a whole set of 5 levels in one run.
//
// Idea: every generated level is a hallway with independent rooms off it
// (a box pushed into the hallway can never come back, so each room's boxes
// stay in that room). Each room is solved on its own, push-optimally, and
// the room solutions are stitched together with walks along the hallway.
//
// Inside a room the search is A* over pushes. A state is the boxes'
// squares plus the player's reachable region (named by its lowest square).
// The heuristic is the cheapest assignment of boxes to goals by walking
// distance (ignoring other boxes), which never overestimates the pushes
// still needed, so the first solved state popped is push-optimal. Two
// deadlocks are pruned: a box on a square from which no push can ever
// reach a goal (found by pulling boxes back from the goals), and a box
// caught in a frozen 2x2 block of walls and boxes with a box off its goal.
//
// Everything is budgeted by work (state counts), never by the wall clock,
// and every iteration order is fixed, so two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (state counts, never time): a room search that runs past
// its cap gives up on that level rather than risking the 60s wall budget.
const MAX_STATES_PER_ROOM = 600_000;
const MAX_STATES_PER_RUN = 3_000_000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

let statesSpent = 0;

/** Parse XSB text. Short rows and the outer frame count as wall. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Squares from which a box can still be pushed onto some goal. Walk
 * backwards from the goals: a box on square y can be pushed one step in
 * direction d onto x when the player can stand at y - d, i.e. that square
 * is open floor. Boxes elsewhere are dead and never worth pushing to.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DY[k]! * w + DX[k]!;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Split a level into rooms. The player's row is the hallway: every open
 * square on it is dead for boxes, so cutting those squares out of the
 * floor leaves one connected part per room. Returns null when the level
 * is not a set of rooms (a box in the hallway, a goal left outside, or a
 * part holding a different count of boxes and goals).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k]! * w + DX[k]!;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  }
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Flood the player's reachable region from `from` with `occupied` in the
 * way, stamping squares in `seen` with `stamp`; returns the lowest square
 * of the region. `stack` is scratch space.
 */
function floodRegion(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` is stuck in a frozen 2x2 block. */
function frozenAt(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player ends on after playing `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const k = STEP.indexOf(ch.toLowerCase());
    p += DY[k]! * w + DX[k]!;
  }
  return p;
}

/**
 * Push-optimal solution of `level` (boxes and goals as given), or null
 * when the search gives up. A* over pushes: f = pushes made + cheapest
 * box-to-goal assignment by walking distance. States are keyed by the
 * packed boxes plus the player's region, so the same position reached
 * with fewer pushes replaces the worse one.
 */
function solvePushOptimal(level: Level): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;

  // Walking distance from each goal over open floor (boxes ignored).
  const dist: Int32Array[] = goals.map(() => new Int32Array(size).fill(-1));
  goals.forEach((g, gi) => {
    const d = dist[gi]!;
    const queue = [g];
    d[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k]! * w + DX[k]!;
        if (!wall[q] && d[q] < 0) {
          d[q] = d[p]! + 1;
          queue.push(q);
        }
      }
    }
  });

  // Cheapest assignment of boxes to goals. With few boxes, try every
  // assignment (branch and bound); with many, sum each box's nearest goal.
  const heuristic = (boxes: number[]): number => {
    if (n <= 6) {
      const used = new Array<boolean>(n).fill(false);
      let best = Infinity;
      const rec = (i: number, sum: number): void => {
        if (sum >= best) return;
        if (i === n) {
          best = sum;
          return;
        }
        for (let j = 0; j < n; j++) {
          if (used[j]) continue;
          const dd = dist[j]![boxes[i]!]!;
          if (dd < 0) continue;
          used[j] = true;
          rec(i + 1, sum + dd);
          used[j] = false;
        }
      };
      rec(0, 0);
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let j = 0; j < n; j++) {
        const dd = dist[j]![b]!;
        if (dd >= 0 && dd < m) m = dd;
      }
      sum += m;
    }
    return sum;
  };

  const pack = (boxes: number[]): number => {
    let p = 0;
    for (let i = n - 1; i >= 0; i--) p = p * size + boxes[i]!;
    return p;
  };
  const unpack = (p: number): number[] => {
    const boxes = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      boxes[i] = p % size;
      p = Math.floor(p / size);
    }
    return boxes;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // State storage, in creation order. `keys` holds each state's index key,
  // so a state superseded by a better route to the same key is skipped
  // when popped.
  const packs: number[] = [];
  const keys: number[] = [];
  const players: number[] = [];
  const parents: number[] = [];
  const pushFrom: number[] = [];
  const pushTo: number[] = [];
  const gs: number[] = [];
  const fs: number[] = [];
  const index = new Map<number, number>();

  const startBoxes = level.boxes.slice();
  const startLow = floodRegion(w, wall, occupied, level.player, seen, ++stamp, stack);
  const startKey = pack(startBoxes) * size + startLow;
  packs.push(pack(startBoxes));
  keys.push(startKey);
  players.push(level.player);
  parents.push(-1);
  pushFrom.push(-1);
  pushTo.push(-1);
  gs.push(0);
  fs.push(heuristic(startBoxes));
  index.set(startKey, 0);

  // Binary heap of state ids, ordered by f, then deeper first, then older.
  const heap: number[] = [0];
  const before = (a: number, b: number): boolean =>
    fs[a]! < fs[b]! || (fs[a]! === fs[b]! && (gs[a]! > gs[b]! || (gs[a]! === gs[b]! && a < b)));
  const heapPush = (id: number): void => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && before(heap[c + 1]!, heap[c]!)) c++;
        if (!before(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = solved(startBoxes) ? 0 : -1;
  let created = 1;
  while (heap.length > 0 && found < 0) {
    const s = heapPop();
    // Superseded by a better route to the same key: skip it.
    if (index.get(keys[s]!) !== s) continue;
    const g = gs[s]!;
    const boxes = unpack(packs[s]!);
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    floodRegion(w, wall, occupied, players[s]!, seen, here, stack);
    for (let bi = 0; bi < n && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k]! * w + DX[k]!;
        const t = b + d;
        if (seen[b - d] !== here) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenAt(w, wall, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let npack = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          npack = pack(next);
          const low = floodRegion(w, wall, occupied, b, mark, ++stamp, stack);
          key = npack * size + low;
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const prev = index.get(key);
        if (prev !== undefined && gs[prev]! <= g + 1) continue;
        if (created >= MAX_STATES_PER_ROOM || statesSpent >= MAX_STATES_PER_RUN) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const id = packs.length;
        packs.push(npack);
        keys.push(key);
        players.push(b);
        parents.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        gs.push(g + 1);
        fs.push(g + 1 + heuristic(next));
        index.set(key, id);
        created++;
        statesSpent++;
        heapPush(id);
        if (solved(next)) {
          found = id;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push chain, then walk each push out in full.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parents[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of chain) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const k = d === -w ? 0 : d === w ? 1 : d === -1 ? 2 : 3;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += PUSH[k]!;
    player = from;
    boxes = unpack(packs[s]!);
  }
  return { pushes: chain.length, moves };
}

/** Solve one level's text, or '' when it cannot be solved in budget. */
function solve(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const rooms = roomsOf(level);
  if (rooms === null) return '';
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const squares = other.done ? other.goals : other.boxes;
      for (const q of squares) wall[q] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch (e) {
    console.error(id, 'solve failed:', e instanceof Error ? e.message : String(e));
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
