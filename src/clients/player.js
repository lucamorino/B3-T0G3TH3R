import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import '@ircam/sc-components';
import devicemotion from '@ircam/devicemotion';

import "../lib/guardrails.js";

import { Scheduler } from '@ircam/sc-scheduling';
import loadAudioBuffer from '../lib/load-audio-buffer.js';
import LoopSampler from '../lib/LoopSampler.js';
import { playerColor } from './palette.js';
import { getDeviceId, waitForAssignment, openNicknameScreen, showGameFull } from './identity.js';
import { canDecodeOpus } from '../lib/audio-format.js';
import { metronomeGrid, gridPosition, samplesPerBar, SAMPLE_RATE } from '../lib/metronome.js';
import { DESCRIPTORS, normalise } from '../lib/descriptors.js';
import setupAudioSharing from '../lib/audio-sharing.js';

import pluginPlatformInit from '@soundworks/plugin-platform-init/client.js';
import pluginSync from '@soundworks/plugin-sync/client.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

async function main($container) {

  const config = loadConfig();
  const client = new Client(config);

  // The launcher reloads the page 50ms after it is hidden (screen lock, app switch),
  // so a player who drops out mid-game comes back to a page that booted in the
  // background. An AudioContext created there, while the phone's audio session is
  // interrupted, can run (analysers, oscilloscope and RNBO analysis all work) yet
  // never reach the speaker, even after the platform-init tap resumes it. Create it
  // only once the page is visible again.
  await waitUntilVisible();

  // iOS 16.4+: play as media rather than as an "ambient" sound, so the context is
  // not muted by the silent switch nor left silent after an interruption.
  if (navigator.audioSession) {
    try {
      navigator.audioSession.type = 'playback';
    } catch (err) {
      console.warn('Could not set the audio session type:', err);
    }
  }

  const audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  console.log(audioContext.sampleRate);
  console.log(audioContext.baseLatency);

  // Motion sensors, for the tilt layer. On iOS they need the player's permission,
  // asked on the platform-init tap, and over https. A refusal, or a phone without
  // sensors, must not keep the player out of the game: the wrapper always reports
  // the feature as available, and the tilt layer is just left out for that phone.
  let motionPermission = 'refused';
  const motionFeature = {
    async requestPermission() {
      try {
        motionPermission = await devicemotion.requestPermission();
      } catch (err) {
        console.warn('Could not access the motion sensors:', err);
      }
      return 'granted';
    },
  };

  client.pluginManager.register('platform-init', pluginPlatformInit, {
    audioContext,
    devicemotion: motionFeature,
  });
  client.pluginManager.register('sync', pluginSync, {
    getTimeFunction: () => audioContext.currentTime,
  }, ['platform-init']);

  // cf. https://soundworks.dev/tools/helpers.html#browserlauncher
  launcher.register(client, { initScreensContainer: $container });

  await client.start();

  // retrieve initialized sync plugin
  const sync = await client.pluginManager.get('sync');
  const scheduler = new Scheduler(() => sync.getSyncTime(), {
    currentTimeToProcessorTimeFunction: syncTime => sync.getLocalTime(syncTime),
  });

  const global = await client.stateManager.attach('global');

  // The server gives this phone its player index, and if it has been here before
  // (the page reloaded after a screen lock or an app switch) its nickname and score.
  const user = await client.stateManager.create('user', { deviceId: getDeviceId() });
  await waitForAssignment(user);

  if (user.get('full')) {
    showGameFull($container);
    await user.delete();
    return;
  }

  const index = user.get('id');
  // Returning players skip the nickname screen and the instructions.
  const returning = user.get('returning');

  // The nickname screen opens by itself on a phone's first visit, while the samples
  // load below, and again whenever the player taps the nickname button (see
  // renderApp). Closing it keeps the current nickname.
  let nicknameScreenOpen = false;

  function editNickname() {
    if (nicknameScreenOpen) return;
    nicknameScreenOpen = true;
    openNicknameScreen($container, { color: playerColor(index).stroke, index, nickname: user.get('nickname') })
      .then(nickname => {
        nicknameScreenOpen = false;
        if (nickname !== null) user.set({ nickname });
      });
  }

  if (!returning) editNickname();

  canDecodeOpus().then(opus => user.set({ audioFormat: opus ? 'opus' : 'mp3' }));

  const control = await client.stateManager.create('control');
  // NOTE: players deliberately do not attach the `control` collection. Doing so makes
  // every player receive every other player's analysis stream (~50 updates/s each),
  // which is O(n^2) traffic across the network and swamps both the access point and
  // the phone. The only thing needed here is the player count, which the server
  // publishes on the `global` state. `display` and `controller` use the collections.

  control.set({ id: index });

  // Tilt: gravity along the phone's x and y axes, in g (-1..1), and when it was
  // last measured.
  const tilt = { x: 0, y: 0, time: -Infinity };
  let motionReported = false;

  if (motionPermission === 'granted') {
    devicemotion.addEventListener((e) => {
      const g = e.accelerationIncludingGravity;
      if (!Number.isFinite(g?.x) || !Number.isFinite(g?.y)) return;
      tilt.x = Math.max(-1, Math.min(1, g.x / 9.81));
      tilt.y = Math.max(-1, Math.min(1, g.y / 9.81));
      tilt.time = performance.now();
      if (!motionReported) {
        motionReported = true;
        control.set({ motion: true });
      }
    });
  }

  // Pad: dot position (0..1) and whether the player touches it, kept by setupUI().
  const pad = { x: 0.5, y: 0.5, active: false };

  // Create gain node and connect it to audio output
  const outputNode = audioContext.createGain();
  outputNode.connect(audioContext.destination);

  // Reverb (synthetic impulse response)
  const reverbConvolver = audioContext.createConvolver();
  const reverbGain = audioContext.createGain();
  reverbGain.gain.value = 0.5;
  const irLength = audioContext.sampleRate * 0.8;
  const irBuffer = audioContext.createBuffer(2, irLength, audioContext.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = irBuffer.getChannelData(ch);
    for (let i = 0; i < irLength; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLength, 2);
    }
  }
  reverbConvolver.buffer = irBuffer;
  reverbConvolver.connect(reverbGain);
  reverbGain.connect(outputNode);

  const humGain = audioContext.createGain();
  humGain.gain.value = 0.175;
  humGain.connect(outputNode);

  // Start every download now and let them run concurrently; they are awaited below.
  const patchExportURL = "assets/rnbo_export/patch.export.json";
  const patcherRequest = fetch(patchExportURL).then(response => response.json());
  const essentiaScriptsRequest = loadEssentiaScripts();
  // awaited later: avoid "unhandled rejection" noise if one fails before that
  patcherRequest.catch(() => {});
  essentiaScriptsRequest.catch(() => {});

  const humSample = './assets/samples/hum.wav';
  const humBuffer = await loadAudioBuffer(humSample, audioContext.sampleRate);
  const vol = 0.5;
  const startTime = sync.getLocalTime() + 0.5;

  const humLoop = new LoopSampler(audioContext, humBuffer, vol, startTime);
  humLoop.output.connect(humGain);

  // The hum plays while waiting for the game to start.
  function playerLoop(phase) {
    humGain.gain.cancelScheduledValues(audioContext.currentTime);
    if (phase === 'waiting') {
      humGain.gain.setValueAtTime(0.125, audioContext.currentTime);
      if (!scheduler.has(humLoop.play)) {
        scheduler.add(humLoop.play, sync.getLocalTime() + 0.5);
      }
    } else {
      humGain.gain.setValueAtTime(0, audioContext.currentTime);
      if (scheduler.has(humLoop.play)) {
        scheduler.remove(humLoop.play);
      }
    }
  }

  playerLoop(global.get('phase'));

  let patcher;
  try {
      patcher = await patcherRequest;

      if (!window.RNBO) {
          // Load RNBO script dynamically
          await loadRNBOScript(patcher.desc.meta.rnboversion);
      }
  } catch (err) {
      console.error("Failed to load patcher or RNBO script:", err);
      return;
  }

  let device;
  console.log("Attempting to create RNBO device...");
  try {
      // RNBO is loaded into the window object, so we use RNBO.createDevice()
      device = await RNBO.createDevice({ context: audioContext, patcher, options: { bufferSize: 2048 } });
  } catch (err) {
      console.error("Failed to create RNBO device:", err);
      return;
  }

  // Connect the device to the web audio graph (volume, then dry + reverb send)
  const dryGain = audioContext.createGain();
  dryGain.gain.value = 0.5;
  dryGain.connect(outputNode);
  const volumeGain = audioContext.createGain();
  volumeGain.gain.value = user.get('volume');
  const padGain = audioContext.createGain();
  padGain.gain.value = 0.25;
  device.node.connect(volumeGain);
  volumeGain.connect(padGain);
  padGain.connect(dryGain);
  padGain.connect(reverbConvolver);

  // Audio shared with other phones (see src/lib/audio-sharing.js): this phone's
  // RNBO output goes to the phones it is routed to in the controller's matrix,
  // and what they send comes into its RNBO input.
  const sharedInput = audioContext.createGain();
  sharedInput.connect(device.node);
  setupAudioSharing({ client, audioContext, index, source: device.node, destination: sharedInput, user })
    .catch((err) => console.error('[webrtc] could not set up audio sharing:', err));

  // Analysis values are collected here and sent together on a fixed 10Hz tick, the
  // rate the server evaluates matches at. Sent as they were produced, they made ~49
  // separate messages per second per phone (RNBO reports sharpness and loudness 20
  // times a second each, in separate messages, plus Essentia at ~10Hz), and on Wi-Fi
  // each message costs a channel access however small it is. Smoothing still runs on
  // every incoming value, so the values themselves are unchanged.
  const CONTROL_SEND_INTERVAL = 100;
  const pendingControl = {};
  let hasPendingControl = false;

  function queueControl(values) {
    Object.assign(pendingControl, values);
    hasPendingControl = true;
  }

  setInterval(() => {
    if (!hasPendingControl) return;
    control.set({ ...pendingControl });
    for (const key in pendingControl) delete pendingControl[key];
    hasPendingControl = false;
  }, CONTROL_SEND_INTERVAL);

  const SMOOTH_ALPHA = 1 / 20;
  const smoothed = { centroid: 0, spectralComplexity: 0, dissonance: 0, sharpness: 0, loudness: 0 };
  function smooth(key, value) {
    smoothed[key] = SMOOTH_ALPHA * value + (1 - SMOOTH_ALPHA) * smoothed[key];
    return smoothed[key];
  }

  // The radar and the matching use the features heavily smoothed. The
  // synchronisation looks at how they evolve within a bar, so the bar recorder
  // samples them only lightly smoothed, normalised to the descriptors' ranges.
  const soundNow = { sharpness: 0, loudness: 0, spectralCentroid: 0, dissonance: 0, spectralComplexity: 0 };
  function trackSound(key, value) {
    if (Number.isFinite(value)) soundNow[key] = 0.5 * value + 0.5 * soundNow[key];
  }

  // Essentia spectral analysis
  await essentiaScriptsRequest;
  const essentiaModule = await EssentiaWASM();
  const essentia = new Essentia(essentiaModule);

  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 2048;
  device.node.connect(analyserNode);
  const timeDomainData = new Float32Array(analyserNode.fftSize);

  let lastAnalysisTime = 0;
  const analysisInterval = 100; // ms between state updates

  function analyzeAudio(timestamp) {
    requestAnimationFrame(analyzeAudio);
    if (timestamp - lastAnalysisTime < analysisInterval) return;
    lastAnalysisTime = timestamp;

    analyserNode.getFloatTimeDomainData(timeDomainData);

    if (timeDomainData.every(v => v === 0)) return;
    if (timeDomainData.some(v => !Number.isFinite(v))) return;

    // essentia.js returns vectors allocated on the WASM heap, which the garbage
    // collector cannot see: each must be delete()d, or the heap grows by ~16MB per
    // minute of play until the browser kills the page.
    let frameVec, windowed, spectrum, peaks;
    try {
      frameVec = essentia.arrayToVector(timeDomainData);
      const { centroid: centroidVal } = essentia.SpectralCentroidTime(frameVec, audioContext.sampleRate);

      windowed = essentia.Windowing(frameVec, true, analyserNode.fftSize, 'hann');
      spectrum = essentia.Spectrum(windowed.frame, analyserNode.fftSize);
      const { spectralComplexity: spectralComplexityVal } = essentia.SpectralComplexity(spectrum.spectrum, 0.005, audioContext.sampleRate);
      peaks = essentia.SpectralPeaks(spectrum.spectrum, 0.01, audioContext.sampleRate / 2, 50, 20, 'frequency', audioContext.sampleRate);
      let dissonanceVal = 0;
      if (essentia.vectorToArray(peaks.frequencies).length >= 2) {
        ({ dissonance: dissonanceVal } = essentia.Dissonance(peaks.frequencies, peaks.magnitudes));
      }

      trackSound('spectralCentroid', centroidVal);
      trackSound('spectralComplexity', spectralComplexityVal);
      trackSound('dissonance', dissonanceVal);

      const centroid = smooth('centroid', Number.isFinite(centroidVal) ? centroidVal : 0);
      const spectralComplexity = smooth('spectralComplexity', Number.isFinite(spectralComplexityVal) ? spectralComplexityVal : 0);
      const dissonance = smooth('dissonance', Number.isFinite(dissonanceVal) ? dissonanceVal : 0);

      queueControl({ spectralCentroid: centroid, spectralComplexity: spectralComplexity, dissonance: dissonance });
    } catch (e) {
      console.debug('Essentia analysis error:', e);
    } finally {
      frameVec?.delete();
      windowed?.frame.delete();
      spectrum?.spectrum.delete();
      peaks?.frequencies.delete();
      peaks?.magnitudes.delete();
    }
  }
  requestAnimationFrame(analyzeAudio);

  console.log("Inports:", getInports(device));
  // initial goal message
  sendMessageToInport(device, 'goal', global.get('goal'));

  let localScore = user.get('local_score'); // restored when rejoining
  let isMatched = false; // matching the target
  let myMatch = null; // { config, closeness, matched }, see global `targetMatch`
  let matchGraceTimeout = null;
  let scoreInterval = null;
  let mySync = null; // this player's synchronisation in the last bar
  let timerDisplay = '--:--';
  let timerInterval = null;
  let interfaceHidden = false; // mirrors renderApp()'s hideInterface

  // Full-screen layer behind the app (#background-layer in app.scss), flashing in
  // the player's colour on the pulses while matching the target. Only its opacity changes
  // from frame to frame, and it sits on its own compositor layer, so that does not
  // repaint the page. Prepended to <body>: outside the part of it that lit renders
  // the app into.
  const backgroundLayer = document.createElement('div');
  backgroundLayer.id = 'background-layer';
  document.body.prepend(backgroundLayer);

  // Only touch the style when a value actually changes. All background changes
  // must go through here.
  let backgroundColor = null;
  let backgroundOpacity = null;

  function setBackground(color, opacity) {
    if (color !== backgroundColor) {
      backgroundColor = color;
      backgroundLayer.style.backgroundColor = color;
    }
    if (opacity !== backgroundOpacity) {
      backgroundOpacity = opacity;
      backgroundLayer.style.opacity = opacity;
    }
  }

  function hideBackground() {
    setBackground(backgroundColor, '0');
  }

  // Each bar, the server tells every player how synchronised they were (see
  // server.js): shown, it does not score.
  function applySyncResult(result) {
    mySync = result?.players?.[index] ?? null;
    renderApp();
  }

  // While the player matches the target (see server.js), the score counts locally
  // at 10Hz, 1 point per second, and is published twice a second: it is only ever
  // shown rounded to whole points. The exact value is published whenever the
  // counter stops.
  const SCORE_PUBLISH_EVERY = 5; // ticks

  function startScoreCounter() {
    if (scoreInterval) return;
    let ticks = 0;
    scoreInterval = setInterval(() => {
      localScore += 0.1;
      if (++ticks % SCORE_PUBLISH_EVERY === 0) user.set({ local_score: localScore });
      renderApp();
    }, 100);
  }

  function stopScoreCounter() {
    if (scoreInterval) {
      clearInterval(scoreInterval);
      scoreInterval = null;
      user.set({ local_score: localScore });
    }
  }

  function applyMatched(raw) {
    const matchedIds = Array.isArray(raw?.[0]) ? raw[0] : [];
    if (matchedIds.includes(index)) {
      if (matchGraceTimeout) { clearTimeout(matchGraceTimeout); matchGraceTimeout = null; }
      if (!isMatched) {
        isMatched = true;
        startScoreCounter();
      }
    } else if (isMatched && !matchGraceTimeout) {
      // a short grace, so a single missed evaluation does not break the match
      matchGraceTimeout = setTimeout(() => {
        matchGraceTimeout = null;
        isMatched = false;
        stopScoreCounter();
        hideBackground();
        renderApp();
      }, 300);
    }
  }

  function resetSync() {
    if (matchGraceTimeout) { clearTimeout(matchGraceTimeout); matchGraceTimeout = null; }
    isMatched = false;
    myMatch = null;
    mySync = null;
    stopScoreCounter();
    hideBackground();
  }

  // Listen for messages from RNBO device
  device.messageEvent.subscribe((ev) => {
    if (ev.tag === "out2") {
      trackSound('sharpness', ev.payload);
      queueControl({ sharpness: smooth('sharpness', ev.payload) });
    }
    if (ev.tag === "out3") {
      trackSound('loudness', ev.payload);
      queueControl({ loudness: smooth('loudness', ev.payload) });
    }
  });

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function setupTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (global.get('phase') !== 'playing') { timerDisplay = '--:--'; return; }
    const duration = global.get('duration');
    if (duration <= 0) { timerDisplay = 'no time'; return; }
    const tick = () => {
      const triggerTime = global.get('syncTriggerTime');
      const elapsed = triggerTime > 0
        ? Math.max(0, sync.getLocalTime() - sync.getLocalTime(triggerTime))
        : 0;
      timerDisplay = formatTime(Math.max(0, duration - elapsed));
      renderApp();
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function applyPhase(phase) {
    resetSync();
    setupTimer();
    playerLoop(phase);
    renderApp();

    if (phase === 'playing') {
      const last = device._lastTouch || [50, 50];
      sendMessageToInport(device, 'touch', last);
      padGain.gain.cancelScheduledValues(audioContext.currentTime);
      padGain.gain.setValueAtTime(0, audioContext.currentTime);
      padGain.gain.linearRampToValueAtTime(0.25, audioContext.currentTime + 0.5);
      // re-measure pad after layout settles (it may have just become visible)
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    } else {
      sendMessageToInport(device, 'start', [0]);
    }
  }

  const myColor = playerColor(index);

  global.onUpdate(updates => {
    if ('goal' in updates) {
      sendMessageToInport(device, 'goal', updates['goal']);
    }
    // `syncTriggerTime` is set by the server right after `phase`: restart the timer
    // from it.
    if ('phase' in updates) {
      console.log('Phase updated:', updates['phase']);
      applyPhase(updates['phase']);
    } else if ('syncTriggerTime' in updates || 'duration' in updates) {
      setupTimer();
      renderApp();
    }
    if ('global_score' in updates) {
      renderApp();
    }
    if ('resetScores' in updates) {
      localScore = 0;
      user.set({ local_score: 0 });
      renderApp();
    }
    if ('sync' in updates) {
      applySyncResult(updates['sync']);
    }
    if ('targetMatch' in updates) {
      const next = updates['targetMatch']?.[index] ?? null;
      if (JSON.stringify(next) !== JSON.stringify(myMatch)) {
        myMatch = next;
        renderApp();
      }
    }
    if ('matched' in updates) {
      applyMatched(updates['matched']);
    }
    if ('pulsesPerBar' in updates) {
      renderApp(); // pulse strip
    }
    if ('metronomeOrigin' in updates) {
      restartClick();
    }
  });

  // Sound parameters set from the controller, forwarded to the RNBO device.
  const presets = patcher.presets || [];
  const RNBO_PARAMS = ['fb_gain', 'fb_trim', 'bp_q', 'phase_q'];

  function setParams(values) {
    for (const name of RNBO_PARAMS) {
      if (name in values) {
        const param = getParameter(device, name);
        if (param) param.value = values[name];
      }
    }
  }

  function applySound(values) {
    if ('preset' in values && presets[values['preset']]) {
      device.setPreset(presets[values['preset']].preset);
      // the preset overwrites the parameters set from the controller
      setParams(user.getValues());
    }
    if ('style' in values) sendMessageToInport(device, 'style', values['style']);
    if ('mod' in values) sendMessageToInport(device, 'mod', [values['mod']]);
    if ('fade' in values) sendMessageToInport(device, 'fade', [values['fade']]);
    if ('volume' in values) volumeGain.gain.setTargetAtTime(values['volume'], audioContext.currentTime, 0.02);
    setParams(values);
  }

  user.onUpdate(updates => {
    if ('nickname' in updates) {
      renderApp(); // nickname button label
    }
    applySound(updates);
  });

  const myColorRgb = `rgb(${myColor.r}, ${myColor.g}, ${myColor.b})`;

  // -------------------------------------------------------------------
  // METRONOME: visual pulse, optional click
  // -------------------------------------------------------------------
  // Decay time (s) of a pulse's flash.
  const PULSE_DECAY = 0.12;

  // Where the current time is on the metronome grid, while playing.
  function currentPosition() {
    if (global.get('phase') !== 'playing') return null;
    return gridPosition(metronomeGrid(global), sync.getSyncTime());
  }

  function pulseEnvelope(position) {
    return position ? Math.exp(-position.sincePulse / PULSE_DECAY) : 0;
  }

  function updateBackground(position) {
    if (isMatched && position) {
      const accent = position.pulse === 0 ? 0.6 : 0.4;
      setBackground(myColorRgb, (accent * pulseEnvelope(position)).toFixed(2));
      return;
    }

    hideBackground();
  }

  // Pulse strip (one dot per pulse of the bar, the current one lit) and the ring
  // around the pad, flashing on every pulse, stronger on the first of the bar.
  // Only opacities change, which does not repaint the page.
  function drawPulse(position) {
    const envelope = pulseEnvelope(position);
    const strip = document.getElementById('pulse-strip');
    if (strip) {
      for (let i = 0; i < strip.children.length; i++) {
        const lit = position !== null && i === position.pulse;
        strip.children[i].style.opacity = lit ? (0.4 + 0.6 * envelope).toFixed(2) : '0.15';
      }
    }
    const ring = document.getElementById('pulse-ring');
    if (ring) {
      const accent = position && position.pulse === 0 ? 1 : 0.5;
      ring.style.opacity = (accent * envelope).toFixed(2);
    }
  }

  // Click on every pulse (global `click`), scheduled on the sync time.
  function playClick(time, downbeat) {
    const osc = audioContext.createOscillator();
    const env = audioContext.createGain();
    osc.frequency.value = downbeat ? 1600 : 1000;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(0.3, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.connect(env).connect(outputNode);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  function clickEngine(currentTime, processorTime) {
    const grid = metronomeGrid(global);
    if (global.get('phase') !== 'playing' || grid.origin <= 0) {
      return currentTime + 0.25; // check again later
    }
    if (currentTime < grid.origin - 0.001) return grid.origin;

    const count = Math.round((currentTime - grid.origin) / grid.pulse);
    const onPulse = Math.abs(currentTime - (grid.origin + count * grid.pulse)) < 0.01;
    if (onPulse && global.get('click')) {
      playClick(processorTime, count % grid.pulsesPerBar === 0);
    }
    const next = Math.floor((currentTime - grid.origin) / grid.pulse + 1e-6) + 1;
    return grid.origin + next * grid.pulse;
  }

  // The grid moved: start again from it.
  function restartClick() {
    if (scheduler.has(clickEngine)) scheduler.remove(clickEngine);
    scheduler.add(clickEngine, sync.getSyncTime());
  }

  restartClick();

  // -------------------------------------------------------------------
  // BAR RECORDER: what the player does during each bar, sampled on the metronome
  // grid at SAMPLE_RATE, and reported to the server once the bar is over
  // -------------------------------------------------------------------
  // Tilt counts as missing when no motion event came for this long (ms).
  const MOTION_TIMEOUT = 250;
  // Reports carry 3 decimals, plenty for normalised values.
  const round3 = value => Math.round(value * 1000) / 1000;

  let recording = null;

  function newRecording(grid, bar) {
    const n = samplesPerBar(grid);
    const empty = () => new Array(n).fill(null);
    return { bar, origin: grid.origin, n, touch: empty(), tilt: empty(), sound: empty(), active: empty() };
  }

  // Missing samples (a late timer tick) take the value of the previous one; a
  // layer missing more than a quarter of the bar, e.g. when the phone joined
  // mid-bar or has no motion sensors, is not reported.
  function finishSeries(series) {
    const present = series.filter(sample => sample !== null).length;
    if (present < series.length * 0.75) return null;
    let last = series.find(sample => sample !== null);
    return series.map(sample => (last = sample ?? last).map(round3));
  }

  function sendRecording(rec) {
    control.set({
      bar: {
        bar: rec.bar,
        origin: rec.origin,
        active: round3(rec.active.filter(Boolean).length / rec.n),
        touch: finishSeries(rec.touch),
        tilt: finishSeries(rec.tilt),
        sound: finishSeries(rec.sound),
      },
    });
  }

  function recordSample() {
    const grid = metronomeGrid(global);
    const position = currentPosition();

    if (recording !== null && (position === null || position.bar !== recording.bar || grid.origin !== recording.origin)) {
      // the bar is over: report it, unless the grid changed or a bar was skipped
      if (position !== null && grid.origin === recording.origin && position.bar === recording.bar + 1) {
        sendRecording(recording);
      }
      recording = null;
    }
    if (position === null) return;
    if (recording === null) recording = newRecording(grid, position.bar);

    const slot = Math.min(recording.n - 1, Math.floor(position.barTime * SAMPLE_RATE));
    recording.touch[slot] = [pad.x, pad.y];
    recording.tilt[slot] = performance.now() - tilt.time < MOTION_TIMEOUT ? [tilt.x, tilt.y] : null;
    recording.sound[slot] = DESCRIPTORS.map(d => normalise(d, soundNow[d.key]));
    recording.active[slot] = pad.active;
  }

  // Ticks twice per sample, so timer jitter does not leave slots empty.
  setInterval(recordSample, 1000 / SAMPLE_RATE / 2);

  // -------------------------------------------------------------------
  // OSCILLOSCOPE
  // -------------------------------------------------------------------
  const oscilloscopeData = new Uint8Array(analyserNode.fftSize);
  let oscilloscope = null; // set up on the first frame the canvas exists

  function drawOscilloscope() {
    if (interfaceHidden) return;

    if (oscilloscope === null) {
      const canvas = document.getElementById('oscilloscope');
      const ctx = canvas?.getContext('2d');
      if (!ctx) return; // not rendered yet
      oscilloscope = {
        ctx,
        width: canvas.width,
        height: canvas.height,
        // One point per canvas pixel: the analyser holds 2048 samples for a 320px
        // wide canvas, and stroking all of them is wasted work on a phone.
        step: Math.max(1, Math.floor(oscilloscopeData.length / canvas.width)),
      };
    }

    const { ctx, width, height, step } = oscilloscope;
    const bufferLength = oscilloscopeData.length;
    analyserNode.getByteTimeDomainData(oscilloscopeData);

    // Fades the previous frames into a trail. 0.51 = 1 - 0.7^2: the trail fades as
    // fast per second at 30 frames per second as 0.3 did at 60.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.51)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = myColor.stroke;
    ctx.beginPath();

    const sliceWidth = (width / bufferLength) * step;
    let x = 0;
    for (let i = 0; i < bufferLength; i += step) {
      const v = oscilloscopeData[i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }

    ctx.stroke();
  }

  // -------------------------------------------------------------------
  // DRAW LOOP: background layer and oscilloscope, at 30 frames per second
  // -------------------------------------------------------------------
  const DRAW_INTERVAL = 1000 / 30;

  let lastDrawTime = -Infinity;

  function drawLoop(timestamp) {
    requestAnimationFrame(drawLoop);
    // requestAnimationFrame follows the display (60Hz, 120Hz on recent phones):
    // skip frames down to 30 per second. The 4ms of slack absorbs frame jitter,
    // which would otherwise make a 60Hz display skip two frames and drop to 20.
    if (timestamp - lastDrawTime < DRAW_INTERVAL - 4) return;
    lastDrawTime = timestamp;

    const position = currentPosition();
    updateBackground(position);
    drawPulse(position);
    drawOscilloscope();
  }

  // -------------------------------------------------------------------
  // RENDER FUNCTION AND GRID SETUP
  // -------------------------------------------------------------------
  function renderApp() {
    const phase = global.get('phase');
    const hideInterface = phase === 'scores';
    interfaceHidden = hideInterface;
    const globalScore = (global.get('global_score') ?? 0).toFixed(0);

    render(html`
      <div id="app-root">

        <!-- Always visible: opens the nickname screen -->
        <button id="nickname-button" type="button" @click=${editNickname}>
          <span class="nickname-button-dot" style="background: ${myColor.stroke};"></span>
          <span class="nickname-button-label">${user.get('nickname') || `Player ${index}`}</span>
        </button>

        <!-- Waiting: instructions, until the game starts -->
        <div id="enter-overlay" style="display: ${phase === 'waiting' ? 'flex' : 'none'};">
            <div id="enter-content">
              <div id="enter-text"></div>
              <button id="enter-button" type="button"> >>> </button>
            </div>
        </div>

        <div id="gameover-overlay" style="display: ${phase === 'end' ? 'flex' : 'none'};">
          <div id="gameover-content">GAME OVER</div>
        </div>

        <!-- Scores: global points and the player's own -->
        <div id="scores-overlay" style="display: ${phase === 'scores' ? 'flex' : 'none'};">
          <div class="scores-block">
            <div class="scores-label">Global Points</div>
            <div class="scores-value">${globalScore}</div>
          </div>
          <div class="scores-block">
            <div class="scores-label">My Points</div>
            <div class="scores-value">${localScore.toFixed(0)}</div>
          </div>
        </div>

        <!-- Info row: player colour + timer + target closeness + sync + global pts + my pts -->
        <div id="info-row" style="display: ${hideInterface ? 'none' : 'flex'};">
          <div id="player-color-dot" style="background: ${myColor.stroke};"></div>
          <div class="score-item">
            <span class="score-label">Timer</span>
            <span class="score-value">${timerDisplay}</span>
          </div>
          <div class="score-item">
            <span class="score-label">Target</span>
            <span class="score-value ${isMatched ? 'synchronised' : ''}">${myMatch ? `${Math.round(myMatch.closeness * 100)}%` : '--'}</span>
          </div>
          <div class="score-item">
            <span class="score-label">Sync</span>
            <span class="score-value">${mySync && mySync.partner !== null ? `${Math.round(mySync.index * 100)}%` : '--'}</span>
          </div>
          <div class="score-item">
            <span class="score-label">Global</span>
            <span class="score-value">${globalScore}</span>
          </div>
          <div class="score-item">
            <span class="score-label">My pts</span>
            <span class="score-value">${localScore.toFixed(0)}</span>
          </div>
        </div>

        <!-- Metronome: one dot per pulse of the bar -->
        <div id="pulse-strip" style="display: ${hideInterface ? 'none' : 'flex'};">
          ${Array.from({ length: global.get('pulsesPerBar') }, (_, i) => html`
            <span class="pulse-dot ${i === 0 ? 'downbeat' : ''}"></span>
          `)}
        </div>

        <!-- Oscilloscope -->
        <div id="oscilloscope-container" style="display: ${hideInterface ? 'none' : 'flex'};">
          <canvas id="oscilloscope" width="320" height="70"></canvas>
        </div>

        <div id="xy-pad-container" style="display: ${hideInterface ? 'none' : 'block'};">
          <canvas id="xy-pad" width="320" height="320"></canvas>
          <div id="pulse-ring"></div>
        </div>

      </div>
    `, $container);
  }

  renderApp();
  setupUI(device, control, audioContext, padGain, global, returning, pad);
  requestAnimationFrame(drawLoop);

  // ---- late-join / initial state sync ----
  // Apply the current phase, and every current sound parameter to the freshly
  // created RNBO device: user.onUpdate only fires on changes, existing state is
  // silent on reconnect.
  applyPhase(global.get('phase'));
  // The preset and parameters, then whatever the controller changed from the
  // defaults (left out, the patch keeps its own values for the messages).
  const defaults = user.getDefaults();
  const changed = Object.fromEntries(Object.entries(user.getValues())
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(defaults[key])));
  applySound({ preset: user.get('preset'), volume: user.get('volume'), ...changed });
  setParams(user.getValues());
  applySyncResult(global.get('sync'));
}

function waitUntilVisible() {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

// load Essentia scripts dynamically
function loadEssentiaScripts() {
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.body.append(el);
    });
  }
  return Promise.all([
    loadScript('assets/essentia/essentia-wasm.web.js'),
    loadScript('assets/essentia/essentia.js-core.js'),
  ]);
}

