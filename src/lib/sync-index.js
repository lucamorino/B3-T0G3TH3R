// Synchronisation index between players, computed once per bar (see server.js).
//
// After Varni et al., "Interactive sonification of synchronisation of motoric
// behaviour in social active listening to music with mobile devices", J Multimodal
// User Interfaces 5 (2012). The phase synchronisation of two players is the CPR
// index: the correlation of their normalised probabilities of recurrence,
//
//   CPR = < p̂1(τ), p̂2(τ) >
//
// where p(τ) is the probability that a player's signal comes back (within a
// tolerance ε) to where it was τ samples earlier. Two players whose movements
// recur with the same time lags (the same rhythm) have a CPR close to 1, whatever
// the shape of their movements.
//
// CPR does not see a constant phase offset: two players moving at the same tempo
// but half a pulse apart still score 1. With the shared metronome the signals of
// all players sit on the same time grid, so a second term, phase lock (the
// correlation of the signals themselves, at lag 0), rewards acting on the same
// beat. Each layer's index mixes both:
//
//   index = (1 - phaseWeight) * max(0, CPR) + phaseWeight * phaseLock
//
// A signal is a series of samples, each a vector (touch: [x, y], tilt: [x, y],
// sound: five features), all normalised to comparable ranges. Both terms work on
// its velocity (the difference between successive samples), like the paper works
// on accelerations: on positions, any two drifting movements recur less and less
// with the lag, and their recurrence curves correlate without any shared rhythm.

// Below this spread of the velocity (normalised units per sample) a signal is
// considered still: it carries no rhythm, so no index is computed for it, as in
// the paper, where not moving stops the feedback.
export const DEFAULT_MIN_SPREAD = 0.005;

function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Overall spread of a vector series: square root of the summed per-dimension
// variances, i.e. the RMS distance of the samples to their mean.
function spread(series) {
  const dims = series[0].length;
  let total = 0;
  for (let d = 0; d < dims; d++) {
    const m = mean(series.map(s => s[d]));
    let v = 0;
    for (const s of series) v += (s[d] - m) ** 2;
    total += v / series.length;
  }
  return Math.sqrt(total);
}

function velocity(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    out.push(series[i].map((v, d) => v - series[i - 1][d]));
  }
  return out;
}

function distance(a, b) {
  let sum = 0;
  for (let d = 0; d < a.length; d++) sum += (a[d] - b[d]) ** 2;
  return Math.sqrt(sum);
}

// Zero mean, unit variance; null if the values are constant.
function zscore(values) {
  const m = mean(values);
  let v = 0;
  for (const x of values) v += (x - m) ** 2;
  const sd = Math.sqrt(v / values.length);
  if (sd < 1e-9) return null;
  return values.map(x => (x - m) / sd);
}

/**
 * Analyse one player's signal over a bar, once, before comparing it with others.
 *
 * Returns null when the signal is missing, too short or still. Otherwise, for its
 * velocity:
 * - recurrence: normalised probability of recurrence p̂(τ), τ = 1..maxLag
 * - centered: the velocity per dimension, z-scored (null for a still dimension)
 *
 * `tolerance` sets the recurrence radius ε relative to the signal's own spread,
 * so that small and large movements are treated alike. `maxLag` (in samples)
 * bounds the lags looked at; by default two thirds of the bar, so a bar of 2
 * pulses still shows the pulse period, while the longest lag keeps a third of the
 * samples to compare.
 */
export function analyseSignal(series, { tolerance = 0.5, minSpread = DEFAULT_MIN_SPREAD, maxLag = Infinity } = {}) {
  if (!Array.isArray(series) || series.length < 9) return null;

  const v = velocity(series);
  const s = spread(v);
  if (s < minSpread) return null;

  const n = v.length;
  const epsilon = tolerance * s;
  const lags = Math.max(2, Math.min(Math.floor(n * 2 / 3), maxLag));

  const p = [];
  for (let lag = 1; lag <= lags; lag++) {
    let count = 0;
    for (let i = 0; i + lag < n; i++) {
      if (distance(v[i], v[i + lag]) < epsilon) count++;
    }
    p.push(count / (n - lag));
  }

  const recurrence = zscore(p);
  if (recurrence === null) return null;

  const dims = v[0].length;
  const centered = [];
  for (let d = 0; d < dims; d++) centered.push(zscore(v.map(x => x[d])));

  return { recurrence, centered };
}

