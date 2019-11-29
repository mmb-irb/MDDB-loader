// Allows to create an additional process
// i.e. another command or programm is runned in addition to this code, no instead
const { spawn } = require('child_process');
// Customized stream from utils
const readStreamPerLine = require('../read-stream-per-line');

// The "*" next to function stands for this function to be a generator which returns an iterator
const executeCommandPerLine = async function*(command, args) {
  // "spawn" runs the provided programm in an additional process
  // Thisway, the code below keeps running in paralel
  // The expected command here may be for example "gmx", which runs Gromacs
  // Gromacs is an independent program which is installed in the computer
  const spawnedProcess = spawn(command, args);
  // The "*" next to yield stands for this function to be a generator/iterator
  // The "spawnedProcess" resulting from spawn returns string chunks which are accessed trough ".stdout"
  yield* readStreamPerLine(spawnedProcess.stdout);
};

module.exports = executeCommandPerLine;
