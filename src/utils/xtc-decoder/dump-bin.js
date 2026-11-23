// What GROMACS reads from an xtc file, used as the ground truth to test the xtc decoder
// GROMACS itself converts the file to trr ("gmx trjconv -f file.xtc -o file.trr"), a format with the values
// as GROMACS read them, not compressed. Any GROMACS in single precision does it
// Here every frame is a "dump", as in the .bin files of the fixtures, little endian: the number of atoms (int32),
// the step (int64), the time (float32), the box (9 float32) and the coordinates (3 float32 per atom), in nm
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// natoms, step and time
const DUMP_HEADER_BYTES = 16;
const BOX_BYTES = 9 * 4;

// Size in bytes of a frame in the dump
const dumpFrameBytes = natoms => DUMP_HEADER_BYTES + BOX_BYTES + natoms * 12;

// The bytes GROMACS would dump for a frame of the decoder
const dumpFrame = frame => {
    const header = Buffer.alloc(DUMP_HEADER_BYTES);
    header.writeInt32LE(frame.natoms, 0);
    header.writeBigInt64LE(BigInt(frame.step), 4);
    header.writeFloatLE(frame.time, 12);
    const { box, coordinates } = frame;
    return Buffer.concat([
        header,
        Buffer.from(box.buffer, box.byteOffset, box.byteLength),
        Buffer.from(coordinates.buffer, coordinates.byteOffset, coordinates.byteLength),
    ]);
};

// Split a dump in the bytes of its frames
const splitDump = dump => {
    const frames = [];
    let offset = 0;
    while (offset < dump.length) {
        const size = dumpFrameBytes(dump.readInt32LE(offset));
        frames.push(dump.subarray(offset, offset + size));
        offset += size;
    }
    return frames;
};

// Tell where two dumped frames differ, for the messages of failed comparisons
const describeDifference = (ours, theirs) => {
    if (ours.length !== theirs.length) return `${ours.readInt32LE(0)} atoms instead of ${theirs.readInt32LE(0)}`;
    let i = 0;
    while (i < ours.length && ours[i] === theirs[i]) i++;
    if (i === ours.length) return 'no difference';
    if (i < 4) return `${ours.readInt32LE(0)} atoms instead of ${theirs.readInt32LE(0)}`;
    if (i < 12) return `step ${ours.readBigInt64LE(4)} instead of ${theirs.readBigInt64LE(4)}`;
    const value = i - (i % 4);
    const what =
        value < DUMP_HEADER_BYTES
            ? 'time'
            : value < DUMP_HEADER_BYTES + BOX_BYTES
            ? `box value ${(value - DUMP_HEADER_BYTES) / 4}`
            : `coordinate ${(value - DUMP_HEADER_BYTES - BOX_BYTES) / 4} (atom ${Math.floor((value - DUMP_HEADER_BYTES - BOX_BYTES) / 12)})`;
    return `${what} is ${ours.readFloatLE(value)} instead of ${theirs.readFloatLE(value)}`;
};

// ----- Running GROMACS -----

// A frame of a trr file, big endian: a header of 76 bytes (the magic number 1993, the name of the format and 13 ints,
// among them the sizes in bytes of what follows, the number of atoms and the step), the time, lambda, the box and
// the coordinates. A trr made from an xtc has no more: no virial, pressure, velocities or forces
const TRR_HEADER_BYTES = 76;
const TRR_INTS_OFFSET = 24;

// The frame of a trr which starts at an offset, as { dump, size: its bytes in the trr }. Undefined if it is not whole
const readTrrFrame = (trr, offset) => {
    if (trr.length - offset < TRR_HEADER_BYTES) return undefined;
    const int = index => trr.readInt32BE(offset + TRR_INTS_OFFSET + index * 4);
    const [boxBytes, coordinatesBytes, natoms, step] = [int(2), int(7), int(10), int(11)];
    const otherBytes = int(0) + int(1) + int(3) + int(4) + int(5) + int(6) + int(8) + int(9);
    // With GROMACS in double precision the values take 8 bytes
    if (trr.readInt32BE(offset) !== 1993 || boxBytes !== BOX_BYTES || coordinatesBytes !== natoms * 12 || otherBytes !== 0)
        throw new Error('GROMACS did not write the trr expected: it must be a GROMACS in single precision');
    const size = TRR_HEADER_BYTES + 8 + BOX_BYTES + coordinatesBytes;
    if (trr.length - offset < size) return undefined;
    const dump = Buffer.alloc(dumpFrameBytes(natoms));
    dump.writeInt32LE(natoms, 0);
    dump.writeBigInt64LE(BigInt(step), 4);
    // The time and, after lambda, the box and the coordinates: the same float32, in the other byte order
    trr.copy(dump, 12, offset + TRR_HEADER_BYTES, offset + TRR_HEADER_BYTES + 4);
    trr.copy(dump, DUMP_HEADER_BYTES, offset + TRR_HEADER_BYTES + 8, offset + size);
    dump.subarray(12).swap32();
    return { dump, size };
};

