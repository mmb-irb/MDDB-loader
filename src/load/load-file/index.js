const fs = require('fs');
const devNull = require('dev-null');

const loadFile = (folder, filename, bucket, dryRun) =>
  new Promise((resolve, reject) => {
    if (!(folder && filename)) {
      return reject(new Error('Need to pass a folder and a filename'));
    }
    try {
      const stream = fs.createReadStream(folder + filename);
      stream.on('error', () => reject);
      stream.on('finish', resolve);
      stream.pipe(dryRun ? devNull() : bucket.openUploadStream(filename));
    } catch (error) {
      reject(error);
    }
  });

module.exports = loadFile;
