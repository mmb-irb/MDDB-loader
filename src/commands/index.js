// Allows to read some actions that user may call through the keyboard or exit the node shell
const process = require('process');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// The main database
const mongodb = require('mongodb');
// This utility displays in console a dynamic loading status
const getSpinner = require('../utils/get-spinner');

// NOTE: transaction logic is just being ignored for now
// NOTE: it's there so that eventually it will become useful (MongoDB >=4)

// This handler calls the requested command
// Also contains common logic for all commands which is runned before and after the main command:
// - Process tracking and console output
// - Mongo database connection/disconnection
// - Error handling and node shell exit
// "argv" is a normal object passed from yargs library
// This object contains the input values of options and positionals from the command
// e.g. in load command, argv contains the values of {folder, dry-run, gromacs-path}
const commonHandler = commandName => async argv => {
  let client;
  let session;
  let db;

  // copy React's idea of references so we can pass the reference to inner commands,
  // and still catch errors and interrupt spinner from here

  // The spinner displays in console a dynamic loading status (see getSpinner)
  // This object saves the access (both read and write) to the spinner methods and variables
  // Since this object is sealed, attributes can be written but not added or deteled
  const spinnerRef = Object.seal({ current: null });

  // keep reference to project ID in case we need to roll back
  // This object is sent empty to the load index.js, which saves a new mongo document on it
  const projectIdRef = Object.seal({ current: null });

  // When the process is interrupted from the keyboard (Control + C)
  process.on('SIGINT', async () => {
    console.log(chalk.red('Caught interrupt signal'));
    if (!(session && session.inTransaction())) {
      process.exit(0); // Exit the node shell. The "0" argument stands for success
      return;
    }
    // in case of any error happening
    // stop spinner
    if (spinnerRef.current && spinnerRef.current.running) {
      spinnerRef.current.fail(
        `Interrupted while doing: ${spinnerRef.current.text}`,
      );
    }
    // Display the interruption process in the console
    spinnerRef.current = getSpinner().start('Aborting current transaction');
    try {
      await session.abortTransaction();
      spinnerRef.current.succeed('Aborted current transaction');
      // If data have been saved, recommend user to run a clean up command
      if (projectIdRef.current) {
        console.error(
          chalk.bgRed('Please run the following command to clean up:'),
        );
        // Provide the exact command which must be used to remove the current project
        // argv.$0 stands for the script name or node command
        // projectIdRef.current returns the current project id
        console.error(
          chalk.bgRed(`"${argv.$0} cleanup ${projectIdRef.current}"`),
        );
      }
      process.exit(0); // Exit the node shell. The "0" argument stands for success
    } catch (_) {
      // If the aborting procedure was not canonical then send a failure message
      spinnerRef.current.fail(
        "Didn't manage to abort current transaction. Try to have a look inside the DB to see if everything is fine or if it needs manual clean-up",
      );
      process.exit(1); // Exit the node shell. The "1" argument stands for failure
    }
  });

  try {
    // Try to connect to mongo as client and get the data base
    try {
      client = await mongodb.MongoClient.connect(
        `mongodb://${process.env.DB_SERVER}:${process.env.DB_PORT}`,
        {
          auth: {
            user: process.env.DB_AUTH_USER,
            password: process.env.DB_AUTH_PASSWORD,
          },
          authSource: process.env.DB_AUTHSOURCE,
          useNewUrlParser: true,
          useUnifiedTopology: true,
        },
      );
      session = client.startSession();
      session.startTransaction();

      // Get the data base
      db = client.db(process.env.DB_NAME);
    } catch (error) {
      console.error(error);
      throw new Error(`Unable to connect to mongo instance or to database`);
    }

    // Each command has its own script
    // Folders containing these scripts have the same command name
    // Find which script must be loaded according to the command name
    const command = require(`./${commandName}`);
    // Call the requested command
    const finalMessage = await command(
      // "argv" is a normal object passed from yargs library
      // This object contains the input values of options and positionals from the command
      // e.g. in load command, argv contains the values of {folder, dry-run, gromacs-path}
      argv,
      // Also include extra stuff useful across all scripts
      { db, bucket: new mongodb.GridFSBucket(db), spinnerRef, projectIdRef },
    );

    // ESTA ESTO COMPLETO? POR QUE ESTÁ COMENTADO EL SPINER? HAY UNA NOTA ARRIBA.
    // commit transaction
    // spinnerRef.current = getSpinner().start('Committing to database');
    // Save changes made and end the transaction
    await session.commitTransaction();
    // spinnerRef.current.succeed('Committed to database');

    // NO ENTIENDO
    if (finalMessage) finalMessage();
  } catch (error) {
    // Stop the spinner
    if (spinnerRef.current && spinnerRef.current.running) {
      spinnerRef.current.fail(
        `Interrupted while doing: ${spinnerRef.current.text}`,
      );
    }
    // Abort transaction and track it with the spinner
    if (session && session.inTransaction()) {
      spinnerRef.current = getSpinner().start('Aborting current transaction');
      await session.abortTransaction();
      spinnerRef.current.succeed('Aborted current transaction');
    }

    if (error) console.error(chalk.bgRed(error.stack));

    // If data have been saved, recommend user to run a clean up command
    if (projectIdRef.current) {
      console.error(
        chalk.bgRed('Please run the following command to clean up:'),
      );
      // Provide the exact command which must be used to remove the current project
      // argv.$0 stands for the script name or node command
      // projectIdRef.current returns the current project id
      console.error(
        chalk.bgRed(`"${argv.$0} cleanup ${projectIdRef.current}"`),
      );
    }
  } finally {
    // In any case, error or not, end session and close client
    if (session) session.endSession(); // End mongo client session
    if (client && client.close) client.close(); // End mongo client
    process.exit(0); // Exit the node shell. The "0" argument stands for success
  }
};

module.exports = commonHandler;
