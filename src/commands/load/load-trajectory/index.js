// It is used to interrupt stream flows
const devNull = require('dev-null');
const throttle = require('lodash.throttle');
// This tool converts miliseconds (ms) to a more human friendly string (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');
const executeCommandPerLine = require('../../../utils/execute-command-per-line');

// Constants
const UNIT_CONVERSION_SCALE = 10;
const N_COORDINATES = 3;
// example matches:
// '      x[    0]={ 6.40500e+00,  7.53800e+00,  9.81800e+00}'
// '      x[35999]={-8.50000e-02,  1.82000e+00,  7.23700e+00}'
const COORDINATES_REGEXP = /^\s*x\[\s*\d*]={\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2})\s*}\s*$/;
const FRAME_REGEXP = / frame \d+:$/;
const THROTTLE_TIME = 1000; // 1 second
const TIMEOUT_WARNING = 30000; // 30 seconds

// Call fe function "loadTrajectory" fo each filename in "filenames"
const loadTrajectories = async (folder, filenames, ...args) => {
  const output = [];
  for (const filename of filenames) {
    output.push(await loadTrajectory(folder, filename, ...args));
  }
  return output;
};

const loadTrajectory = (
  folder,
  filename,
  bucket,
  files,
  projectID,
  gromacsCommand, // It is the gromacs-path from the spinner
  dryRun,
  spinnerRef,
) => {
  // Display the start of this process in console
  spinnerRef.current = getSpinner().start(
    `Loading trajectory file '${filename}'`,
  );
  // Track the current frame
  let frameCount = 0;
  let timeoutID;
  // This throttle calls the specified function every "THROTTLE_TIME" seconds (1 second)
  const updateSpinner = throttle(() => {
    // Update the spiner periodically to show the user the time taken for the running process
    spinnerRef.current.text = `Loading trajectory file '${filename}' (frame ${frameCount} in ${prettyMs(
      Date.now() - spinnerRef.current.time,
    )})`;
    // logic to warn user if something seems to be getting stuck
    if (timeoutID) clearTimeout(timeoutID); // Cancel the last timeout if exist
    timeoutID = setTimeout(() => {
      spinnerRef.current.text = `Loading trajectory file '${filename}' (frame ${frameCount} in ${prettyMs(
        Date.now() - spinnerRef.current.time,
      )}) ${chalk.yellow(
        '⚠️ Timeout warning: nothing happened in the last 30 seconds',
      )}`;
    }, TIMEOUT_WARNING);
  }, THROTTLE_TIME);

  return new Promise(async (resolve, reject) => {
    // keep a buffer handy for reuse for every atoms in every frame
    // Allocate a new buffer of the provided size
    // Float32Array.BYTES_PER_ELEMENT corresponds to 4
    const coordinatesBuffer = Buffer.alloc(
      Float32Array.BYTES_PER_ELEMENT * N_COORDINATES,
    );
    // This assembly runs Gromacs as a paralel process which returns an output in string chunks
    // These strings are converted in standarized "lines"
    const asyncLineGenerator = executeCommandPerLine(gromacsCommand, [
      // Arguments sent to Gromacs
      'dump',
      '-f',
      folder + filename,
    ]);
    // Set the name for the new file stored in mongo
    let dbFilename = 'trajectory.bin';
    const pcaMatch = filename.match(/\.(pca-\d+)\./i);
    if (pcaMatch) dbFilename = `trajectory.${pcaMatch[1]}.bin`;
    // Manage the dryRun option
    const uploadStream = dryRun
      ? devNull() // If dryRun is true then interrupt the stream flow
      : // Else, open an upload stream to mongo
        bucket.openUploadStream(dbFilename, {
          contentType: 'application/octet-stream',
          chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });

    // error
    uploadStream.on('error', error => {
      // Display the end of this process as failure in console
      spinnerRef.current.fail(error);
      reject();
    });

    // finish
    uploadStream.on('finish', async ({ _id, length }) => {
      updateSpinner.cancel();
      if (timeoutID) clearTimeout(timeoutID);
      // Display the end of this process as success in console
      spinnerRef.current.succeed(
        `Loaded trajectory file '${filename}' (${frameCount} frames)`,
      );
      const trajectoryFileDescriptor = (await files.findOneAndUpdate(
        { _id },
        {
          $set: {
            metadata: {
              frames: frameCount,
              atoms:
                length /
                frameCount /
                Float32Array.BYTES_PER_ELEMENT /
                N_COORDINATES,
              project: projectID,
            },
          },
        },
        { returnOriginal: false },
      )).value;
      // resolve with number of frames
      resolve(trajectoryFileDescriptor);
    });

    // for each atom coordinates in the data
    for await (const line of asyncLineGenerator) {
      // Save matches with a long RegExp pattern defined above
      const match = line.match(COORDINATES_REGEXP);
      if (!match) {
        // try to check if it's a "frame number" line
        if (FRAME_REGEXP.test(line)) {
          frameCount++;
          updateSpinner(); // NO ACABO DE COMPRENDER COMO FUNCIONA ESTO
        }
        continue; // Next line
      }

      // convert units
      coordinatesBuffer.writeFloatLE(+match[1] * UNIT_CONVERSION_SCALE, 0); // x
      coordinatesBuffer.writeFloatLE(+match[2] * UNIT_CONVERSION_SCALE, 4); // y
      coordinatesBuffer.writeFloatLE(+match[3] * UNIT_CONVERSION_SCALE, 8); // z

      // In case of overload stop writing streams and wait until the drain is resolved
      const keepGoing = uploadStream.write(coordinatesBuffer);
      if (!keepGoing) {
        await new Promise(resolve => uploadStream.once('drain', resolve));
      }
    }

    uploadStream.end();
  });
};

module.exports = loadTrajectories;
