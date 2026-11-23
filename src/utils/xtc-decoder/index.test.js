// Tests of the xtc decoder against GROMACS itself
// The fixtures are xtc files written by GROMACS with what GROMACS reads from them (the .bin files, see dump-bin.js),
// so these tests need no GROMACS. See generate-fixtures.js, which makes them
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readXtcFrames, frameBytes, XtcError } = require('.');
const { dumpFrame, splitDump, describeDifference, runDump } = require('./dump-bin');
const { randomSystem, writeXtc, withTemporaryDirectory } = require('./generate-fixtures');

const fixtures = require('./fixtures/fixtures.json');
const badInput = require('./fixtures/bad-input.json');
const fixture = name => path.join(__dirname, 'fixtures', name);

// Read an xtc file with the decoder
// Returns its frames as GROMACS would dump them, and how it ended: incomplete or not, or with an error
// "fast" is the number of frames the fast decoder decoded
const read = (filepath, options) => {
    const dumps = [];
    const frames = readXtcFrames(filepath, options);
    let fast = 0;
    let next;
    try {
        while (!(next = frames.next()).done) {
            dumps.push(dumpFrame(next.value));
            if (next.value.fast) fast++;
        }
    } catch (error) {
        return { dumps, error, fast };
    }
    return { dumps, incomplete: next.value.incomplete, count: next.value.frames, fast };
};

