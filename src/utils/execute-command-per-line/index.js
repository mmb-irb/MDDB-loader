// Allows to call a unix command or run another script
// The execution of this code keeps running
const { spawn } = require('child_process');
// Customized stream from utils
const readStreamPerLine = require('../read-stream-per-line');

// The "*" next to function stands for this function to be a generator which returns an iterator
// This function is used to run Gromacs in a spawned child process and retrieve the output
// It is equivalent to type in the terminal this: gmx dump -f path/to/trajectory
const executeCommandPerLine = async function*(command, args) {
  // "spawn" runs the provided programm in an additional process (child process)
  // The expected command here may be for example "gmx", which runs Gromacs
  // Gromacs is an independent program which must be installed in the computer
  // WARNING!!
  // Problems related to this child process not returning data may be related to backpressure
  // The spawned Gromacs process will only return data if this data is consumed
  // If data si not consumed the process sleeps. This is a default behaviour
  // WARNING!! 'detached: true' prevents this child to be killed when user makes control + C
  const spawnedProcess = spawn(command, args, { detached: true });

  // The "*" next to yield stands for this function to be a generator/iterator
  // The "spawnedProcess" resulting from spawn returns chunks which are accessed trough ".stdout"
  yield* readStreamPerLine(spawnedProcess.stdout);
};

module.exports = executeCommandPerLine;
