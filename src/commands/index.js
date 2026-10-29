// Allows to read some actions that user may call through the keyboard or exit the node shell
const process = require('process');
// This utility displays in console a dynamic loading status
const logger = require('../utils/logger');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// The project manager class
const getDatabase = require('../database/index');
// Exit codes for errors and interruptions
const { ERROR_EXIT_CODE, INTERRUPTION_EXIT_CODE } = require('../utils/constants');

// This handler calls the requested command
// Also contains common logic for all commands which is runned before and after the main command:
// - Process tracking and console output
// - Mongo database connection/disconnection
// - Error handling and node shell exit
// "argv" is a normal object passed from yargs library
// This object contains the input values of options and positionals from the command
// e.g. in load command, argv contains the values of {folder, gromacs-path}
const commonHandler = commandName => async argv => {
  //console.log(argv);

  // Initialize the database handler
  const database = await getDatabase();

  // When the process is interrupted from the keyboard (Control + C)
  process.on('SIGINT', async () => {
    console.log(chalk.red('\nCaught interrupt signal'));
    // Use this line to display memory usage
    //console.log(process.memoryUsage().rss);

    // Set the environmental variable abort in case it is not set yet
    // This variable is read constantly at different point of the load command
    // If this variable conatains any text, the load process will try to exit cleanly
    if (!process.env.abort) {
      process.env.abort = 'abort';
      // In case of any error happening stop the logger
      // Note that we must not throw an error here or the process would be killed before asking the user
      if (logger.isLogRunning()) logger.stopFailLog(`Aborted while doing: ${logger.logText()}`);
    }
    // In case the abort was already in progress and we receive a new 'abort' request
    else {
      // We instantly kill the whole process
      // This would lead to generate trash data in the database
      console.error(chalk.bgRed('Process was instantly killed. Trash data may have been generated in the database'));
      process.exit(INTERRUPTION_EXIT_CODE);
    }
  });

  // Exit with an error code if something goes wrong
  let exitCode = 0;

  // Run the command wrapped by a try
  // This way we can catch the fail and better log the error if something goes wrong
  try {
    // Each command has its own script
    // Folders containing these scripts have the same command name
    // Find which script must be loaded according to the command name
    const command = require(`./${commandName}`);
    // Call the requested command while passing all the arguments
    const finalMessage = await command(argv, database);
    if (finalMessage) finalMessage();
  } catch (error) {
    exitCode = ERROR_EXIT_CODE;
    process.env.abort = 'abort';
    // Stop the logger
    // Note that we must not throw an error here or the changes would not be reverted
    if (logger.isLogRunning()) logger.stopFailLog(`Interrupted while doing '${logger.logText()}' due to error:\n${error.stack}`);
    else if (error) console.error(chalk.bgRed(error.stack));
    // Try to revert changes
    // When overwriting we are updating the project, so changes are never reverted and the new data is kept
    // Note that the overwritten data was already deleted, so reverting would leave the project without it
    // When conserving, the previous data is never deleted, so we can safely revert without asking
    if (!argv.overwrite) await database.revertLoad(argv.conserve);
  } finally {
    // End mongo client
    const client = database.client;
    if (client && client.close) client.close();
    // Exit the node shell. The "0" exit code stands for success
    process.exit(exitCode);
  }
};

module.exports = commonHandler;
