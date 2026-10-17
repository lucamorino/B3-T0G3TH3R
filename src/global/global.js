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
  // Relative tolerance under which two players' analysis features match.
  delta: {
    type: 'float',
    default: 0.1,
    min: 0,
    max: 1,
  },
  // Indexes of the players currently matched, as [[...indexes]], set by the server.
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
