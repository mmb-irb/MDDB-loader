const fs = require('fs');

const readStreamPerLine = require('../read-stream-per-line');

// Read a file and return its text line by line in an async stream format
// DANI: Esto antes era un generador al que le podías pasar varios paths a la vez
// DANI: Le quité esa opción porque era peligroso. Estubimos años cargando las proyecciones del pca en un orden incorrecto
const readFilePerLine = async function(path) {
  // If there is no paths, stop here
  if (!path) return;
  // For each path start reading files and generating text lines
  const readStream = fs.createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: 1024,
  });
  return readStreamPerLine(readStream);
};

module.exports = readFilePerLine;
