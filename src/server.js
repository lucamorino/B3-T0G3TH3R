import '@soundworks/helpers/polyfills.js';
import '@soundworks/helpers/catch-unhandled-errors.js';
import { Server } from '@soundworks/core/server.js';
import { loadConfig, configureHttpRouter } from '@soundworks/helpers/server.js';

import fs from 'node:fs';

import pluginPlatformInit from '@soundworks/plugin-platform-init/server.js';
import pluginSync from '@soundworks/plugin-sync/server.js';

import { metronomeGrid, barStart, SAMPLE_RATE } from './lib/metronome.js';
import { evaluateBar } from './lib/sync-index.js';
import { DESCRIPTORS, normalise, normaliseConfig } from './lib/descriptors.js';

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
// Audio routing between phones (WebRTC), edited in the controller's matrix:
// connections: Array<{ from: index, to: index }>, the sound of player `from` sent
// to the RNBO input of player `to`.
server.stateManager.defineClass('routing', {
  connections: { type: 'any', default: [] },
});

await server.start();

const global = await server.stateManager.create('global');
await server.stateManager.create('routing');

// ---------------------------------------------------------------------------
// WebRTC signaling
//
// Phones send their sound to each other peer to peer (see the player); the
// server only relays the offers, answers and ICE candidates between them, by
// player index. A player keeps its index when its page reloads (see the player
// registry below), so its peers may still hold connections to the page that is
// gone: when a player registers, every other one is told to drop them and
// connect again.
// ---------------------------------------------------------------------------
const rtcClients = new Map(); // player index -> soundworks client

server.onClientConnect((client) => {
  client.socket.addListener('webrtc:register', (playerIndex) => {
    rtcClients.set(playerIndex, client);
    for (const other of rtcClients.values()) {
      if (other !== client) other.socket.send('webrtc:peer-joined', playerIndex);
    }
  });
  client.socket.addListener('webrtc:signal', ({ to, payload }) => {
    rtcClients.get(to)?.socket.send('webrtc:signal', payload);
  });
});

server.onClientDisconnect((client) => {
  for (const [index, other] of rtcClients) {
    if (other === client) rtcClients.delete(index);
  }
});
const sync = await server.pluginManager.get('sync');

// Players seen since the server started, see the player registry below.
const devices = new Map(); // deviceId -> { index, nickname, score, state, lastSeen }
// Set when a score changes, see the global score below.
let scoreDirty = false;

// ---------------------------------------------------------------------------
// Targets
//
// The database of targets, descriptor configurations players have to reach, is
// read from data/targets.json at startup (TARGETS=path/to/file.json to use
// another one; tools/generate-targets.js makes a random one). The controller
// picks the current one by its index.
// ---------------------------------------------------------------------------
const TARGETS_FILE = process.env.TARGETS || 'data/targets.json';

function loadTargets() {
  try {
    const { targets } = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
    const valid = targets.filter(t => Array.isArray(t.configs) && t.configs.length > 0);
    console.log(`[targets] ${valid.length} targets loaded from ${TARGETS_FILE}`);
    return valid;
  } catch (err) {
    console.error(`[targets] could not read ${TARGETS_FILE}:`, err.message);
    return [];
  }
}

const targets = loadTargets();
// Last match result sent, see evaluateTarget() below.
let lastTargetMatch = '';

function selectTarget(index) {
  const target = targets[Math.min(index, targets.length - 1)] ?? null;
  global.set({ target });
  if (target) console.log(`[targets] target ${target.name}`);
}

global.set({ targetCount: targets.length });
selectTarget(global.get('targetIndex'));

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
    if (updates.phase === 'playing') {
      startMetronome();
    } else {
      lastTargetMatch = '';
      global.set({ metronomeOrigin: 0, sync: null, matched: [[]], targetMatch: {} });
    }
    scheduleRoundEnd();
  }
  if ('duration' in updates) {
    scheduleRoundEnd();
  }
  if ('pulsePeriod' in updates || 'pulsesPerBar' in updates) {
    moveMetronome();
  }
  if ('targetIndex' in updates) {
    selectTarget(updates.targetIndex);
  }
  if ('metronomeOrigin' in updates) {
    grid = metronomeGrid(global);
    reports.clear();
    nextBar = 0;
  }
  if ('resetScores' in updates) {
    for (const device of devices.values()) device.score = 0;
    scoreDirty = true;
    console.log('[game] scores reset');
  }
});

// ---------------------------------------------------------------------------
// Shared metronome
//
// The pulse grid starts shortly after the game starts playing, so every phone has
// time to see it coming. When the pulse or the bar changes during the game, the
// new grid starts on the next bar line of the previous one.
// ---------------------------------------------------------------------------
const LEAD_IN = 1; // seconds from the start of the game to its first pulse
const MIN_RESTART_DELAY = 0.25; // seconds, for the new grid to reach the phones

// Grid in force; it keeps the previous pulse and bar while they are being changed.
let grid = metronomeGrid(global);

function startMetronome() {
  global.set({ metronomeOrigin: sync.getSyncTime() + LEAD_IN });
}

function moveMetronome() {
  if (global.get('phase') !== 'playing' || grid.origin <= 0) return;
  const now = sync.getSyncTime();
  let bar = Math.max(0, Math.ceil((now - grid.origin) / grid.bar));
  if (barStart(grid, bar) - now < MIN_RESTART_DELAY) bar += 1;
  global.set({ metronomeOrigin: barStart(grid, bar) });
}

