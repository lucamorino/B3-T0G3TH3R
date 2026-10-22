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
  // Value sent to the RNBO `start` inport while playing (0 outside of `playing`).
  start: {
    type: 'float',
    default: 1,
    min: 0,
    max: 1,
  },
  goal: {
    type: 'any',
    default: [30, 30, 30],
  },
  // Third value of the RNBO `touch` message, shared by every player.
  slider: {
    type: 'float',
    default: 30,
    min: 0,
    max: 100,
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
  // Index from which players count as synchronised: they light up and score.
  // 0.4 is the value from which synchronisation is considered remarkable in
  // Varni et al. (2012).
  syncThreshold: {
    type: 'float',
    default: 0.4,
    min: 0,
    max: 1,
  },
  // Result of the last evaluated bar, set by the server:
  // { bar, origin, duration, group, players: { [id]: { index, partner, layers } } }
  sync: {
    type: 'any',
    default: null,
    nullable: true,
  },
  // Indexes of the players synchronised in the last bar, as [[...indexes]], set by
  // the server.
  matched: {
    type: 'any',
    default: [[]],
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
