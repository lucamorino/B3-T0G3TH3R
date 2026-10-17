export default {
    // Must stay >= CAPACITY in server.js, otherwise indexes above `max` are
    // silently clamped and several players end up sharing one id.
    id: {
      type: 'float',
      default: 0,
      min: 0,
      max: 128,
    },
    // Sound of the player's instrument, set from the controller and forwarded to
    // the RNBO device.
    volume: {
      type: 'float',
      default: 1,
      min: 0,
      max: 1,
    },
    style: {
      type: 'any',
      default: [659, 436, 172],
    },
    fb_gain: {
      type: 'float',
      default: 0.31,
      min: 0.001,
      max: 3.99,
    },
    fb_trim: {
      type: 'float',
      default: 0.31,
      min: 0.001,
      max: 3.99,
    },
    fade: {
      type: 'float',
      default: 200,
      min: 10,
      max: 10000,
    },
    mod: {
      type: 'float',
      default: 0.5,
      min: 0,
      max: 1,
    },
    env: {
      type: 'any',
      default: [30, 70],
    },
    LFO: {
      type: 'any',
      default: [0, 2.5, 0.2],
    },
    // Values above `max` are silently clamped.
    local_score: {
      type: 'float',
      default: 0,
      min: 0,
      max: 100000,
    },
    // Identity, see the player registry in server.js. The player creates its state
    // with `deviceId` (kept in the phone's localStorage); the server answers by
    // setting `id`, `nickname` and `local_score` (restored when the phone has been
    // here before), `returning` and `assigned`, or `full` when every slot is taken.
    deviceId: {
      type: 'string',
      default: '',
    },
    nickname: {
      type: 'string',
      default: '',
    },
    assigned: {
      type: 'boolean',
      default: false,
    },
    // true when the phone has been here before: it skips the nickname screen and
    // the instructions, whether or not it chose a nickname then
    returning: {
      type: 'boolean',
      default: false,
    },
    full: {
      type: 'boolean',
      default: false,
    },
    // 'opus' or 'mp3': which encoding of the samples this phone loaded.
    audioFormat: {
      type: 'string',
      default: '',
    },
  };