// ---------------------------------------------------------------------------
// Synchronisation
//
// Each phone records, on the metronome grid, what its player does during a bar
// (pad touch, tilt, sound features) and reports it once the bar is over. Shortly
// after the end of each bar, the server evaluates the bar from the reports it got
// (see src/lib/sync-index.js): every player gets a synchronisation index, their
// best with another player, and the players whose index reaches `syncThreshold`
// are synchronised. Synchronisation is shown, it does not score.
// ---------------------------------------------------------------------------
// Time after the end of a bar the server waits for the phones' reports.
const REPORT_GRACE = 0.5;
// Below these spreads of a layer's velocity, a player is considered still in it.
const MIN_SPREAD = { touch: 0.005, tilt: 0.01, sound: 0.003 };
// The recurrence of a signal is looked at over lags of up to 3 pulses: enough to
// see the pulse and half the tempo, and bounded for long bars.
const MAX_LAG_PULSES = 3;

const reports = new Map(); // bar -> Map(player index -> report)
let nextBar = 0; // next bar to evaluate

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function evaluate(bar) {
  const barReports = reports.get(bar) ?? new Map();
  reports.delete(bar);

  const layers = {
    touch: { weight: global.get('weightTouch'), minSpread: MIN_SPREAD.touch },
    tilt: { weight: global.get('weightTilt'), minSpread: MIN_SPREAD.tilt },
    sound: { weight: global.get('weightSound'), minSpread: MIN_SPREAD.sound },
  };
  const result = evaluateBar(barReports, layers, {
    phaseWeight: global.get('phaseWeight'),
    tolerance: global.get('tolerance'),
    maxLag: Math.max(4, Math.round(MAX_LAG_PULSES * grid.pulse * SAMPLE_RATE)),
  });

  const threshold = global.get('syncThreshold');
  const players = {};
  const synchronised = [];
  for (const [id, { index, partner, layers: pairLayers }] of Object.entries(result.players)) {
    const roundedLayers = {};
    for (const [name, value] of Object.entries(pairLayers)) {
      roundedLayers[name] = value === null ? null : round3(value);
    }
    players[id] = { index: round3(index), partner, layers: roundedLayers };
    if (partner !== null && index >= threshold) synchronised.push(Number(id));
  }

  global.set({
    sync: { bar, origin: grid.origin, duration: grid.bar, group: round3(result.group), synchronised, players },
  });

  if (barReports.size > 0) {
    console.log(`[sync] bar ${bar}: ${barReports.size} reports, group ${result.group.toFixed(2)}, synchronised: ${synchronised.join(', ') || '-'}`);
  }
}

setInterval(() => {
  if (global.get('phase') !== 'playing' || grid.origin <= 0) return;
  const now = sync.getSyncTime();
  while (now >= barStart(grid, nextBar + 1) + REPORT_GRACE) {
    evaluate(nextBar);
    nextBar += 1;
  }
}, 50);

function receiveReport(state, report) {
  // reports of a previous grid, or arriving after their bar was evaluated
  if (report.origin !== grid.origin || report.bar < nextBar) return;
  if (!reports.has(report.bar)) reports.set(report.bar, new Map());
  reports.get(report.bar).set(state.get('id'), report);
}

const controlCollection = await server.stateManager.getCollection('control');
const controlStates = new Map();

controlCollection.onAttach((state) => {
  controlStates.set(state.id, state);
  state.onUpdate((updates) => {
    if (updates.bar) receiveReport(state, updates.bar);
  });
  global.set({ numPlayers: controlStates.size });
}, true);

controlCollection.onDetach((state) => {
  controlStates.delete(state.id);
  global.set({ numPlayers: controlStates.size });
});

// ---------------------------------------------------------------------------
// Matching the target
//
// About 10 times a second, every player's sound (the descriptors the phone
// publishes, see control.js) is compared with their configuration of the
// target: the connected players, in index order, take the target's
// configurations in turn. A player who touches the pad and whose every
// descriptor is within `matchTolerance` of the target (normalised to the
// descriptor's range) matches it, and scores 1 point per second on their phone.
// ---------------------------------------------------------------------------
const MATCH_INTERVAL = 100;

function evaluateTarget() {
  const target = global.get('target');
  if (global.get('phase') !== 'playing' || !target) return;

  const configs = target.configs.map(normaliseConfig);
  const tolerance = global.get('matchTolerance');
  const states = Array.from(controlStates.values()).sort((a, b) => a.get('id') - b.get('id'));

  const targetMatch = {};
  const matched = [];
  states.forEach((state, rank) => {
    const config = rank % configs.length;
    const distances = DESCRIPTORS.map((d, i) => Math.abs(normalise(d, state.get(d.key)) - configs[config][i]));
    // the farthest descriptor decides: matching when closeness >= 1 - tolerance
    const closeness = 1 - Math.max(...distances);
    const isMatched = state.get('active') > 0 && closeness >= 1 - tolerance;
    const id = state.get('id');
    targetMatch[id] = { config, closeness: Math.round(closeness * 100) / 100, matched: isMatched };
    if (isMatched) matched.push(id);
  });

  // only send changes: every client receives the global state
  const serialised = JSON.stringify(targetMatch);
  if (serialised === lastTargetMatch) return;
  lastTargetMatch = serialised;
  global.set({ targetMatch, matched: [matched] });
}

setInterval(evaluateTarget, MATCH_INTERVAL);

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
