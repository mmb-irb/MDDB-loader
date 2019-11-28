const process = require('process');

const chalk = require('chalk');
const mongodb = require('mongodb');

const getSpinner = require('../utils/get-spinner');

// common logic for all commands
// set up database accesses and transactions
// clean-up afterwards and commit or abort transactions
// handle errors thrown from the commands and pass them to the user
// NOTE: transaction logic is just being ignored for now
// NOTE: it's there so that eventually it will become useful (MongoDB >=4)
const commonHandler = commandName => async argv => {
  let client;
  let session;
  let db;

  // copy React's idea of references
  // so we can pass the reference to inner commands, and still catch errors and
  // interrupt spinner from here
  const spinnerRef = Object.seal({ current: null });
  // keep reference to project ID in case we need to roll back
  const projectIdRef = Object.seal({ current: null });

  process.on('SIGINT', async () => {
    console.log(chalk.red('Caught interrupt signal'));
    if (!(session && session.inTransaction())) {
      process.exit(0);
      return;
    }
    // in case of any error happening
    // stop spinner
    if (spinnerRef.current && spinnerRef.current.running) {
      spinnerRef.current.fail(
        `Interrupted while doing: ${spinnerRef.current.text}`,
      );
    }
    spinnerRef.current = getSpinner().start('Aborting current transaction');
    try {
      await session.abortTransaction();
      spinnerRef.current.succeed('Aborted current transaction');
      // warn user to run clean up
      if (projectIdRef.current) {
        console.error(
          chalk.bgRed('Please run the following command to clean up:'),
        );
        console.error(
          chalk.bgRed(`"${argv.$0} cleanup ${projectIdRef.current}"`),
        );
      }
      process.exit(0);
    } catch (_) {
      spinnerRef.current.fail(
        "Didn't manage to abort current transaction. Try to have a look inside the DB to see if everything is fine or if it needs manual clean-up",
      );
      process.exit(1);
    }
  });

  try {
    // Mongo client
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

      db = client.db(process.env.DB_NAME);
    } catch (error) {
      console.error(error);
      // throw custom error
      throw new Error(`Unable to connect to mongo instance or to database`);
    }

    /* specific handler */
    const command = require(`./${commandName}`);
    // call the requested command with
    const finalMessage = await command(
      // normal object passed from the yargs library
      argv,
      // extra stuff useful across all scripts
      { db, bucket: new mongodb.GridFSBucket(db), spinnerRef, projectIdRef },
    );
    /**/

    // commit transaction
    // spinnerRef.current = getSpinner().start('Committing to database');
    await session.commitTransaction();
    // spinnerRef.current.succeed('Committed to database');

    if (finalMessage) finalMessage();
  } catch (error) {
    // in case of any error happening
    // stop spinner
    if (spinnerRef.current && spinnerRef.current.running) {
      spinnerRef.current.fail(
        `Interrupted while doing: ${spinnerRef.current.text}`,
      );
    }
    // abort transaction
    if (session && session.inTransaction()) {
      spinnerRef.current = getSpinner().start('Aborting current transaction');
      await session.abortTransaction();
      spinnerRef.current.succeed('Aborted current transaction');
    }

    if (error) console.error(chalk.bgRed(error.stack));

    // warn user to run clean up
    if (projectIdRef.current) {
      console.error(
        chalk.bgRed('Please run the following command to clean up:'),
      );
      console.error(
        chalk.bgRed(`"${argv.$0} cleanup ${projectIdRef.current}"`),
      );
    }
  } finally {
    // in any case, error or not, clean up session and client
    if (session) session.endSession();
    if (client && client.close) client.close();
    process.exit(0);
  }
};

module.exports = commonHandler;
