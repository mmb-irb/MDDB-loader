// Tests of the trajectory reader: a worker thread decodes the xtc file and this thread gets its coordinates in Ångström
// They use the fixtures of the xtc decoder: xtc files written by GROMACS, with what GROMACS reads from them in nm
const fs = require('fs');
const os = require('os');
const path = require('path');
// Keep the workers the reader starts, to see what they send
const mockWorkers = [];
jest.mock('worker_threads', () => {
    const actual = jest.requireActual('worker_threads');
    class Worker extends actual.Worker {
        constructor(...args) {
            super(...args);
            mockWorkers.push(this);
        }
    }
    return { ...actual, Worker };
});
const logger = require('../logger');
const readAndParseTrajectory = require('.');
const { splitDump } = require('../xtc-decoder/dump-bin');

const fixtures = require('../xtc-decoder/fixtures/fixtures.json');
const fixture = name => path.join(__dirname, '..', 'xtc-decoder', 'fixtures', name);

// The frames GROMACS reads from a fixture, converted to Ångström as the loader stores them:
// every float32 value in nm multiplied by 10 and rounded to float32
const expectedFrames = name =>
    splitDump(fs.readFileSync(fixture(`${name}.bin`))).map(dump => {
        const values = new Float32Array(new Uint8Array(dump.subarray(16)).buffer).map(value => Math.fround(value * 10));
        const bytes = Buffer.from(values.buffer);
        return { box: bytes.subarray(0, 36), coordinates: bytes.subarray(36) };
    });

