import { samplePath } from './audio-format.js';

const contexts = new Map();

async function fetchAndDecode(context, pathname) {
  const response = await fetch(pathname);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${pathname}: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return context.decodeAudioData(arrayBuffer);
}

// `pathname` names the original .mp3 / .wav file. Devices that can decode Opus
// load its .webm version instead (see audio-format.js), and fall back to the
// original if that one file fails anyway.
export default async function loadAudioBuffer(pathname, sampleRate = 48000) {
  if (!contexts.has(sampleRate)) {
    const context = new OfflineAudioContext(1, 1, sampleRate);
    contexts.set(sampleRate, context);
  }

  const context = contexts.get(sampleRate);
  const preferred = await samplePath(pathname);

  if (preferred === pathname) {
    return fetchAndDecode(context, pathname);
  }

  try {
    return await fetchAndDecode(context, preferred);
  } catch (err) {
    console.warn(`Could not load ${preferred}, falling back to ${pathname}`, err);
    return fetchAndDecode(context, pathname);
  }
}
