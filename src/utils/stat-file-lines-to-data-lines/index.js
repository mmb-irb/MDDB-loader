const WHITE_SPACE = /\s+/;
const COMMENT_LINE = /^[#@&]/;

// This function converts data by reading text lines and returning arrays
// By default, comment lines are skipped and not returned (e.g. '# This is a comment')
// If the emitCommentSymbol is passed as true, return a comment 'Symbol' class
const statFileLinesToDataLines = async function*(lines) {
  // 'lines' are expected to come from a readFilePerLine()
  for await (const line of lines || []) {
    // Remove surrounding white spaces
    let processedLine = line.trim();
    if (!processedLine) continue;
    // If there is data left, check if the line is commented
    if (COMMENT_LINE.test(processedLine)) {
      // Emmit comment simbols only in case this option is marked as true
      //if (emitCommentSymbol) yield COMMENT_SYMBOL;
      yield processedLine;
    } else {
      // If line is not commented, return it as an array of words (in this case, numbers)
      // (e.g.) 5517   0.1287 -> [ 5517 , 0.1287 ]
      yield processedLine.split(WHITE_SPACE).map(cell => {
        if (Number.isFinite(+cell)) return +cell;
        else return cell;
      });
    }
  }
};
// Export also the regexp pattern, so other scripts can access to it
statFileLinesToDataLines.COMMENT_LINE = COMMENT_LINE;

module.exports = statFileLinesToDataLines;
