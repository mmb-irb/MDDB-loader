// This library provides a fake mongo db which is useful to perform tests
// More information: https://github.com/nodkz/mongodb-memory-server
const mongodb = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
// Visual tool which allows to add colors in console
const chalk = require('chalk');

// Set some fake projects to be uploaded
const project1 = {
  accession: 'MCNS00001',
  published: false,
  metadata: {
    NAME: 'prueba 1',
    UNIT: 'A',
    ATOMS: 123,
  },
};
const project2 = {
  accession: 'MCNS00002',
  published: true,
  metadata: {
    NAME: 'prueba 2',
    UNIT: 'A',
    ATOMS: 456,
  },
};
const project3 = {
  accession: 'MCNS00003',
  published: false,
  metadata: {
    NAME: 'prueba 3',
    UNIT: 'B',
    ATOMS: 123,
  },
};

const project4 = {
  published: false,
  metadata: {
    NAME: 'prueba 3',
    UNIT: 'C',
  },
};

// Set up the fake server and return an available connection to this server
const establishFakeConnection = async () => {
  // Do nothing if we are not testing
  if (process.env.MODE !== 'testing') return;
  console.log(chalk.bgMagenta('\n Running loader in TEST mode \n'));
  let client;
  let connected = false;
  try {
    // If there is a provided connection string, try to connect to it
    // WARNING: The string connection may be not valid
    let connectionString;
    if (process.env.TEST_CONNECTION_STRING) {
      try {
        connectionString = process.env.TEST_CONNECTION_STRING;
        client = await mongodb.MongoClient.connect(connectionString, {
          useNewUrlParser: true,
        });
        connected = true;
        console.log(
          'The provided connection string is valid: Connected to Mongo Memory Server',
        );
      } catch (error) {
        console.error(
          chalk.red(
            'The provided connection string is not valid: There is no active Mongo Memory Server',
          ),
        );
      }
    }
    // In case  there is no connection string or it is not valid...
    // Create a new server and get the connection string
    if (!connected) {
      console.log('A new instance of Mongo Memory Server will be created');
      const mongod = new MongoMemoryServer();
      connectionString = await mongod.getConnectionString();
      //console.log(mongod.getInstanceInfo());
      client = await mongodb.MongoClient.connect(connectionString, {
        useNewUrlParser: true,
      });
    }

    // Add data to the server to simulate the MoDEL structure
    const db = client.db(process.env.DB_NAME);
    const projects = await db.createCollection('projects');
    //console.log(projects);
    await projects.insertOne(project1);
    await projects.insertOne(project2);
    await projects.insertOne(project3);
    await projects.insertOne(project4);
    return client;
  } catch (error) {
    console.error('Mongo Memory Server connection error');
    console.error(error);
    if (client && 'close' in client) client.close();
  }
};

module.exports = establishFakeConnection();
