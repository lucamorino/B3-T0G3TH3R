// src/global/global.js
export default {
  // Where the game is, set from the controller:
  // - waiting: players read the instructions, the display shows how to join
  // - playing: the pad is live, matching players score points
  // - scores:  the pad is hidden, phones and display show the scores
  // - end:     game over
  phase: {
    type: 'enum',
    list: ['waiting', 'playing', 'scores', 'end'],
    default: 'waiting',
  },
  // Sync time at which the current phase started, set by the server.
  syncTriggerTime: {
    type: 'float',
    default: 0,
  },
  // Length of a round in seconds, 0 for no time limit. When it runs out the server
  // moves the game on to the scores.
  duration: {
    type: 'float',
    default: 0,
    min: 0,
    max: 3600,
  },
  goal: {
    type: 'any',
    default: [30, 30, 30],
  },
  // ---- Shared metronome (see src/lib/metronome.js) ----
  // Time between two pulses, in milliseconds.
  pulsePeriod: {
    type: 'float',
    default: 500,
    min: 200,
    max: 2000,
  },
  // Pulses in a bar, the time unit in which synchronisation is evaluated.
  pulsesPerBar: {
    type: 'integer',
    default: 4,
    min: 1,
    max: 16,
  },
  // Sync time (seconds) of the first pulse of bar 0, set by the server when the
  // game starts playing and whenever the pulse or the bar changes. 0: no pulse.
  metronomeOrigin: {
    type: 'float',
    default: 0,
  },
  // Phones also click on every pulse.
  click: {
    type: 'boolean',
    default: false,
  },
  // ---- Synchronisation (see src/lib/sync-index.js) ----
  // Weight of each layer in a pair's index; 0 leaves the layer out.
  weightTouch: {
    type: 'float',
    default: 1,
    min: 0,
    max: 1,
  },
  weightTilt: {
    type: 'float',
    default: 1,
    min: 0,
    max: 1,
  },
  weightSound: {
    type: 'float',
    default: 1,
    min: 0,
    max: 1,
  },
  // Share of the phase lock (acting on the same beat) against the CPR index
  // (moving with the same rhythm) in each layer's index.
  phaseWeight: {
    type: 'float',
    default: 0.5,
    min: 0,
    max: 1,
  },
  // Recurrence radius, relative to the spread of each player's signal.
  tolerance: {
    type: 'float',
    default: 0.5,
    min: 0.05,
    max: 2,
  },
  // Index from which players count as synchronised (shown, no points).
  // 0.4 is the value from which synchronisation is considered remarkable in
  // Varni et al. (2012).
  syncThreshold: {
    type: 'float',
    default: 0.4,
    min: 0,
    max: 1,
  },
  // Result of the last evaluated bar, set by the server:
  // { bar, origin, duration, group, synchronised: [...indexes],
  //   players: { [id]: { index, partner, layers } } }
  sync: {
    type: 'any',
    default: null,
    nullable: true,
  },
  // ---- Targets (see src/lib/descriptors.js and data/targets.json) ----
  // Index, in the target database, of the target players have to reach.
  targetIndex: {
    type: 'integer',
    default: 0,
    min: 0,
    max: 100000,
  },
  // Number of targets in the database, set by the server.
  targetCount: {
    type: 'integer',
    default: 0,
    min: 0,
    max: 100000,
  },
  // The current target, set by the server from `targetIndex`:
  // { id, name, configs: [{ [descriptor]: value }, ...] }. With several
  // configurations, the players (in index order) take them in turn.
  target: {
    type: 'any',
    default: null,
    nullable: true,
  },
  // Largest distance, on every descriptor (normalised to its range, 0..1),
  // between a player's sound and its target for the player to match it.
  matchTolerance: {
    type: 'float',
    default: 0.1,
    min: 0.01,
    max: 0.5,
  },
  // How close each player is to their target, set by the server about 10 times a
  // second: { [id]: { config, closeness, matched } }, `config` being the index of
  // the player's configuration in the target and `closeness` 1 minus the
  // normalised distance of the descriptor farthest from it (a player matches
  // when closeness >= 1 - matchTolerance).
  targetMatch: {
    type: 'any',
    default: {},
  },
  // Indexes of the players matching their target, as [[...indexes]], set by the
  // server. Matching players score 1 point per second.
  matched: {
    type: 'any',
    default: [[]],
  },
  // Display: one slice of the radar per player instead of all on the same axes.
  radarSplit: {
    type: 'boolean',
    default: false,
  },
  // Sum of every player's score, maintained by the server. Values above `max` are
  // silently clamped, and many players pass 1000 quickly, hence the generous ceiling.
  global_score: {
    type: 'float',
    default: 0,
    min: 0,
    max: 1000000,
  },
  // Number of currently connected players, maintained by the server. Players read
  // this instead of subscribing to the whole `control` collection, which would make
  // every player receive every other player's analysis stream (O(n^2) traffic).
  numPlayers: {
    type: 'integer',
    default: 0,
    min: 0,
    max: 1000,
  },
  // Set from the controller: every player's score goes back to 0.
  resetScores: {
    type: 'boolean',
    event: true,
  },
};
