// Allows to call a unix command or run another script
// The execution of this code keeps running
const { spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// Constants
const UNIT_CONVERSION_SCALE = 10;
const N_COORDINATES = 3;
const BYTES_PER_ATOM = Float32Array.BYTES_PER_ELEMENT * N_COORDINATES;
// example matches:
// '      x[    0]={ 6.40500e+00,  7.53800e+00,  9.81800e+00}'
// '      x[35999]={-8.50000e-02,  1.82000e+00,  7.23700e+00}'
const COORDINATES_REGEXP = /^\s*x\[\s*\d*]={\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2})\s*}\s*$/;
const FRAME_REGEXP = / frame \d+:$/;

// Batch size: number of atoms to accumulate before yielding
const BATCH_SIZE = 1000; // Adjust based on memory/performance tradeoff
// Batch size of 1000 atoms = 12KB per chunk
// Backpressure control: max chunks in queue before worker pauses
// GridFS uses 4MB chunks internally, so we want enough buffer to keep it fed
const MAX_QUEUE_SIZE = 5000;
// 5000 chunks × 12KB = ~60MB buffer, allowing worker to stay ahead of uploads

// ===================== WORKER THREAD ARCHITECTURE =====================
// Because Node.js runs JavaScript in a single-threaded environment, heavy
// computations (like regex parsing millions of lines) block the event loop
// and prevent I/O operations (like MongoDB uploads) from running efficiently.
// 
// Solution: Use Worker Threads to run parsing in a separate CPU thread.
// - WORKER THREAD: Spawns Gromacs, parses output lines, sends binary chunks
// - MAIN THREAD: Receives chunks, uploads to MongoDB via GridFS
// 
// This allows true parallelism: parsing and uploading happen simultaneously
// on different CPU cores, improving throughput by ~50% (8.6 -> 12.7 MB/sec).
//
// Reference: https://nodesource.com/blog/worker-threads-nodejs-multithreading-in-javascript
//
// ===================== WORKER THREAD CODE =====================
if (!isMainThread) {
    const { filepath, gromacsCommand } = workerData;
    
    // Backpressure: wait for resume signal from main thread when queue is full
    let canSend = true;
    let resolveResume = null;
    
    parentPort.on('message', (msg) => {
        if (msg.type === 'pause') {
            canSend = false;
        } else if (msg.type === 'resume') {
            canSend = true;
            if (resolveResume) {
                const resolve = resolveResume;
                resolveResume = null;
                resolve();
            }
        }
    });
    
    // Wait until main thread signals it's ready for more data
    const waitForResume = async () => {
        if (canSend) return;
        await new Promise(resolve => { resolveResume = resolve; });
    };
    
    // The "*" next to function stands for this function to be a generator which returns an iterator
    // This function is used to run Gromacs in a spawned child process and retrieve the output line by line
    // The full command passed to this function is to be: gmx dump -f path/to/trajectory
    const yieldCommandOutputPerLines = async function*(command, args) {
        // "spawn" runs the provided programm in an additional process (child process)
        // The expected command here may be for example "gmx", which runs Gromacs
        // Gromacs is an independent program which must be installed in the computer
        // WARNING!!
        // Problems related to this child process not returning data may be related to backpressure
        // The spawned Gromacs process will only return data if this data is consumed
        // If data si not consumed the process sleeps. This is a default behaviour
        // WARNING!! 'detached: true' prevents this child to be killed when user makes control + C
        const spawnedProcess = spawn(command, args, { detached: true });
        // If there is no output stream then return here
        if (!spawnedProcess.stdout) return;
        // Track the current stream
        let previous = '';
        for await (const chunk of spawnedProcess.stdout) {
            // Add the new chunk to the current stream
            previous += chunk;
            // End of line (\n) index
            let eolIndex;
            // This while is runned multiple times for each chunk
            while ((eolIndex = previous.indexOf('\n')) >= 0) {
                // Yields a new string which is made by the characters from 0 to "eolIndex" in "previous"
                // This yield does no include the end of line
                yield previous.slice(0, eolIndex);
                // Removes the yielded slice from the "previous" including the end of line
                previous = previous.slice(eolIndex + 1);
            }
        }
        // Finally, if there is remaining data, send it
        if (previous.length > 0) {
            yield previous;
        }
    };
    
    // Parse trajectory and send chunks to main thread
    (async () => {
        // Run a gromacs 'dump' command to read a gromacs trajectroy file and output their coordinates in a human readable format
        const commandArgs = ['dump', '-f', filepath];
        // Pre-allocate a batch buffer
        const atomBatchBuffer = Buffer.alloc(BYTES_PER_ATOM * BATCH_SIZE);
        let batchOffset = 0;
        // Iterate over the command output lines
        for await (const line of yieldCommandOutputPerLines(gromacsCommand, commandArgs)) {
            // Save matches with a long RegExp pattern defined above
            const match = line.match(COORDINATES_REGEXP);
            if (!match) {
                // try to check if it's a "frame number" line
                if (FRAME_REGEXP.test(line)) {
                    // Flush remaining buffer before frame update
                    if (batchOffset > 0) {
                        await waitForResume(); // Backpressure: wait if queue is full
                        parentPort.postMessage({ type: 'data', buffer: Buffer.from(atomBatchBuffer.subarray(0, batchOffset)) });
                        batchOffset = 0;
                    }
                    // Send a log update signal every time a new frame is completed
                    parentPort.postMessage({ type: 'frame' });
                }
                continue; // Next line
            }
            // Write coordinates at the current batch offset
            atomBatchBuffer.writeFloatLE(+match[1] * UNIT_CONVERSION_SCALE, batchOffset);     // x
            atomBatchBuffer.writeFloatLE(+match[2] * UNIT_CONVERSION_SCALE, batchOffset + 4); // y
            atomBatchBuffer.writeFloatLE(+match[3] * UNIT_CONVERSION_SCALE, batchOffset + 8); // z
            batchOffset += BYTES_PER_ATOM;
            
            // Yield when batch is full
            if (batchOffset >= atomBatchBuffer.length) {
                await waitForResume(); // Backpressure: wait if queue is full
                //Buffer.from() creates a copy, safe for async consumers
                parentPort.postMessage({ type: 'data', buffer: Buffer.from(atomBatchBuffer) });
                batchOffset = 0;
            }
        }
        
        // Flush any remaining data
        if (batchOffset > 0) {
            await waitForResume(); // Backpressure: wait if queue is full
            parentPort.postMessage({ type: 'data', buffer: Buffer.from(atomBatchBuffer.subarray(0, batchOffset)) });
        }
        
        parentPort.postMessage({ type: 'done' });
    })();
    
} else {
    // ===================== MAIN THREAD CODE =====================
    
    // Read a trajectory file while coordinates are parsed to float32 binary data
    const readAndParseTrajectory = async function* (filepath, gromacsCommand, newFrameUpdate, abort) {
        // Track the last time we checked if the load was aborted
        let lastCheck = Date.now();
        
        // Create worker thread for parsing
        const worker = new Worker(__filename, {
            workerData: { filepath, gromacsCommand }
        });
        
        // Queue to hold chunks from worker until consumed
        // BACKPRESSURE MECHANISM: Without limiting queue size, the worker produces data
        // faster than MongoDB can upload. The difference accumulates in this queue, causing
        // memory to grow (potentially to GB). When heap fills up, Node.js triggers garbage
        // collection (GC), which pauses ALL JavaScript execution for 50-500ms, causing gaps
        // in network upload (the scattered pattern in monitoring).
        // Solution: pause worker when queue reaches MAX_QUEUE_SIZE, resume when it drains.
        const chunkQueue = [];
        let resolveWaiting = null;
        let isDone = false;
        let workerError = null;
        let workerPaused = false; // Track if worker is paused due to backpressure
        
        // Handle messages from worker
        worker.on('message', (msg) => {
            if (msg.type === 'data') {
                chunkQueue.push(Buffer.from(msg.buffer));
                // Pause worker if queue is getting too large
                if (chunkQueue.length >= MAX_QUEUE_SIZE && !workerPaused) {
                    workerPaused = true;
                    worker.postMessage({ type: 'pause' });
                }
                if (resolveWaiting) {
                    const resolve = resolveWaiting;
                    resolveWaiting = null;
                    resolve();
                }
            } else if (msg.type === 'frame') {
                // Signal frame update - push a special marker
                chunkQueue.push({ isFrame: true });
                if (resolveWaiting) {
                    const resolve = resolveWaiting;
                    resolveWaiting = null;
                    resolve();
                }
            } else if (msg.type === 'done') {
                isDone = true;
                if (resolveWaiting) {
                    const resolve = resolveWaiting;
                    resolveWaiting = null;
                    resolve();
                }
            }
        });
        
        worker.on('error', (err) => {
            workerError = err;
            isDone = true;
            if (resolveWaiting) {
                const resolve = resolveWaiting;
                resolveWaiting = null;
                resolve();
            }
        });
        
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
            
            // Resume worker if queue has drained below threshold
            if (workerPaused && chunkQueue.length < MAX_QUEUE_SIZE / 2) {
                workerPaused = false;
                worker.postMessage({ type: 'resume' });
            }
            
            // Handle frame marker
            if (item.isFrame) {
                newFrameUpdate(); // Send a log update signal every time a new frame is completed
                continue;
            }
            
            // Check once per second if the process has been aborted
            const now = Date.now();
            if (now > lastCheck + 1000) {
                if (await abort()) {
                    worker.terminate();
                    process.exit(0);
                }
                lastCheck = now;
            }
            
            // Yield the data chunk
            yield item;
        }
        
        // Ensure worker is terminated
        await worker.terminate();
    };

    module.exports = readAndParseTrajectory;
}