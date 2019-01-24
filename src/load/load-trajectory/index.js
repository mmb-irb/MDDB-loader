const devNull = require('dev-null');

const readFilePerLine = require('../../utils/read-file-per-line');

const MULTIPLE_WHITE_SPACES = /\s+/;

const loadTrajectory = (folder, filename, bucket, dryRun) =>
  new Promise(async (resolve, reject) => {
    const asyncLineGenerator = readFilePerLine(folder + filename);
    // skip first line (software comment);
    asyncLineGenerator.next();

    const uploadStream = dryRun
      ? devNull()
      : bucket.openUploadStream('trajectory.bin');
    uploadStream.on('error', reject);
    uploadStream.on('finish', resolve);

    for await (const line of asyncLineGenerator) {
      const keepGoing = uploadStream.write(
        Buffer.from(
          Float32Array.from(line.trim().split(MULTIPLE_WHITE_SPACES)).buffer,
        ),
      );

      if (!keepGoing) {
        await new Promise(resolve => uploadStream.once('drain', resolve));
      }
    }

    uploadStream.end();
  });

module.exports = loadTrajectory;
