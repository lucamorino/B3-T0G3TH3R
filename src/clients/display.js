import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import pluginSync from '@soundworks/plugin-sync/client.js';

import { playerColor } from './palette.js';
import { metronomeGrid, gridPosition } from '../lib/metronome.js';
import { DESCRIPTORS, normalise, normaliseConfig } from '../lib/descriptors.js';

function tryEnterFullscreen() {
  const element = document.documentElement; // Target the entire page
  let fullscreenPromise;

  if (element.requestFullscreen) {
    fullscreenPromise = element.requestFullscreen();
  } else if (element.mozRequestFullScreen) { // Firefox
    fullscreenPromise = element.mozRequestFullScreen();
  } else if (element.webkitRequestFullscreen) { // Chrome, Safari, Opera
    fullscreenPromise = element.webkitRequestFullscreen();
  } else if (element.msRequestFullscreen) { // IE/Edge
    fullscreenPromise = element.msRequestFullscreen();
  } else {
    console.warn('Fullscreen API is not supported by this browser.');
    // If not supported, return a resolved promise as there's nothing to do.
    return Promise.resolve();
  }

  return fullscreenPromise.catch(err => {
    console.warn(`Could not enter full-screen mode: ${err.message} (${err.name})`);
    // Re-throw the error so the caller knows the request failed.
    throw err;
  });
}

