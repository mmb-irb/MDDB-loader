const WHITE_SPACE = /\s+/;
const SKIP_LINE = /^[#@&]/;

const statFileLinesToDataLines = async function*(lines) {
  for await (const line of lines || []) {
    let processsedLine = line.trim();
    if (!processsedLine) continue;
    if (SKIP_LINE.test(processsedLine)) continue;
    yield processsedLine.split(WHITE_SPACE).map(cell => +cell);
  }
};

module.exports = statFileLinesToDataLines;
