# `B3-T0G3TH3R`

An audience participation game piece: every spectator plays a sound instrument on
their phone, the phones' sounds feed into each other, and players score points by
bringing their interdependent sounds, together, to a target configuration of sound
descriptors shown on the display. Their synchronisation, on a pulse shared by
every device, is evaluated along the way.

The project is built with **soundworks** and **RNBO**. Its architecture follows
`B3-H4RSH` (browser clients only, the game is run from a browser `controller`),
its player interface and display come from `The Contested Zone` (pad, Essentia
analysis, radar display), and its instrument and audio sharing from
`NINA_B3-H4RSH`, the No-Input Network Audiosystem (RNBO patch with an audio input,
phones sending their sound to each other over WebRTC). There is no Max / Ableton
Live client and no voice scenes.

## Clients

| Role         | Path          | What it is |
| ------------ | ------------- | ---------- |
| `player`     | `/`           | The phone instrument: XY pad driving the RNBO patch, tilt sensors, visual pulse, oscilloscope, closeness to the target, sync index, timer and points, nickname. |
| `display`    | `/display`    | The projected screen: pulse, player cards (closeness to the target, lit while matching it), radar of the target and of every player's sound descriptors (together or split), group sync, timer, scores ranking. |
| `controller` | `/controller` | The operator panel: game phase, round length, target, metronome, synchronisation settings, audio sharing matrix, and the sound parameters of every player or of each one. |

## How the game works

The controller moves the game through four phases (`phase` in `src/global/global.js`):

- **waiting**: players read the instructions while a hum plays; the display shows how to join.
- **playing**: the metronome runs and the pad is live. Players whose sound matches
  the target (see below) flash in their colour on the pulses and score points; the
  global score is the sum of every player's points. With a round length set, the
  server moves on to the scores when the time runs out.
- **scores**: phones show the global and their own points, the display the ranking.
- **end**: game over.

## Targets and scoring

Each phone analyses its sound on five descriptors: sharpness, loudness, spectral
centroid, dissonance and spectral complexity (`src/lib/descriptors.js`, which also
sets the range each one is drawn and compared on). A **target** is a configuration
of these five values; players score while their sound matches it. As the phones'
sounds feed into each other (see Audio sharing), a player cannot reach it alone:
the routed players have to adapt their sounds to each other.

**The database.** The targets are read from `data/targets.json` when the server
starts (`TARGETS=path/to/file.json npm run start` for another one):

```json
{
  "descriptors": ["sharpness", "loudness", "spectralCentroid", "dissonance", "spectralComplexity"],
  "targets": [
    { "id": 0, "name": "T01", "configs": [{ "sharpness": 1.26, "loudness": 78, "spectralCentroid": 765, "dissonance": 0.06, "spectralComplexity": 22.3 }] },
    { "id": 5, "name": "T06 (complementary)", "configs": [{ "...": "..." }, { "...": "..." }] }
  ]
}
```

A target has one configuration, shared by every player, or several,
complementary ones: the connected players, in index order, take them in turn (with
two configurations and two players, each has their own). The current database is
random, made by `node tools/generate-targets.js [count] [file]`, which draws each
value in the range most sounds of the RNBO patch fall in (measured across its
presets and the whole pad).

**Matching.** In the controller, the operator picks the target (by number, previous
/ next, or at random). About ten times a second the server compares each player's
descriptors with their configuration, each normalised to its range: a player's
**closeness** is 1 minus the distance of their farthest descriptor, and a player
who touches the pad matches the target when their closeness reaches
1 − `matchTolerance` (0.1 by default, i.e. every descriptor within 10% of its
range). A matching player flashes and scores 1 point per second.

**The radar** on the display shows the target (dashed white) and every player's
descriptors (in their colour) on the same chart, so players see their sounds move
towards it. It has two views, switched in the controller:

- **together**: every player on the same five axes; a complementary target shows
  each of its configurations (T1, T2…);
- **split**: one slice of five axes per player, the descriptors in reverse order on
  every other slice, so that with two players the halves mirror each other. The
  target is one outline around all slices, each showing the configuration of that
  slice's player: symmetric when the players share the same configuration,
  asymmetric when theirs are complementary.

## Synchronisation

Along the way, the game evaluates the sensory-motor synchronisation of the
players (it is shown on the phones, the display and the controller, and does not
score), on three layers:

1. **touch**: the movement of the finger on the pad (x, y);
2. **tilt**: the tilt of the phone (gravity along its x and y axes, from the
   motion sensors, which need https, see below);
3. **sound**: how the features of the player's sound evolve (loudness, sharpness,
   spectral centroid, dissonance, spectral complexity).

**Shared metronome.** When the game starts playing, the server anchors a grid of
pulses on the sync time (`pulsePeriod` ms apart, `pulsesPerBar` to a bar). Every
phone shows the pulse (a row of dots, the current one lit, and a ring flashing
around the pad, stronger on the first pulse of the bar), and can click on it. The
pulse and the bar are set in the controller; a change applies from the next bar
line. See `src/lib/metronome.js`.

**The bar is the time unit.** Each phone samples the three layers at 20Hz on the
grid during a bar, and sends them to the server once the bar is over (one message
per bar, rather than a continuous stream). Half a second after the end of each bar
the server evaluates it:

- For every player and layer, it computes the probability of recurrence p(τ) of
  the signal's velocity (how likely it comes back, within a tolerance, to where it
  was τ samples earlier), as in the CPR index of Varni et al., *Interactive
  sonification of synchronisation of motoric behaviour in social active listening
  to music with mobile devices* (J Multimodal User Interfaces, 2012). A player
  who does not move in a layer has no index in it.
