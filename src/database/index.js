// Connect to the actual database (MongoDB)
const connectToMongo = require('../utils/connect-to-mongo/index');
// This utility displays in console a dynamic loading status
const logger = require('../utils/logger');
// Add colors in console
const chalk = require('chalk');
// Load auxiliar functions
const { mongoidFormat, userConfirm } = require('../utils/auxiliar-functions');
// The project class is used to handle database data from a specific project
const Project = require('./project');

// Get the environment prefix
const ACCESSION_PREFIX = process.env.ACCESSION_PREFIX;
// Set the first accession code
// Accession codes are alphanumeric and the first value is to be letter
const FIRST_ACCESSION_CODE = 'A0001';

// Set the alhpanumeric number of characters: 36 (10 numbers + 24 letters)
const ALPHANUMERIC = 36;

// Set the project class
class Database {
    constructor (client, db, bucket) {
        if (!client) throw new Error('No client');
        if (!db) throw new Error('No database');
        if (!bucket) throw new Error('No bucket');
        // Get database handlers
        this.client = client; // Client is not used by the database, but it is read from the database by others
        this.db = db;
        this.bucket = bucket;
        // Set some collections and list them all together
        this.collections = [];
        for (const [ collectionKey, collectionName ] of Object.entries(this.COLLECTION_NAMES)) {
            this[collectionKey] = db.collection(collectionName);
            this.collections.push(this[collectionKey]);
        }
        // Keep track of the newly inserted data
        // This way, in case anything goes wrong, we can revert changes
        this.inserted_data = [];
    };

    // ----- Constants -----

    // Set the collection names
    COLLECTION_NAMES = {
        projects: 'projects',
        references: 'references',
        topologies: 'topologies',
        files: 'fs.files',
        chunks: 'fs.chunks',
        analyses: 'analyses',
        chains: 'chains',
        counters: 'counters'
    }

    // Set the collection document names
    // This is used for displaying only
    COLLECTION_DOCUMENT_NAMES = {
        projects: 'project',
        references: 'reference',
        topologies: 'topology',
        files: 'file',
        chunks: 'chunk',
        analyses: 'analysis',
        chains: 'chain',
        counters: 'counter'
    }

    // ----------------------


    // Get the generic name of a document by the collection it belongs to
    // This is used for displaying only
    nameCollectionDocument = collection => {
        if (collection === this.projects) return 'project';
        if (collection === this.references) return 'reference';
        if (collection === this.topologies) return 'topology';
        if (collection === this.files) return 'file';
        if (collection === this.analyses) return 'analysis';
        if (collection === this.chains) return 'chain';
        if (collection === this.chunks) return 'chunk';
        throw new Error('Not supported collection');
    }

    // Find a project by its id or accession
    // Return null if project does not exist
    findProject = async idOrAccession => {
        // WARNING: Here we must kill the process if the input id or accession is undefined or null
        // WARNING: The query would just return the first project in the database which is very dangerous
        if (!idOrAccession) throw new Error('Missing ID or Accession');
        // If it is an accession we have to query in a specific format
        // If it is an object id we can directly query with it
        const query = mongoidFormat.test(idOrAccession) ? idOrAccession : { accession: idOrAccession };
        // Find the already existing project in mongo
        const projectData = await this.projects.findOne(query);
        return projectData;
    }

    // Find an already existing project in the database and set its data as the handler project data
    syncProject = async idOrAccession => {
        // Find the already existing project in mongo
        const projectData = await this.findProject(idOrAccession);
        if (!projectData) throw new Error(`No project found for ID/Accession '${idOrAccession}'`);
        return new Project(projectData, this);
    }

