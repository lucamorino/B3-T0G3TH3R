// Analysis of each player's sound, published by the player at 10Hz. The server
// compares these between players to find who matches (see server.js), and the
// display draws them on its radar.
export default {
    // Must stay >= CAPACITY in server.js, otherwise indexes above `max` are
    // silently clamped and several players end up sharing one id.
    id: {
      type: 'float',
      default: 0,
      min: 0,
      max: 128,
    },
    // 1 while the player touches the pad
    active: {
      type: 'float',
      default: 0,
      min: 0,
      max: 1,
    },
    loudness: {
      type: 'float',
      default: 0,
      min: 0,
      max: 120,
    },
    sharpness: {
      type: 'float',
      default: 0,
      min: 0,
      max: 5,
    },
    spectralCentroid: {
      type: 'float',
      default: 0,
      min: 0,
      max: 10000,
    },
    dissonance: {
      type: 'float',
      default: 0,
      min: 0,
      max: 1,
    },
    spectralComplexity: {
      type: 'float',
      default: 0,
      min: 0,
      max: 100,
    },
  };