async function main($container) {
  const config = loadConfig();
  const client = new Client(config);

  const getTime = () => performance.now() / 1000;
  client.pluginManager.register('sync', pluginSync, { getTimeFunction: getTime });

  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  await client.start();

  document.body.classList.add('display-client');

  // Try immediate fullscreen; if it needs a gesture, show prompt and listen for ESC
  tryEnterFullscreen().catch(() => {
    const prompt = document.createElement('div');
    prompt.id = 'fs-prompt';
    prompt.textContent = 'PRESS ESC TO ENTER FULLSCREEN';
    document.body.appendChild(prompt);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      tryEnterFullscreen().then(() => {
        document.getElementById('fs-prompt')?.remove();
        window.removeEventListener('keydown', onKey);
      }).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
  });

  const sync = await client.pluginManager.get('sync');
  const global = await client.stateManager.attach('global');
  const controlCollection = await client.stateManager.getCollection('control');
  const controlStates = new Map();
  const controlUpdateUnsubs = new Map();

  const userCollection = await client.stateManager.getCollection('user');
  const userStates = new Map();

  // Canvas text can't read CSS variables, so the app font is named here too.
  const CANVAS_FONT = "'DM Mono', monospace";

  function sortedUsers() {
    return Array.from(controlStates.values()).sort((a, b) => (a.get('id') ?? 0) - (b.get('id') ?? 0));
  }

  // Connected players, one per player index, from their `user` states. A phone that
  // rejoins before its previous connection has been noticed as closed briefly has
  // two states with the same index: the newer one (attached last) wins.
  function players() {
    const byIndex = new Map();
    for (const state of userStates.values()) {
      if (state.get('assigned')) byIndex.set(state.get('id'), state);
    }
    return Array.from(byIndex.values()).sort((a, b) => a.get('id') - b.get('id'));
  }

  // Players by score, highest first; ties keep player index order.
  function rankedPlayers() {
    return players().sort((a, b) => (b.get('local_score') ?? 0) - (a.get('local_score') ?? 0));
  }

  function nicknameOf(index) {
    for (const state of players()) {
      if (state.get('id') === index) return state.get('nickname') || `player ${index}`;
    }
    return `player ${index}`;
  }

  // Indexes of the players matching their target. The server sets `matched` as
  // [[...indexes]].
  function matchedIndexes() {
    const raw = global.get('matched');
    return new Set(Array.isArray(raw?.[0]) ? raw[0] : []);
  }

  let timerDisplay = '--:--';
  let timerInterval = null;

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
        ? Math.max(0, getTime() - sync.getLocalTime(triggerTime))
        : 0;
      timerDisplay = formatTime(Math.max(0, duration - elapsed));
      renderApp();
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  // With many players the collection delivers hundreds of updates per second.
  // Rendering per update would queue one renderApp() and one radar draw each time, all
  // running on the same frame, so coalesce both onto at most one per frame.
  let renderPending = false;
  let radarDrawPending = false;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderApp();
    });
  }

  function scheduleRadarDraw() {
    if (radarDrawPending) return;
    radarDrawPending = true;
    requestAnimationFrame(() => {
      radarDrawPending = false;
      drawRadar();
    });
  }

  // The analysis values only feed the radar.
  controlCollection.onAttach((state) => {
    controlStates.set(state.id, state);
    const off = state.onUpdate(() => scheduleRadarDraw());
    if (typeof off === 'function') controlUpdateUnsubs.set(state.id, off);
    scheduleRadarDraw();
  }, true);

  controlCollection.onDetach((state) => {
    controlStates.delete(state.id);
    const off = controlUpdateUnsubs.get(state.id);
    if (typeof off === 'function') off();
    controlUpdateUnsubs.delete(state.id);
    scheduleRadarDraw();
  });

  // Nicknames and scores feed the player cards.
  const userUpdateUnsubs = new Map();

  userCollection.onAttach((state) => {
    userStates.set(state.id, state);
    userUpdateUnsubs.set(state.id, state.onUpdate(() => scheduleRender()));
    scheduleRender();
  }, true);

  userCollection.onDetach((state) => {
    userStates.delete(state.id);
    userUpdateUnsubs.get(state.id)?.();
    userUpdateUnsubs.delete(state.id);
    scheduleRender();
  });

  global.onUpdate(updates => {
    if ('phase' in updates || 'syncTriggerTime' in updates || 'duration' in updates) {
      setupTimer();
    }
    scheduleRender();
  });

  // How close a player is to their target, as a percentage, or '--'.
  function closenessOf(index) {
    const result = global.get('targetMatch')?.[index];
    return result ? `${Math.round(result.closeness * 100)}%` : '--';
  }

  // Metronome: the pulse strip flashes on every pulse, on every frame, outside of
  // lit (only opacities change).
  const PULSE_DECAY = 0.12;

  function currentPosition() {
    if (global.get('phase') !== 'playing') return null;
    return gridPosition(metronomeGrid(global), sync.getSyncTime());
  }

  function barLabel(position) {
    return position ? String(position.bar + 1) : '--';
  }

  function drawPulse() {
    requestAnimationFrame(drawPulse);
    const strip = document.getElementById('display-pulse');
    if (!strip) return;
    const position = currentPosition();
    const envelope = position ? Math.exp(-position.sincePulse / PULSE_DECAY) : 0;
    for (let i = 0; i < strip.children.length; i++) {
      const lit = position !== null && i === position.pulse;
      strip.children[i].style.opacity = lit ? (0.4 + 0.6 * envelope).toFixed(2) : '0.15';
    }
    const bar = document.getElementById('display-bar');
    if (bar) bar.textContent = barLabel(position);
  }

  requestAnimationFrame(drawPulse);

  // Radar of the players' sound descriptors and of the target.
  //
  // - together (default): every player on the same five axes, the target's
  //   configuration(s) as dashed outlines
  // - split (`radarSplit`): one slice of five axes per player, in index order,
  //   each slice listing the descriptors in the opposite order of the previous
  //   one, so that with two players the two halves mirror each other. The target
  //   is a single dashed outline around all slices, each slice showing the
  //   configuration that player has to reach: symmetric when the players share
  //   the same configuration, asymmetric when theirs are complementary.
  function drawRadar() {
    const canvas = document.getElementById('radar-canvas');
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w === 0 || h === 0) return;

    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Same order as the server's: the n-th player takes the n-th configuration.
    const users = sortedUsers();
    const target = global.get('target');
    const targetConfigs = (target?.configs ?? []).map(normaliseConfig);
    const matched = matchedIndexes();
    const split = global.get('radarSplit');

    const slices = split ? Math.max(1, users.length) : 1;
    const perSlice = DESCRIPTORS.length;
    const numAxes = slices * perSlice;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const labelPad = split ? 56 : 40;
    const radius = Math.min(w, h) * 0.5 - labelPad;
    const angleStep = (2 * Math.PI) / numAxes;
    // Split: half a step off the vertical, so that the slices meet on it and the
    // first two mirror each other across it.
    const startAngle = -Math.PI / 2 + (split ? angleStep / 2 : 0);

    // Axis of descriptor `d` in slice `slice`; odd slices go the other way round.
    const axisOf = (slice, d) => slice * perSlice + (slice % 2 === 0 ? d : perSlice - 1 - d);
    const angleOf = axis => startAngle + axis * angleStep;
    const point = (axis, value) => ({
      x: cx + value * radius * Math.cos(angleOf(axis)),
      y: cy + value * radius * Math.sin(angleOf(axis)),
    });

    // Grid rings
    for (const level of [0.2, 0.4, 0.6, 0.8, 1.0]) {
      ctx.beginPath();
      for (let i = 0; i < numAxes; i++) {
        const { x, y } = point(i, level);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Axes + labels (short ones once the radar gets crowded)
    const fontSize = Math.max(8, Math.round(w * (numAxes > 10 ? 0.011 : 0.014)));
    ctx.font = `${fontSize}px ${CANVAS_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let slice = 0; slice < slices; slice++) {
      DESCRIPTORS.forEach((descriptor, d) => {
        const axis = axisOf(slice, d);
        const end = point(axis, 1);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(end.x, end.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();

        const label = point(axis, 1 + (labelPad * 0.5) / radius);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText(numAxes > 10 ? descriptor.label.slice(0, 4) : descriptor.label, label.x, label.y);
      });
    }

    // Split: slice borders, and each slice's player name past its labels
    if (split) {
      for (let slice = 0; slice < slices; slice++) {
        const border = point(slice * perSlice - 0.5, 1.04);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(border.x, border.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // the name goes past the label of the slice's middle axis, away from the
        // centre
        const state = users[slice];
        if (state) {
          const middle = slice * perSlice + (perSlice - 1) / 2;
          const at = point(middle, 1 + (labelPad * 0.5) / radius);
          const cos = Math.cos(angleOf(middle));
          const sin = Math.sin(angleOf(middle));
          const labelWidth = ctx.measureText(DESCRIPTORS[(perSlice - 1) / 2].label).width;
          ctx.fillStyle = playerColor(state.get('id')).stroke;
          ctx.font = `bold ${fontSize + 2}px ${CANVAS_FONT}`;
          if (Math.abs(cos) > 0.4) {
            ctx.textAlign = cos > 0 ? 'left' : 'right';
            ctx.fillText(nicknameOf(state.get('id')), at.x + Math.sign(cos) * (labelWidth / 2 + 10), at.y);
          } else {
            ctx.fillText(nicknameOf(state.get('id')), at.x, at.y + Math.sign(sin) * (fontSize + 8));
          }
          ctx.textAlign = 'center';
          ctx.font = `${fontSize}px ${CANVAS_FONT}`;
        }
      }
    }

    // Players
    users.forEach((state, rank) => {
      const id = state.get('id');
      const { stroke, fill } = playerColor(id);
      const values = DESCRIPTORS.map(d => normalise(d, state.get(d.key)));
      const isMatched = matched.has(id);

      // together: a polygon on the five axes; split: a wedge on the player's slice
      const points = values.map((value, d) => point(split ? axisOf(rank, d) : d, value));
      // round the slice in axis order, i.e. reversed descriptors on odd slices
      const ordered = split && rank % 2 === 1 ? [...points].reverse() : points;

      ctx.beginPath();
      if (split) ctx.moveTo(cx, cy);
      ordered.forEach((p, i) => {
        if (i === 0 && !split) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = isMatched ? 4 : 2;
      ctx.shadowColor = isMatched ? stroke : 'transparent';
      ctx.shadowBlur = isMatched ? 14 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;

      points.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
        ctx.fillStyle = stroke;
        ctx.fill();
      });
    });

    // Target: dashed white outline(s), on top
    if (targetConfigs.length > 0) {
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      if (split) {
        for (let axis = 0; axis < numAxes; axis++) {
          const slice = Math.floor(axis / perSlice);
          const local = axis % perSlice;
          const d = slice % 2 === 0 ? local : perSlice - 1 - local;
          const { x, y } = point(axis, targetConfigs[slice % targetConfigs.length][d]);
          if (axis === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      } else {
        for (const config of targetConfigs) {
          config.forEach((value, d) => {
            const { x, y } = point(d, value);
            if (d === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // together, complementary target: name each configuration at its first vertex
      if (!split && targetConfigs.length > 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = `bold ${fontSize}px ${CANVAS_FONT}`;
        targetConfigs.forEach((config, k) => {
          const { x, y } = point(0, config[0]);
          ctx.fillText(`T${k + 1}`, x + 14, y);
        });
      }
    }

    // Legend: players and their closeness to the target, flowing into further
    // columns rather than running off the bottom of the canvas.
    const legendFontSize = Math.max(9, Math.round(w * 0.02));
    ctx.font = `${legendFontSize}px ${CANVAS_FONT}`;
    ctx.textAlign = 'left';
    const lineH = legendFontSize + 6;
    const rowsPerColumn = Math.max(1, Math.floor((h - 12) / lineH));
    const columnWidth = 20 + ctx.measureText('M'.repeat(16)).width + 12;
    users.forEach((state, i) => {
      const id = state.get('id');
      const { stroke } = playerColor(id);
      const configs = targetConfigs.length > 1 ? ` T${(i % targetConfigs.length) + 1}` : '';
      const label = `${nicknameOf(id)} ${closenessOf(id)}${configs}`;
      const lx = 10 + Math.floor(i / rowsPerColumn) * columnWidth;
      const ly = 12 + (i % rowsPerColumn) * lineH;
      ctx.beginPath();
      ctx.arc(lx, ly, 5, 0, 2 * Math.PI);
      ctx.fillStyle = stroke;
      ctx.fill();
      ctx.fillStyle = matched.has(id) ? stroke : 'rgba(255,255,255,0.8)';
      ctx.fillText(label, lx + 10, ly);
    });

    // Target name, top right
    if (target) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = `bold ${legendFontSize}px ${CANVAS_FONT}`;
      ctx.fillText(`TARGET ${target.name}`, w - 10, 12);
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(w - 10 - ctx.measureText(`TARGET ${target.name}`).width, 12 + lineH * 0.7);
      ctx.lineTo(w - 10, 12 + lineH * 0.7);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  function renderApp() {
    const phase = global.get('phase');
    const showScores = phase === 'scores';
    const hideInterface = phase !== 'playing';
    const globalScore = (global.get('global_score') ?? 0).toFixed(0);

    const list = players();
    const matched = matchedIndexes();
    const ranking = showScores ? rankedPlayers() : [];
    // Up to 10 players per column, read top to bottom then left to right.
    const rankingCols = Math.max(1, Math.ceil(ranking.length / 10));
    const rankingRows = Math.ceil(ranking.length / rankingCols);

    render(html`
      <div id="display-root">

        <!-- Waiting: how to join the game -->
        <div id="enter-overlay" style="display: ${phase === 'waiting' ? 'flex' : 'none'};">
          <div class="display-enter">
            <div class="display-enter-title">${client.config.app.name}</div>
            <div class="display-enter-steps">
              <div class="display-enter-line">1. Join the network</div>
              <div class="display-enter-line">2. Open the browser and go to</div>
              <div class="display-enter-line"><strong>${window.location.host}</strong></div>
            </div>
            <div class="display-enter-advice">
              <div>${list.length} player${list.length === 1 ? '' : 's'} connected</div>
            </div>
          </div>
        </div>

        <div id="gameover-overlay" style="display: ${phase === 'end' ? 'flex' : 'none'};">
          <div id="gameover-content">GAME OVER</div>
        </div>

        <!-- Scores: global points and every player's score, highest first -->
        <div id="scores-overlay" style="display: ${showScores ? 'flex' : 'none'};">
          <div class="scores-block">
            <div class="scores-label">Global Points</div>
            <div class="scores-value">${globalScore}</div>
          </div>
          ${ranking.length > 0
            ? html`
              <div
                class="display-ranking"
                style="grid-template-columns: repeat(${rankingCols}, minmax(0, 1fr)); grid-template-rows: repeat(${rankingRows}, auto); width: min(92vw, ${rankingCols * 380}px)"
              >
                ${ranking.map((state, i) => {
                  const index = state.get('id');
                  const { r, g, b } = playerColor(index);
                  return html`
                    <div class="display-ranking-row" style="--player-rgb: ${r}, ${g}, ${b};">
                      <span class="display-ranking-rank">${i + 1}</span>
                      <span class="display-player-name">${state.get('nickname') || `Player ${index}`}</span>
                      <span class="display-player-score">${(state.get('local_score') ?? 0).toFixed(0)}</span>
                    </div>
                  `;
                })}
              </div>
            `
            : ''
          }
        </div>

        <!-- Interface: shown while playing -->
        <div id="display-left" style="${hideInterface ? 'display:none' : ''}">
          <h2 class="display-section-title">Players</h2>
          ${list.length === 0
            ? html`<p class="display-empty">No players connected.</p>`
            : html`
              <div
                class="display-player-grid"
                style="grid-template-rows: repeat(${Math.ceil(list.length / 2)}, minmax(0, 56px))"
              >
                ${list.map((state) => {
                  const index = state.get('id');
                  const { r, g, b } = playerColor(index);
                  return html`
                    <div
                      class="display-player ${matched.has(index) ? 'matched' : ''}"
                      style="--player-rgb: ${r}, ${g}, ${b}"
                    >
                      <span class="display-player-name">${state.get('nickname') || `Player ${index}`}</span>
                      <span class="display-player-sync">${closenessOf(index)}</span>
                      <span class="display-player-score">${(state.get('local_score') ?? 0).toFixed(0)}</span>
                    </div>
                  `;
                })}
              </div>
            `
          }
        </div>

        <div id="display-right" style="${hideInterface ? 'display:none' : ''}">
          <div id="display-pulse">
            ${Array.from({ length: global.get('pulsesPerBar') }, (_, i) => html`
              <span class="pulse-dot ${i === 0 ? 'downbeat' : ''}"></span>
            `)}
          </div>
          <h2 class="display-section-title">Target</h2>
          <div id="radar-container">
            <canvas id="radar-canvas"></canvas>
          </div>
          <div class="score-row">
            <span class="score-label">BAR</span>
            <span class="score-value" id="display-bar">--</span>
          </div>
          <div class="score-row">
            <span class="score-label">GROUP SYNC</span>
            <span class="score-value">${global.get('sync') ? `${Math.round(global.get('sync').group * 100)}%` : '--'}</span>
          </div>
          <div class="score-row">
            <span class="score-label">TIMER</span>
            <span class="score-value">${timerDisplay}</span>
          </div>
          <div class="score-row">
            <span class="score-label">GLOBAL POINTS</span>
            <span class="score-value">${globalScore}</span>
          </div>
        </div>

        <button
          id="fullscreen-btn"
          @click=${() => {
            if (!document.fullscreenElement) {
              document.documentElement.requestFullscreen();
            } else {
              document.exitFullscreen();
            }
          }}
        >${document.fullscreenElement ? '⛶ EXIT' : '⛶ FULLSCREEN'}</button>

      </div>
    `, $container);

    scheduleRadarDraw();
  }

  setupTimer();
  renderApp();

  const resizeObserver = new ResizeObserver(() => scheduleRadarDraw());
  const radarContainer = document.getElementById('radar-container');
  if (radarContainer) resizeObserver.observe(radarContainer);

  window.addEventListener('resize', () => scheduleRadarDraw());
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '100%',
});
