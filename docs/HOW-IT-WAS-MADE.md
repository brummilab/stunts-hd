# How Stunts HD was made

## The approach

**Recompiled: the game.** Stunts' own code is never rewritten. When you open your copy, the game's `GAME.EXE` is
decoded and translated, instruction by instruction, into JavaScript in your browser (`stunts/translate.js`,
`x86dec.js`, `exefile.js`). A small map (`map.json`) supplies only names and places, built from the Restunts project's
disassembly. The handling, opponents, replays and crashes are the original's because the code is the original's.

**Reimplemented: the PC around it.** The translated game runs on a small emulated PC written for this project: DOS
file and memory services, the BIOS, VGA mode 13h, the PIT timer, the keyboard controller and an AdLib (OPL2) synth
(`stunts/cpu.js`, `dos.js`, `drv86.js`, `opl-worklet.js`). The game runs in a worker.

**Redrawn: the picture.** The game still draws its own 320x200 frame. Each frame, `hires-capture.js` records what the
original renderer was asked to draw (shapes, places, cameras), and `hires-view.js` draws the same scene again in
real 3D with three.js: at display resolution, widescreen, interpolated between the game's frames, with shadows.
Press <kbd>H</kbd> for the original picture at any time.

## How it's checked against the original

- **The translation:** the JavaScript made from your `GAME.EXE` must match a checksum of the known-good translation
  before it runs, so a different or modified program is turned away rather than run wrongly. During development
  `stunts/tools/align.js` lines the decoder up against the Restunts disassembly instruction by instruction, and
  `mapcheck.py` reports anything the map has to supply beyond your own executable.
- **The game's behaviour:** it is the game's own code, so physics and AI aren't re-created and can't drift. The replay
  that ships with the game plays back on it as recorded.
- **The HD picture:** a debug mode (`?debug`) draws the original renderer's picture half-transparent over the HD one,
  so any place the redraw disagrees with the game shows at once.
- **Play-testing:** `stunts/tools/qa.mjs` drives the real page in headless Chrome. Scripted races, menu flows, replays
  and camera changes are run and screenshotted, often rapid bursts of frames to catch one-frame glitches. Before/after
  comparisons are made against older builds checked out side by side.
- **Geometry:** `stunts/tools/gaps.py` looks at every track from many low viewpoints, finding cracks and holes where the
  sky shows through the HD models.

## Working with AI

Stunts HD was made with the help of AI coding tools (Claude Code). In practice:

- **The AI wrote and changed the code**, and did most of the investigation: reading the translated game, finding where
  a bug came from, measuring before changing anything.
- **Agents ran the headless tests**: driving races, menus and replays in headless Chrome, taking screenshots and frame
  bursts, timing frames, and comparing against older builds, so a fix was shown working rather than assumed.
- **Detailed commit messages and notes.** Each commit says what was wrong and why the fix works, and longer notes keep
  decisions and dead ends, so a new working session doesn't rediscover the same things.
- **A human did the QA and made the decisions**: playing the builds, spotting what looked or felt wrong, choosing what
  ships and what is shelved, and approving every public release.

Some experiments were tried and dropped this way. Ray-traced sun shadows and a baked time-of-day lighting mode both
worked, but cost too much frame rate in the browser and were left out.

## Problems worth knowing about

| Symptom | Cause | Fix |
| --- | --- | --- |
| More Tracks crashed with a big track pack | The game counts its file list in a signed byte: over 127 names overflowed it | Wildcard file searches return at most 127 names |
| Racing the same track again after picking another car: a black scene and giant polygons | The HD world was rebuilt only when the track's layout changed, but a car change reloads the track's shapes elsewhere in memory | The world is rebuilt at every race start |
| In the in-car view, the road under the car vanished on banked corners | The HD view copied only the polygons the game drew, and the game drops those right at its camera | The in-car view always draws whole pieces, and keeps the camera clear of the road |
| Clouds multiplied, and drifted in the in-car view | Each cloud's place was worked out undoing only the camera's pitch, not its roll, so a leaning camera put clouds in new places | The camera's whole rotation is undone, and a remembered cloud the game no longer draws is dropped |
| Touching the other car could leave yours pulling left for the rest of the race | A rounding slip in the 1990 code | Fixed in the game's code: it straightens out |
| You could see into cars through the edges of their windows | Pushing the dark grey under-body faces inward (to stop them cutting through panels) also caught the windows | Only faces low on the car are pushed |
| Tyre marks darker where they overlapped | Each overlapping mark darkened the ground again | A stencil darkens each pixel once |
| One-frame flashes when switching modes or leaving a race | Layers decided from different moments: the game's last 3D picture kept a few frames | The HUD and side fills follow the frame actually on screen |

## Where to look in the code

| Path | What it does |
| --- | --- |
| `stunts/translate.js`, `x86dec.js`, `exefile.js` | decode `GAME.EXE` and translate it to JavaScript |
| `stunts/tools/mkmap.py`, `asm2js.py` | build `map.json` from the Restunts disassembly; the same translation offline |
| `stunts/cpu.js`, `dos.js`, `drv86.js`, `worker.js` | the emulated PC; the game runs in a worker |
| `stunts/opl-worklet.js` | OPL2 FM synthesis |
| `stunts/hires-capture.js` | records, each game frame, what the original renderer would draw |
| `stunts/hires-view.js` | the HD redraw: models, shadows, interpolation, widescreen, clouds, tyre marks |
| `stunts/main.js` | puts the layers together each frame; HUD; keys |
| `stunts/qol.js`, `setup.js` | ghost car, track sharing, settings, the welcome screen |
| `stunts/tools/qa.mjs`, `gaps.py` | headless play-testing; geometry gap checking |
| `desktop/` | the desktop app (Electron) |
