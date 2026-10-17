// Player identity: the device id that lets a phone rejoin as the same player, and
// the nickname screen shown on its first visit. See the player registry in
// server.js for the other half.

const DEVICE_ID_KEY = 'b3-t0g3th3r:device-id';
const NICKNAME_MAX_LENGTH = 16; // keep in sync with server.js

function randomId() {
  // crypto.randomUUID() only exists in secure contexts (HTTPS), and the show may
  // be served over plain HTTP on the local network; getRandomValues works on both.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let clientsInThisPage = 0;

/**
 * Id identifying this phone across page reloads, kept in localStorage.
 *
 * With `?emulate=n` several players share the page and its localStorage, so each
 * one past the first gets a suffix to stay distinct.
 */
export function getDeviceId() {
  const slot = clientsInThisPage++;
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
  } catch {
    // storage unavailable: still play, just without rejoining as the same player
    id = id || randomId();
  }
  return slot === 0 ? id : `${id}:${slot}`;
}

/**
 * Resolves once the server has answered the `user` state: either assigned it a
 * player index (`assigned`) or refused it because the game is full (`full`).
 */
export function waitForAssignment(user) {
  return new Promise((resolve) => {
    if (user.get('assigned') || user.get('full')) {
      resolve();
      return;
    }
    const off = user.onUpdate((updates) => {
      if (updates.assigned || updates.full) {
        off();
        resolve();
      }
    });
  });
}

function createScreen($container) {
  const screen = document.createElement('div');
  screen.className = 'identity-screen';
  // Prepended, not appended: lit renders the app into $container too, and when it
  // swaps templates it clears everything from its start marker to the end of the
  // container, which would include a screen appended after it. The screen is
  // position: fixed, so where it sits in the DOM does not affect the layout.
  $container.prepend(screen);
  return screen;
}

/**
 * Full-screen nickname form, above every other layer. Opens on a phone's first
 * visit, and again whenever the player taps the nickname button.
 *
 * Resolves with the new nickname once submitted, or null if closed without
 * submitting; the screen is removed either way.
 */
export function openNicknameScreen($container, { color, index, nickname = '' }) {
  return new Promise((resolve) => {
    const screen = createScreen($container);
    screen.innerHTML = `
      <button class="identity-close" type="button" aria-label="Close">&#x2715;</button>
      <form class="identity-content" autocomplete="off">
        <div class="identity-dot"></div>
        <p class="identity-label"></p>
        <input
          class="identity-input"
          type="text"
          name="nickname"
          maxlength="${NICKNAME_MAX_LENGTH}"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="done"
        />
        <button class="identity-button" type="submit"> >>> </button>
      </form>
    `;

    const form = screen.querySelector('form');
    const input = screen.querySelector('input');
    const submit = screen.querySelector('.identity-button');
    const close = screen.querySelector('.identity-close');
    // set as properties, never through innerHTML: the nickname is user input
    screen.querySelector('.identity-dot').style.background = color;
    screen.querySelector('.identity-label').textContent = nickname ? 'Change your nickname' : 'Choose your nickname';
    input.placeholder = `Player ${index}`;
    input.value = nickname;
    submit.disabled = nickname === '';

    const done = (result) => {
      input.blur(); // closes the on-screen keyboard
      screen.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };

    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        done(null);
      }
    };
    document.addEventListener('keydown', onKeydown);

    input.addEventListener('input', () => {
      submit.disabled = input.value.trim() === '';
    });

    close.addEventListener('click', () => done(null));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.replace(/\s+/g, ' ').trim();
      if (value === '') {
        return;
      }
      done(value);
    });

    input.focus();
  });
}

/**
 * Shown instead of the game when every player slot is taken.
 */
export function showGameFull($container) {
  const screen = createScreen($container);
  screen.innerHTML = `
    <div class="identity-content">
      <p class="identity-label">The game is full.</p>
      <p class="identity-hint">Sorry, there is no free place left.</p>
    </div>
  `;
}
