const { spawn } = require('child_process');

const readStreamPerLine = require('../read-stream-per-line');

const executeCommandPerLine = async function*(command, args) {
  const spawnedProcess = spawn(command, args);

  yield* readStreamPerLine(spawnedProcess.stdout);
};

module.exports = executeCommandPerLine;