    // Create a new project in the database
    // Set the handler project data accordingly
    createProject = async () => {
        // Create a new project
        // DANI: El mdref está fuertemente hardcodeado, hay que pensarlo
        const newAccession = await this.issueNewAccession();
        const projectData = { accession: newAccession, published: false, mds: [], mdref: 0, files: [] };
        logger.startLog(`📝 Adding new database project`);
        // Load the new project
        const result = await this.projects.insertOne(projectData);
        // If the operation failed
        if (result.acknowledged === false) return logger.failLog(`📝 Failed to add new database project`);
        logger.successLog(`📝 Added new database project -> ${result.insertedId}`);
        // Update the project id
        projectData._id = result.insertedId;
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new project',
            collection: this.projects,
            id: result.insertedId
        });
        // Set the new project handler and return it
        return new Project(projectData, this);
    }

    // Add a new reference in the references collection in case it does not exist yet
    loadReference = async reference => {
        // Check if the reference is already in the database and, if so, skip the load
        const current = await this.references.findOne({ uniprot: reference.uniprot });
        if (current) return console.log(chalk.grey(`Reference ${reference.uniprot} is already in the database`));
        logger.startLog(`💽 Loading reference ${reference.uniprot}`);
        // Load the new reference
        const result = await this.references.insertOne(reference);
        // If the operation failed
        if (result.acknowledged === false) return logger.failLog(`💽 Failed to load reference ${reference.uniprot}`);
        logger.successLog(`💽 Loaded reference ${reference.uniprot}`);
        console.log(chalk.green(`  Loaded new reference ${reference.uniprot} -> ${result.insertedId}`));
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new reference',
            collection: this.references,
            id: result.insertedId
        });
    };

    // Check if a reference is still under usage
    // i.e. there is at least one project using it
    isReferenceUsed = async uniprot => {
        const projects = await this.projects.count({ 'metadata.REFERENCES': uniprot });
        if (projects === 0) return false;
        return true;
    }

    // Delete a reference
    deleteReference = async uniprot => {
        logger.startLog(`🗑️  Deleting referece ${uniprot}`);
        const result = await this.references.deleteOne({ uniprot: uniprot });
        if (!result) return logger.failLog(`🗑️  Failed to delete referece ${uniprot}`);
        logger.successLog(`🗑️  Deleted referece ${uniprot}`);
    }

    // Given an id, find the document and the collection it belongs to
    findId = async id => {
        // Iterate over all collections until we find the id
        for await (const collection of this.collections) {
            const document = await collection.findOne({ _id: id });
            if (document) return { document, collection };
        }
        // If there was no result then null is returned
        return null;
    }

    // Unload things loaded in the database during the last run
    revertLoad = async (confirmed = false) => {
        // Check if any data was loaded
        // If not, there is no point in asking the user
        if (this.inserted_data.length === 0) return;
        // Stop the logs if it they are still alive
        if (logger.isLogRunning()) logger.failLog(`Interrupted while doing: ${logger.logText}`);
        // Ask the user if already loaded data is to be conserved or cleaned up
        const confirm = confirmed || await userConfirm(
            `There was some problem and load has been aborted. Confirm further instructions:
            C - Conserve already loaded data
            * - Delete already loaded data`);
        // If data is to be conserved there is nothing to do here
        if (confirm === 'C') return;
        // Delete inserted data one by one
        for (const data of this.inserted_data) {
            const collection = data.collection;
            if (collection === this.files) {
                console.log('allright its a file');
                await this.bucket.delete(currentFile.id);
            } 
            else {
                const result = await data.collection.deleteOne({ _id: data.id });
                if (result.acknowledged === false) throw new Error(`Failed to delete ${data.name}`);
            }
            console.log(`🗑️  Deleted ${data.name} <- ${data.id}`);
        }
    };

    // Create a new accession and add 1 to the last accession count
    // Note that this is the default accession but it is not mandatory to use this accession format
    // A custom accession may be forced through command line
    issueNewAccession = async () => {
        // First we must find the next available accession number
        const currentCounter = await this.counters.findOne({ prefix: ACCESSION_PREFIX });
        // If prefix already exists then get the next number and update the counter
        let accessionCode;
        if (currentCounter) {
            const nextAccessionCode = currentCounter.last + 1;
            const result = await this.counters.updateOne(
                { prefix: ACCESSION_PREFIX },
                { $set: { last: nextAccessionCode } });
            if (!result.acknowledged) throw Error(`Failed to update counter`);
            accessionCode = nextAccessionCode.toString(ALPHANUMERIC).toUpperCase();
            if (accessionCode.length > 5)
                throw new Error(`You have reached the limit of accession codes. Next would be ${accessionCode}`);
        }
        // If the counter does not yet exist then create it
        else {
            const result = await this.counters.insertOne({
                last: parseInt(FIRST_ACCESSION_CODE, ALPHANUMERIC),
                prefix: ACCESSION_PREFIX
            });
            if (!result.acknowledged) throw Error(`Failed to create new counter`);
            accessionCode = FIRST_ACCESSION_CODE;
        }
        // Return the new accession
        return `${ACCESSION_PREFIX}:${accessionCode}`;
    };
}

// Connect to the database
// Then construct and return the database handler
const getDatabase = async () => {
    const { client, db, bucket } = await connectToMongo();
    return new Database(client, db, bucket);
};

module.exports = getDatabase;