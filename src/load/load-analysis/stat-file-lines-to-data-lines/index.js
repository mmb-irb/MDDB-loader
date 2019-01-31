const WHITE_SPACE = /\s+/;
const statFileLinesToDataLines = async function*(lines) {
  for await (const line of lines || []) {
    let processsedLine = line.trim();
    if (!processsedLine) continue;
    if (processsedLine.startsWith('#')) continue;
    if (processsedLine.startsWith('@')) continue;
    yield processsedLine.split(WHITE_SPACE).map(cell => +cell);
  }
};

module.exports = statFileLinesToDataLines;
