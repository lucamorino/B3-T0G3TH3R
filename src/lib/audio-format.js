// Picks which encoding of the samples a device loads.
//
// Samples are stored twice: as Opus (.webm, a fraction of the size) and as the
// original .mp3 / .wav. Opus support in decodeAudioData is patchy on iOS, and
// failing there would leave a phone silent, so instead of trusting the browser's
// self-description each device decodes a tiny Opus clip once, and loads Opus only
// if that works. Re-encode with tools/encode-audio.sh after changing a sample.

// 60ms of silence, Opus in WebM (526 bytes)
const OPUS_PROBE = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAHeEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggEwTbuMU6uEHFO7a1OsggHI7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiEBRAAAAAAAAFlSua+WuAQAAAAAAAFzXgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQLhkZ+BAbWIQOdwAAAAAABiZIEQY6KTT3B1c0hlYWQBATgBgLsAAAAAABJUw2fRc3POY8CLY8WIAAAAAAAAAAFnyJlFo4dFTkNPREVSRIeMTGF2YyBsaWJvcHVzZ8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMC4wNjgwMDAwMDAAH0O2db3ngQCji4EAAIAIC+Y7I6tgo4qBABWACAissw7Go4qBACmACAissw7GoJOhioEAPQAICKyzDsZ1ooQAzf5gHFO7a5G7j7OBALeK94EB8YIBhvCBAw==';

let opusSupport = null;

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Resolves to true if this device can decode Opus samples. Decoded once and cached.
 */
export function canDecodeOpus() {
  if (opusSupport === null) {
    opusSupport = (async () => {
      try {
        const context = new OfflineAudioContext(1, 1, 48000);
        const buffer = await context.decodeAudioData(base64ToArrayBuffer(OPUS_PROBE));
        return buffer.length > 0;
      } catch {
        return false;
      }
    })();
  }
  return opusSupport;
}

/**
 * Path of the encoding of `path` this device should load: the .webm (Opus)
 * version if it can decode Opus, `path` itself otherwise.
 */
export async function samplePath(path) {
  return (await canDecodeOpus()) ? path.replace(/\.(mp3|wav)$/, '.webm') : path;
}