// The whole frames at the start of some bytes of a trr, as dumps, and the bytes they take
const readTrrFrames = trr => {
    const dumps = [];
    let size = 0;
    for (let frame; (frame = readTrrFrame(trr, size)); size += frame.size) dumps.push(frame.dump);
    return { dumps, size };
};

// The arguments to convert a trajectory to trr
const trjconvArguments = (filepath, trr) => ['trjconv', '-f', filepath, '-o', trr];
// GROMACS must write to the path of the trr as it is: if something is there, it must not move it away as a backup
const TRJCONV_ENVIRONMENT = { ...process.env, GMX_MAXBACKUP: '-1' };

// What GROMACS says in its standard error when it gives up: its fatal error, if any
const readFailure = stderr => {
    const match = /Fatal error:\n([^\n]*)/.exec(stderr) || /Assertion failed:\n(?:Condition:[^\n]*\n)?([^\n]*)/.exec(stderr);
    return match ? match[1] : '';
};

// How GROMACS ended: its exit code (or the signal that killed it), if it warned about an incomplete frame and its fatal error
// "left" is the number of bytes of the trr after its last whole frame: none, unless GROMACS failed
const ending = (status, signal, stderr, left) => {
    const code = status === null ? signal : status;
    if (code === 0 && left !== 0) throw new Error(`GROMACS wrote ${left} bytes that are not a whole frame`);
    return { code, incomplete: /Incomplete frame/.test(stderr), failure: readFailure(stderr) };
};

// Read a small file with GROMACS and wait for it. Returns the dump of its frames and how GROMACS ended (see above)
// If GROMACS fails, the frames it read before may be missing: it does not write them to the trr one by one
const runDump = (gmx, filepath) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xtc-trr-'));
    try {
        const trrPath = path.join(directory, 'frames.trr');
        const result = spawnSync(gmx, trjconvArguments(filepath, trrPath), { env: TRJCONV_ENVIRONMENT, maxBuffer: 1024 * 1024 * 1024 });
        if (result.error) throw result.error;
        const trr = fs.existsSync(trrPath) ? fs.readFileSync(trrPath) : Buffer.alloc(0);
        const { dumps, size } = readTrrFrames(trr);
        return { dump: Buffer.concat(dumps), ...ending(result.status, result.signal, result.stderr.toString(), trr.length - size) };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
};

// Read a file of any size with GROMACS: an async generator of the dump of every frame
// It returns { code, incomplete, failure } as runDump does
// The trr is several times bigger than the xtc, so GROMACS writes it to a named pipe and it is never in the disk
const streamDump = async function*(gmx, filepath) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xtc-trr-'));
    let child;
    let ownEnd;
    // The stream of the pipe ends when nobody has it open to write. GROMACS may fail before it opens it,
    // so the pipe is also open here until GROMACS is gone: then the stream ends in any case
    const closeOwnEnd = () => {
        if (ownEnd !== undefined) fs.closeSync(ownEnd);
        ownEnd = undefined;
    };
    try {
        const pipe = path.join(directory, 'frames.trr');
        const made = spawnSync('mkfifo', [pipe]);
        if (made.error || made.status !== 0) throw made.error || new Error(`Could not make a named pipe: ${made.stderr}`);
        const trr = fs.createReadStream(pipe, { highWaterMark: 8 * 1024 * 1024 });
        ownEnd = fs.openSync(pipe, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        child = spawn(gmx, trjconvArguments(filepath, pipe), { stdio: ['ignore', 'ignore', 'pipe'], env: TRJCONV_ENVIRONMENT });
        let stderr = '';
        // GROMACS writes its progress here: keep the end only
        child.stderr.on('data', text => (stderr = (stderr + text).slice(-100000)));
        const closed = new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (status, signal) => {
                closeOwnEnd();
                resolve({ status, signal });
            });
        });
        // GROMACS could not even start: stop waiting for its frames
        closed.catch(error => trr.destroy(error));
        let pending = Buffer.alloc(0);
        for await (const chunk of trr) {
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            const { dumps, size } = readTrrFrames(pending);
            yield* dumps;
            pending = pending.subarray(size);
        }
        const { status, signal } = await closed;
        return ending(status, signal, stderr, pending.length);
    } finally {
        if (child) child.kill();
        closeOwnEnd();
        fs.rmSync(directory, { recursive: true, force: true });
    }
};

module.exports = { dumpFrameBytes, dumpFrame, splitDump, describeDifference, runDump, streamDump };
