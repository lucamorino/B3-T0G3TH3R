// Sound descriptors of a player's sound, analysed on the phone (RNBO for sharpness
// and loudness, Essentia for the others), shared by every part of the game: the
// display's radar, the matching against targets (server), the synchronisation's
// sound layer and the target generator (tools/generate-targets.js).
//
// - min, max: the range drawn on the radar, to which values are normalised
// - typical:  the range most sounds fall in, [10th, 90th percentile], measured on
//   the B3-H4RSH_NINA patch across its presets and the whole pad; random targets
//   are drawn from it so that they can be reached
export const DESCRIPTORS = [
  { key: 'sharpness',          label: 'Sharpness',  min: 0.5, max: 3,    typical: [1, 1.85] },
  { key: 'loudness',           label: 'Loudness',   min: 0,   max: 100,  typical: [41, 80] },
  { key: 'spectralCentroid',   label: 'Centroid',   min: 0,   max: 4000, typical: [315, 2300] },
  { key: 'dissonance',         label: 'Dissonance', min: 0,   max: 0.5,  typical: [0.006, 0.43] },
  { key: 'spectralComplexity', label: 'Complexity', min: 0,   max: 60,   typical: [4.5, 44.5] },
];

/**
 * A descriptor's value mapped to 0..1 over its range (clamped).
 */
export function normalise(descriptor, value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - descriptor.min) / (descriptor.max - descriptor.min)));
}

/**
 * A configuration ({ [key]: value } in descriptor units) as normalised values, in
 * the order of DESCRIPTORS.
 */
export function normaliseConfig(config) {
  return DESCRIPTORS.map(d => normalise(d, config?.[d.key]));
}
