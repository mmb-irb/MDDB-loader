const fs = require('fs');

const readStreamPerLine = require('../read-stream-per-line');

// Read a file and return its text line by line in an async stream format
const readFilePerLine = async function*(paths) {
  // If there is no paths, stop here
  if (!paths) return;
  // If paths is not an array but a single string, convert it into an array
  if (typeof paths === 'string') paths = [paths];
  // For each path start reading files and generating text lines
  for (let i = 0; i < paths.length; i++) {
    const readStream = fs.createReadStream(paths[i], {
      encoding: 'utf8',
      highWaterMark: 1024,
    });
    yield* readStreamPerLine(readStream);
  }
};

module.exports = readFilePerLine;
