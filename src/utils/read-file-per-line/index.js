const fs = require('fs');

const readFilePerLine = async function*(path) {
  const readStream = fs.createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: 1024,
  });

  let previous = '';
  for await (const chunk of readStream) {
    previous += chunk;
    let eolIndex;
    while ((eolIndex = previous.indexOf('\n')) >= 0) {
      // line includes EOL, yield line (without EOL)
      yield previous.slice(0, eolIndex);

      previous = previous.slice(eolIndex + 1);
    }
  }
  if (previous.length > 0) {
    yield previous;
  }
};

module.exports = readFilePerLine;
