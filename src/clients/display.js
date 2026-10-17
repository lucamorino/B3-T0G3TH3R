import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import pluginSync from '@soundworks/plugin-sync/client.js';

import { playerColor } from './palette.js';

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

  const AXES = [
    { key: 'sharpness',            label: 'Sharpness',   min: 0,  max: 3     },
    { key: 'loudness',             label: 'Loudness',    min: 0,  max: 120   },
    { key: 'spectralCentroid',     label: 'Centroid',    min: 0,  max: 3000  },
    { key: 'dissonance',           label: 'Dissonance',  min: 0,  max: 1     },
    { key: 'spectralComplexity',   label: 'Complexity',  min: 0,  max: 100   },
  ];

  // Canvas text can't read CSS variables, so the app font is named here too.
  const CANVAS_FONT = "'DM Mono', monospace";

  function normalize(value, min, max) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

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

  // Indexes of the players currently matched. The server sets `matched` as
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

    const numAxes = AXES.length;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const labelPad = 40;
    const radius = Math.min(w, h) * 0.5 - labelPad;
    const angleStep = (2 * Math.PI) / numAxes;
    const startAngle = -Math.PI / 2;

    // Grid rings
    const ringLevels = [0.2, 0.4, 0.6, 0.8, 1.0];
    ringLevels.forEach((level) => {
      const r = level * radius;
      ctx.beginPath();
      for (let i = 0; i < numAxes; i++) {
        const angle = startAngle + i * angleStep;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Axes + labels
    for (let i = 0; i < numAxes; i++) {
      const angle = startAngle + i * angleStep;
      const ax = cx + radius * Math.cos(angle);
      const ay = cy + radius * Math.sin(angle);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ax, ay);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const labelR = radius + labelPad * 0.75;
      const lx = cx + labelR * Math.cos(angle);
      const ly = cy + labelR * Math.sin(angle);
      const fontSize = Math.max(8, Math.round(w * 0.014));
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `${fontSize}px ${CANVAS_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(AXES[i].label, lx, ly);
    }

    // User polygons
    const users = sortedUsers();
    users.forEach((state) => {
      const { stroke, fill } = playerColor(state.get('id'));

      const points = AXES.map((axis, i) => {
        const val = normalize(state.get(axis.key) ?? 0, axis.min, axis.max);
        const angle = startAngle + i * angleStep;
        return {
          x: cx + val * radius * Math.cos(angle),
          y: cy + val * radius * Math.sin(angle),
        };
      });

      ctx.beginPath();
      points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();

      points.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
        ctx.fillStyle = stroke;
        ctx.fill();
      });
    });

    // Legend: flows into further columns rather than running off the bottom of the
    // canvas once there are more players than fit in one.
    const legendFontSize = Math.max(9, Math.round(w * 0.02));
    ctx.font = `${legendFontSize}px ${CANVAS_FONT}`;
    const lineH = legendFontSize + 6;
    const rowsPerColumn = Math.max(1, Math.floor((h - 12) / lineH));
    const columnWidth = 20 + ctx.measureText('M'.repeat(10)).width + 12;
    users.forEach((state, i) => {
      const { stroke } = playerColor(state.get('id'));
      const label = nicknameOf(state.get('id') ?? 0);
      const lx = 10 + Math.floor(i / rowsPerColumn) * columnWidth;
      const ly = 12 + (i % rowsPerColumn) * lineH;
      ctx.beginPath();
      ctx.arc(lx, ly, 5, 0, 2 * Math.PI);
      ctx.fillStyle = stroke;
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 10, ly);
    });

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
                      <span class="display-player-score">${(state.get('local_score') ?? 0).toFixed(0)}</span>
                    </div>
                  `;
                })}
              </div>
            `
          }
        </div>

        <div id="display-right" style="${hideInterface ? 'display:none' : ''}">
          <h2 class="display-section-title">Analysis</h2>
          <div id="radar-container">
            <canvas id="radar-canvas"></canvas>
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
