// Allows to call a unix command or run another script
// The execution of this code keeps running
const { spawn } = require('child_process');

// Constants
const UNIT_CONVERSION_SCALE = 10;
const N_COORDINATES = 3;
const BYTES_PER_ATOM = Float32Array.BYTES_PER_ELEMENT * N_COORDINATES;
// example matches:
// '      x[    0]={ 6.40500e+00,  7.53800e+00,  9.81800e+00}'
// '      x[35999]={-8.50000e-02,  1.82000e+00,  7.23700e+00}'
const COORDINATES_REGEXP = /^\s*x\[\s*\d*]={\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2})\s*}\s*$/;
const FRAME_REGEXP = / frame \d+:$/;

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

// Read a trajectory file while coordinates are parsed to float32 binary data
const readAndParseTrajectory = async function* (filepath, gromacsCommand, newFrameUpdate, abort) {
    // Track the last time we checked if the load was aborted
    let lastCheck = Date.now();
    // Run a gromacs 'dump' command to read a gromacs trajectroy file and output their coordinates in a human readable format
    const commandArgs = [ 'dump', '-f', filepath ];
    // Iterate over the command output lines
    for await (const line of yieldCommandOutputPerLines(gromacsCommand, commandArgs)) {
        // Check once per second if the process has been aborted
        const now = Date.now();
        if (now > lastCheck + 1000) {
            if (await abort()) process.exit(0);
            lastCheck = now;
        }
        // Save matches with a long RegExp pattern defined above
        const match = line.match(COORDINATES_REGEXP);
        if (!match) {
            // try to check if it's a "frame number" line
            if (FRAME_REGEXP.test(line)) {
                newFrameUpdate(); // Send a log update signal every time a new frame is completed
            }
            continue; // Next line
        }
        // convert units
        // DANI: Anteriormente el buffer era alocado fuera del loop y reutilizado
        // DANI: Esto no era seguro así que he hecho que se declare cada vez
        // DANI: El rendimineto es el mismo, pero no he comprovado a fondo si hay fuga de memoria
        const coordinatesBuffer = Buffer.alloc(BYTES_PER_ATOM);
        coordinatesBuffer.writeFloatLE(+match[1] * UNIT_CONVERSION_SCALE, 0); // x
        coordinatesBuffer.writeFloatLE(+match[2] * UNIT_CONVERSION_SCALE, 4); // y
        coordinatesBuffer.writeFloatLE(+match[3] * UNIT_CONVERSION_SCALE, 8); // z
        yield coordinatesBuffer;
    }
};

module.exports = readAndParseTrajectory;