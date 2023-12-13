// Small functions used along the whole loader

// Allows asking user for confirmation
const prompts = require('prompts');
// Add colors in console
const chalk = require('chalk');
// Allows to call a unix command or run another script
// The execution of this code keeps running
const { spawnSync } = require('child_process');

// Set some constants

// Set problematic signs for directory/folder names
FORBIDEN_DIRECTORY_CHARACTERS = ['.', ',', ';', ':']

// Throw a question for the user trough the console
// Await for the user to confirm
const userConfirm = async question => {
  const response = await prompts({
    type: 'text',
    name: 'confirm',
    message: question,
  });
  if (response.confirm) return response.confirm;
  return null;
};

// Usual question
const userConfirmDataLoad = async fieldname => {
  const confirm = await userConfirm(
    `'${fieldname}' already exists in the project. Confirm data loading:
    Y - Overwrite previous data with new data
    * - Conserve previous data and discard new data`
  ) === 'Y';
  // Warn the user about the consequences of its decision
  const message = confirm
    ? 'Previous data will be overwritten by the new data'
    : 'Previous data is conserved and the new data will be discarded';
  console.log(chalk.yellow(message));
  return confirm;
};

// Check if gromacs excutable is in path
// If a command is passed then use it
// Otherwiese, guess the gromacs command by try and fail
// Return the working command
const USUAL_GROMACS_COMMANDS = ['gmx', 'gmx_mpi']
const getGromacsCommand = command => {
  // Set the commands to try before we give up
  const commandsToTry = command ? [ command ] : USUAL_GROMACS_COMMANDS;
  for (const cmd of commandsToTry) {
    // Check if a command is installed in the system
    // WARNING: "error" is not used, but it must be declared in order to obtain the output
    const process = spawnSync(cmd, ['/?'], {encoding: 'utf8'});
    if (process.output !== null) return cmd;
  }
  // In case no grommacs command was found in the path we warn the user and stop here
  throw new Error('Gromacs is not installed or its source is not in $PATH');
};

// Translate a MD name to a MD directory
const mdNameToDirectory = name => {
  // Make all letters lower and replace white spaces by underscores
  let directory = name.toLowerCase().replace(' ', '_');
  // Remove problematic characters
  for (const character of FORBIDEN_DIRECTORY_CHARACTERS) {
    directory = directory.replace(character, '');
  }
  return directory
}

// Given a path with any number of steps, return the last step
const getBasename = path => {
  const steps = path.split('/');
  return steps[steps.length -1];
}

// This is just like an string array with the accepted formats
const mimeMap = new Map([['.pdb', 'chemical/x-pdb']]);

// Check if the provided filename has one of the accepted formats
// If it is, return the type. If not, return the "octet-stream" format.
const getMimeTypeFromFilename = filename => {
  for (const [extension, type] of mimeMap.entries()) {
    if (filename.toLowerCase().endsWith(extension)) return type;
  }
  // default
  return 'application/octet-stream';
};

module.exports = {
  userConfirm,
  userConfirmDataLoad,
  getGromacsCommand,
  mdNameToDirectory,
  getBasename,
  getMimeTypeFromFilename
};