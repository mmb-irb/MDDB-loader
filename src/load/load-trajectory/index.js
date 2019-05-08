const devNull = require('dev-null');
const ora = require('ora');
const throttle = require('lodash.throttle');

const executeCommandPerLine = require('../../utils/execute-command-per-line');

const UNIT_CONVERSION_SCALE = 10;
const N_COORDINATES = 3;

// example matches:
// '      x[    0]={ 6.40500e+00,  7.53800e+00,  9.81800e+00}'
// '      x[35999]={-8.50000e-02,  1.82000e+00,  7.23700e+00}'
const COORDINATES_REGEXP = /^\s*x\[\s*\d*]={\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2})\s*}\s*$/;
const FRAME_REGEXP = / frame \d+:$/;

const THROTTLE_TIME = 1000;

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
) => {
  const spinner = ora().start(`Loading trajectory file '${filename}'`);
  spinner.time = Date.now();
  let frameCount = 0;
  const updateSpinner = throttle(
    () =>
      (spinner.text = `Loading trajectory file '${filename}' (frame ${frameCount})`),
    THROTTLE_TIME,
  );

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
        });

    // error
    uploadStream.on('error', error => {
      spinner.fail(error);
      reject();
    });

    // finish
    uploadStream.on('finish', async ({ _id, length }) => {
      updateSpinner.cancel();
      spinner.succeed(
        `Loaded trajectory file '${filename}' (${frameCount} frames in ${Math.round(
          (Date.now() - spinner.time) / 1000,
        )}s)`,
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
