const fs = require('fs');
const devNull = require('dev-null');

const loadFile = (folder, filename, bucket, dryRun) =>
  new Promise((resolve, reject) => {
    fs.createReadStream(folder + filename)
      .pipe(dryRun ? devNull() : bucket.openUploadStream(filename))
      .on('error', reject)
      .on('finish', resolve);
  });

module.exports = loadFile;
