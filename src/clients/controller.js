import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import '@ircam/sc-components';

import { playerColor } from './palette.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

// Sound parameters of each player's instrument (see src/clients/user.js), edited
// for every player at once or one player at a time. `size` marks list parameters,
// edited as that many numbers.
const SOUND_PARAMS = [
  { key: 'volume',  label: 'Volume',  min: 0,     max: 1,     step: 0.01,  digits: 2 },
  { key: 'mod',     label: 'Mod',     min: 0,     max: 1,     step: 0.01,  digits: 2 },
  { key: 'fade',    label: 'Fade',    min: 10,    max: 10000, step: 10,    digits: 0 },
  { key: 'fb_gain', label: 'FB Gain', min: 0.001, max: 3.99,  step: 0.001, digits: 3 },
  { key: 'fb_trim', label: 'FB Trim', min: 0.001, max: 3.99,  step: 0.001, digits: 3 },
  { key: 'style',   label: 'Style',   size: 3 },
  { key: 'env',     label: 'Env',     size: 2 },
  { key: 'LFO',     label: 'LFO',     size: 3 },
];

const PHASES = ['waiting', 'playing', 'scores', 'end'];

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
              <label class="toggle-row">
                <span class="toggle-label">START</span>
                <input
                  class="toggle-input"
                  type="checkbox"
                  .checked="${global.get('start') > 0}"
                  @change="${(event) => global.set({ start: event.target.checked ? 1 : 0 })}"
                />
                <span class="toggle-indicator"></span>
              </label>
              <div class="param-row">
                <span class="param-label">Slider</span>
                <input
                  class="param-input"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  .value="${String(global.get('slider'))}"
                  @input="${(event) => global.set({ slider: parseFloat(event.target.value) })}"
                />
                <span class="param-value">${formatValue(global.get('slider'), 0)}</span>
              </div>
              <div class="param-row">
                <span class="param-label">Match delta</span>
                <input
                  class="param-input"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  .value="${String(global.get('delta'))}"
                  @input="${(event) => global.set({ delta: parseFloat(event.target.value) })}"
                />
                <span class="param-value">${formatValue(global.get('delta'), 2)}</span>
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
          </div>
          <div class="controller-center">
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
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '100%',
});
