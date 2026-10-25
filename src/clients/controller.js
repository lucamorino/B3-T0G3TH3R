import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import '@ircam/sc-components';

import { playerColor } from './palette.js';
import { DESCRIPTORS } from '../lib/descriptors.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

// Sound parameters of each player's instrument (see src/clients/user.js), edited
// for every player at once or one player at a time. `size` marks list parameters,
// edited as that many numbers.
const SOUND_PARAMS = [
  { key: 'volume',  label: 'Volume',  min: 0,     max: 1,     step: 0.01,  digits: 2 },
  { key: 'preset',  label: 'Preset',  min: 0,     max: 15,    step: 1,     digits: 0 },
  { key: 'mod',     label: 'Mod',     min: 0,     max: 1,     step: 0.01,  digits: 2 },
  { key: 'fade',    label: 'Fade',    min: 10,    max: 10000, step: 10,    digits: 0 },
  { key: 'fb_gain', label: 'FB Gain', min: 0.001, max: 3.99,  step: 0.001, digits: 3 },
  { key: 'fb_trim', label: 'FB Trim', min: 0.001, max: 3.99,  step: 0.001, digits: 3 },
  { key: 'bp_q',    label: 'BP Q',    min: 0.001, max: 0.99,  step: 0.001, digits: 3 },
  { key: 'phase_q', label: 'Phase Q', min: 0.001, max: 0.99,  step: 0.001, digits: 3 },
  { key: 'style',   label: 'Style',   size: 3 },
];

const PHASES = ['waiting', 'playing', 'scores', 'end'];

// Global parameters of the synchronisation (see src/lib/sync-index.js).
const SYNC_PARAMS = [
  { key: 'weightTouch',   label: 'Touch layer', min: 0,    max: 1, step: 0.05, digits: 2 },
  { key: 'weightTilt',    label: 'Tilt layer',  min: 0,    max: 1, step: 0.05, digits: 2 },
  { key: 'weightSound',   label: 'Sound layer', min: 0,    max: 1, step: 0.05, digits: 2 },
  { key: 'phaseWeight',   label: 'Phase lock',  min: 0,    max: 1, step: 0.05, digits: 2 },
  { key: 'tolerance',     label: 'Tolerance',   min: 0.05, max: 2, step: 0.05, digits: 2 },
  { key: 'syncThreshold', label: 'Threshold',   min: 0,    max: 1, step: 0.01, digits: 2 },
];

