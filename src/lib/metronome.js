// Shared metronome. The server anchors a grid of pulses on the sync time
// (`metronomeOrigin` in the global state); every device derives the current pulse
// and bar from it, so all of them pulse together.
//
// A bar of `pulsesPerBar` pulses is the time unit in which players act together
// and in which their synchronisation is evaluated (see sync-index.js).

// Rate at which the phones sample touch, tilt and sound within a bar.
export const SAMPLE_RATE = 20; // Hz

/**
 * Grid described by the global state: times in seconds of sync time.
 */
export function metronomeGrid(global) {
  const pulse = global.get('pulsePeriod') / 1000;
  const pulsesPerBar = global.get('pulsesPerBar');
  return {
    origin: global.get('metronomeOrigin'),
    pulse,
    pulsesPerBar,
    bar: pulse * pulsesPerBar,
  };
}

/**
 * Where `time` (sync time, seconds) falls on the grid, or null before its origin.
 * - bar:        index of the bar since the origin
 * - pulse:      index of the pulse within the bar (0 is the downbeat)
 * - sincePulse: seconds since that pulse
 * - barTime:    seconds since the start of the bar
 */
export function gridPosition(grid, time) {
  if (grid.origin <= 0 || time < grid.origin) return null;
  const elapsed = time - grid.origin;
  const pulseCount = Math.floor(elapsed / grid.pulse);
  return {
    bar: Math.floor(pulseCount / grid.pulsesPerBar),
    pulse: pulseCount % grid.pulsesPerBar,
    sincePulse: elapsed - pulseCount * grid.pulse,
    barTime: elapsed - Math.floor(pulseCount / grid.pulsesPerBar) * grid.bar,
  };
}

/**
 * Sync time at which bar `bar` starts.
 */
export function barStart(grid, bar) {
  return grid.origin + bar * grid.bar;
}

/**
 * Number of samples a bar holds at SAMPLE_RATE.
 */
export function samplesPerBar(grid) {
  return Math.max(1, Math.round(grid.bar * SAMPLE_RATE));
}
