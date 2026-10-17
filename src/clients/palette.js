// Player colours, shared by the players (colour dot, matched background,
// oscilloscope), the display (cards, radar, legend) and the controller, so a
// player has the same colour everywhere.
//
// The first eight entries are the original palette, so small groups look as they
// always did. The rest are spread around the hue circle by the golden angle, which
// keeps any run of consecutive player indexes visually distinct, and alternate
// lightness so neighbouring hues stay apart on the dark background.

const BASE = [
  [255, 99, 132],
  [54, 162, 235],
  [255, 206, 86],
  [75, 192, 192],
  [153, 102, 255],
  [255, 159, 64],
  [199, 199, 199],
  [100, 140, 255],
];

const PALETTE_SIZE = 64;
const GOLDEN_ANGLE = 137.508;
const LIGHTNESS = [0.62, 0.5, 0.72];

function hslToRgb(hue, saturation, lightness) {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

const generated = Array.from({ length: PALETTE_SIZE - BASE.length }, (_, i) => {
  const hue = (20 + i * GOLDEN_ANGLE) % 360;
  return hslToRgb(hue, 0.75, LIGHTNESS[i % LIGHTNESS.length]);
});

export const PLAYER_PALETTE = [...BASE, ...generated].map(([r, g, b]) => ({
  r,
  g,
  b,
  stroke: `rgba(${r}, ${g}, ${b}, 0.9)`,
  fill: `rgba(${r}, ${g}, ${b}, 0.15)`,
}));

// Colour for a player index. Wraps around past the end of the palette rather than
// failing, so raising the server's capacity never breaks a client.
export function playerColor(index) {
  const i = Number.isFinite(index) ? Math.abs(Math.round(index)) : 0;
  return PLAYER_PALETTE[i % PLAYER_PALETTE.length];
}
