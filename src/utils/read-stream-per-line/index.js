const readStreamPerLine = async function*(readStream) {
  if (!readStream) return;

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

module.exports = readStreamPerLine;
