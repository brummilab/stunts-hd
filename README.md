# Stunts HD

Stunts / 4D Sports Driving (DOS, 1990), running natively in the browser in HD: widescreen, smooth at any
refresh rate, sharp shadows, the original game logic underneath.

**Play:** https://stunts-recomp.pages.dev/ (bring your own copy of the game: it is read in your browser and
never uploaded) · **Trailer:** https://youtu.be/WifwNFpG96o

## Bring your own tracks and cars

Custom `.TRK` tracks in your zip appear alongside the stock ones (or drop them on the game at any time), and add-on
cars in your zip show up in the car select, packed or unpacked.

## How it works

The original DOS executable from your own copy is translated, instruction by instruction, into JavaScript in
your browser and run unmodified on a small emulated PC: DOS file and memory services, BIOS, VGA mode 13h, the
PIT timer, the keyboard controller and an AdLib (OPL2) synth. Because it is the real game code, the handling,
opponents, replays and crashes behave exactly as they did. A renderer then picks up what the game draws each
frame and paints it again with WebGL at display resolution, interpolated between the game's own frames.

| File | Role |
| --- | --- |
| `stunts/translate.js`, `x86dec.js`, `exefile.js` | decode GAME.EXE and translate it to JavaScript, with `map.json` |
| `stunts/tools/mkmap.py` | builds `map.json` (names and places only) from the Restunts disassembly |
| `stunts/tools/asm2js.py` | the same translation, offline, for development |
| `stunts/cpu.js`, `dos.js`, `drv86.js`, `worker.js` | the emulated PC; the game runs in a worker |
| `stunts/opl-worklet.js` | OPL2 FM synthesis in an AudioWorklet |
| `stunts/hires-capture.js` | records, each game frame, what the original renderer would draw |
| `stunts/hires-view.js` | redraws it in HD (three.js): shadows, interpolation, widescreen |
| `stunts/qol.js`, `setup.js` | ghosts, track sharing, settings, the welcome screen |
| `desktop/` | the same game as a desktop app (Electron) |
| `stunts/tools/` | headless test runner (`qa.mjs`), geometry gap checker (`gaps.*`), site build (`site.py`) |

## Run it yourself

Nothing of the game is in this repository. You need:

1. your own copy of Stunts 1.1 (the game's files, or a zip of them);
2. a checkout of [Restunts](https://github.com/4d-stunts/restunts) in `vendor/restunts`, to build `map.json`:
   `python3 stunts/tools/mkmap.py`;
3. then serve with the headers the game needs (SharedArrayBuffer): `python3 stunts/tools/serve.py 8766` and
   open http://localhost:8766/stunts/.

`python3 stunts/tools/site.py` builds the static site into `dist/`.

## Credits

The reverse engineering this stands on is the Restunts project's disassembly of Stunts. Stunts / 4D Sports
Driving was made by Distinctive Software and published by Broderbund / Mindscape; it is not affiliated with
this project. three.js (MIT).

## Licence

MIT for this project's own code: see LICENSE.

## Support

If you enjoy it, you can buy me a coffee: https://buymeacoffee.com/mrfinster
