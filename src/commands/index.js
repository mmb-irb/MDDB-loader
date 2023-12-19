// Allows to read some actions that user may call through the keyboard or exit the node shell
const process = require('process');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// The project manager class
const getDatabase = require('../database/index');

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
  const spinnerRef = database.spinnerRef;

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
      // In case of any error happening stop the spinner
      if (spinnerRef.current && spinnerRef.current.running)
        spinnerRef.current.fail(`Interrupted while doing: ${spinnerRef.current.text}`);
    }
    // In case the abort was already in progress and we receive a new 'abort' request
    else {
      // We instantly kill the whole process
      // This would lead to generate trash data in the database
      console.error(chalk.bgRed('Process was instantly killed. Trash data may have been generated in the database'));
      process.exit(0);
    }
  });

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
    process.env.abort = 'abort';
    // Stop the spinner
    if (spinnerRef.current && spinnerRef.current.running)
      spinnerRef.current.fail(`Interrupted while doing: ${spinnerRef.current.text}`);
    if (error) console.error(chalk.bgRed(error.stack));
    // Try to revert changes
    await database.revertLoad();
  } finally {
    // End mongo client
    const client = database.client;
    if (client && client.close) client.close();
    // Exit the node shell. The "0" argument stands for success
    process.exit(0);
  }
};

module.exports = commonHandler;