// The same for some bytes, through a temporary file
let temporaryDirectory;
beforeAll(() => (temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xtc-decoder-test-'))));
afterAll(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
const readBytes = (bytes, options) => {
    const filepath = path.join(temporaryDirectory, 'test.xtc');
    fs.writeFileSync(filepath, bytes);
    return read(filepath, options);
};

// Expect some frames to be the ones GROMACS dumped, bit by bit, telling the first value that is not
const expectSameFrames = (dumps, expected) => {
    expect(dumps.length).toBe(expected.length);
    const differences = dumps.map((dump, i) => `frame ${i}: ${describeDifference(dump, expected[i])}`);
    expect(differences.filter(difference => !difference.endsWith('no difference'))).toEqual([]);
};

// Hash of a dump, as in bad-input.json
const hash = bytes =>
    crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex')
        .slice(0, 16);

// Offsets where every frame of an xtc file ends
const frameEnds = bytes => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const ends = [];
    for (let offset = 0; offset < bytes.length; ) {
        offset += frameBytes(view, offset, bytes.length - offset);
        ends.push(offset);
    }
    return ends;
};

describe('xtc decoder', () => {
    describe.each(fixtures)('$name ($covers)', ({ name, natoms, frames }) => {
        const expected = splitDump(fs.readFileSync(fixture(`${name}.bin`)));

        it('reads the same frames as GROMACS', () => {
            const { dumps, incomplete, count, error } = read(fixture(`${name}.xtc`));
            expect(error).toBeUndefined();
            expectSameFrames(dumps, expected);
            expect(incomplete).toBe(false);
            expect(count).toBe(frames);
            expect(dumps[0].readInt32LE(0)).toBe(natoms);
        });

        it('reads the same frames with the general decoder alone', () => {
            // By default the fast decoder takes the usual frames, so the general one would not see them
            const { dumps, incomplete, error, fast } = read(fixture(`${name}.xtc`), { fast: false });
            expect(error).toBeUndefined();
            expectSameFrames(dumps, expected);
            expect(incomplete).toBe(false);
            expect(fast).toBe(0);
        });

        it('reads the same frames a few bytes at a time', () => {
            // Frames do not fit in the buffer, so it has to grow and to be filled many times
            const { dumps, incomplete, error } = read(fixture(`${name}.xtc`), { bufferBytes: 64 });
            expect(error).toBeUndefined();
            expectSameFrames(dumps, expected);
            expect(incomplete).toBe(false);
        });
    });

    // Make sure the fixtures still are what their names say
    describe('fixtures', () => {
        const header = name => {
            const bytes = fs.readFileSync(fixture(`${name}.xtc`));
            const int = offset => bytes.readInt32BE(offset);
            return {
                magic: int(0),
                precision: bytes.readFloatBE(56),
                sizes: [int(72) - int(60) + 1, int(76) - int(64) + 1, int(80) - int(68) + 1],
                smallidx: int(84),
            };
        };
        const frames = name => Array.from(readXtcFrames(fixture(`${name}.xtc`)));

        it('have every precision', () => {
            for (let ndec = 0; ndec <= 8; ndec++) expect(header(`ndec-${ndec}`).precision).toBe(10 ** ndec);
            for (const precision of [3, 500, 1234, 100007])
                expect(header(`precision-${precision}`).precision).toBe(precision);
        });

        it('have no precision when coordinates are not compressed', () => {
            expect(frames('atoms-9').map(frame => frame.precision)).toEqual([-1, -1, -1]);
            expect(frames('atoms-10').map(frame => frame.precision)).toEqual([1000, 1000, 1000]);
        });

        it('have sizes that fit together in a number, and sizes that do not', () => {
            const tooBig = size => size > 0xffffff;
            expect(header('waters').sizes.some(tooBig)).toBe(false);
            expect(header('wide').sizes.every(tooBig)).toBe(true);
            expect(header('wide-x').sizes.map(tooBig)).toEqual([true, false, false]);
            expect(header('wide-x').sizes[2]).toBe(1);
            expect(header('same-point').sizes).toEqual([1, 1, 1]);
        });

        it('have a smallidx after the end of the table', () => {
            expect(header('sparse').smallidx).toBe(73);
            expect(header('sparse').sizes.some(size => size > 0xffffff)).toBe(false);
            expect(header('sparse-wide').smallidx).toBe(73);
            expect(header('zigzag').smallidx).toBeGreaterThan(48);
        });

        it('have a range of 32 bits, which GROMACS reads wrong', () => {
            const size30 = header('range-30-bits').sizes[0];
            expect(size30).toBeGreaterThanOrEqual(2 ** 29);
            expect(size30).toBeLessThan(2 ** 30);
            expect(header('range-32-bits').sizes[0]).toBeGreaterThanOrEqual(2 ** 30);
            // All atoms get the minimum x and y, as in GROMACS. Their z is right
            for (const { coordinates } of frames('range-32-bits')) {
                const x = coordinates.filter((value, i) => i % 3 === 0);
                const z = coordinates.filter((value, i) => i % 3 === 2);
                expect(new Set(x).size).toBe(1);
                expect(new Set(z).size).toBe(30);
            }
            for (const { coordinates } of frames('range-30-bits'))
                expect(new Set(coordinates.filter((value, i) => i % 3 === 0)).size).toBe(30);
        });

        it('have frames for the fast decoder and frames it leaves to the general one', () => {
            const fast = name => read(fixture(`${name}.xtc`)).fast;
            // Usual frames
            expect(fast('waters')).toBe(3);
            expect(fast('mixed')).toBe(3);
            expect(fast('many-frames')).toBe(200);
            // Not compressed
            expect(fast('atoms-9')).toBe(0);
            // Ints stored one by one
            expect(fast('wide')).toBe(0);
            // Atoms or small differences of more than 48 bits
            expect(fast('zigzag')).toBe(0);
            expect(fast('sparse')).toBe(0);
            expect(fast('precision-100007')).toBe(0);
            // Some frames of each
            expect(fast('random-3')).toBe(3);
            expect(fast('random-9')).toBe(1);
            const all = fixtures.map(({ name, frames }) => fast(name) / frames);
            expect(all.filter(share => share === 1).length).toBe(36);
            expect(all.filter(share => share === 0).length).toBe(16);
        });

        it('have the 2023 format with the frames of the 1995 format', () => {
            expect(header('magic-2023').magic).toBe(2023);
            expect(header('waters').magic).toBe(1995);
            expect(fs.readFileSync(fixture('magic-2023.bin')).equals(fs.readFileSync(fixture('waters.bin')))).toBe(true);
        });

        it('have frames that are the same and frames that are not', () => {
            const [first, ...others] = frames('identical-frames');
            for (const frame of others) expect(frame.coordinates).toEqual(first.coordinates);
            const [one, another] = frames('many-frames');
            expect(another.coordinates).not.toEqual(one.coordinates);
        });

        it('have steps and times up to the limits', () => {
            const steps = frames('steps-and-times').map(frame => frame.step);
            expect(steps).toEqual([0, 1, 2, 2147483647, -1, -2147483648, 123456789]);
            const times = frames('steps-and-times').map(frame => frame.time);
            expect(times).toEqual([0, 0.1, 0.30000001, 123456.789, -5, 1e9, 1e-9].map(Math.fround));
        });
    });

    // Limits no file written by GROMACS is at, and the fuzz tests do not reach either
    describe('limits of a frame', () => {
        // The size of a compressed frame whose header has these values
        const size = ({ magic = 1995, natoms, dataBytes }) => {
            const header = Buffer.alloc(96);
            header.writeInt32BE(magic, 0);
            header.writeInt32BE(natoms, 4);
            header.writeInt32BE(natoms, 52);
            if (magic === 2023) header.writeInt32BE(Math.floor(dataBytes / 2 ** 32), 88);
            header.writeUInt32BE(dataBytes % 2 ** 32, magic === 2023 ? 92 : 88);
            return frameBytes(new DataView(header.buffer, header.byteOffset, header.length), 0, header.length);
        };

        it('takes as much compressed data as GROMACS has room for, and no more', () => {
            // GROMACS reads it into 240 bytes up to 16 atoms, and into 1.2 ints per coordinate with more atoms
            expect(size({ natoms: 16, dataBytes: 240 })).toBe(92 + 240);
            expect(() => size({ natoms: 16, dataBytes: 241 })).toThrow(/Wrong size of the compressed data in xtc frame \(241 bytes for 16 atoms\)/);
            expect(size({ natoms: 17, dataBytes: 244 })).toBe(92 + 244);
            expect(() => size({ natoms: 17, dataBytes: 245 })).toThrow(/Wrong size of the compressed data/);
            expect(size({ natoms: 1000, dataBytes: 14400 })).toBe(92 + 14400);
            expect(() => size({ natoms: 1000, dataBytes: 14401 })).toThrow(/Wrong size of the compressed data/);
        });

        it('needs one bit of compressed data per atom at least', () => {
            expect(size({ natoms: 80, dataBytes: 10 })).toBe(92 + 12);
            expect(() => size({ natoms: 81, dataBytes: 10 })).toThrow(/its compressed data is too short/);
        });

        it('takes up to 298261617 atoms with the magic number of 1995', () => {
            expect(size({ natoms: 298261617, dataBytes: 40000000 })).toBe(92 + 40000000);
            expect(() => size({ natoms: 298261618, dataBytes: 40000000 })).toThrow(/298261618 atoms need the magic number 2023/);
            expect(size({ magic: 2023, natoms: 298261618, dataBytes: 40000000 })).toBe(96 + 40000000);
        });

        it('reads the size of the compressed data as an int64 with the magic number of 2023', () => {
            expect(size({ magic: 2023, natoms: 400000000, dataBytes: 2 ** 32 + 8 })).toBe(96 + 2 ** 32 + 8);
            expect(() => size({ magic: 2023, natoms: 400000000, dataBytes: 2 ** 33 })).toThrow(/Wrong size of the compressed data in xtc frame \(8589934592 bytes/);
        });

        it('reads frames one byte smaller and one byte bigger than its buffer', () => {
            const ends = frameEnds(fs.readFileSync(fixture('waters.xtc')));
            const expectedFrames = splitDump(fs.readFileSync(fixture('waters.bin')));
            // Buffers of the size of every frame, and of the frames up to every one, give or take a byte
            const sizes = ends.map((end, i) => end - (ends[i - 1] || 0));
            for (const bufferBytes of [1, 2, 3, ...[...sizes, ...ends].flatMap(size => [size - 1, size, size + 1])]) {
                const { dumps, incomplete, error } = read(fixture('waters.xtc'), { bufferBytes });
                expect({ bufferBytes, error }).toEqual({ bufferBytes, error: undefined });
                expectSameFrames(dumps, expectedFrames);
                expect(incomplete).toBe(false);
            }
        });
    });

    describe('with a file that is not a trajectory', () => {
        it('reads no frames from an empty file', () => {
            expect(readBytes(Buffer.alloc(0))).toEqual({ dumps: [], incomplete: false, count: 0, fast: 0 });
        });

        it('fails with a file that is not xtc', () => {
            const { error } = readBytes(Buffer.from('This is not a trajectory, however long it is\n'));
            expect(error).toBeInstanceOf(XtcError);
            expect(error.message).toMatch(/Wrong magic number/);
        });

        it('fails with a file that does not exist', () => {
            expect(read(fixture('missing.xtc')).error.code).toBe('ENOENT');
        });

        it('stops if the file gets shorter while it is read', () => {
            const stats = fs.fstatSync;
            // The file has 100 bytes less than it had when it was opened
            const spy = jest.spyOn(fs, 'fstatSync').mockImplementation(fd => ({ size: stats(fd).size + 100 }));
            try {
                expect(read(fixture('waters.xtc'))).toMatchObject({ incomplete: false, count: 3 });
            } finally {
                spy.mockRestore();
            }
        });
    });

    // The file ends before it should, e.g. the simulation was killed or the copy was interrupted
    // GROMACS keeps the frames before the incomplete one and warns: so does the decoder
    describe.each(Object.keys(badInput.truncated))('with %s.xtc truncated at every byte', name => {
        const bytes = fs.readFileSync(fixture(`${name}.xtc`));
        const expected = splitDump(fs.readFileSync(fixture(`${name}.bin`)));
        const ends = frameEnds(bytes);
        // What GROMACS did with every size, in bad-input.json
        const gromacs = badInput.truncated[name];

        it('gives the frames that are complete and tells if one is not', () => {
            for (let size = 0; size < bytes.length; size++) {
                const whole = ends.filter(end => end <= size).length;
                const { dumps, incomplete, error } = readBytes(bytes.subarray(0, size));
                expect(error).toBeUndefined();
                expectSameFrames(dumps, expected.slice(0, whole));
                expect({ size, incomplete }).toEqual({ size, incomplete: size !== 0 && !ends.includes(size) });
            }
        });

        it('does as GROMACS, where GROMACS knows what it does', () => {
            const counts = { same: 0, 'no warning': 0, 'no first frame': 0, 'not defined': 0 };
            for (let size = 0; size < bytes.length; size++) {
                const whole = ends.filter(end => end <= size).length;
                const incomplete = size !== 0 && !ends.includes(size);
                const inFrame = size - (ends[whole - 1] || 0);
                const [code, frames, warned, dumpHash] = gromacs[size];
                const sameFrames = frames === whole && dumpHash === hash(Buffer.concat(expected.slice(0, whole)));
                // With the 2023 format, GROMACS does not notice that the file ends in the second half of the size
                // of the compressed data: it crashes, or it gives a frame it made up
                if (name === 'bad-input-magic-2023' && inFrame >= 92 && inFrame < 96) {
                    expect({ size, crashOrMadeUpFrame: code !== 0 || (frames === whole + 1 && !warned) }).toEqual({
                        size,
                        crashOrMadeUpFrame: true,
                    });
                    counts['not defined']++;
                    continue;
                }
                // GROMACS fails if it cannot read a first frame. The decoder gives no frames, and the loader fails then
                if (whole === 0) {
                    expect({ size, code }).toEqual({ size, code: 1 });
                    counts['no first frame']++;
                    continue;
                }
                expect({ size, code, sameFrames }).toEqual({ size, code: 0, sameFrames: true });
                // GROMACS ignores 1 to 3 bytes after a frame, since they are not even a magic number
                if (inFrame > 0 && inFrame < 4) {
                    expect({ size, warned }).toEqual({ size, warned: false });
                    counts['no warning']++;
                    continue;
                }
                expect({ size, warned }).toEqual({ size, warned: incomplete });
                counts.same++;
            }
            // 4 sizes in every frame
            const notDefined = name === 'bad-input-magic-2023' ? 4 * ends.length : 0;
            const noFirstFrame = ends[0] - (notDefined ? 4 : 0);
            const noWarning = 3 * (ends.length - 1);
            expect(counts).toEqual({
                same: bytes.length - notDefined - noFirstFrame - noWarning,
                'no warning': noWarning,
                'no first frame': noFirstFrame,
                'not defined': notDefined,
            });
        });
    });

    // Bytes of the file are wrong, e.g. a damaged disk or a bad copy
    describe('with damaged files', () => {
        const bytes = fs.readFileSync(fixture('bad-input-waters.xtc'));
        // Compare the decoder with what GROMACS did (in bad-input.json): [exit code, frames, warned of incomplete frame, hash]
        // Returns 'same', 'both give an error', or the error of the decoder when GROMACS gives none
        const compare = (damaged, [code, frames, warned, dumpHash], options) => {
            const { dumps, incomplete, error } = readBytes(damaged, options);
            if (error && !(error instanceof XtcError)) throw error;
            // GROMACS gave an error or crashed: the decoder must fail
            if (code !== 0) expect(error).toBeInstanceOf(XtcError);
            if (code === 1) return 'both give an error';
            // The decoder is stricter than GROMACS, which crashed or read something
            // These count together: with the same file GROMACS may crash in one run and not in the next
            if (error) return error.message.replace(/ \(.*\)$/, '');
            // Both read it: they must read the same
            expect({ frames: dumps.length, incomplete, hash: hash(Buffer.concat(dumps)) }).toEqual({
                frames,
                incomplete: warned,
                hash: dumpHash,
            });
            return 'same';
        };

        // With the fast decoder, which leaves to the general one what it cannot decode, and with the general one alone
        it.each([[true], [false]])('fails when GROMACS fails and reads the same when GROMACS reads, with every byte changed in 3 ways (fast decoder: %s)', fast => {
            const results = {};
            for (const [key, gromacs] of Object.entries(badInput.damaged)) {
                const [offset, flip] = key.split('^').map(Number);
                const damaged = Buffer.from(bytes);
                damaged[offset] ^= flip;
                const result = compare(damaged, gromacs, { fast });
                results[result] = (results[result] || 0) + 1;
            }
            // Changes in the time, the step, the box and most of the compressed data cannot be noticed: xtc has no checksum
            // Where only the decoder gives an error, GROMACS reads or writes memory that is not its own, and it crashes
            // or not, or it reads values of no use
            expect(results).toEqual({
                same: 1570,
                'both give an error': 73,
                'Wrong number of atoms in xtc frame': 48,
                'Wrong precision in xtc frame': 6,
                'Wrong smallidx in xtc frame': 33,
                'Wrong run in xtc frame: it has more atoms than the frame': 228,
                'Wrong size of the compressed data in xtc frame': 16,
                'Wrong xtc frame: its compressed data is too short': 6,
            });
            expect(Object.values(results).reduce((sum, count) => sum + count, 0)).toBe(bytes.length * 3);
        });

        // What the decoder does with every edit of generate-fixtures.js: 'same' as GROMACS, or the error
        const EDITS = {
            'smallidx 8, below the first size of the table': /Wrong run in xtc frame: it has more atoms than the frame/,
            'smallidx 0': /Wrong run in xtc frame: it has no size/,
            'smallidx 73 with runs in the frame': /Wrong smallidx in xtc frame \(74\)/,
            'smallidx 74, after the end of the table': /Wrong smallidx in xtc frame \(74\)/,
            'smallidx -1': /Wrong smallidx in xtc frame \(-1\)/,
            'size of x is 0': /Wrong run in xtc frame: it has more atoms than the frame/,
            'size of y is 0': /Wrong sizes in xtc frame/,
            'size of z is 0': /Wrong sizes in xtc frame/,
            'size of x is negative': /Wrong run in xtc frame: it has more atoms than the frame/,
            'size of x takes 32 bits': /Wrong run in xtc frame: it has more atoms than the frame/,
            'no compressed data': /its compressed data is too short/,
            'negative size of the compressed data': /Wrong size of the compressed data in xtc frame \(-1 bytes for 30 atoms\)/,
            'compressed data one byte shorter': /its compressed data is too short/,
            'compressed data 4 bytes shorter': /its compressed data is too short/,
            'compressed data 4 bytes longer': /Wrong magic number in xtc file/,
            // The file ends before the frame does: an incomplete frame, also for GROMACS
            'compressed data 8 bytes longer in the last frame': 'same',
            'precision 0': /Wrong precision in xtc frame \(0\)/,
            'negative precision': /Wrong precision in xtc frame \(-1000\)/,
            'infinite precision': /Wrong precision in xtc frame \(Infinity\)/,
            'one atom less in the header of a frame': /Wrong number of atoms in xtc frame \(29 instead of 30\)/,
            'one atom less in a frame': /Wrong number of atoms in xtc frame \(29 instead of 30\)/,
            'one atom more in a frame': /Wrong number of atoms in xtc frame \(31 instead of 30\)/,
            'one atom more in the first frame': /Wrong run in xtc frame: it has more atoms than the frame/,
            '9 atoms in a frame, which would not be compressed': /Wrong number of atoms in xtc frame \(9 instead of 30\)/,
            'no atoms in the first frame': /Wrong magic number in xtc file/,
            'negative number of atoms in the first frame': /Wrong number of atoms in xtc frame \(-30\)/,
            '300 million atoms with magic number 1995': /300000000 atoms need the magic number 2023/,
            'magic number 2023 in a frame of the 1995 format': /Wrong size of the compressed data in xtc frame/,
            'magic number 1996': /Wrong magic number in xtc file \(1996 instead of 1995 or 2023\)/,
        };

        it('has an expected result for every edit', () => {
            expect(badInput.edited.map(edit => edit.what)).toEqual(Object.keys(EDITS));
        });

        it.each(badInput.edited)('with $what', ({ what, changes, gromacs }) => {
            const damaged = Buffer.from(bytes);
            for (const [offset, hexadecimal] of changes) Buffer.from(hexadecimal, 'hex').copy(damaged, offset);
            for (const fast of [true, false]) {
                const result = compare(damaged, gromacs, { fast });
                if (EDITS[what] === 'same') expect(result).toBe('same');
                else expect(readBytes(damaged, { fast }).error.message).toMatch(EDITS[what]);
            }
        });
    });
});

// Tests that run GROMACS, skipped unless XTC_TEST_GMX has the path of any GROMACS in single precision
// XTC_TEST_SYSTEMS is the number of random systems to try (200 by default)
const gmx = process.env.XTC_TEST_GMX;
(gmx ? describe : describe.skip)('xtc decoder against GROMACS', () => {
    const systems = Number(process.env.XTC_TEST_SYSTEMS || 200);

    it(`reads ${systems} systems made at random as GROMACS does`, () => {
        withTemporaryDirectory(directory => {
            // The fixtures have the first seeds
            for (let seed = 1001; seed <= 1000 + systems; seed++) {
                const filepath = writeXtc(gmx, randomSystem(seed), directory);
                const { dump, code, incomplete } = runDump(gmx, filepath);
                expect({ seed, code, incomplete }).toEqual({ seed, code: 0, incomplete: false });
                const { dumps, error } = read(filepath);
                expect({ seed, error }).toEqual({ seed, error: undefined });
                expectSameFrames(dumps, splitDump(dump));
            }
        });
    }, 600000);
});
