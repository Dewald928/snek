// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
import { schema, t, table, SenderError } from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const GRID_WIDTH = 60;
const GRID_HEIGHT = 50;
const INITIAL_SNAKE_LENGTH = 3;
const PELLET_COUNT = 32;
const TICK_INTERVAL_MICROS = 150_000n; // 150ms

const DIRECTIONS = ["up", "down", "left", "right"] as const;
type Dir = (typeof DIRECTIONS)[number];

function isDir(s: string): s is Dir {
  return DIRECTIONS.includes(s as Dir);
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
const Vec2 = t.object("Vec2", { x: t.i32(), y: t.i32() });

// ─────────────────────────────────────────────────────────────────────────────
// TABLES
// ─────────────────────────────────────────────────────────────────────────────
const user = table(
  { name: "user", public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string().optional(),
    online: t.bool(),
  },
);

const message = table(
  { name: "message", public: true },
  { sender: t.identity(), sent: t.timestamp(), text: t.string() },
);

const snake = table(
  { name: "snake", public: true },
  {
    identity: t.identity().primaryKey(),
    body: t.array(Vec2),
    direction: t.string(),
    nextDirection: t.string().optional(),
    alive: t.bool(),
  },
);

const pellet = table(
  { name: "pellet", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    x: t.i32(),
    y: t.i32(),
  },
);

// Single row: next scheduled tick. Scheduled reducer runs game_tick.
const gameTick = table(
  {
    name: "game_tick",
    scheduled: () => run_game_tick,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  },
);

// One row: spawn counter for deterministic pellet placement (reducers must be deterministic)
const spawnCounter = table(
  { name: "spawn_counter", public: false },
  {
    id: t.u64().primaryKey(), // single row id = 1n
    value: t.u64(),
  },
);

const spacetimedb = schema({
  user,
  message,
  snake,
  pellet,
  gameTick,
  spawnCounter,
});
export default spacetimedb;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function nextHead(x: number, y: number, dir: Dir): { x: number; y: number } {
  switch (dir) {
    case "up":
      return { x, y: y - 1 };
    case "down":
      return { x, y: y + 1 };
    case "left":
      return { x: x - 1, y };
    case "right":
      return { x: x + 1, y };
  }
}

function opposite(dir: Dir): Dir {
  switch (dir) {
    case "up":
      return "down";
    case "down":
      return "up";
    case "left":
      return "right";
    case "right":
      return "left";
  }
}

// Build set of occupied grid cells (snake segments + pellets)
function getAllOccupiedCellsTyped(
  snakes: Iterable<{ body: Array<{ x: number; y: number }> }>,
  pellets: Iterable<{ x: number; y: number }>,
): Set<string> {
  const set = new Set<string>();
  for (const s of snakes) {
    for (const seg of s.body) {
      set.add(`${seg.x},${seg.y}`);
    }
  }
  for (const p of pellets) {
    set.add(`${p.x},${p.y}`);
  }
  return set;
}

// Multiplicative hash constant (32-bit) so spawn indices are scattered across the grid (no diagonal bands)
const HASH_PRIME = 2654435761;

function findEmptyCell(
  occupied: Set<string>,
  startCounter: bigint,
): { x: number; y: number } | null {
  const total = GRID_WIDTH * GRID_HEIGHT;
  for (let i = 0; i < total; i++) {
    const k = Number((startCounter + BigInt(i)) % BigInt(0x100000000));
    const n = ((k * HASH_PRIME) >>> 0) % total;
    const x = n % GRID_WIDTH;
    const y = Math.floor(n / GRID_WIDTH) % GRID_HEIGHT;
    if (!occupied.has(`${x},${y}`)) return { x, y };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// REDUCERS
// ─────────────────────────────────────────────────────────────────────────────
export const set_direction = spacetimedb.reducer(
  { direction: t.string() },
  (ctx, { direction }) => {
    if (!isDir(direction)) throw new SenderError("Invalid direction");
    const row = ctx.db.snake.identity.find(ctx.sender);
    if (!row) throw new SenderError("No snake for this player");
    if (!row.alive) return;
    const current = row.direction as Dir;
    if (opposite(current) === direction) return; // no reverse
    ctx.db.snake.identity.update({ ...row, nextDirection: direction });
  },
);

export const respawn = spacetimedb.reducer((ctx) => {
  const row = ctx.db.snake.identity.find(ctx.sender);
  if (!row || row.alive) return;
  const occupied = getAllOccupiedCellsTyped(
    ctx.db.snake.iter(),
    ctx.db.pellet.iter(),
  );
  const counterRow = ctx.db.spawnCounter.id.find(1n);
  const nextVal = counterRow ? counterRow.value + 1n : 1n;
  if (counterRow) {
    ctx.db.spawnCounter.id.update({ ...counterRow, value: nextVal });
  } else {
    ctx.db.spawnCounter.insert({ id: 1n, value: nextVal });
  }
  const cell = findEmptyCell(occupied, nextVal);
  if (!cell) return;
  const body = Array.from({ length: 1 }, () => ({ x: cell.x, y: cell.y }));
  ctx.db.snake.identity.update({
    ...row,
    body,
    direction: "right",
    nextDirection: undefined,
    alive: true,
  });
});

// Scheduled reducer: one game tick, then schedule next
export const run_game_tick = spacetimedb.reducer(
  { arg: gameTick.rowType },
  (ctx, { arg }) => {
    const occupied = getAllOccupiedCellsTyped(
      ctx.db.snake.iter(),
      ctx.db.pellet.iter(),
    );

    for (const s of ctx.db.snake.iter()) {
      if (!s.alive) continue;
      const dir = (s.nextDirection ?? s.direction) as Dir;
      const head = s.body[0];
      if (!head) continue;
      const { x: nx, y: ny } = nextHead(head.x, head.y, dir);

      // Wall
      if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) {
        ctx.db.snake.identity.update({ ...s, alive: false });
        continue;
      }

      // Pellet
      let ate = false;
      for (const p of ctx.db.pellet.iter()) {
        if (p.x === nx && p.y === ny) {
          ate = true;
          ctx.db.pellet.id.delete(p.id);
          // New pellet must not spawn on (nx,ny) which will be snake head
          occupied.add(`${nx},${ny}`);
          const counterRow = ctx.db.spawnCounter.id.find(1n);
          const nextVal = counterRow ? counterRow.value + 1n : 1n;
          if (counterRow) {
            ctx.db.spawnCounter.id.update({ ...counterRow, value: nextVal });
          } else {
            ctx.db.spawnCounter.insert({ id: 1n, value: nextVal });
          }
          const newCell = findEmptyCell(occupied, nextVal);
          if (newCell) {
            ctx.db.pellet.insert({
              id: 0n,
              x: newCell.x,
              y: newCell.y,
            });
          }
          break;
        }
      }

      // Collision with any *alive* snake body (including self after move). Dead snakes are ghosts — no collision.
      const newBody = [{ x: nx, y: ny }, ...s.body];
      if (!ate) newBody.pop();
      let dead = false;
      for (const other of ctx.db.snake.iter()) {
        if (!other.alive) continue; // skip ghosts
        const segments = other.identity.isEqual(s.identity)
          ? newBody.slice(1)
          : other.body;
        for (const seg of segments) {
          if (seg.x === nx && seg.y === ny) {
            dead = true;
            break;
          }
        }
        if (dead) break;
      }
      if (dead) {
        ctx.db.snake.identity.update({ ...s, alive: false });
        continue;
      }

      ctx.db.snake.identity.update({
        ...s,
        body: newBody,
        direction: dir,
        nextDirection: undefined,
      });
    }

    // Schedule next tick
    const nextTime = ctx.timestamp.microsSinceUnixEpoch + TICK_INTERVAL_MICROS;
    ctx.db.gameTick.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(nextTime),
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// CHAT (KEEP)
// ─────────────────────────────────────────────────────────────────────────────
function validateName(name: string) {
  if (!name) throw new SenderError("Names must not be empty");
}

export const set_name = spacetimedb.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    validateName(name);
    const userRow = ctx.db.user.identity.find(ctx.sender);
    if (!userRow) throw new SenderError("Cannot set name for unknown user");
    ctx.db.user.identity.update({ ...userRow, name });
  },
);

function validateMessage(text: string) {
  if (!text) throw new SenderError("Messages must not be empty");
}

export const send_message = spacetimedb.reducer(
  { text: t.string() },
  (ctx, { text }) => {
    validateMessage(text);
    ctx.db.message.insert({
      sender: ctx.sender,
      text,
      sent: ctx.timestamp,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
export const init = spacetimedb.init((ctx) => {
  // Initial pellets and first game tick are created in clientConnected when first client joins,
  // or we could create them here. SpacetimeDB init runs once when module is first published.
  // Seed initial pellets in first game_tick or on first connect. Here we only ensure spawn counter exists.
  ctx.db.spawnCounter.insert({ id: 1n, value: 0n });
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  const userRow = ctx.db.user.identity.find(ctx.sender);
  if (userRow) {
    ctx.db.user.identity.update({ ...userRow, online: true });
  } else {
    ctx.db.user.insert({
      name: undefined,
      identity: ctx.sender,
      online: true,
    });
  }

  // Snake: create if not exists — start in grid center so layout is never all top-left
  let snakeRow = ctx.db.snake.identity.find(ctx.sender);
  if (!snakeRow) {
    const occupied = getAllOccupiedCellsTyped(
      ctx.db.snake.iter(),
      ctx.db.pellet.iter(),
    );
    const centerX = Math.floor(GRID_WIDTH / 2) - 1;
    const centerY = Math.floor(GRID_HEIGHT / 2);
    const body: Array<{ x: number; y: number }> = [];
    const canUseCenter =
      !occupied.has(`${centerX},${centerY}`) &&
      !occupied.has(`${centerX + 1},${centerY}`) &&
      !occupied.has(`${centerX + 2},${centerY}`);
    if (canUseCenter) {
      for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
        body.push({ x: centerX + i, y: centerY });
      }
    } else {
      const counterRow = ctx.db.spawnCounter.id.find(1n);
      const nextVal = counterRow ? counterRow.value + 1n : 1n;
      if (counterRow) {
        ctx.db.spawnCounter.id.update({ ...counterRow, value: nextVal });
      } else {
        ctx.db.spawnCounter.insert({ id: 1n, value: nextVal });
      }
      const cell = findEmptyCell(occupied, nextVal);
      if (!cell) return;
      for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
        body.push({ x: cell.x + i, y: cell.y });
      }
    }
    ctx.db.snake.insert({
      identity: ctx.sender,
      body,
      direction: "left",
      nextDirection: undefined,
      alive: true,
    });
  }

  // Ensure pellets exist (lazy: only if pellet count is below PELLET_COUNT)
  const pelletRows = [...ctx.db.pellet.iter()];
  if (pelletRows.length < PELLET_COUNT) {
    const occupied = getAllOccupiedCellsTyped(
      ctx.db.snake.iter(),
      ctx.db.pellet.iter(),
    );
    const counterRow = ctx.db.spawnCounter.id.find(1n);
    let counter = counterRow ? counterRow.value : 0n;
    for (let i = pelletRows.length; i < PELLET_COUNT; i++) {
      counter += 1n;
      if (counterRow) {
        ctx.db.spawnCounter.id.update({ ...counterRow, value: counter });
      } else {
        ctx.db.spawnCounter.insert({ id: 1n, value: counter });
      }
      const cell = findEmptyCell(occupied, counter);
      if (cell) {
        ctx.db.pellet.insert({ id: 0n, x: cell.x, y: cell.y });
        occupied.add(`${cell.x},${cell.y}`);
      }
    }
  }

  // Ensure game tick is scheduled (only one row at a time)
  const tickRows = [...ctx.db.gameTick.iter()];
  if (tickRows.length === 0) {
    const nextTime = ctx.timestamp.microsSinceUnixEpoch + TICK_INTERVAL_MICROS;
    ctx.db.gameTick.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(nextTime),
    });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const userRow = ctx.db.user.identity.find(ctx.sender);
  if (userRow) {
    ctx.db.user.identity.update({ ...userRow, online: false });
  }
});
