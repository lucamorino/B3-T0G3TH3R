import '@soundworks/helpers/polyfills.js';
import '@soundworks/helpers/catch-unhandled-errors.js';
import { Server } from '@soundworks/core/server.js';
import { loadConfig, configureHttpRouter } from '@soundworks/helpers/server.js';

import pluginPlatformInit from '@soundworks/plugin-platform-init/server.js';
import pluginSync from '@soundworks/plugin-sync/server.js';

import globalSchema from './global/global.js';
import userSchema from './clients/user.js';
import controlSchema from './clients/control.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

const config = loadConfig(process.env.ENV, import.meta.url);

console.log(`
--------------------------------------------------------
- launching "${config.app.name}" in "${process.env.ENV || 'default'}" environment
- [pid: ${process.pid}]
--------------------------------------------------------
`);

const server = new Server(config);
await configureHttpRouter(server);

// Register plugins and create shared state classes
server.pluginManager.register('platform-init', pluginPlatformInit);
server.pluginManager.register('sync', pluginSync);

// Maximum number of players (see the player registry below). The `id` field of the
// `user` and `control` classes must allow values up to CAPACITY - 1, otherwise
// indexes are silently clamped and players collide.
const CAPACITY = 50;

server.stateManager.defineClass('global', globalSchema);
server.stateManager.defineClass('user', userSchema);
server.stateManager.defineClass('control', controlSchema);

await server.start();

const global = await server.stateManager.create('global');
const sync = await server.pluginManager.get('sync');

// Players seen since the server started, see the player registry below.
const devices = new Map(); // deviceId -> { index, nickname, score, state, lastSeen }
// Set when a score changes, see the global score below.
let scoreDirty = false;

// ---------------------------------------------------------------------------
// Phases and round timer
//
// Every phase change is stamped with the sync time it happened at, so players and
// display show the same timer, and late joiners know how far into it they are.
// When a round has a duration, the game moves on to the scores once it runs out.
// ---------------------------------------------------------------------------
let roundTimeout = null;

function scheduleRoundEnd() {
  clearTimeout(roundTimeout);
  roundTimeout = null;

  const duration = global.get('duration');
  if (global.get('phase') !== 'playing' || duration <= 0) return;

  const elapsed = sync.getSyncTime() - global.get('syncTriggerTime');
  const remaining = Math.max(0, duration - elapsed);
  roundTimeout = setTimeout(() => {
    roundTimeout = null;
    console.log('[game] time is up');
    global.set({ phase: 'scores' });
  }, remaining * 1000);
}

global.onUpdate(async updates => {
  if ('phase' in updates) {
    await global.set({ syncTriggerTime: sync.getSyncTime() });
    console.log(`[game] phase: ${updates.phase}`);
    if (updates.phase !== 'playing') global.set({ matched: [[]] });
    scheduleRoundEnd();
  }
  if ('duration' in updates) {
    scheduleRoundEnd();
  }
  if ('resetScores' in updates) {
    for (const device of devices.values()) device.score = 0;
    scoreDirty = true;
    console.log('[game] scores reset');
  }
});

// ---------------------------------------------------------------------------
// Matching
//
// Two active players match when every analysis feature of one is within `delta`
// (relative) of the other's. Matched players score points (counted on their
// phones) for as long as they stay matched.
// ---------------------------------------------------------------------------
const ANALYSIS_FEATURES = ['loudness', 'sharpness', 'spectralCentroid', 'dissonance', 'spectralComplexity'];

function featuresMatch(stateA, stateB) {
  const delta = global.get('delta');
  for (const feature of ANALYSIS_FEATURES) {
    const a = stateA.get(feature);
    const b = stateB.get(feature);
    const avg = (a + b) / 2;
    if (avg < 1e-6) continue; // both near zero — treat as matching
    if (Math.abs(a - b) > delta * avg) return false;
  }
  return true;
}

function evaluateMatches(controlStates) {
  if (global.get('phase') !== 'playing') return;

  const active = Array.from(controlStates.values()).filter(s => s.get('active') > 0);
  const matchedIds = new Set();

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (featuresMatch(active[i], active[j])) {
        matchedIds.add(active[i].get('id'));
        matchedIds.add(active[j].get('id'));
      }
    }
  }

  global.set({ matched: [Array.from(matchedIds)] });
}

const controlCollection = await server.stateManager.getCollection('control');
const controlStates = new Map();