- For every pair of players and layer: the **CPR index**, the correlation of their
  normalised p̂(τ), close to 1 when they move with the same rhythm; and the
  **phase lock**, the correlation of their signals at lag 0, close to 1 when they
  also move on the same beat (CPR alone does not see a constant offset, which the
  shared pulse makes meaningful). The layer index mixes both (`phaseWeight`).
- A pair's index is the weighted mean of the layers both players are active in
  (weights `weightTouch`, `weightTilt`, `weightSound`; 0 leaves a layer out).
- A player's index is their best pair's. Players at or above `syncThreshold`
  (0.4 by default, from the paper) count as synchronised. The group index is the
  mean over all pairs.

The algorithm is in `src/lib/sync-index.js`, the scheduling in `src/server.js`.

## Audio sharing

Each phone runs the `B3-H4RSH_NINA` RNBO patch, which has an audio input: the
operator routes the sound of any phone into the input of any other one with the
**audio sharing matrix** in the controller (row: the phone that sends, column: the
phone that receives; `ring` sends each phone to the next one, `clear` removes every
route). A phone processes what it receives, and its output goes on to the phones
it sends to, so routes can form chains and feedback loops between phones.

Each route is a peer-to-peer WebRTC connection, opened by the sending phone: its
RNBO output goes into a `MediaStream` sent to the receiving phone, which plays it
into its RNBO input (see `src/lib/audio-sharing.js`). The server only relays the
signaling messages between phones and holds the routes (the `routing` state); a
cell of the matrix turns green once its connection is established. Routes stay
when a phone reloads its page: it rejoins as the same player and its connections
are opened again. Each phone sends one audio stream per route it is the source
of, so keep a phone's routes to a few.

The phones find each other through their local network addresses; on a network
with internet access a STUN server also helps across networks.

As in NINA_B3-H4RSH, the patch plays while the pad is touched (`start`), and each
new touch triggers it (`trigger`). The sound parameters of each player (volume,
preset, mod, fade, feedback gain and trim, bandpass and phase Q, style) are set in
the controller; a preset is loaded first and the parameters applied on top of it.

## Players' identity

Players keep their index, nickname and score when their page reloads (screen lock,
app switch, network blip): each phone keeps a device id in its localStorage, and
the server's player registry gives a returning device its slot back (see
`src/server.js`). Up to 50 players (`CAPACITY` in `src/server.js`).

## Https and motion sensors

Browsers only give access to the motion sensors to pages served over https, so the
server runs in https (`config/env-default.yaml`). Without certificate files it
generates a self-signed certificate: each phone has to accept a security warning
once. To avoid it, create a certificate trusted by the phones, for example with
[mkcert](https://github.com/FiloSottile/mkcert) (as for Xplosive Collision), and
point to it in an env config file:

```yaml
useHttps: true
httpsInfos:
  cert: /path/to/cert.pem
  key: /path/to/key.pem
```

On iOS the phone asks the player for access to the motion sensors on the first
tap. A player who refuses, or a phone without sensors, still plays, without the
tilt layer.

## Files

```
src/
├─ server.js              plugins, phases and round timer, targets and matching, metronome, bar evaluation, WebRTC signaling, player registry, global score
├─ global/global.js       `global` state: phase, round, metronome, synchronisation settings and results, scores
├─ clients/
│  ├─ user.js             `user` state (one per player): identity, score, sound parameters, established audio routes
│  ├─ control.js          `control` state (one per player): pad activity, sound analysis, bar reports
│  ├─ player.js           phone instrument
│  ├─ display.js          projected display
│  ├─ controller.js       operator panel
│  ├─ identity.js         device id and nickname screen
│  └─ palette.js          player colours, shared by every client
├─ lib/
│  ├─ metronome.js        shared pulse grid
│  ├─ descriptors.js      sound descriptors and their ranges
│  ├─ sync-index.js       synchronisation index (CPR and phase lock)
│  ├─ audio-sharing.js    WebRTC audio routes between phones
│  └─ ...                 audio helpers (sample loading, Opus support, hum loop)
└─ styles/app.scss
public/assets/
├─ rnbo_export/           the RNBO instrument patch (B3-H4RSH_NINA, from NINA_B3-H4RSH)
├─ rnbo/1.4.2/            RNBO runtime, served locally
├─ essentia/              Essentia.js (WASM) for the spectral analysis
└─ samples/               hum (.wav and Opus .webm, see tools/encode-audio.sh)
data/
└─ targets.json           target database (random for now)
tools/
├─ generate-targets.js    random target database
└─ encode-audio.sh        Opus versions of the samples
```

## Running

```bash
npm install
npm run dev        # build, watch and run the server
```

Then open `https://<server-ip>:8000` on the phones, `/display` on the projector and
`/controller` on the operator's computer. `npm run build` then `npm run start` runs
the server without watching.

Several players can be emulated in one browser window with `?emulate=n`, e.g.
`https://127.0.0.1:8000?emulate=4`.

### `ENV` and `PORT`

Environment config files live in `/config` (`env-<name>.yaml`); `ENV=prod npm run start`
uses `config/env-prod.yaml`. `PORT=3000 npm run start` overrides the port.

## Links / Resources

- [General Documentation / Tutorials](https://soundworks.dev/)
- [API](https://soundworks.dev/api)
- [Examples](https://github.com/collective-soundworks/soundworks-examples)
- [Issue Tracker](https://github.com/collective-soundworks/soundworks/issues)

## Credits

[soundworks](https://soundworks.dev) is developed by the ISMM team at Ircam

## License

[BSD-3-Clause](./LICENSE)
