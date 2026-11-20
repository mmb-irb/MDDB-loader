// The output of "gmx dump -bin -f file.xtc", used as the ground truth to test the xtc decoder
// It has what the GROMACS reader gives for every frame, little endian: the number of atoms (int32),
// the step (int64), the time (float32), the box (9 float32) and the coordinates (3 float32 per atom), in nm
// The -bin option is in the gromacs_mddb bioconda package (3000-add-binary-xtc-output-to-gmx-dump.patch)
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

// What GROMACS says in the standard error of "gmx dump" when it gives up: its fatal error, if any
const readFailure = stderr => {
    const match =
        /Fatal error:\n([^\n]*)/.exec(stderr) ||
        /(Cannot read trajectory[^\n]*)/.exec(stderr) ||
        /(Inconsistent input or file format[^\n]*)/.exec(stderr);
    return match ? match[1] : '';
};

// Run "gmx dump -bin" on a small file and wait for it
// Returns its dump, its exit code (or the signal that killed it), if it warned about an incomplete frame and its fatal error
const runDump = (gmx, filepath) => {
    const result = spawnSync(gmx, ['dump', '-bin', '-f', filepath], { maxBuffer: 1024 * 1024 * 1024 });
    if (result.error) throw result.error;
    const stderr = result.stderr.toString();
    return {
        dump: result.stdout,
        code: result.status === null ? result.signal : result.status,
        incomplete: /Incomplete frame/.test(stderr),
        failure: readFailure(stderr),
    };
};

// Run "gmx dump -bin" on a file of any size: an async generator of the bytes of every frame
// It returns { code, incomplete, failure } as runDump does
const streamDump = async function*(gmx, filepath) {
    const child = spawn(gmx, ['dump', '-bin', '-f', filepath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    // GROMACS writes its progress here: keep the end only
    child.stderr.on('data', text => (stderr = (stderr + text).slice(-100000)));
    const closed = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (status, signal) => resolve(status === null ? signal : status));
    });
    try {
        let pending = Buffer.alloc(0);
        for await (const chunk of child.stdout) {
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            while (pending.length >= 4) {
                const size = dumpFrameBytes(pending.readInt32LE(0));
                if (pending.length < size) break;
                yield pending.subarray(0, size);
                pending = pending.subarray(size);
            }
        }
        const code = await closed;
        if (pending.length) throw new Error(`GROMACS wrote ${pending.length} bytes that are not a whole frame`);
        return { code, incomplete: /Incomplete frame/.test(stderr), failure: readFailure(stderr) };
    } finally {
        child.kill();
    }
};

module.exports = { dumpFrameBytes, dumpFrame, splitDump, describeDifference, runDump, streamDump };