// `evaluateMatches` compares every pair of active players, so running it on each
// incoming update costs O(n^3) per second. The analysis itself only updates at 10Hz,
// so coalescing the pending updates onto a 10Hz tick is perceptually identical.
const MATCH_EVAL_INTERVAL = 100;
let matchEvalPending = false;

setInterval(() => {
  if (!matchEvalPending) return;
  matchEvalPending = false;
  evaluateMatches(controlStates);
}, MATCH_EVAL_INTERVAL);

controlCollection.onAttach((state) => {
  controlStates.set(state.id, state);
  state.onUpdate(() => { matchEvalPending = true; });
  global.set({ numPlayers: controlStates.size });
  matchEvalPending = true;
}, true);

controlCollection.onDetach((state) => {
  controlStates.delete(state.id);
  global.set({ numPlayers: controlStates.size });
  matchEvalPending = true;
});

// ---------------------------------------------------------------------------
// Player registry
//
// Each phone keeps a random device id in its localStorage and creates its `user`
// state with it. A new device gets the lowest free player index. A device seen
// before (the page reloaded after a screen lock, an app switch or a network blip)
// gets its index, nickname and score back, so it rejoins as the same player.
//
// Indexes stay reserved while a device is away. When every one is taken, a new
// device reclaims the slot of the device that has been away the longest.
//
// The registry lives in memory: restarting the server starts everyone afresh.
// ---------------------------------------------------------------------------
const NICKNAME_MAX_LENGTH = 16; // keep in sync with src/clients/identity.js

function sanitizeNickname(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
}

function allocateIndex() {
  const taken = new Set(Array.from(devices.values(), (device) => device.index));
  for (let index = 0; index < CAPACITY; index++) {
    if (!taken.has(index)) return index;
  }

  let longestAway = null;
  for (const [deviceId, device] of devices) {
    if (device.state === null && (longestAway === null || device.lastSeen < longestAway.device.lastSeen)) {
      longestAway = { deviceId, device };
    }
  }
  if (longestAway === null) return null;

  console.log(`[players] full, reclaiming #${longestAway.device.index} from "${longestAway.device.nickname}"`);
  devices.delete(longestAway.deviceId);
  scoreDirty = true;
  return longestAway.device.index;
}

// The global score is the sum of every player's score, players away included.
// Players publish their score twice a second, so it is summed at the same rate.
const SCORE_SUM_INTERVAL = 500;

setInterval(() => {
  if (!scoreDirty) return;
  scoreDirty = false;
  let sum = 0;
  for (const device of devices.values()) sum += device.score;
  global.set({ global_score: sum });
}, SCORE_SUM_INTERVAL);

const userCollection = await server.stateManager.getCollection('user');

userCollection.onAttach(async (state) => {
  const deviceId = state.get('deviceId');
  if (!deviceId) return;

  let device = devices.get(deviceId);
  const returning = device !== undefined;

  if (!returning) {
    const index = allocateIndex();
    if (index === null) {
      console.log('[players] full, refusing a new device');
      await state.set({ full: true });
      return;
    }
    device = { index, nickname: '', score: 0, state: null, lastSeen: 0 };
    devices.set(deviceId, device);
  }

  // If the device's previous connection has not been noticed as closed yet, this
  // newer one takes over; updates from the stale one are ignored from now on.
  device.state = state;

  state.onUpdate((updates) => {
    if (device.state !== state) return;
    if ('nickname' in updates) {
      const nickname = sanitizeNickname(updates.nickname);
      device.nickname = nickname;
      if (nickname !== updates.nickname) state.set({ nickname });
      console.log(`[players] #${device.index} is "${nickname}"`);
    }
    if ('local_score' in updates) {
      device.score = updates.local_score;
      scoreDirty = true;
    }
    if ('audioFormat' in updates) console.log(`[players] #${device.index} loaded ${updates.audioFormat} samples`);
  });

  await state.set({
    id: device.index,
    nickname: device.nickname,
    local_score: device.score,
    returning,
    assigned: true,
  });

  console.log(returning
    ? `[players] #${device.index} "${device.nickname}" rejoined`
    : `[players] #${device.index} joined (new device)`);
}, true);

userCollection.onDetach((state) => {
  for (const device of devices.values()) {
    if (device.state === state) {
      device.state = null;
      device.lastSeen = Date.now();
    }
  }
});