async function main($container) {
  const config = loadConfig();
  const client = new Client(config);

  // cf. https://soundworks.dev/tools/helpers.html#browserlauncher
  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  await client.start();

  document.body.classList.add('controller-client');

  const global = await client.stateManager.attach('global');
  const userCollection = await client.stateManager.getCollection('user');
  const routing = await client.stateManager.attach('routing');

  // Values last sent to every player from the "All players" card, so its inputs
  // show something sensible. Starts from the schema defaults.
  const allValues = {};
  for (const { key } of SOUND_PARAMS) {
    allValues[key] = userCollection.getDefaults()[key];
  }

  // Connected players, one per player index (see display.js).
  function players() {
    const byIndex = new Map();
    for (const state of userCollection) {
      if (state.get('assigned')) byIndex.set(state.get('id'), state);
    }
    return Array.from(byIndex.values()).sort((a, b) => a.get('id') - b.get('id'));
  }

  function matchedIndexes() {
    const raw = global.get('matched');
    return new Set(Array.isArray(raw?.[0]) ? raw[0] : []);
  }

  // ── Routing matrix (audio sharing, see src/lib/audio-sharing.js) ──────────
  // Requested routes are in the `routing` state; each phone reports in its
  // `user` state the routes it has actually established.
  function isRouted(from, to) {
    return (routing.get('connections') ?? []).some((c) => c.from === from && c.to === to);
  }

  function isLive(from, to) {
    const state = players().find((s) => s.get('id') === from);
    return (state?.get('connectedTo') ?? []).includes(to);
  }

  function toggleRoute(from, to) {
    const connections = routing.get('connections') ?? [];
    routing.set({
      connections: isRouted(from, to)
        ? connections.filter((c) => !(c.from === from && c.to === to))
        : [...connections, { from, to }],
    });
  }

  // Each connected player sends to the next one, the last to the first.
  function routeRing() {
    const indexes = players().map((s) => s.get('id'));
    if (indexes.length < 2) return;
    routing.set({
      connections: indexes.map((from, i) => ({ from, to: indexes[(i + 1) % indexes.length] })),
    });
  }

  function routingMatrix(list) {
    if (list.length < 2) return html`<p class="empty-state">Connect two players or more to route their sound.</p>`;
    const routeCount = (routing.get('connections') ?? []).length;
    return html`
      <div class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr>
              <th class="matrix-corner">out ↓ / in →</th>
              ${list.map((dst) => html`
                <th class="matrix-head" style="--player-color: ${playerColor(dst.get('id')).stroke}" title="${dst.get('nickname') || `Player ${dst.get('id')}`}">
                  <span class="player-dot"></span>${dst.get('id')}
                </th>
              `)}
            </tr>
          </thead>
          <tbody>
            ${list.map((src) => {
              const from = src.get('id');
              return html`
                <tr>
                  <th class="matrix-label" style="--player-color: ${playerColor(from).stroke}">
                    <span class="player-dot"></span>#${from} ${src.get('nickname') || ''}
                  </th>
                  ${list.map((dst) => {
                    const to = dst.get('id');
                    const self = from === to;
                    const routed = !self && isRouted(from, to);
                    const live = routed && isLive(from, to);
                    return html`
                      <td class="matrix-cell">
                        <button
                          class="matrix-btn ${routed ? 'routed' : ''} ${live ? 'live' : ''} ${self ? 'self' : ''}"
                          type="button"
                          title="${self ? '' : `#${from} → #${to}${routed ? (live ? ' (connected)' : ' (connecting)') : ''}`}"
                          ?disabled="${self}"
                          @click="${() => toggleRoute(from, to)}"
                        ></button>
                      </td>
                    `;
                  })}
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
      <div class="matrix-actions">
        <button class="phase-button" type="button" @click="${routeRing}">ring</button>
        <button class="phase-button" type="button" ?disabled="${routeCount === 0}" @click="${() => routing.set({ connections: [] })}">clear (${routeCount})</button>
      </div>
      <p class="matrix-legend">
        <span class="matrix-btn routed"></span> requested
        <span class="matrix-btn routed live"></span> connected
      </p>
    `;
  }

  const percent = value => `${Math.round(value * 100)}%`;

  // A player's result in the last bar: index and per-layer indexes.
  // ── Targets ───────────────────────────────────────────────────────────────
  function selectTarget(index) {
    const count = global.get('targetCount');
    if (count === 0) return;
    global.set({ targetIndex: ((index % count) + count) % count });
  }

  function formatDescriptor(value) {
    if (!Number.isFinite(value)) return '--';
    return Math.abs(value) >= 100 ? value.toFixed(0) : value.toPrecision(3);
  }

  function targetSection() {
    const target = global.get('target');
    const count = global.get('targetCount');
    return html`
      <section>
        <h2>Target</h2>
        ${count === 0
          ? html`<p class="empty-state">No target database (see data/targets.json).</p>`
          : html`
            <div class="target-picker">
              <button class="phase-button" type="button" @click="${() => selectTarget(global.get('targetIndex') - 1)}">◀</button>
              <input
                class="param-number"
                type="number"
                min="1"
                max="${count}"
                .value="${String(global.get('targetIndex') + 1)}"
                @change="${(event) => selectTarget((parseInt(event.target.value, 10) || 1) - 1)}"
              />
              <span class="param-value">/ ${count}</span>
              <button class="phase-button" type="button" @click="${() => selectTarget(global.get('targetIndex') + 1)}">▶</button>
              <button class="phase-button" type="button" @click="${() => selectTarget(Math.floor(Math.random() * count))}">random</button>
            </div>
            ${target ? html`
              <div class="target-table-scroll">
              <table class="target-table">
                <thead>
                  <tr>
                    <th>${target.name}</th>
                    ${DESCRIPTORS.map(d => html`<th title="${d.label}">${d.label.slice(0, 4)}</th>`)}
                  </tr>
                </thead>
                <tbody>
                  ${target.configs.map((config, k) => html`
                    <tr>
                      <td>${target.configs.length > 1 ? `T${k + 1}` : 'all'}</td>
                      ${DESCRIPTORS.map(d => html`<td>${formatDescriptor(config[d.key])}</td>`)}
                    </tr>
                  `)}
                </tbody>
              </table>
              </div>
            ` : ''}
          `}
        ${rangeRow(
          { label: 'Tolerance', min: 0.01, max: 0.5, step: 0.01, digits: 2 },
          global.get('matchTolerance'),
          (value) => global.set({ matchTolerance: value }),
        )}
        <label class="toggle-row">
          <span class="toggle-label">SPLIT RADAR (ONE SLICE PER PLAYER)</span>
          <input
            class="toggle-input"
            type="checkbox"
            .checked="${global.get('radarSplit')}"
            @change="${(event) => global.set({ radarSplit: event.target.checked })}"
          />
          <span class="toggle-indicator"></span>
        </label>
      </section>
    `;
  }

  // A player's closeness to their target, as a percentage, and their configuration.
  function targetSummary(index) {
    const result = global.get('targetMatch')?.[index];
    if (!result) return '--';
    const configs = global.get('target')?.configs.length ?? 1;
    return `${percent(result.closeness)}${configs > 1 ? ` of T${result.config + 1}` : ''}${result.matched ? ' · matched' : ''}`;
  }

  function syncSummary(index) {
    const result = global.get('sync')?.players?.[index];
    if (!result || result.partner === null) return '--';
    const layers = Object.entries(result.layers)
      .map(([name, value]) => `${name} ${value === null ? '-' : percent(value)}`)
      .join(' · ');
    return `${percent(result.index)} with #${result.partner} (${layers})`;
  }

  const rangeRow = (def, value, onInput) => html`
    <div class="param-row">
      <span class="param-label">${def.label}</span>
      <input
        class="param-input"
        type="range"
        min="${def.min}"
        max="${def.max}"
        step="${def.step}"
        .value="${String(value)}"
        @input="${(event) => onInput(parseFloat(event.target.value))}"
      />
      <span class="param-value">${formatValue(Number(value), def.digits)}</span>
    </div>
  `;

  const formatValue = (value, digits) => {
    if (!Number.isFinite(value)) return '--';
    return value.toFixed(digits);
  };

  // One row per sound parameter; `set` receives { key: value } updates.
  function soundParamRows(values, set) {
    return SOUND_PARAMS.map((def) => {
      const value = values[def.key];

      if (def.size) {
        const list = Array.isArray(value) ? value : [];
        return html`
          <div class="param-row">
            <span class="param-label">${def.label}</span>
            <div class="param-list">
              ${Array.from({ length: def.size }, (_, i) => html`
                <input
                  class="param-number"
                  type="number"
                  step="any"
                  .value="${String(list[i] ?? 0)}"
                  @change="${(event) => {
                    const next = Array.from({ length: def.size }, (_, j) => Number(list[j] ?? 0));
                    next[i] = parseFloat(event.target.value) || 0;
                    set({ [def.key]: next });
                  }}"
                />
              `)}
            </div>
            <span class="param-value"></span>
          </div>
        `;
      }

      return html`
        <div class="param-row">
          <span class="param-label">${def.label}</span>
          <input
            class="param-input"
            type="range"
            min="${def.min}"
            max="${def.max}"
            step="${def.step}"
            .value="${String(value)}"
            @input="${(event) => set({ [def.key]: parseFloat(event.target.value) })}"
          />
          <span class="param-value">${formatValue(Number(value), def.digits)}</span>
        </div>
      `;
    });
  }

  function renderApp() {
    const phase = global.get('phase');
    const list = players();
    const matched = matchedIndexes();

    render(html`
      <div class="controller-layout">
        <header>
          <h1>${client.config.app.name} | ${client.role}</h1>
          <sw-audit .client="${client}"></sw-audit>
        </header>
        <div class="controller-columns">
          <div class="controller-left">
            <section>
              <h2>Game</h2>
              <div class="phase-buttons">
                ${PHASES.map((name) => html`
                  <button
                    class="phase-button ${phase === name ? 'active' : ''}"
                    type="button"
                    @click="${() => global.set({ phase: name })}"
                  >${name}</button>
                `)}
              </div>
              <div class="param-row">
                <span class="param-label">Round (s)</span>
                <input
                  class="param-number"
                  type="number"
                  min="0"
                  max="3600"
                  step="1"
                  .value="${String(global.get('duration'))}"
                  @change="${(event) => global.set({ duration: Math.max(0, parseFloat(event.target.value) || 0) })}"
                />
                <span class="param-value">${global.get('duration') > 0 ? '' : 'no time'}</span>
              </div>
              <div class="param-row">
                <span class="param-label">Goal</span>
                <div class="param-list">
                  ${[0, 1, 2].map((i) => html`
                    <input
                      class="param-number"
                      type="number"
                      step="any"
                      .value="${String(global.get('goal')?.[i] ?? 0)}"
                      @change="${(event) => {
                        const goal = [0, 1, 2].map((j) => Number(global.get('goal')?.[j] ?? 0));
                        goal[i] = parseFloat(event.target.value) || 0;
                        global.set({ goal });
                      }}"
                    />
                  `)}
                </div>
                <span class="param-value"></span>
              </div>
              <div class="stat-row">
                <span class="param-label">Players</span>
                <span class="param-value">${global.get('numPlayers')}</span>
              </div>
              <div class="stat-row">
                <span class="param-label">Global points</span>
                <span class="param-value">${formatValue(global.get('global_score'), 0)}</span>
              </div>
              <button
                class="phase-button danger"
                type="button"
                @click="${() => {
                  if (confirm('Reset every player\'s score to 0?')) global.set({ resetScores: true });
                }}"
              >reset scores</button>
            </section>
            ${targetSection()}
            <section>
              <h2>Metronome</h2>
              <div class="param-row">
                <span class="param-label">Pulse (ms)</span>
                <input
                  class="param-number"
                  type="number"
                  min="200"
                  max="2000"
                  step="10"
                  .value="${String(global.get('pulsePeriod'))}"
                  @change="${(event) => {
                    const value = Math.min(2000, Math.max(200, parseFloat(event.target.value) || 500));
                    global.set({ pulsePeriod: value });
                  }}"
                />
                <span class="param-value">${formatValue(60000 / global.get('pulsePeriod'), 0)} bpm</span>
              </div>
              <div class="param-row">
                <span class="param-label">Pulses / bar</span>
                <input
                  class="param-number"
                  type="number"
                  min="1"
                  max="16"
                  step="1"
                  .value="${String(global.get('pulsesPerBar'))}"
                  @change="${(event) => {
                    const value = Math.min(16, Math.max(1, Math.round(parseFloat(event.target.value) || 4)));
                    global.set({ pulsesPerBar: value });
                  }}"
                />
                <span class="param-value">${formatValue(global.get('pulsePeriod') * global.get('pulsesPerBar') / 1000, 1)} s</span>
              </div>
              <label class="toggle-row">
                <span class="toggle-label">CLICK ON PHONES</span>
                <input
                  class="toggle-input"
                  type="checkbox"
                  .checked="${global.get('click')}"
                  @change="${(event) => global.set({ click: event.target.checked })}"
                />
                <span class="toggle-indicator"></span>
              </label>
            </section>
            <section>
              <h2>Synchronisation</h2>
              ${SYNC_PARAMS.map((def) => rangeRow(def, global.get(def.key), (value) => global.set({ [def.key]: value })))}
              <div class="stat-row">
                <span class="param-label">Last bar</span>
                <span class="param-value">${global.get('sync') ? `#${global.get('sync').bar + 1}` : '--'}</span>
              </div>
              <div class="stat-row">
                <span class="param-label">Group sync</span>
                <span class="param-value">${global.get('sync') ? percent(global.get('sync').group) : '--'}</span>
              </div>
            </section>
          </div>
          <div class="controller-center">
            <section>
              <h2>Audio sharing</h2>
              ${routingMatrix(list)}
            </section>
            <section>
              <h2>Players sound</h2>
              <div class="user-params">
                <div class="user-params-card">
                  <div class="user-params-header">All players</div>
                  ${soundParamRows(allValues, (updates) => {
                    Object.assign(allValues, updates);
                    userCollection.set(updates);
                    renderApp();
                  })}
                </div>
                ${list.map((state) => {
                  const index = state.get('id');
                  const { stroke } = playerColor(index);
                  return html`
                    <div class="user-params-card ${matched.has(index) ? 'matched' : ''}" style="--player-color: ${stroke}">
                      <div class="user-params-header">
                        <span class="player-dot"></span>
                        #${index} ${state.get('nickname') || `Player ${index}`}
                        <span class="player-score">${formatValue(state.get('local_score'), 0)} pts</span>
                      </div>
                      <div class="player-sync">target ${targetSummary(index)}</div>
                      <div class="player-sync">sync ${syncSummary(index)}</div>
                      ${soundParamRows(state.getValues(), (updates) => state.set(updates))}
                    </div>
                  `;
                })}
              </div>
              ${list.length === 0 ? html`<p class="empty-state">No players connected.</p>` : ''}
            </section>
          </div>
        </div>
      </div>
    `, $container);
  }

  // Players publish their score twice a second each: coalesce renders onto frames.
  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderApp();
    });
  }

  renderApp();
  global.onUpdate(() => scheduleRender());
  userCollection.onChange(() => scheduleRender());
  routing.onUpdate(() => scheduleRender());
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '100%',
});
