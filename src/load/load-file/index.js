const fs = require('fs');
const devNull = require('dev-null');
const chalk = require('chalk');

const loadFile = (folder, filename, bucket, dryRun) =>
  new Promise((resolve, reject) => {
    if (!(folder && filename)) {
      return reject(new Error('Need to pass a folder and a filename'));
    }
    try {
      const stream = fs.createReadStream(folder + filename);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(dryRun ? devNull() : bucket.openUploadStream(filename));
    } catch (error) {
      console.error(chalk.bgRed(error));
      reject(error);
    }
  });

module.exports = loadFile;