// load RNBO script dynamically
function loadRNBOScript(version) {
  return new Promise((resolve, reject) => {
    if (/^\d+\.\d+\.\d+-dev$/.test(version)) {
      throw new Error("Patcher exported with a Debug Version! Please specify the correct RNBO version to use in the code.");
    }

    // Try same-origin local copy first to avoid COEP/CORS issues.
    const localSrc = `assets/rnbo/${encodeURIComponent(version)}/rnbo.min.js`;
    const cdnSrc = `https://c74-public.nyc3.digitaloceanspaces.com/rnbo/${encodeURIComponent(version)}/rnbo.min.js`;

    function appendScript(src, useCrossOrigin) {
      const el = document.createElement('script');
      if (useCrossOrigin) {
        // when requesting cross-origin script, set crossorigin so proper CORS flow
        // can occur if the CDN returns Access-Control-Allow-Origin.
        el.crossOrigin = 'anonymous';
      }
      el.src = src;
      el.onload = () => resolve();
      el.onerror = (err) => {
        // If the local copy failed, try the CDN as a fallback. If CDN fails too, reject.
        if (src === localSrc) {
          console.warn(`Local RNBO not found at ${localSrc}, falling back to CDN`);
          // try CDN (may still be blocked by COEP if the CDN doesn't provide proper headers)
          appendScript(cdnSrc, true);
        } else {
          console.error(err);
          reject(new Error("Failed to load rnbo.js v" + version));
        }
      };
      document.body.append(el);
    }

    appendScript(localSrc, false);
  });
}
// helper functions
function getInports(device) {
  const messages = device.messages;
  const inports = messages.filter(
    (message) => message.type === RNBO.MessagePortType.Inport
  );
  return inports;
}
function getParameter(device, parameterName) {
  const parameters = device.parameters;
  const parameter = parameters.find((param) => param.name === parameterName);
  return parameter;
}
function sendMessageToInport(device, inportTag, values) {
  // Send the message event to the RNBO device
  let messageEvent = new RNBO.MessageEvent(
    RNBO.TimeNow,
    inportTag,
    values
  );
  device.scheduleEvent(messageEvent);
}

