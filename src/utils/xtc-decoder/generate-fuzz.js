/**
 * Make fixtures/fuzz.json: what the reader of GROMACS gets from the random frames of the fuzz tests (fuzz.js)
 *
 * Not needed to run the tests, only to make that file again, e.g. with a new version of GROMACS, or to find
 * the frame behind a failed test. It needs the source of GROMACS and a C++ compiler (g++), not GROMACS itself:
 * it compiles the functions that read xtc files, as they are in the source, into a small program (fuzz-oracle.cpp)
 * Run with: node src/utils/xtc-decoder/generate-fuzz.js <GROMACS source directory> [git revision, e.g. v2025.3]
 * It fails if the decoder does not read every frame as GROMACS does, telling the first frame that differs
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { frameBytes } = require('.');
const { splitDump } = require('./dump-bin');
const { withTemporaryDirectory } = require('./generate-fixtures');
const { makeFrames, readFrame, hashBatch } = require('./fuzz');

const FIXTURES_DIRECTORY = path.join(__dirname, 'fixtures');
const SOURCE_FILE = 'src/gromacs/fileio/libxdrf.cpp';
// Batches of frames in fixtures/fuzz.json. Their seeds are 1, 2, 3...
const BATCHES = 120;

// ----- The reader of GROMACS -----

// The text of the source from the last "start" to the first "end" after it. With "inclusive" the end is part of it
const piece = (source, start, end, inclusive) => {
    const from = source.lastIndexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`The source of GROMACS has changed: could not find\n${from < 0 ? start : end}`);
    return source.slice(from, inclusive ? to + end.length : to) + '\n';
};

// The pieces of libxdrf.cpp fuzz-oracle.cpp is made of, by the name of the file it includes
// They are copied as they are, but for "std::exit", which becomes "exit" so the oracle can catch it
const sourcePieces = source => ({
    'gromacs-table.inc': piece(source, 'static const int magicints[] = {', '};', true),
    'gromacs-functions.inc':
        piece(source, '#define FIRSTIDX', '\n', true) +
        piece(source, 'struct DataBuffer\n{', '\n};', true) +
        ['static int sizeofint(', 'static int sizeofints(', 'static int receivebits(', 'static void receiveints(']
            .map(start => piece(source, start, '\n}', true))
            .join('')
            .replace(/\bstd::exit\(/g, 'exit('),
    // The variables of xdr3dfcoord and their first values
    'gromacs-declarations.inc': piece(source, '    int          minint[3], maxint[3],', '    unsigned int uint_batchsize;', true),
    'gromacs-start.inc': piece(source, '    bitsizeint[0] = bitsizeint[1] = bitsizeint[2] = 0;', 'prevcoord[2] = 0;', true),
    // xdr3dfcoord when it reads: the sizes, the size of the small differences, and the loop over the atoms
    'gromacs-sizes.inc': piece(source, '        sizeint[0] = maxint[0] - minint[0] + 1;', '        if (xdr_int(xdrs, &smallidx) == 0)', false),
    'gromacs-small.inc': piece(source, '        smaller      = magicints[std::max(FIRSTIDX, smallidx - 1)] / 2;', 'magicints[smallidx];', true),
    'gromacs-loop.inc': piece(source, '        lfp           = fp;', '    }\n    if (we_should_free)', false),
});

// Compile the oracle in a directory. Returns its path
const buildOracle = (source, directory) => {
    for (const [name, text] of Object.entries(sourcePieces(source))) fs.writeFileSync(path.join(directory, name), text);
    const oracle = path.join(directory, 'oracle');
    // Signed ints wrap around, as in the builds of GROMACS. No warnings: the variables of the parts we do not use
    const args = ['-O2', '-fwrapv', '-w', '-I', directory, '-o', oracle, path.join(__dirname, 'fuzz-oracle.cpp')];
    const result = spawnSync('g++', args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Could not compile the oracle:\n${result.stderr}`);
    return oracle;
};

// What GROMACS reads from some frames: for each one the bytes of its coordinates, or null if it is not defined
const readWithGromacs = (oracle, frames) => {
    const input = [];
    for (const frame of frames) {
        const size = Buffer.alloc(4);
        size.writeUInt32LE(frame.length);
        input.push(size, frame);
    }
    const result = spawnSync(oracle, [], { input: Buffer.concat(input), maxBuffer: 1024 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`The oracle failed (${result.status === null ? result.signal : result.status})`);
    const output = result.stdout;
    const coordinates = [];
    for (let offset = 0; offset < output.length; ) {
        if (output[offset++] === 0) {
            coordinates.push(null);
            continue;
        }
        const bytes = output.readUInt32LE(offset) * 4;
        coordinates.push(output.subarray(offset + 4, offset + 4 + bytes));
        offset += 4 + bytes;
    }
    if (coordinates.length !== frames.length) throw new Error('The oracle did not read all the frames');
    return coordinates;
};

// ----- What the decoder must do -----

// The decoder refuses two kinds of frames GROMACS reads: these are them, not taken from the code of the decoder
// A precision GROMACS never writes, with which it reads coordinates that are infinite or not numbers
const hasUnusablePrecision = view => {
    const precision = view.getFloat32(56);
    const inverse = Math.fround(1 / precision);
    return !(precision > 0) || !(inverse > 0) || inverse === Infinity;
};
// More compressed data than fits in the buffer GROMACS reads it into (the oracle has a bigger one)
const hasTooMuchData = view => {
    const natoms = view.getInt32(4);
    const dataBytes = view.getUint32(view.getInt32(0) === 2023 ? 92 : 88);
    return dataBytes > (natoms <= 16 ? 240 : Math.floor(natoms * 3 * 1.2) * 4);
};
// What the decoder must read from a frame, given what GROMACS reads: the same, or nothing
const expectedFrom = (frame, gromacs) => {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    return gromacs === null || hasUnusablePrecision(view) || hasTooMuchData(view) ? null : gromacs;
};

const sameBytes = (one, other) => (one === null || other === null ? one === other : one.equals(other));

// Fail telling the frame the decoder does not read as expected, if any
const checkDecoder = (frames, expected, where) => {
    frames.forEach((frame, i) => {
        for (const fast of [true, false]) {
            if (sameBytes(readFrame(frame, fast), expected[i])) continue;
            const whichDecoder = fast ? 'with the fast decoder' : 'with the general decoder alone';
            const whatExpected = expected[i] ? 'GROMACS reads it, and the decoder refuses it or reads other values' : 'the decoder reads it, and it must refuse it';
            throw new Error(`${where}, frame ${i} ${whichDecoder}: ${whatExpected}\nThe frame is ${Buffer.from(frame).toString('hex')}`);
        }
    });
};

// The compressed frames of a fixture, each as its bytes
const fixtureFrames = name => {
    const bytes = fs.readFileSync(path.join(FIXTURES_DIRECTORY, `${name}.xtc`));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const frames = [];
    for (let offset = 0; offset < bytes.length; ) {
        const size = frameBytes(view, offset, bytes.length - offset);
        frames.push(bytes.subarray(offset, offset + size));
        offset += size;
    }
    return frames;
};

// ----- Main -----

const main = () => {
    const [directory, revision] = process.argv.slice(2);
    if (!directory) {
        console.error('Usage: node generate-fuzz.js <GROMACS source directory> [git revision]');
        process.exit(2);
    }
    const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const source = revision ? git('show', `${revision}:${SOURCE_FILE}`) : fs.readFileSync(path.join(directory, SOURCE_FILE), 'utf8');
    const version = revision || git('describe', '--tags', '--always').trim();
    withTemporaryDirectory(build => {
        const oracle = buildOracle(source, build);
        // First of all, the oracle must read the fixtures as GROMACS itself did
        const fixtures = require('./fixtures/fixtures.json').filter(fixture => fixture.natoms > 9);
        for (const { name } of fixtures) {
            const frames = fixtureFrames(name);
            const dumped = splitDump(fs.readFileSync(path.join(FIXTURES_DIRECTORY, `${name}.bin`))).map(dump => dump.subarray(52));
            const read = readWithGromacs(oracle, frames);
            if (read.length !== dumped.length || !read.every((coordinates, i) => sameBytes(coordinates, dumped[i])))
                throw new Error(`The oracle does not read ${name}.xtc as GROMACS did`);
        }
        console.log(`The oracle of GROMACS ${version} reads the ${fixtures.length} compressed fixtures as GROMACS did`);
        // Then the frames made at random
        const batches = [];
        let read = 0;
        for (let seed = 1; seed <= BATCHES; seed++) {
            const frames = makeFrames(seed);
            const expected = readWithGromacs(oracle, frames).map((coordinates, i) => expectedFrom(frames[i], coordinates));
            checkDecoder(frames, expected, `Batch ${seed}`);
            read += expected.filter(Boolean).length;
            batches.push({ seed, read: expected.filter(Boolean).length, hash: hashBatch(expected) });
        }
        const frames = BATCHES * makeFrames(1).length;
        console.log(`The decoder reads ${read} of ${frames} frames made at random as GROMACS ${version}, and refuses the rest`);
        const lines = batches.map(batch => `  ${JSON.stringify(batch)}`).join(',\n');
        fs.writeFileSync(path.join(FIXTURES_DIRECTORY, 'fuzz.json'), `{\n "gromacs": ${JSON.stringify(version)},\n "batches": [\n${lines}\n ]\n}\n`);
    });
};

if (require.main === module) main();
