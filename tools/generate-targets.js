#!/usr/bin/env node
//
// Generate a random database of targets, the descriptor configurations players
// have to reach (see src/lib/descriptors.js and the README).
//
//   node tools/generate-targets.js [count] [file]
//
// Writes `count` targets (40 by default) to `file` (data/targets.json by default).
// Values are drawn uniformly in each descriptor's typical range. About a third of
// the targets are complementary: two configurations, one for each half of the
// players, instead of one shared by all of them.

import fs from 'node:fs';
import path from 'node:path';

import { DESCRIPTORS } from '../src/lib/descriptors.js';

const count = parseInt(process.argv[2] || '', 10) || 40;
const file = process.argv[3] || 'data/targets.json';
const COMPLEMENTARY_SHARE = 1 / 3;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function randomConfig() {
  const config = {};
  for (const { key, typical: [low, high] } of DESCRIPTORS) {
    // 3 significant digits are plenty for a target
    const value = low + Math.random() * (high - low);
    const digits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(value) || 1)));
    config[key] = round(value, digits);
  }
  return config;
}

const targets = Array.from({ length: count }, (_, i) => {
  const complementary = Math.random() < COMPLEMENTARY_SHARE;
  return {
    id: i,
    name: `T${String(i + 1).padStart(2, '0')}${complementary ? ' (complementary)' : ''}`,
    configs: complementary ? [randomConfig(), randomConfig()] : [randomConfig()],
  };
});

const database = {
  descriptors: DESCRIPTORS.map(({ key }) => key),
  targets,
};

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(database, null, 2) + '\n');
console.log(`${targets.length} targets written to ${file}`);
