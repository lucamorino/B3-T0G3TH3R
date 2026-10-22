// What each player does, published by the player:
// - the analysis of its sound at 10Hz, which the display draws on its radar
// - once per bar, what it did during the bar (`bar`), from which the server
//   evaluates who is synchronised (see server.js and src/lib/sync-index.js)
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
    // true once the phone has delivered motion sensor data (tilt layer)
    motion: {
      type: 'boolean',
      default: false,
    },
    // Report of the last bar, sampled on the shared metronome grid:
    // { bar, origin, active, touch, tilt, sound }, where touch, tilt and sound are
    // series of samples ([x, y], [x, y] and five features, normalised), or null
    // when the phone has nothing to report for that layer.
    bar: {
      type: 'any',
      default: null,
      nullable: true,
    },
  };
