# xtc decoder

`index.js` reads GROMACS `.xtc` trajectories without running GROMACS. It is a port of the GROMACS reader
(`libxdrf.cpp` and `xtcio.cpp`) and it must give the same float32 values GROMACS gives, bit for bit.

This file explains how the tests keep the decoder and the GROMACS reader from drifting apart.

There are two kinds of drift, and they are covered in different ways:

- **The decoder changes**: someone edits it and breaks it. Caught by `npm test`.
- **GROMACS changes**: a new version reads xtc files in another way. Only caught when someone runs
  the tools below by hand.

The decoder is stricter than GROMACS on purpose. It refuses files with which GROMACS reads out of its own memory
or reads values of no use (precision 0, numbers of atoms that do not match). So the guarantee is
"the same values or an error", never "other values".

## Drift in the decoder: caught by `npm test`

These tests need no GROMACS: the expected values were made with GROMACS and are in `fixtures/`.

| Test | Where the expected values come from | What it protects |
|---|---|---|
| Fixtures: 56 xtc files, 349 frames (`index.test.js`) | A GROMACS binary reading files GROMACS wrote, kept in the `.bin` files | The usual path: number of atoms, step, time, box and every coordinate. Run in three ways: with the fast decoder, with the general decoder alone, and with a read buffer of 64 bytes |
| Fuzz: 60,000 frames made at random (`fuzz.test.js`) | The functions of the reader, copied from the GROMACS source and compiled. Kept as a hash per 500 frames in `fuzz.json` | What real files never reach: every packed size from 1 to 72 bits, every entry of the table of sizes, the limits of the fast decoder (48 and 53 bits) |
| Truncated files: 3 files cut at every byte (`index.test.js`) | What `gmx trjconv` did with every cut, in `bad-input.json` | The same whole frames and the same warning of an incomplete frame as GROMACS |
| Damaged files: 1,980 copies with every byte changed in 3 ways, and 29 edits of the headers (`index.test.js`) | What `gmx trjconv` did with every one, in `bad-input.json` | The decoder never reads other values than GROMACS: 1,570 copies read the same, and where GROMACS gives an error or crashes the decoder fails too |
| Limits of a frame (`index.test.js`) | Headers made by hand | The checks of sizes, one byte or one atom at each side of every limit |
| Reader (`../read-and-parse-trajectory/index.test.js`) | The same 56 fixtures, times 10 as float32 | The values on their way to the database: the worker thread, the chunks and the change from nm to Å |

### How strong they are

89 bugs of one line were put in the decoder on purpose, one at a time (November 2026):

- 71 make the tests fail.
- 16 change nothing in what the decoder reads.
- 1 only shows at the millionth frame of a file.
- 1 needs a frame over 4 GiB.

The fuzz test is the only one that catches 19 of the 71. Those are the ones that would give other coordinates
with no error: a missing `| 0` or `Math.fround`, an entry of the table of sizes changed by one,
a limit of the fast decoder.

## Drift in GROMACS: checked by hand

No test in `npm test` runs GROMACS, so a GROMACS that read xtc files in another way would not make them fail.
These tools tell:

| Tool | What it does | Last results |
|---|---|---|
| `node generate-fuzz.js <GROMACS source directory> [git revision]` | Makes `fuzz.json` again from the reader of that version (needs `g++`, not GROMACS). If the file changes, the reader changed | The same file from v2024.5, v2025.3, v2025.4, v2026.0, v2026.2 and the main branch of November 2026. Sources up to v2024.0 have another layout and the script stops |
| `node generate-fixtures.js <gmx>` | Makes every fixture again with any GROMACS in single precision. git shows what changed | 2026.3 and 2025.4 give every `.xtc` and `.bin` as it is here |
| `XTC_TEST_GMX=<gmx> npx jest src/utils/xtc-decoder` | Systems made at random, written and read by that GROMACS and compared at once. `XTC_TEST_SYSTEMS` is how many (200 by default) | 500 systems with 2026.3 and 200 with 2025.4, identical |
| `node check-parity.js <gmx> <trajectory.xtc>...` | Whole real trajectories, frame by frame. It writes nothing next to them | 166 trajectories, 20,529 frames, identical with 2026.3 |

GROMACS reads the files through `gmx trjconv -f file.xtc -o file.trr`: a trr has the values as GROMACS read them,
not compressed (see `dump-bin.js`).

`bad-input.json` is not the same from one run of `generate-fixtures.js` to the next. With some damaged files GROMACS
reads or writes memory that is not its own, and then it crashes or not. The tests do not depend on those rows.

## What is not covered

- The loader has no continuous integration: the tests run when someone runs them.
- A new version of GROMACS is only checked when someone runs the tools above with it.
- No real trajectory over 365,534 atoms was compared. Bigger systems are only in the fixtures and the fuzz frames.
- All the results above are from one laptop with Node 26. Nothing was run on a cluster.
- Nothing checks what is uploaded. A wrong value in production would not be noticed.
