// Allows to read some actions that user may call through the keyboard or exit the node shell
const process = require('process');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// The main database
const mongodb = require('mongodb');
// A way to connect to a fake mongodb for testing
const mongoMemory = require('../testing/index');

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
  //let session;
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
    console.log(chalk.red('\nCaught interrupt signal'));
    // Use this line to display memory usage
    //console.log(process.memoryUsage().rss);

    // Set the environmental variable abort in case it is not set yet
    // This variable is read constantly at different point of the load command
    // If this variable conatains any text, the load process will try to exit cleanly
    if (!process.env.abort) {
      process.env.abort = 'abort';
      // in case of any error happening
      // stop spinner
      if (spinnerRef.current && spinnerRef.current.running) {
        spinnerRef.current.fail(
          `Interrupted while doing: ${spinnerRef.current.text}`,
        );
      }
    }
    // In case the abort was already in progress and we receive a new 'abort' request
    else {
      // We instantly kill the whole process
      // This would lead to generate trash data in the database
      console.error(
        chalk.bgRed(
          'Process was instantly killed. Trash data may have been generated in the database',
        ),
      );
      process.exit(0);
    }
  });

  try {
    // Try to connect to mongo as client and get the data base
    try {
      if (process.env.MODE === 'testing') client = await mongoMemory;
      else
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
            connectTimeoutMS: 0,
            socketTimeoutMS: 0, // In order to avoid Mongo connection time out
          },
        );
      //session = client.startSession();
      // NOTE: transaction logic is just being ignored for now
      // NOTE: it's there so that eventually it will become useful (MongoDB >=4)
      // Dani NOTEs:
      // mongodb driver 3.4.1 complies about this while 2.3.7 is fine with it.
      // It can be commented, but the abort procedure (Control + C) may be affected
      //session.startTransaction(); // Se queja de esto si usas el driver de mongodb 3.4

      // Get the data base
      db = client.db(process.env.DB_NAME);
      // Use it to ping
      //db.admin().ping((err, output) => console.log(output));
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
    //await session.commitTransaction();
    // spinnerRef.current.succeed('Committed to database');

    if (finalMessage) finalMessage();
  } catch (error) {
    process.env.abort = 'abort';
    // Stop the spinner
    if (spinnerRef.current && spinnerRef.current.running) {
      spinnerRef.current.fail(
        `Interrupted while doing: ${spinnerRef.current.text}`,
      );
    }
    /*
    // Abort transaction and track it with the spinner
    if (session && session.inTransaction()) {
      spinnerRef.current = getSpinner().start('Aborting current transaction');
      await session.abortTransaction();
      spinnerRef.current.succeed('Aborted current transaction');
    }
    */
    if (error) console.error(chalk.bgRed(error.stack));
  } finally {
    // In any case, error or not, end session and close client
    //if (session) session.endSession(); // End mongo client session
    if (client && client.close) client.close(); // End mongo client
    process.exit(0); // Exit the node shell. The "0" argument stands for success
  }
};

module.exports = commonHandler;
