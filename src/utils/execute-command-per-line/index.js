const { spawn } = require('child_process');

const readStreamPerLine = require('../read-stream-per-line');

const executeCommandPerLine = async function*(command, args) {
  const process = spawn(command, args);

  yield* readStreamPerLine(process.stdout);
};

module.exports = executeCommandPerLine;
