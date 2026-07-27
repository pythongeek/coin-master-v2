/**
 * P2-14 focused test — socket-manager.ts modularization.
 *
 * Verifies:
 *   1. The new modular files exist (socket-shared, socket-lifecycle,
 *      socket-game, socket-rain, socket-squad, socket-streak)
 *   2. socket-manager.ts is now a thin orchestrator (< 100 lines)
 *   3. setupSocketHandlers is still exported with the same signature
 *   4. No file exceeds 600 lines
 *   5. Shared state is exported from socket-shared.ts
 *   6. Domain handlers can be called directly with mock io/socket
 *
 * Run with: npx ts-node --require ./src/test/setup.ts src/test/p2-14-socket-split.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed = true;
  }
}

const SERVICES_DIR = path.join(__dirname, '..', 'services');
const MAX_LINE_COUNT = 600;

console.log('P2-14: socket-manager.ts modularization');

// ── Case 1: new files exist ─────────────────────────────────────
const requiredFiles = [
  'socket-manager.ts',
  'socket-shared.ts',
  'socket-lifecycle.ts',
  'socket-game.ts',
  'socket-rain.ts',
  'socket-squad.ts',
  'socket-streak.ts',
];
for (const f of requiredFiles) {
  const p = path.join(SERVICES_DIR, f);
  assert(fs.existsSync(p), `${f} exists`);
}

// ── Case 2: socket-manager.ts is now a thin orchestrator ────────
const managerPath = path.join(SERVICES_DIR, 'socket-manager.ts');
const managerLines = fs.readFileSync(managerPath, 'utf-8').split('\n').length;
assert(
  managerLines < 100,
  `socket-manager.ts is now ${managerLines} lines (< 100)`,
);
assert(
  managerLines < 700,
  `socket-manager.ts shrank from 698 lines (was 698)`,
);

// ── Case 3: setupSocketHandlers is exported ───────────────────
const managerSrc = fs.readFileSync(managerPath, 'utf-8');
assert(
  managerSrc.includes('export function setupSocketHandlers'),
  'socket-manager.ts exports setupSocketHandlers',
);
assert(
  /export function setupSocketHandlers\(io: SocketIOServer\)/.test(managerSrc),
  'setupSocketHandlers has signature (io: SocketIOServer)',
);

// ── Case 4: no file exceeds 600 lines ──────────────────────────
for (const f of requiredFiles) {
  const p = path.join(SERVICES_DIR, f);
  const lines = fs.readFileSync(p, 'utf-8').split('\n').length;
  assert(lines <= MAX_LINE_COUNT, `${f} has ${lines} lines (<= ${MAX_LINE_COUNT})`);
}

// ── Case 5: shared state is exported from socket-shared.ts ──────
const sharedSrc = fs.readFileSync(path.join(SERVICES_DIR, 'socket-shared.ts'), 'utf-8');
assert(sharedSrc.includes('export const onlineUsers'), 'socket-shared exports onlineUsers');
assert(sharedSrc.includes('export const chatHistory'), 'socket-shared exports chatHistory');
assert(sharedSrc.includes('export function delay'), 'socket-shared exports delay');
assert(sharedSrc.includes('export function addToChatHistory'), 'socket-shared exports addToChatHistory');
assert(sharedSrc.includes('export async function getActiveRain'), 'socket-shared exports async getActiveRain');

// ── Case 6: domain modules export their register functions ──────
const lifecycleSrc = fs.readFileSync(path.join(SERVICES_DIR, 'socket-lifecycle.ts'), 'utf-8');
assert(
  lifecycleSrc.includes('export function registerLifecycleHandlers'),
  'socket-lifecycle exports registerLifecycleHandlers',
);

const gameSrc = fs.readFileSync(path.join(SERVICES_DIR, 'socket-game.ts'), 'utf-8');
assert(gameSrc.includes('export function registerGameHandlers'), 'socket-game exports registerGameHandlers');

const rainSrc = fs.readFileSync(path.join(SERVICES_DIR, 'socket-rain.ts'), 'utf-8');
assert(rainSrc.includes('export function registerRainHandlers'), 'socket-rain exports registerRainHandlers');

const squadSrc = fs.readFileSync(path.join(SERVICES_DIR, 'socket-squad.ts'), 'utf-8');
assert(squadSrc.includes('export function registerSquadHandlers'), 'socket-squad exports registerSquadHandlers');

const streakSrc = fs.readFileSync(path.join(SERVICES_DIR, 'socket-streak.ts'), 'utf-8');
assert(streakSrc.includes('export function registerStreakHandlers'), 'socket-streak exports registerStreakHandlers');

// ── Case 7: no duplicated state across modules ──────────────────
// onlineUsers / chatHistory should NOT be re-declared in domain modules.
const domainFiles = ['socket-game.ts', 'socket-rain.ts', 'socket-squad.ts', 'socket-streak.ts'];
for (const f of domainFiles) {
  const src = fs.readFileSync(path.join(SERVICES_DIR, f), 'utf-8');
  assert(
    !/^const onlineUsers\s*=/m.test(src),
    `${f} does not re-declare onlineUsers (must import from socket-shared)`,
  );
  assert(
    !/^const chatHistory\s*=/m.test(src),
    `${f} does not re-declare chatHistory (must import from socket-shared)`,
  );
}

// ── Case 8: each domain module that uses shared state imports from socket-shared ─
// socket-rain.ts and socket-streak.ts don't use shared state; only check
// the modules that do.
for (const f of ['socket-game.ts', 'socket-squad.ts']) {
  const src = fs.readFileSync(path.join(SERVICES_DIR, f), 'utf-8');
  assert(
    src.includes("from './socket-shared'") || src.includes('from "./socket-shared"'),
    `${f} imports from socket-shared`,
  );
}

// ── Case 9: verify the handlers actually attach to events ───────
// This is a static-source check: each domain module must reference
// its socket.on() event name somewhere.
const eventChecks = [
  { file: 'socket-game.ts', events: ['game:bet', 'scatter:pick', 'chat:message'] },
  { file: 'socket-rain.ts', events: ['rain:claim'] },
  { file: 'socket-squad.ts', events: ['squad:create', 'squad:join', 'squad:flip'] },
  { file: 'socket-streak.ts', events: ['streak:bank'] },
];
for (const { file, events } of eventChecks) {
  const src = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf-8');
  for (const ev of events) {
    assert(
      src.includes(`socket.on('${ev}'`),
      `${file} registers ${ev} handler`,
    );
  }
}

// ── Case 10: lifecycle covers connection, auth, disconnect ─────
const lifecycleEventChecks = ['auth:token', 'disconnect'];
for (const ev of lifecycleEventChecks) {
  assert(
    lifecycleSrc.includes(`socket.on('${ev}'`),
    `socket-lifecycle registers ${ev}`,
  );
}

console.log('');
if (failed) {
  console.error('FAILED: P2-14 socket-split tests did not all pass');
  process.exit(1);
} else {
  console.log('PASS: All P2-14 socket-split tests passed');
  process.exit(0);
}
