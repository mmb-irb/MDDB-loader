/**
 * Compare the xtc decoder with GROMACS on whole trajectories, frame by frame and bit by bit
 *
 * Not a jest test: it needs GROMACS with "gmx dump -bin" (the gromacs_mddb package) and real trajectories
 * Run with: node src/utils/xtc-decoder/check-parity.js <gmx> <trajectory.xtc> [more trajectories]
 * It exits with 1 if any trajectory differs
 */
const { readXtcFrames } = require('.');
const { dumpFrame, describeDifference, streamDump } = require('./dump-bin');

// Compare one trajectory. Returns a line with the result, starting with OK or DIFFERENT
const checkParity = async (gmx, filepath) => {
    const start = Date.now();
    const ours = readXtcFrames(filepath);
    const theirs = streamDump(gmx, filepath);
    let frames = 0;
    let bytes = 0;
    let difference;
    let end;
    let ending;
    try {
        while (!difference) {
            const their = await theirs.next();
            if (their.done) {
                ending = their.value;
                break;
            }
            const our = ours.next();
            if (our.done) {
                difference = `the decoder has ${frames} frames and GROMACS has more`;
                break;
            }
            const frame = dumpFrame(our.value);
            if (!frame.equals(their.value)) difference = `frame ${frames}: ${describeDifference(frame, their.value)}`;
            else {
                frames++;
                bytes += frame.length;
            }
        }
        // GROMACS is done: so must be the decoder
        if (!difference) {
            const our = ours.next();
            if (!our.done) difference = `GROMACS has ${frames} frames and the decoder has more`;
            else end = our.value;
        }
    } catch (error) {
        difference = `after ${frames} frames: ${error.message}`;
    } finally {
        // Stop GROMACS if we stopped before it did
        await theirs.return();
    }
    if (!difference && ending.code !== 0) difference = `GROMACS failed (${ending.code}) ${ending.failure}`;
    if (!difference && ending.incomplete !== end.incomplete)
        difference = `incomplete last frame: ${end.incomplete} in the decoder, ${ending.incomplete} in GROMACS`;
    const seconds = (Date.now() - start) / 1000;
    const megabytes = (bytes / 1000000).toFixed(0);
    return difference
        ? `DIFFERENT ${filepath}: ${difference}`
        : `OK ${filepath}: ${frames} frames (${megabytes} MB) identical${end.incomplete ? ', incomplete last frame' : ''}, in ${seconds.toFixed(1)} s`;
};

const main = async () => {
    const [gmx, ...filepaths] = process.argv.slice(2);
    if (!gmx || filepaths.length === 0) {
        console.error('Usage: node check-parity.js <gmx> <trajectory.xtc> [more trajectories]');
        process.exit(2);
    }
    let failed = false;
    for (const filepath of filepaths) {
        const result = await checkParity(gmx, filepath);
        console.log(result);
        if (!result.startsWith('OK')) failed = true;
    }
    process.exit(failed ? 1 : 0);
};

main();