/**
 * CPR index of two analysed signals, in [-1, 1].
 */
export function cpr(a, b) {
  const n = Math.min(a.recurrence.length, b.recurrence.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a.recurrence[i] * b.recurrence[i];
  return sum / n;
}

/**
 * Phase lock of two analysed signals, in [0, 1]: their correlation at lag 0,
 * averaged over the dimensions that move in both; moving in opposition scores 0.
 */
export function phaseLock(a, b) {
  const dims = Math.min(a.centered.length, b.centered.length);
  let sum = 0;
  let count = 0;
  for (let d = 0; d < dims; d++) {
    const x = a.centered[d];
    const y = b.centered[d];
    if (x === null || y === null) continue;
    const n = Math.min(x.length, y.length);
    let r = 0;
    for (let i = 0; i < n; i++) r += x[i] * y[i];
    sum += r / n;
    count++;
  }
  return count === 0 ? 0 : Math.max(0, sum / count);
}

/**
 * Synchronisation index of two analysed signals, in [0, 1].
 */
export function layerIndex(a, b, phaseWeight = 0.5) {
  return (1 - phaseWeight) * Math.max(0, cpr(a, b)) + phaseWeight * phaseLock(a, b);
}

/**
 * Evaluate a bar.
 *
 * `reports`: Map of player id -> { [layer]: series | null }
 * `layers`:  { [layer]: { weight, minSpread } }, layers of weight 0 are skipped
 * options:   phaseWeight, tolerance and maxLag (see above)
 *
 * Returns:
 * - players: { [id]: { index, partner, layers: { [layer]: index | null } } }, a
 *   player's index being their best synchronisation with another player, and
 *   `layers` the per-layer indexes of that pair
 * - group: mean index over every pair of players that could be compared
 */
export function evaluateBar(reports, layers, { phaseWeight = 0.5, tolerance = 0.5, maxLag = Infinity } = {}) {
  const layerNames = Object.keys(layers).filter(name => layers[name].weight > 0);

  // Each player's signals are analysed once, then compared with every other's.
  const analysed = new Map();
  for (const [id, report] of reports) {
    const signals = {};
    for (const name of layerNames) {
      signals[name] = analyseSignal(report[name], { tolerance, maxLag, minSpread: layers[name].minSpread });
    }
    analysed.set(id, signals);
  }

  const ids = Array.from(analysed.keys());
  const players = {};
  for (const id of ids) {
    players[id] = { index: 0, partner: null, layers: {} };
  }

  let groupSum = 0;
  let groupCount = 0;

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = analysed.get(ids[i]);
      const b = analysed.get(ids[j]);
      const pairLayers = {};
      let weighted = 0;
      let weights = 0;

      for (const name of layerNames) {
        if (a[name] === null || b[name] === null) {
          pairLayers[name] = null;
          continue;
        }
        const value = layerIndex(a[name], b[name], phaseWeight);
        pairLayers[name] = value;
        weighted += layers[name].weight * value;
        weights += layers[name].weight;
      }

      if (weights === 0) continue; // nothing comparable in this pair

      const index = weighted / weights;
      groupSum += index;
      groupCount++;

      for (const [self, other] of [[ids[i], ids[j]], [ids[j], ids[i]]]) {
        if (players[self].partner === null || index > players[self].index) {
          players[self] = { index, partner: other, layers: pairLayers };
        }
      }
    }
  }

  return { players, group: groupCount > 0 ? groupSum / groupCount : 0 };
}
