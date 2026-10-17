# `B3-T0G3TH3R`

An audience participation game piece: every spectator plays a sound instrument on
their phone, and scores points by tuning their sound with other players'.

The project is built with **soundworks** and **RNBO**. Its architecture follows
`B3-H4RSH` (browser clients only, the game is run from a browser `controller`),
and its player instrument and display come from `The Contested Zone` (RNBO pad
instrument, Essentia analysis, matching and scoring, radar display). There is no
Max / Ableton Live client and no voice scenes.

## Clients

| Role         | Path          | What it is |
| ------------ | ------------- | ---------- |
| `player`     | `/`           | The phone instrument: XY pad driving the RNBO patch, oscilloscope, timer and points, nickname. |
| `display`    | `/display`    | The projected screen: player cards (lit while matched), radar of every player's sound analysis, timer, scores ranking. |
| `controller` | `/controller` | The operator panel: game phase, round length, global parameters, and the sound parameters of every player or of each one. |

## How the game works

The controller moves the game through four phases (`phase` in `src/global/global.js`):

- **waiting**: players read the instructions while a hum plays; the display shows how to join.
- **playing**: the pad is live. Each phone analyses its own sound (loudness and
  sharpness from RNBO, spectral centroid, complexity and dissonance from Essentia)
  and publishes it at 10Hz while the player holds the pad. The server compares
  active players: two players match when every feature of one is within `delta`
  (relative) of the other's. Matched phones flash in the player's colour and count
  1 point per second; the global score is the sum of every player's points. With a
  round length set, the server moves on to the scores when the time runs out.
- **scores**: phones show the global and their own points, the display the ranking.
- **end**: game over.

Players keep their index, nickname and score when their page reloads (screen lock,
app switch, network blip): each phone keeps a device id in its localStorage, and
the server's player registry gives a returning device its slot back (see
`src/server.js`). Up to 50 players (`CAPACITY` in `src/server.js`).

## Files

```
src/
├─ server.js              plugins, phases and round timer, matching, player registry, global score
├─ global/global.js       `global` state: phase, round, slider, delta, goal, matched, scores
├─ clients/
│  ├─ user.js             `user` state (one per player): identity, score, sound parameters
│  ├─ control.js          `control` state (one per player): pad activity and sound analysis
│  ├─ player.js           phone instrument
│  ├─ display.js          projected display
│  ├─ controller.js       operator panel
│  ├─ identity.js         device id and nickname screen
│  └─ palette.js          player colours, shared by every client
├─ lib/                   audio helpers (sample loading, Opus support, hum loop)
└─ styles/app.scss
public/assets/
├─ rnbo_export/           the RNBO instrument patch (from The Contested Zone)
├─ rnbo/1.4.2/            RNBO runtime, served locally
├─ essentia/              Essentia.js (WASM) for the spectral analysis
└─ samples/               hum (.wav and Opus .webm, see tools/encode-audio.sh)
```

## Running

```bash
npm install
npm run dev        # build, watch and run the server
```

Then open `http://<server-ip>:8000` on the phones, `/display` on the projector and
`/controller` on the operator's computer. `npm run build` then `npm run start` runs
the server without watching.

Several players can be emulated in one browser window with `?emulate=n`, e.g.
`http://127.0.0.1:8000?emulate=4`.

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