function setupUI(device, control, audioContext, padGain, global, returning, pad) {
    const canvas = document.getElementById('xy-pad');
    const ctx = canvas.getContext('2d');
    const accentColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--sw-accent-color').trim() || '#ff44b4';

    const updateControlActive = (active) => {
      pad.active = active;
      control.set({ active: active ? 1 : 0 });
    };

    // Setup pad
    let padSize = canvas.width;
    const dotRadius = 10;
    let dotX = padSize / 2;
    let dotY = padSize / 2;
    let dragging = false;
    let activePointerId = null;

    function resizePad() {
      const container = canvas.parentElement;
      const rect = container.getBoundingClientRect();
      const cs = getComputedStyle(container);
      const innerW = rect.width
        - parseFloat(cs.paddingLeft || '0')
        - parseFloat(cs.paddingRight || '0');
      const size = Math.max(150, Math.floor(innerW || window.innerWidth * 0.9));
      padSize = size;
      canvas.width = size;
      canvas.height = size;
      canvas.style.width = '100%';
      canvas.style.height = `${size}px`;
      dotX = Math.max(dotRadius, Math.min(padSize - dotRadius, dotX));
      dotY = Math.max(dotRadius, Math.min(padSize - dotRadius, dotY));
      drawPad();
    }

    function getXY(e) {
        const rect = canvas.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;
        x = Math.max(dotRadius, Math.min(padSize - dotRadius, x));
        y = Math.max(dotRadius, Math.min(padSize - dotRadius, y));
        return { x, y };
    }

    function drawPad() {
        ctx.clearRect(0, 0, padSize, padSize);
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotRadius, 0, 2 * Math.PI);
        ctx.fillStyle = accentColor || '#ff44b4';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.stroke();
    }

    function sendTouch() {
        pad.x = dotX / padSize;
        pad.y = dotY / padSize;
        const touchX = Math.round((dotX / padSize) * 100);
        const touchY = Math.round((dotY / padSize) * 100);
        device._lastTouch = [touchX, touchY];
        sendMessageToInport(device, 'touch', [touchX, touchY]);
    }

    function release(e) {
        if (e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        padGain.gain.cancelScheduledValues(audioContext.currentTime);
        padGain.gain.setValueAtTime(padGain.gain.value, audioContext.currentTime);
        padGain.gain.linearRampToValueAtTime(0.25, audioContext.currentTime + 0.2);
        sendMessageToInport(device, 'start', [0]);
        updateControlActive(false);
    }

    requestAnimationFrame(resizePad);
    window.addEventListener('resize', resizePad);

    // Pointer events: one finger drives the pad
    canvas.addEventListener('pointerdown', (e) => {
        if (activePointerId !== null) return;
        activePointerId = e.pointerId;
        dragging = true;
        ({ x: dotX, y: dotY } = getXY(e));
        drawPad();
        padGain.gain.cancelScheduledValues(audioContext.currentTime);
        padGain.gain.setValueAtTime(padGain.gain.value, audioContext.currentTime);
        padGain.gain.linearRampToValueAtTime(1, audioContext.currentTime + 0.2);
        sendTouch();
        // as in NINA_B3-H4RSH: the patch plays while touched, and each new touch
        // triggers it
        sendMessageToInport(device, 'start', [1]);
        sendMessageToInport(device, 'trigger', [1]);
        updateControlActive(true);
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!dragging || e.pointerId !== activePointerId) return;
        ({ x: dotX, y: dotY } = getXY(e));
        drawPad();
        sendTouch();
    });

    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointerleave', release);
    canvas.addEventListener('pointercancel', release);

    drawPad();

    // Overlay text can be advanced as soon as UI is rendered (DOMContentLoaded may already have fired)
    const enterButton = document.getElementById("enter-button");
    const enterText = document.getElementById("enter-text");
    const enterTexts = [
      [
        'How to play:',
        'Tap and hold the pad to generate the sound.',
        'Drag around to shape the sound.',
        'Your sound reaches the other players, theirs reaches you.',
        'Together, bring your sounds to the target on the screen.',
        'While your sound matches it, you collect points.',
      ],
      [
        'Turn up the volume on your device.',
        'Turn up the brightness of your screen.',
        'Wait for the game to start.',
        'Good luck and enjoy!',
      ],
    ];
    // Returning players have read the instructions already: go straight to the last
    // page.
    let enterTextIndex = returning ? enterTexts.length - 1 : 0;

    const renderEnterText = (index) => {
      if (!enterText) return;
      const lines = enterTexts[index] || [];
      const nodes = lines.map((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        return p;
      });
      enterText.replaceChildren(...nodes);
      if (enterButton) {
        enterButton.style.display = index < enterTexts.length - 1 ? 'flex' : 'none';
      }
    };
    if (enterButton && enterText) {
      renderEnterText(enterTextIndex);
      enterButton.onclick = () => {
        enterTextIndex = (enterTextIndex + 1) % enterTexts.length;
        renderEnterText(enterTextIndex);
      };
    }
}

// The launcher allows to launch multiple clients in the same browser window
// e.g. `http://127.0.0.1:8000?emulate=10` to run 10 clients side-by-side
launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
});
