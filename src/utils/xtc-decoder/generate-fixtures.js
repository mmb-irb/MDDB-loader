/**
 * Generate the fixtures of the xtc decoder tests: small xtc files written by GROMACS, what GROMACS reads
 * from them, and what GROMACS does with truncated and damaged copies of some of them
 *
 * Not needed to run the tests, only to make the fixtures again. It needs two GROMACS:
 * - any installed GROMACS, to write the xtc files (trjconv, grompp and mdrun)
 * - one with "gmx dump -bin" (the gromacs_mddb package), to read them. If it is installed, it can do both
 * Run with: node src/utils/xtc-decoder/generate-fixtures.js <gmx> [gmx with dump -bin]
 * The same input gives the same fixtures, so git shows what changed
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { frameBytes } = require('.');
const { dumpFrameBytes, runDump } = require('./dump-bin');

const FIXTURES_DIRECTORY = path.join(__dirname, 'fixtures');

// ----- Systems to write -----

// Random numbers from 0 to 1 that are the same every time (mulberry32)
const random = seed => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (rng, options) => options[Math.floor(rng() * options.length)];
const between = (rng, low, high) => low + rng() * (high - low);

// Atoms anywhere between "low" and "high", which are numbers or one number per dimension
const scattered = (rng, natoms, low, high) => {
    const lows = [].concat(low, low, low);
    const highs = [].concat(high, high, high);
    return Array.from({ length: natoms }, () => [0, 1, 2].map(d => between(rng, lows[d], highs[d])));
};

// Molecules of 3 atoms within "bond" of each other, like water: every molecule is a run of small differences
const waters = (rng, natoms, low, high, bond = 0.1) => {
    const atoms = [];
    let center;
    for (let i = 0; i < natoms; i++) {
        if (i % 3 === 0) center = scattered(rng, 1, low, high)[0];
        atoms.push(center.map(value => value + between(rng, -bond, bond)));
    }
    return atoms;
};

// A chain of atoms, every one up to "step" from the atom before in every dimension: long runs
const chain = (rng, natoms, start, step) => {
    const atoms = [];
    let last = start;
    for (let i = 0; i < natoms; i++) {
        last = last.map(value => value + between(rng, -step, step));
        atoms.push(last);
    }
    return atoms;
};

// Two places "step" apart, with atoms going from one to the other all the time
const zigzag = (rng, natoms, step, noise = 0.001) =>
    Array.from({ length: natoms }, (unused, i) => [0, 1, 2].map(() => 1 + (i % 2) * step + rng() * noise));

// Pieces of all of the above, of different sizes: the run length and the size of the small differences go up and down
const mixed = (rng, natoms, size = 6) => {
    let atoms = [];
    while (atoms.length < natoms) {
        const count = Math.min(natoms - atoms.length, 1 + Math.floor(rng() * 40));
        const kind = Math.floor(rng() * 4);
        if (kind === 0) atoms = atoms.concat(scattered(rng, count, 0, size));
        else if (kind === 1) atoms = atoms.concat(waters(rng, count, 0, size, pick(rng, [0.02, 0.1, 0.3])));
        else if (kind === 2) {
            const start = scattered(rng, 1, 0, size)[0];
            atoms = atoms.concat(chain(rng, count, start, pick(rng, [0.003, 0.01, 0.05, 0.2, 1])));
        } else atoms = atoms.concat(Array(count).fill(scattered(rng, 1, 0, size)[0]));
    }
    return atoms;
};

const scale = (atoms, factor) => atoms.map(atom => atom.map(value => value * factor));

// Boxes as GROMACS writes them in a .gro file: v1(x) v2(y) v3(z) v1(y) v1(z) v2(x) v2(z) v3(x) v3(y)
const RECTANGULAR_BOX = [5, 6, 7, 0, 0, 0, 0, 0, 0];
const TRICLINIC_BOX = [5, 6, 7, 0, 0, 1, 0, 2, 3];

// Frames with the atoms "makeAtoms" gives for every frame, 2 ps and 1000 steps apart
const makeFrames = (count, makeAtoms, box = RECTANGULAR_BOX) =>
    Array.from({ length: count }, (unused, i) => ({ time: i * 2, step: i * 1000, box, atoms: makeAtoms(i) }));

// The systems of the fixtures. Every one tells what it is there for
// With "ndec" it is written by "gmx trjconv -ndec", so its precision is 10^ndec
// With "precision" it is written by a short "gmx mdrun", the only way to get other precisions: its atoms move a bit every step
const systems = () => {
    const list = [];
    const add = (name, covers, system) => list.push({ name, covers, ndec: 3, ...system });
    let seed = 1000;
    const rng = () => random(seed++);

    // Number of atoms
    for (const natoms of [1, 9])
        add(`atoms-${natoms}`, `${natoms} atom${natoms > 1 ? 's' : ''}: 9 atoms or less are not compressed`, {
            frames: makeFrames(3, () => scattered(rng(), natoms, -3, 3)),
        });
    add('atoms-10', '10 atoms: the smallest compressed frame', {
        frames: makeFrames(3, () => mixed(rng(), 10)),
    });
    for (const natoms of [16, 17])
        add(`atoms-${natoms}`, `${natoms} atoms: GROMACS has a fixed buffer for up to 16 atoms`, {
            frames: makeFrames(2, () => scattered(rng(), natoms, -3, 3)),
        });

    // Precision
    for (let ndec = 0; ndec <= 8; ndec++)
        add(`ndec-${ndec}`, `precision 10^${ndec}`, {
            ndec,
            decimals: Math.max(6, ndec + 1),
            // The same integers for every precision, more or less
            frames: makeFrames(2, () => scale(mixed(rng(), 60), 10 ** (3 - ndec))),
        });
    // mdrun only writes precisions that are whole numbers
    for (const precision of [3, 500, 1234, 100007])
        add(`precision-${precision}`, `precision ${precision}, which is not a power of 10`, {
            precision,
            frames: makeFrames(1, () => mixed(rng(), 40, 4), TRICLINIC_BOX),
        });

    // Sign and size of the coordinates
    add('negative', 'negative coordinates only', { frames: makeFrames(2, () => scale(mixed(rng(), 60), -1)) });
    add('far-from-origin', 'coordinates over 1000 nm', {
        frames: makeFrames(2, () => mixed(rng(), 60).map(atom => atom.map(value => value + 1000))),
    });
    add('very-far-from-origin', 'integers over 2^24, which a float32 cannot hold exactly', {
        frames: makeFrames(2, () => mixed(rng(), 60).map(atom => atom.map(value => value + 30000))),
    });
    add('wide', 'a range over 2^24 in every dimension: the 3 integers of an atom are stored one by one, 25 bits each', {
        frames: makeFrames(2, () => scattered(rng(), 40, -9000, 9000)),
    });
    add('wide-waters', 'the same with water molecules, so there are runs too', {
        frames: makeFrames(2, () => waters(rng(), 60, -9000, 9000)),
    });
    add('wide-x', 'a range over 2^24 in x only: integers stored one by one with 25, 13 and 1 bits', {
        frames: makeFrames(2, () => scattered(rng(), 40, [-9000, 0, 2], [9000, 6, 2])),
    });
    add('range-30-bits', 'the widest range GROMACS reads well, 30 bits', {
        ndec: 6,
        frames: makeFrames(2, () => scattered(rng(), 30, [-400, -400, -3], [400, 400, 3])),
    });
    add('range-32-bits', 'a range of 2^30 or more takes 32 bits, which GROMACS reads as 0: all atoms get the minimum x and y', {
        ndec: 6,
        frames: makeFrames(2, () => scattered(rng(), 30, [-600, -600, -3], [600, 600, 3])),
    });

    // Shape of the system, which decides how it is compressed
    add('waters', 'water molecules: runs of 2 atoms with the first two atoms interchanged', {
        frames: makeFrames(3, () => waters(rng(), 300, 0, 3)),
    });
    add('chain', 'a chain: runs of 8 atoms, the longest', {
        frames: makeFrames(2, () => chain(rng(), 200, [3, 3, 3], 0.02)),
    });
    add('mixed', 'a bit of everything: the run length and the size of the small differences go up and down', {
        frames: makeFrames(3, () => mixed(rng(), 400)),
    });
    add('same-point', 'all atoms at the same point: sizes of 1 and the smallest small differences', {
        frames: makeFrames(2, () => Array(30).fill([1.234, 2.345, 3.456])),
    });
    add('plane', 'all atoms in a plane: a size of 1', {
        frames: makeFrames(2, () => mixed(rng(), 60).map(atom => [atom[0], atom[1], 2.5])),
    });
    add('line', 'all atoms in a line: two sizes of 1', {
        frames: makeFrames(2, () => mixed(rng(), 60).map(atom => [atom[0], 1.5, 2.5])),
    });
    add('zigzag', 'consecutive atoms 1.5 nm apart with precision 10^6: small differences and atoms of more than 48 bits', {
        ndec: 6,
        frames: makeFrames(2, () => zigzag(rng(), 30, 1.5)),
    });
    add('sparse', 'consecutive atoms 10 nm apart with precision 10^6: smallidx is 73, after the end of the table, and atoms have 72 bits', {
        ndec: 6,
        frames: makeFrames(2, () => zigzag(rng(), 30, 10)),
    });
    add('sparse-wide', 'the same 30 nm apart: smallidx 73 and integers stored one by one', {
        ndec: 6,
        frames: makeFrames(2, () => zigzag(rng(), 30, 30)),
    });

    // Frames
    add('single-frame', 'only one frame', { frames: makeFrames(1, () => mixed(rng(), 100)) });
    const still = mixed(rng(), 100);
    add('identical-frames', '4 frames with the same coordinates', { frames: makeFrames(4, () => still) });
    const moving = rng();
    let positions = waters(moving, 12, 0, 3);
    add('many-frames', '200 frames of 12 atoms that move a bit, with a box that grows', {
        frames: Array.from({ length: 200 }, (unused, i) => {
            positions = positions.map(atom => atom.map(value => value + between(moving, -0.01, 0.01)));
            return { time: i * 0.5, step: i * 250, box: [5 + i * 0.01, 6, 7, 0, 0, 0, 0, 0, 0], atoms: positions };
        }),
    });
    const boxes = [
        [3, 3, 3, 0, 0, 0, 0, 0, 0],
        RECTANGULAR_BOX,
        TRICLINIC_BOX,
        [4.5, 4.5, 3.18198, 0, 0, 0, 0, 2.25, 2.25],
        [123456.7, 234567.8, 345678.9, 0, 0, 0, 0, 0, 0],
        [1000000, 2000000, 3000000, 0, 0, 500000, 0, 600000, 700000],
        [0.001, 0.002, 0.003, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
    ];
    add('boxes', 'cubic, rectangular, triclinic, huge, tiny and no box', {
        frames: boxes.map((box, i) => ({ time: i, step: i, box, atoms: mixed(rng(), 20) })),
    });
    const times = [
        [0, 0],
        [0.1, 1],
        [0.30000001, 2],
        [123456.789, 2147483647],
        [-5, -1],
        [1e9, -2147483648],
        [1e-9, 123456789],
    ];
    add('steps-and-times', 'steps up to the limits of an int32 and times a float32 cannot hold exactly', {
        frames: times.map(([time, step]) => ({ time, step, box: RECTANGULAR_BOX, atoms: mixed(rng(), 20) })),
    });
    add('waters-3000', '3000 atoms: bigger frames, to read the file in several pieces', {
        frames: makeFrames(3, () => waters(rng(), 3000, 0, 5)),
    });

    // Systems made at random
    for (let i = 1; i <= 12; i++) add(`random-${i}`, 'a system made at random', randomSystem(i));
    return list;
};

// A system made at random from a seed: any number of atoms, precision, size and shape
const randomSystem = seed => {
    const rng = random(seed * 7919);
    const natoms = Math.floor(pick(rng, [() => between(rng, 1, 10), () => between(rng, 10, 20), () => between(rng, 20, 300), () => between(rng, 300, 2000)])());
    const ndec = pick(rng, [0, 1, 2, 3, 3, 3, 4, 5, 6, 7]);
    // Coordinates times the precision must fit in an int32
    const limit = 2e9 / 10 ** ndec;
    const size = Math.min(limit / 2, pick(rng, [0.01, 1, 5, 20, 100, 2000, 50000, 1000000]));
    const center = [0, 1, 2].map(() => between(rng, -1, 1) * Math.min(limit / 2 - size / 2, pick(rng, [0, 5, 1000])));
    const makeAtoms = () => {
        const kind = Math.floor(rng() * 6);
        const atoms =
            kind === 0
                ? scattered(rng, natoms, -size / 2, size / 2)
                : kind === 1
                ? waters(rng, natoms, -size / 2, size / 2, pick(rng, [0.001, 0.1, 1]) * Math.min(1, size))
                : kind === 2
                ? chain(rng, natoms, [0, 0, 0], (size / Math.sqrt(natoms + 1)) * pick(rng, [0.001, 0.01, 0.1]))
                : kind === 3
                ? scale(zigzag(rng, natoms, pick(rng, [0.5, 1, 4]), 0.001), size / 8)
                : kind === 4
                ? scattered(rng, natoms, [-size / 2, 0, 0], [size / 2, pick(rng, [0, size / 1000]), 0])
                : scale(mixed(rng, natoms), size / 60);
        return atoms.map(atom => atom.map((value, d) => value + center[d]));
    };
    const box = pick(rng, [RECTANGULAR_BOX, TRICLINIC_BOX]);
    const still = rng() < 0.2 && makeAtoms();
    return {
        ndec,
        decimals: Math.max(6, ndec + 1),
        frames: Array.from({ length: 1 + Math.floor(rng() * 4) }, (unused, i) => ({
            time: i * 10,
            step: i * 5000,
            box,
            atoms: still || makeAtoms(),
        })),
    };
};

// ----- Writing them with GROMACS -----

// The text of a .gro file with several frames. GROMACS takes the number of decimals from the columns of the first atom
const groText = (frames, decimals = 6) => {
    const width = decimals + 10;
    const lines = [];
    for (const { time, step, box, atoms } of frames) {
        lines.push(`fixture t= ${time} step= ${step}`, String(atoms.length));
        atoms.forEach((atom, i) => {
            const number = String((i % 99999) + 1).padStart(5);
            lines.push(`${number}RES      A${number}${atom.map(value => value.toFixed(decimals).padStart(width)).join('')}`);
        });
        lines.push(box.join(' '));
    }
    return lines.join('\n') + '\n';
};

// Run GROMACS in a directory and fail if it does
const run = (gmx, args, cwd) => {
    const result = spawnSync(gmx, args, { cwd, env: { ...process.env, GMX_MAXBACKUP: '-1' }, maxBuffer: 1024 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`"${gmx} ${args.join(' ')}" failed:\n${result.stderr.toString().slice(-2000)}`);
};

// A topology of atoms that do not see each other, and the parameters of a run of 4 steps writing every step
const TOPOLOGY = natoms => `[ defaults ]
1 1 no 1.0 1.0
[ atomtypes ]
X 1.0 0.0 A 0.0 0.0
[ moleculetype ]
X 0
[ atoms ]
1 X 1 RES A 1 0.0 1.0
[ system ]
fixture
[ molecules ]
X ${natoms}
`;
const PARAMETERS = precision => `integrator = md
dt = 0.002
nsteps = 4
cutoff-scheme = Verlet
coulombtype = cut-off
rcoulomb = 0.9
rvdw = 0.9
nstxout-compressed = 1
compressed-x-precision = ${precision}
gen_vel = yes
gen_temp = 300
gen_seed = 7
`;

// Write a system as an xtc file with GROMACS, in "directory". Returns the path of the xtc file
const writeXtc = (gmx, system, directory) => {
    const { frames, decimals, ndec, precision } = system;
    fs.writeFileSync(path.join(directory, 'system.gro'), groText(frames, decimals));
    if (precision === undefined) {
        run(gmx, ['trjconv', '-f', 'system.gro', '-o', 'system.xtc', '-ndec', String(ndec)], directory);
        return path.join(directory, 'system.xtc');
    }
    fs.writeFileSync(path.join(directory, 'topol.top'), TOPOLOGY(frames[0].atoms.length));
    fs.writeFileSync(path.join(directory, 'grompp.mdp'), PARAMETERS(precision));
    run(gmx, ['grompp', '-c', 'system.gro', '-maxwarn', '10'], directory);
    run(gmx, ['mdrun', '-nt', '1', '-x', 'system.xtc'], directory);
    return path.join(directory, 'system.xtc');
};

// Run a function with a new temporary directory, which is deleted at the end
const withTemporaryDirectory = action => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xtc-fixtures-'));
    try {
        return action(directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
};

// ----- Truncated and damaged files -----

const hash = bytes =>
    crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex')
        .slice(0, 16);

// What GROMACS does with some bytes as an xtc file: [exit code or signal, whole frames dumped, if it warned
// of an incomplete frame, hash of its dump]
const gromacsOutcome = (gmxDump, bytes, directory) => {
    const filepath = path.join(directory, 'damaged.xtc');
    fs.writeFileSync(filepath, bytes);
    const { dump, code, incomplete } = runDump(gmxDump, filepath);
    const natoms = dump.length >= 4 ? dump.readInt32LE(0) : -1;
    const frames = natoms >= 0 ? Math.floor(dump.length / dumpFrameBytes(natoms)) : 0;
    return [code, frames, incomplete, hash(dump)];
};

// Offsets where the frames of an xtc file start
const frameOffsets = bytes => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const offsets = [];
    for (let offset = 0; offset < bytes.length; offset += frameBytes(view, offset, bytes.length - offset)) offsets.push(offset);
    return offsets;
};

// Fields of a frame to edit: [name, offset in the frame]
const FIELDS = {
    magic: 0,
    natoms: 4,
    natomsAgain: 52,
    precision: 56,
    minX: 60,
    minY: 64,
    minZ: 68,
    maxX: 72,
    maxY: 76,
    maxZ: 80,
    smallidx: 84,
    dataBytes: 88,
};
// Edits of the header of a frame that reach the checks the damaged bytes above may miss
// Every edit is [frame, field, new value], where the value may be relative to another field of the frame
const EDITS = [
    ['smallidx 8, below the first size of the table', [[1, 'smallidx', 8]]],
    ['smallidx 0', [[1, 'smallidx', 0]]],
    ['smallidx 73 with runs in the frame', [[1, 'smallidx', 73]]],
    ['smallidx 74, after the end of the table', [[1, 'smallidx', 74]]],
    ['smallidx -1', [[1, 'smallidx', -1]]],
    ['size of x is 0', [[1, 'maxX', { field: 'minX', plus: -1 }]]],
    ['size of y is 0', [[1, 'maxY', { field: 'minY', plus: -1 }]]],
    ['size of z is 0', [[1, 'maxZ', { field: 'minZ', plus: -1 }]]],
    ['size of x is negative', [[1, 'maxX', { field: 'minX', plus: -1000 }]]],
    ['size of x takes 32 bits', [[1, 'maxX', { field: 'minX', plus: 1500000000 }]]],
    ['no compressed data', [[1, 'dataBytes', 0]]],
    ['negative size of the compressed data', [[1, 'dataBytes', -1]]],
    ['compressed data one byte shorter', [[1, 'dataBytes', { field: 'dataBytes', plus: -1 }]]],
    ['compressed data 4 bytes shorter', [[1, 'dataBytes', { field: 'dataBytes', plus: -4 }]]],
    ['compressed data 4 bytes longer', [[1, 'dataBytes', { field: 'dataBytes', plus: 4 }]]],
    ['compressed data 8 bytes longer in the last frame', [[2, 'dataBytes', { field: 'dataBytes', plus: 8 }]]],
    ['precision 0', [[1, 'precision', 0]]],
    ['negative precision', [[1, 'precision', { float: -1000 }]]],
    ['infinite precision', [[1, 'precision', { float: Infinity }]]],
    ['one atom less in the header of a frame', [[1, 'natoms', 29]]],
    ['one atom less in a frame', [[1, 'natoms', 29], [1, 'natomsAgain', 29]]],
    ['one atom more in a frame', [[1, 'natoms', 31], [1, 'natomsAgain', 31]]],
    ['one atom more in the first frame', [[0, 'natoms', 31], [0, 'natomsAgain', 31]]],
    ['9 atoms in a frame, which would not be compressed', [[1, 'natoms', 9], [1, 'natomsAgain', 9]]],
    ['no atoms in the first frame', [[0, 'natoms', 0], [0, 'natomsAgain', 0]]],
    ['negative number of atoms in the first frame', [[0, 'natoms', -30], [0, 'natomsAgain', -30]]],
    ['300 million atoms with magic number 1995', [[0, 'natoms', 300000000], [0, 'natomsAgain', 300000000]]],
    ['magic number 2023 in a frame of the 1995 format', [[1, 'magic', 2023]]],
    ['magic number 1996', [[1, 'magic', 1996]]],
];

// Apply edits to a copy of an xtc file. Returns the copy and the bytes changed as [offset, hexadecimal bytes]
const applyEdits = (bytes, edits) => {
    const copy = Buffer.from(bytes);
    const offsets = frameOffsets(bytes);
    const changes = edits.map(([frame, field, value]) => {
        const offset = offsets[frame] + FIELDS[field];
        if (typeof value === 'number') copy.writeInt32BE(value, offset);
        else if (value.float !== undefined) copy.writeFloatBE(value.float, offset);
        else copy.writeInt32BE(bytes.readInt32BE(offsets[frame] + FIELDS[value.field]) + value.plus, offset);
        return [offset, copy.subarray(offset, offset + 4).toString('hex')];
    });
    return { copy, changes };
};

// The same frames with magic number 2023: the size of the compressed data becomes an int64
// GROMACS only writes this format over 298 million atoms, but it reads it with any number of atoms
const toMagic2023 = bytes => {
    const pieces = [];
    const offsets = frameOffsets(bytes);
    offsets.forEach((offset, i) => {
        const frame = Buffer.from(bytes.subarray(offset, i + 1 < offsets.length ? offsets[i + 1] : bytes.length));
        frame.writeInt32BE(2023, 0);
        pieces.push(frame.subarray(0, FIELDS.dataBytes), Buffer.alloc(4), frame.subarray(FIELDS.dataBytes));
    });
    return Buffer.concat(pieces);
};

// ----- Main -----

const main = () => {
    const [gmx, gmxDump = gmx] = process.argv.slice(2);
    if (!gmx) {
        console.error('Usage: node generate-fixtures.js <gmx> [gmx with dump -bin]');
        process.exit(2);
    }
    // Start from no fixtures, so the ones that are not made any more go away. fuzz.json is made by generate-fuzz.js
    fs.mkdirSync(FIXTURES_DIRECTORY, { recursive: true });
    for (const name of fs.readdirSync(FIXTURES_DIRECTORY))
        if (/\.(xtc|bin|json)$/.test(name) && name !== 'fuzz.json') fs.unlinkSync(path.join(FIXTURES_DIRECTORY, name));
    const fixture = name => path.join(FIXTURES_DIRECTORY, name);
    // Keep an xtc file with what GROMACS reads from it
    const keep = (name, covers, xtc, expectedFrames) => {
        fs.writeFileSync(fixture(`${name}.xtc`), xtc);
        const { dump, code, incomplete } = runDump(gmxDump, fixture(`${name}.xtc`));
        if (code !== 0 || incomplete) throw new Error(`GROMACS could not read ${name}.xtc`);
        fs.writeFileSync(fixture(`${name}.bin`), dump);
        const natoms = dump.readInt32LE(0);
        const frames = dump.length / dumpFrameBytes(natoms);
        if (expectedFrames !== undefined && frames !== expectedFrames)
            throw new Error(`${name}.xtc has ${frames} frames instead of ${expectedFrames}`);
        console.log(`${name}: ${natoms} atoms, ${frames} frames, ${xtc.length} bytes`);
        return { name, covers, natoms, frames };
    };
    withTemporaryDirectory(directory => {
        const manifest = [];
        for (const system of systems()) {
            const xtc = fs.readFileSync(writeXtc(gmx, system, directory));
            // A run of 4 steps writes 5 frames
            const frames = system.precision === undefined ? system.frames.length : 5;
            manifest.push(keep(system.name, system.covers, xtc, frames));
        }
        // The 2023 format, from a file GROMACS wrote. GROMACS must read the same frames from both
        const waters = fs.readFileSync(fixture('waters.xtc'));
        manifest.push(keep('magic-2023', 'magic number 2023, with the size of the compressed data as an int64', toMagic2023(waters)));
        if (!fs.readFileSync(fixture('magic-2023.bin')).equals(fs.readFileSync(fixture('waters.bin'))))
            throw new Error('GROMACS reads different frames with magic number 2023');
        fs.writeFileSync(fixture('fixtures.json'), JSON.stringify(manifest, null, 1) + '\n');

        // Small files for the truncated and damaged copies: 3 frames of 30 atoms, of 9 atoms, and of 30 atoms with magic number 2023
        const small = { ndec: 3, frames: makeFrames(3, i => waters30(i)) };
        const smallXtc = fs.readFileSync(writeXtc(gmx, small, directory));
        keep('bad-input-waters', 'the file that is truncated and damaged', smallXtc, 3);
        const sources = {
            'bad-input-waters': smallXtc,
            'atoms-9': fs.readFileSync(fixture('atoms-9.xtc')),
            'bad-input-magic-2023': toMagic2023(smallXtc),
        };
        keep('bad-input-magic-2023', 'the same with magic number 2023', sources['bad-input-magic-2023'], 3);
        const badInput = { truncated: {}, damaged: {}, edited: [] };
        // Every file cut at every byte
        for (const [name, bytes] of Object.entries(sources)) {
            console.log(`Truncating ${name} at every one of its ${bytes.length} bytes`);
            badInput.truncated[name] = [];
            for (let size = 0; size < bytes.length; size++)
                badInput.truncated[name].push(gromacsOutcome(gmxDump, bytes.subarray(0, size), directory));
        }
        // Every byte of the first file changed in 3 ways: its lowest bit, its highest bit and all of its bits
        console.log(`Damaging every byte of bad-input-waters`);
        for (let offset = 0; offset < smallXtc.length; offset++) {
            for (const flip of [0x01, 0x80, 0xff]) {
                const copy = Buffer.from(smallXtc);
                copy[offset] ^= flip;
                badInput.damaged[`${offset}^${flip}`] = gromacsOutcome(gmxDump, copy, directory);
            }
        }
        // And its headers edited
        for (const [what, edits] of EDITS) {
            const { copy, changes } = applyEdits(smallXtc, edits);
            badInput.edited.push({ what, changes, gromacs: gromacsOutcome(gmxDump, copy, directory) });
        }
        // One line per case, to keep the file small and its changes readable
        const lines = object => '{\n' + Object.entries(object).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n') + '\n }';
        fs.writeFileSync(
            fixture('bad-input.json'),
            `{\n "truncated": ${lines(badInput.truncated)},\n "damaged": ${lines(badInput.damaged)},\n "edited": [\n` +
                badInput.edited.map(edit => `  ${JSON.stringify(edit)}`).join(',\n') +
                '\n ]\n}\n',
        );
    });
};

// 30 atoms in molecules of 3: the small file of the truncated and damaged copies
const waters30 = frame => waters(random(500 + frame), 30, 0, 3);

if (require.main === module) main();

module.exports = { random, randomSystem, writeXtc, withTemporaryDirectory };
