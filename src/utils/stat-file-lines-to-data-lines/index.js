const WHITE_SPACE = /\s+/;
const COMMENT_LINE = /^[#@&]/;

const COMMENT_SYMBOL = Symbol('comment');

const statFileLinesToDataLines = async function*(
  lines,
  { emitCommentSymbol = false } = {},
) {
  for await (const line of lines || []) {
    let processsedLine = line.trim();
    if (!processsedLine) continue;
    if (COMMENT_LINE.test(processsedLine)) {
      if (emitCommentSymbol) yield COMMENT_SYMBOL;
    } else {
      yield processsedLine.split(WHITE_SPACE).map(cell => +cell);
    }
  }
};
statFileLinesToDataLines.COMMENT_SYMBOL = COMMENT_SYMBOL;

module.exports = statFileLinesToDataLines;
