const devNull = require('dev-null');
const ora = require('ora');

const executeCommandPerLine = require('../../utils/execute-command-per-line');

const UNIT_CONVERSION_SCALE = 10;

// example matches:
// '      x[    0]={ 6.40500e+00,  7.53800e+00,  9.81800e+00}'
// '      x[35999]={-8.50000e-02,  1.82000e+00,  7.23700e+00}'
const COORDINATES_REGEXP = /^\s*x\[\s*\d*]={\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2})\s*}\s*$/;
const FRAME_REGEXP = / frame \d+:$/;

const loadTrajectory = (folder, filename, gromacsCommand, bucket, dryRun) => {
  const spinner = ora().start(`Loading trajectory file '${filename}'`);
  spinner.time = Date.now();
  return new Promise(async (resolve, reject) => {
    let frameCount = 0;
    // keep a buffer handy for reuse for every atoms in every frame
    const coordinatesBuffer = Buffer.alloc(Float32Array.BYTES_PER_ELEMENT * 3);

    const asyncLineGenerator = executeCommandPerLine(gromacsCommand, [
      'dump',
      '-f',
      folder + filename,
    ]);

    const uploadStream = dryRun
      ? devNull()
      : bucket.openUploadStream('trajectory.bin');
    uploadStream.on('error', error => {
      spinner.fail(error);
      reject();
    });
    uploadStream.on('finish', trajectoryFileDescriptor => {
      spinner.succeed(
        `Loaded trajectory file '${filename}' (${frameCount} frames in ${Math.round(
          (Date.now() - spinner.time) / 1000,
        )}s)`,
      );
      // resolve with number of frames
      resolve({ trajectoryFileDescriptor, frameCount });
    });
    // for each atom coordinates in the data
    for await (const line of asyncLineGenerator) {
      const match = line.match(COORDINATES_REGEXP);
      if (!match) {
        // try to check if it's a "frame number" line
        if (FRAME_REGEXP.test(line)) {
          frameCount++;
          spinner.text = `Loading trajectory file '${filename}' (frame ${frameCount})`;
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

module.exports = loadTrajectory;
