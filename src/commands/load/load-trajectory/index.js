const devNull = require('dev-null');
const throttle = require('lodash.throttle');
const prettyMs = require('pretty-ms');
const chalk = require('chalk');

const getSpinner = require('../../../utils/get-spinner');
const executeCommandPerLine = require('../../../utils/execute-command-per-line');

const UNIT_CONVERSION_SCALE = 10;
const N_COORDINATES = 3;

// example matches:
// '      x[    0]={ 6.40500e+00,  7.53800e+00,  9.81800e+00}'
// '      x[35999]={-8.50000e-02,  1.82000e+00,  7.23700e+00}'
const COORDINATES_REGEXP = /^\s*x\[\s*\d*]={\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2})\s*}\s*$/;
const FRAME_REGEXP = / frame \d+:$/;

const THROTTLE_TIME = 1000; // 1 second
const TIMEOUT_WARNING = 30000; // 30 seconds

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
  gromacsCommand,
  dryRun,
  spinnerRef,
) => {
  spinnerRef.current = getSpinner().start(
    `Loading trajectory file '${filename}'`,
  );

  let frameCount = 0;
  let timeoutID;
  const updateSpinner = throttle(() => {
    spinnerRef.current.text = `Loading trajectory file '${filename}' (frame ${frameCount} in ${prettyMs(
      Date.now() - spinnerRef.current.time,
    )})`;
    // logic to warn user if something seems to be getting stuck
    if (timeoutID) clearTimeout(timeoutID);
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
    const coordinatesBuffer = Buffer.alloc(
      Float32Array.BYTES_PER_ELEMENT * N_COORDINATES,
    );

    const asyncLineGenerator = executeCommandPerLine(gromacsCommand, [
      'dump',
      '-f',
      folder + filename,
    ]);

    let dbFilename = 'trajectory.bin';
    const pcaMatch = filename.match(/\.(pca-\d+)\./i);
    if (pcaMatch) dbFilename = `trajectory.${pcaMatch[1]}.bin`;

    const uploadStream = dryRun
      ? devNull()
      : bucket.openUploadStream(dbFilename, {
          contentType: 'application/octet-stream',
          chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });

    // error
    uploadStream.on('error', error => {
      spinnerRef.current.fail(error);
      reject();
    });

    // finish
    uploadStream.on('finish', async ({ _id, length }) => {
      updateSpinner.cancel();
      if (timeoutID) clearTimeout(timeoutID);
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
      const match = line.match(COORDINATES_REGEXP);
      if (!match) {
        // try to check if it's a "frame number" line
        if (FRAME_REGEXP.test(line)) {
          frameCount++;
          updateSpinner();
        }
        continue;
      }

      // convert units
      coordinatesBuffer.writeFloatLE(+match[1] * UNIT_CONVERSION_SCALE, 0); // x
      coordinatesBuffer.writeFloatLE(+match[2] * UNIT_CONVERSION_SCALE, 4); // y
      coordinatesBuffer.writeFloatLE(+match[3] * UNIT_CONVERSION_SCALE, 8); // z

      const keepGoing = uploadStream.write(coordinatesBuffer);

      if (!keepGoing) {
        await new Promise(resolve => uploadStream.once('drain', resolve));
      }
    }

    uploadStream.end();
  });
};

module.exports = loadTrajectories;
