// Allows to read some actions that user may call through the keyboard or exit the node shell
const process = require('process');
// The main database
const mongodb = require('mongodb');
// This library provides a fake mongo db which is useful to perform tests
// More information: https://github.com/nodkz/mongodb-memory-server
const { MongoMemoryServer } = require('mongodb-memory-server');
// Visual tool which allows to add colors in console
const chalk = require('chalk');

// Set some fake projects to be uploaded as a test
const fakeProjects = [
    {
        accession: 'MCNS00001',
        published: false,
        metadata: {
            NAME: 'prueba 1',
            UNIT: 'A',
            ATOMS: 123
        },
    },
    {
        accession: 'MCNS00002',
        published: true,
        metadata: {
            NAME: 'prueba 2',
            UNIT: 'A',
            ATOMS: 456,
        },
    },
    {
        accession: 'MCNS00003',
        published: false,
        metadata: {
            NAME: 'prueba 3',
            UNIT: 'B',
            ATOMS: 123,
        },
    }
];

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
        try {
            //connectionString = process.env.TEST_CONNECTION_STRING;
            connectionString = `mongodb://127.0.0.1:${process.env.DB_PORT}/${process.env.DB_NAME}?`;
            client = await mongodb.MongoClient.connect(connectionString, { useNewUrlParser: true });
            connected = true;
            console.log('The provided connection string is valid: Connected to Mongo Memory Server');
        } catch (error) {
            console.error(
            chalk.red('The provided connection string is not valid: There is no active Mongo Memory Server'));
        }
        // In case  there is no connection string or it is not valid...
        // Create a new server and get the connection string
        if (!connected) {
            console.log('A new instance of Mongo Memory Server will be created');
            const mongod = new MongoMemoryServer();
            // If tnext line silently crashes try to type 'npm i mongodb-memory-server' in the terminal
            // DANI: Esto para la documentación:
            // Si después de instar mongodb memory server sigue fallando se puede activar el debug poniendo 'MONGOMS_DEBUG=1' en el archivo '.env'
            // A mi funcionó hacer 'sudo apt-get install libcurl3' y luego 'sudo apt-get install libcurl4 php-curl'
            connectionString = await mongod.getUri();
            client = await mongodb.MongoClient.connect(connectionString, { useNewUrlParser: true });
        }
        // Add data to the server to simulate the MoDEL structure
        const db = client.db(process.env.DB_NAME);
        const projects = await db.createCollection('projects');
        for await (const fakeProject of fakeProjects) {
            await projects.insertOne(fakeProject);
        }
        return client;
    } catch (error) {
        console.error('Mongo Memory Server connection error');
        console.error(error);
        if (client && 'close' in client) client.close();
    }
  };

// Set the required environmental variables to connect to Mongo
const REQUIRED_ENV = [ 'DB_SERVER', 'DB_PORT', 'DB_NAME',
    'DB_AUTH_USER', 'DB_AUTH_PASSWORD', 'DB_AUTHSOURCE'];
// Try to connect to mongo as client and get the data base
const connectToMongo = async () => {
    // Make sure we have the required enviornmental variables
    const missingEnv = REQUIRED_ENV.filter(env => !process.env[env]);
    if (missingEnv.length > 0) throw new Error(
        'Missing enviornmental variables: ' + missingEnv.join(', ') + '.\nPlease consider ' +
        'either including them in the ".env" file or providing these variables via command-line.');
    try {
        if (process.env.MODE === 'testing') client = await establishFakeConnection();
        else client = await mongodb.MongoClient.connect(
            `mongodb://${process.env.DB_SERVER}:${process.env.DB_PORT}`,
            {
                auth: {
                    username: process.env.DB_AUTH_USER,
                    password: process.env.DB_AUTH_PASSWORD,
                },
                authSource: process.env.DB_AUTHSOURCE,
                useNewUrlParser: true,
                useUnifiedTopology: true,
                connectTimeoutMS: 0,
                socketTimeoutMS: 0, // In order to avoid Mongo connection time out
                readConcernLevel: 'local',
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
        const db = client.db(process.env.DB_NAME);
        const bucket = new mongodb.GridFSBucket(db);
        return { client, db, bucket };
        // Use it to ping
        //db.admin().ping((err, output) => console.log(output));
    } catch (error) {
        console.error(error);
        throw new Error(`Unable to connect to mongo instance or to database`);
    }
}

module.exports = connectToMongo;