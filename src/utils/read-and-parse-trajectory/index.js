const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// Constants
// GROMACS coordinates are in nm and we store them in Ångström
const UNIT_CONVERSION_SCALE = 10;
// Backpressure control: bytes of coordinates the main thread may have waiting before the worker pauses
// GridFS is written 16 MiB at a time, so this is enough to keep it fed
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
// Coordinates are given in chunks of this size at most, whatever the size of a frame
// The loader gathers them to write 16 MiB at a time: with small chunks all its writes have about that size
const MAX_CHUNK_BYTES = 64 * 1024;

// ===================== WORKER THREAD ARCHITECTURE =====================
// Because Node.js runs JavaScript in a single-threaded environment, heavy
// computations (like decoding the compressed coordinates of a trajectory) block
// the event loop and prevent I/O operations (like MongoDB uploads) from running efficiently.
//
// Solution: Use Worker Threads to run the decoding in a separate CPU thread.
// - WORKER THREAD: Reads the xtc file, decodes its frames, sends binary chunks
// - MAIN THREAD: Receives chunks, uploads to MongoDB via GridFS
//
// This allows true parallelism: decoding and uploading happen simultaneously
// on different CPU cores.
//
// Reference: https://nodesource.com/blog/worker-threads-nodejs-multithreading-in-javascript
//
// ===================== WORKER THREAD CODE =====================
if (!isMainThread) {
    // The xtc file is decoded here, with no need of GROMACS: frames come with the same values GROMACS reads
    const { readXtcFrames } = require('../xtc-decoder');
    const { filepath, parseBox, queued, maxQueuedBytes } = workerData;

    // Convert float32 values from nm to Ångström in place
    // Every product is rounded once, when it is stored as float32: the same result as a float32 multiplication
    const toAngstroms = values => {
        for (let i = 0; i < values.length; i++) values[i] *= UNIT_CONVERSION_SCALE;
    };

    // Decode the trajectory and send every frame to the main thread
    // An error here (e.g. a damaged file) reaches the main thread as the 'error' event of the worker
    const frames = readXtcFrames(filepath);
    let next;
    while (!(next = frames.next()).done) {
        const { box, coordinates } = next.value;
        // Send a log update signal every time a new frame starts
        parentPort.postMessage({ type: 'frame' });
        // Send the box, only if it was requested
        if (parseBox) {
            toAngstroms(box);
            parentPort.postMessage({ type: 'box', buffer: box.buffer }, [box.buffer]);
        }
        // Send the coordinates of the whole frame. The buffer is transferred, not copied
        toAngstroms(coordinates);
        Atomics.add(queued, 0, BigInt(coordinates.byteLength));
        parentPort.postMessage({ type: 'data', buffer: coordinates.buffer }, [coordinates.buffer]);
        // Backpressure: wait while the main thread has too many bytes waiting
        // The main thread wakes us up every time it consumes a chunk. The timeout is just in case
        let waiting;
        while ((waiting = Atomics.load(queued, 0)) >= maxQueuedBytes) Atomics.wait(queued, 0, waiting, 1000);
    }
    // The file ended in the middle of a frame: the frames before it were sent
    if (next.value.incomplete) parentPort.postMessage({ type: 'incomplete', frames: next.value.frames });
    parentPort.postMessage({ type: 'done' });

} else {
    // ===================== MAIN THREAD CODE =====================
    const os = require('os');
    const chalk = require('chalk');
    const logger = require('../logger');
    // Exit code for interruptions
    const { INTERRUPTION_EXIT_CODE } = require('../constants');

    // Read a trajectory file (xtc) while coordinates are parsed to float32 binary data, in Ångström
    // If a box update function is passed then box vectors are parsed as well and sent to this function frame by frame
    // Every box is a buffer with 9 float32 values: the 3 box vectors, in Ångstroms
    // It throws if the file is damaged. If the file ends in the middle of a frame, it warns and gives the frames before it
    // The gromacs command is not used any more, since the file is decoded here: the argument stays so callers do not change
    // The last argument is for tests only, to try the limits above with small files
    const readAndParseTrajectory = async function* (filepath, gromacsCommand, newFrameUpdate, abort, newBoxUpdate, limits = {}) {
        const { maxQueuedBytes = MAX_QUEUED_BYTES, maxChunkBytes = MAX_CHUNK_BYTES } = limits;
        // Chunks are the bytes of float32 values as they are in memory, and we store them little endian
        if (os.endianness() !== 'LE') throw new Error('Trajectories can only be loaded from a little endian machine');
        // Track the last time we checked if the load was aborted
        let lastCheck = Date.now();

        // BACKPRESSURE MECHANISM: The worker produces data faster than MongoDB can upload.
        // Without a limit the difference accumulates in the queue below, causing memory to grow
        // (potentially to GB). When heap fills up, Node.js triggers garbage collection (GC),
        // which pauses ALL JavaScript execution for 50-500ms, causing gaps in network upload.
        // Solution: both threads share the number of bytes sent by the worker and not consumed yet.
        // The worker adds to it and waits while it is over the limit, even if this thread is too busy to say so.
        const queued = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));

        // Create worker thread for parsing
        const worker = new Worker(__filename, {
            workerData: { filepath, parseBox: Boolean(newBoxUpdate), queued, maxQueuedBytes }
        });

        // Queue to hold chunks from worker until consumed
        const chunkQueue = [];
        let resolveWaiting = null;
        let isDone = false;
        let workerError = null;
        // Wake up the loop below, if it is waiting for the queue
        const wakeUp = () => {
            if (!resolveWaiting) return;
            const resolve = resolveWaiting;
            resolveWaiting = null;
            resolve();
        };

        // Handle messages from worker
        worker.on('message', (msg) => {
            // The coordinates of a whole frame. The buffers are transferred, so they are wrapped and not copied
            if (msg.type === 'data') chunkQueue.push(Buffer.from(msg.buffer));
            // Signal frame update - push a special marker
            else if (msg.type === 'frame') chunkQueue.push({ isFrame: true });
            // Push the box as a special marker to keep it in order with frames
            else if (msg.type === 'box') chunkQueue.push({ isBox: true, buffer: Buffer.from(msg.buffer) });
            else if (msg.type === 'incomplete') logger.printLog(chalk.yellow(
                `WARNING: Trajectory file '${filepath}' ends with an incomplete frame. Only the ${msg.frames} frames before it are loaded`));
            else if (msg.type === 'done') isDone = true;
            wakeUp();
        });

        worker.on('error', (err) => {
            workerError = err;
            isDone = true;
            wakeUp();
        });

        try {
            // Yield chunks as they arrive from worker
            while (true) {
                // Wait for data if queue is empty
                while (chunkQueue.length === 0 && !isDone) {
                    await new Promise(resolve => { resolveWaiting = resolve; });
                }

                // Check for errors
                if (workerError) {
                    throw workerError;
                }

                // If done and queue empty, exit
                if (chunkQueue.length === 0 && isDone) {
                    break;
                }

                // Get next item from queue
                const item = chunkQueue.shift();

                // Handle frame marker
                if (item.isFrame) {
                    newFrameUpdate(); // Send a log update signal every time a new frame is completed
                    continue;
                }

                // Handle box marker
                if (item.isBox) {
                    newBoxUpdate(item.buffer);
                    continue;
                }

                // Give the coordinates of the frame in chunks
                for (let offset = 0; offset < item.length; offset += maxChunkBytes) {
                    // Check once per second if the process has been aborted
                    const now = Date.now();
                    if (now > lastCheck + 1000) {
                        if (await abort()) {
                            worker.terminate();
                            process.exit(INTERRUPTION_EXIT_CODE);
                        }
                        lastCheck = now;
                    }

                    // Yield the data chunk, which is a part of the buffer and not a copy
                    yield item.subarray(offset, offset + maxChunkBytes);
                }

                // This frame is not waiting any more: let the worker go on if it was waiting for room
                Atomics.sub(queued, 0, BigInt(item.length));
                Atomics.notify(queued, 0);
            }
        } finally {
            // Ensure worker is terminated, also if we stop reading before the end
            await worker.terminate();
        }
    };

    module.exports = readAndParseTrajectory;
}