// Read a trajectory to the end. Returns its chunks and boxes, and the order in which everything came
const readAll = async (filepath, { withBox = true, abort = () => false, limits } = {}) => {
    const events = [];
    const boxes = [];
    const chunks = [];
    const addFrame = () => events.push('frame');
    const addBox = box => {
        events.push('box');
        boxes.push(box);
    };
    const reader = readAndParseTrajectory(filepath, 'gmx', addFrame, abort, withBox ? addBox : undefined, limits);
    for await (const chunk of reader) {
        events.push('chunk');
        chunks.push(chunk);
    }
    return { events, boxes, chunks };
};

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('trajectory reader', () => {
    let directory;
    let printLog;
    beforeAll(() => (directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-trajectory-reader-'))));
    afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
    beforeEach(() => {
        mockWorkers.length = 0;
        printLog = jest.spyOn(logger, 'printLog').mockImplementation(() => {});
    });
    afterEach(() => printLog.mockRestore());

    // A copy of a fixture with some of its bytes, or with a byte changed
    const makeCopy = (name, change) => {
        const filepath = path.join(directory, `${name}.xtc`);
        fs.writeFileSync(filepath, change(Buffer.from(fs.readFileSync(fixture(`${name}.xtc`)))));
        return filepath;
    };

    it.each(fixtures)('gives $name as GROMACS reads it, times 10 as float32', async ({ name }) => {
        const expected = expectedFrames(name);
        const { events, boxes, chunks } = await readAll(fixture(`${name}.xtc`));
        // One chunk per frame, after the frame is counted and its box is given
        expect(events).toEqual(expected.flatMap(() => ['frame', 'box', 'chunk']));
        expect(Buffer.concat(boxes).equals(Buffer.concat(expected.map(frame => frame.box)))).toBe(true);
        expect(Buffer.concat(chunks).equals(Buffer.concat(expected.map(frame => frame.coordinates)))).toBe(true);
        expect(printLog).not.toHaveBeenCalled();
    });

    it('gives buffers and no boxes if they are not asked for', async () => {
        const { events, chunks } = await readAll(fixture('waters.xtc'), { withBox: false });
        expect(events).toEqual(['frame', 'chunk', 'frame', 'chunk', 'frame', 'chunk']);
        expect(chunks.every(chunk => Buffer.isBuffer(chunk) && chunk.length === 300 * 3 * 4)).toBe(true);
    });

    it('gives big frames in several chunks', async () => {
        // Frames of 3600 bytes in chunks of 1000 bytes at most
        const expected = expectedFrames('waters');
        const { events, chunks } = await readAll(fixture('waters.xtc'), { limits: { maxChunkBytes: 1000 } });
        expect(events).toEqual(expected.flatMap(() => ['frame', 'box', 'chunk', 'chunk', 'chunk', 'chunk']));
        expect(chunks.map(chunk => chunk.length)).toEqual([1000, 1000, 1000, 600, 1000, 1000, 1000, 600, 1000, 1000, 1000, 600]);
        expect(Buffer.concat(chunks).equals(Buffer.concat(expected.map(frame => frame.coordinates)))).toBe(true);
    });

    it('multiplies the values of GROMACS by 10, rounding to float32 once', async () => {
        // The values of the first atom of a fixture, as an example of the conversion
        const nanometers = new Float32Array(new Uint8Array(fs.readFileSync(fixture('waters.bin')).subarray(52, 64)).buffer);
        const { chunks } = await readAll(fixture('waters.xtc'));
        const angstroms = new Float32Array(new Uint8Array(chunks[0].subarray(0, 12)).buffer);
        expect(Array.from(angstroms)).toEqual(Array.from(nanometers, value => Math.fround(value * 10)));
        // Never further than half a float32 step from 10 times the value of GROMACS
        angstroms.forEach((value, i) => expect(Math.abs(value - nanometers[i] * 10)).toBeLessThan(2e-6));
    });

    it('warns of an incomplete last frame and gives the frames before it', async () => {
        const expected = expectedFrames('waters').slice(0, 2);
        // The file ends 100 bytes before it should
        const filepath = makeCopy('waters', bytes => bytes.subarray(0, bytes.length - 100));
        const { events, chunks } = await readAll(filepath);
        expect(events).toEqual(expected.flatMap(() => ['frame', 'box', 'chunk']));
        expect(Buffer.concat(chunks).equals(Buffer.concat(expected.map(frame => frame.coordinates)))).toBe(true);
        expect(printLog).toHaveBeenCalledTimes(1);
        expect(printLog.mock.calls[0][0]).toMatch(/WARNING: Trajectory file '.*waters.xtc' ends with an incomplete frame. Only the 2 frames before it are loaded/);
    });

    it('fails with a damaged file, instead of giving part of it', async () => {
        // The magic number of the last frame is wrong
        const start = fs.readFileSync(fixture('waters.xtc')).lastIndexOf(Buffer.from([0, 0, 7, 203, 0, 0, 1, 44]));
        const filepath = makeCopy('waters', bytes => {
            bytes[start + 3] = 0;
            return bytes;
        });
        await expect(readAll(filepath)).rejects.toThrow(/Wrong magic number in xtc file/);
        expect(printLog).not.toHaveBeenCalled();
    });

    it('fails with a file that does not exist', async () => {
        await expect(readAll(path.join(directory, 'missing.xtc'))).rejects.toThrow(/ENOENT/);
    });

    it('stops the worker while too many bytes or too many frames wait to be consumed', async () => {
        // 200 frames of 144 bytes. Count the chunks the worker has sent
        const countSent = () => {
            const count = { sent: 0 };
            mockWorkers[mockWorkers.length - 1].on('message', message => (count.sent += message.type === 'data' ? 1 : 0));
            return count;
        };
        const expected = Buffer.concat(expectedFrames('many-frames').map(frame => frame.coordinates));
        // With room for 1000 bytes, the worker stops after 7 chunks until one is consumed. With room for 5 frames, after 5
        for (const [limits, most] of [[{ maxQueuedBytes: 1000 }, 7], [{ maxQueuedFrames: 5 }, 5]]) {
            const slow = readAndParseTrajectory(fixture('many-frames.xtc'), 'gmx', () => {}, () => false, undefined, limits);
            const first = await slow.next();
            const slowCount = countSent();
            await wait(300);
            expect({ limits, sent: slowCount.sent <= most }).toEqual({ limits, sent: true });
            // Everything comes in the end, in order
            const chunks = [first.value];
            for await (const chunk of slow) chunks.push(chunk);
            expect(Buffer.concat(chunks).equals(expected)).toBe(true);
        }
        // With the usual room, the whole file is sent without waiting
        const fast = readAndParseTrajectory(fixture('many-frames.xtc'), 'gmx', () => {}, () => false);
        await fast.next();
        const fastCount = countSent();
        await wait(300);
        expect(fastCount.sent).toBeGreaterThan(190);
        await fast.return();
    });

    it('terminates the worker if reading stops before the end, also while the worker waits', async () => {
        const reader = readAndParseTrajectory(fixture('many-frames.xtc'), 'gmx', () => {}, () => false, undefined, { maxQueuedBytes: 1000 });
        await reader.next();
        const exited = new Promise(resolve => mockWorkers[0].once('exit', resolve));
        // Give the worker time to fill the room it has and wait for more
        await wait(100);
        await reader.return();
        await exited;
    });

    it('fails if the worker stops before the end, instead of waiting forever', async () => {
        const reader = readAndParseTrajectory(fixture('many-frames.xtc'), 'gmx', () => {}, () => false, undefined, { maxQueuedBytes: 1000 });
        await reader.next();
        // The worker is waiting for room: kill it, as the system could
        await mockWorkers[0].terminate();
        const readTheRest = async () => {
            for await (const chunk of reader) expect(chunk).toBeDefined();
        };
        await expect(readTheRest()).rejects.toThrow(/many-frames.xtc' stopped unexpectedly \(exit code 1\)/);
    });

    it('exits when the load is aborted', async () => {
        // The reader asks if the load was aborted once per second: make time run fast
        let now = Date.now();
        const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => (now += 2000));
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit was called');
        });
        try {
            await expect(readAll(fixture('waters.xtc'), { abort: async () => true })).rejects.toThrow('process.exit was called');
            expect(exit).toHaveBeenCalledWith(130);
        } finally {
            dateNow.mockRestore();
            exit.mockRestore();
        }
    });
});
