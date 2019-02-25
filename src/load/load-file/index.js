const fs = require('fs');
const devNull = require('dev-null');
const chalk = require('chalk');

const mimeMap = new Map([['.pdb', 'chemical/x-pdb']]);

const getMimeTypeFromFilename = filename => {
  for (const [extension, type] of mimeMap.entries()) {
    if (filename.toLowerCase().endsWith(extension)) return type;
  }
  // default
  return 'application/octet-stream';
};

const loadFile = (folder, filename, bucket, dryRun) =>
  new Promise((resolve, reject) => {
    if (!(folder && filename)) {
      return reject(new Error('Need to pass a folder and a filename'));
    }
    try {
      const readStream = fs.createReadStream(folder + filename);
      const writeStream = dryRun
        ? devNull()
        : bucket.openUploadStream(filename, {
            contentType: getMimeTypeFromFilename(filename),
          });
      readStream.on('error', reject);
      writeStream.on('finish', resolve);
      readStream.pipe(writeStream);
    } catch (error) {
      console.error(chalk.bgRed(error));
      reject(error);
    }
  });

module.exports = loadFile;
