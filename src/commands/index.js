const process = require('process');

const chalk = require('chalk');
const mongodb = require('mongodb');

const getSpinner = require('../utils/get-spinner');

const commonHandler = commandName => async argv => {
  let mongoConfig;
  let client;
  let session;
  let db;
  // copy React's idea of references
  // so we can pass the reference to inner commands, and still catch errors and
  // interrupt spinner from here
  const spinnerRef = Object.seal({ current: null });

  process.on('SIGINT', async () => {
    console.log(chalk.red('Caught interrupt signal'));
    if (!(session && session.inTransaction())) {
      process.exit(0);
      return;
    }
    spinnerRef.current = getSpinner().start('Aborting current transaction');
    try {
      await session.abortTransaction();
      spinnerRef.current.succeed('Aborted current transaction');
      process.exit(0);
    } catch (_) {
      spinnerRef.current.fail(
        "Didn't manage to abort current transaction. Try to have a look inside the DB to see if everything is fine or if it needs manual clean-up",
      );
      process.exit(1);
    }
  });

  try {
    // Mongo config
    try {
      // Mongo config file, can be json or js code
      mongoConfig = require('../../configs/mongo');
    } catch (_) {
      // throw custom error
      throw new Error("Couldn't find mongo config file");
    }

    // Mongo client
    try {
      const { server, port, db: dbName, ...config } = mongoConfig;
      client = await mongodb.MongoClient.connect(
        `mongodb://${server}:${port}`,
        config,
      );

      session = client.startSession();
      session.startTransaction();

      db = client.db(dbName);
    } catch (_) {
      // throw custom error
      throw new Error(
        `Unable to connect to mongo instance or to '${
          mongoConfig.dbName
        }' database`,
      );
    }

    /* specific handler */
    const command = require(`./${commandName}`);
    // call the requested command with
    await command(
      // normal object passed from the yargs library
      argv,
      // extra stuff useful across all scripts
      { db, bucket: new mongodb.GridFSBucket(db), spinnerRef },
    );
    /**/

    // commit transaction
    spinnerRef.current = getSpinner().start('Committing to database');
    await session.commitTransaction();
    spinnerRef.current.succeed('Committed to database');
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

    console.error(chalk.bgRed(error.stack));
  } finally {
    // in any case, error or not, clean up session and client
    if (session) session.endSession();
    if (client && client.close) client.close();
  }
};

module.exports = commonHandler;
