const fs = require('fs');

const readStreamPerLine = require('../read-stream-per-line');

const readFilePerLine = async function*(path) {
  if (!path) return;
  const readStream = fs.createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: 1024,
  });

  yield* readStreamPerLine(readStream);
};

module.exports = readFilePerLine;
