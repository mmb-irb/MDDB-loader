// Connect to the actual database (MongoDB)
const connectToMongo = require('../utils/connect-to-mongo/index');
// This utility displays in console a dynamic loading status
const logger = require('../utils/logger');
// Add colors in console
const chalk = require('chalk');
// Load auxiliar functions
const { mongoidFormat, userConfirm, userConfirmOrphanDataDeletion } = require('../utils/auxiliar-functions');
// Mongo ObjectId class
const { ObjectId } = require('mongodb');
// The project class is used to handle database data from a specific project
const Project = require('./project');

// Set the first accession code
// Accession codes are alphanumeric and the first value is to be letter
const FIRST_ACCESSION_CODE = 'A0001';
const ACCESSION_CHARACTERS_LIMIT = FIRST_ACCESSION_CODE.length;

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
        this.new_accession_issued = false;
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
        projects: { singular: 'project', plural: 'projects' },
        references: { singular: 'reference', plural: 'references' },
        topologies: { singular: 'topology', plural: 'topologies' },
        files: { singular: 'file', plural: 'files' },
        chunks: { singular: 'chunk', plural: 'chunks' },
        analyses: { singular: 'analysis', plural: 'analyses' },
        chains: { singular: 'chain', plural: 'chains' },
        counters: { singular: 'counter', plural: 'counters' }
    }

    // ----------------------


    // Get the generic name of a document by the collection it belongs to
    // Plural is returned by default but you can provide the number of ducments
    // Thus in case it is a single document the singular is returned
    // This is used for displaying only
    nameCollectionDocuments = (collectionKey, numberOfDocuments = 0) => {
        const documentNames = this.COLLECTION_DOCUMENT_NAMES[collectionKey];
        if (!documentNames) throw new Error(`Not supported collection ${collectionKey}`);
        return numberOfDocuments === 1 ? documentNames.singular : documentNames.plural;
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

    // Find an already existing project in the database and return the project data handler
    // Return null if the project does not exist
    syncProject = async idOrAccession => {
        // Find the already existing project in mongo
        const projectData = await this.findProject(idOrAccession);
        if (!projectData) return null;
        return new Project(projectData, this);
    }

    // Create a new project in the database and return the project data handler
    // An accession may be passed
    // If no accession is passed then a new accession is issued with the default format
    createProject = async (forcedAccession = null) => {
        // If the accession was forced then check it does not exists
        if (forcedAccession) {
            const previousProjectData = await this.projects.findOne({ accession: forcedAccession });
            if (previousProjectData) throw new Error(`Forced accession '${forcedAccession}' already exists`);
        }
        // Create a new project
        // DANI: El mdref está fuertemente hardcodeado, hay que pensarlo
        const newAccession = forcedAccession || await this.issueNewAccession();
        const projectData = { accession: newAccession, published: false, metadata: {}, mds: [], mdref: 0, files: [] };
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

    // Create a new accession and add 1 to the last accession count
    // Note that this is the default accession but it is not mandatory to use this accession format
    // A custom accession may be forced through command line
    issueNewAccession = async () => {
        // First we must find the next available accession number
        const currentCounter = await this.counters.findOne({ accessions: true });
        // If prefix already exists then get the next number and update the counter
        let accessionCode;
        if (currentCounter) {
            const nextAccessionCode = currentCounter.last + 1;
            const result = await this.counters.updateOne(
                { accessions: true },
                { $set: { last: nextAccessionCode } });
            if (!result.acknowledged) throw Error(`Failed to update counter`);
            accessionCode = nextAccessionCode.toString(ALPHANUMERIC).toUpperCase();
            if (accessionCode.length > ACCESSION_CHARACTERS_LIMIT)
                throw new Error(`You have reached the limit of accession codes. Next would be ${accessionCode}`);
        }
        // If the counter does not yet exist then create it
        else {
            const result = await this.counters.insertOne({
                accessions: true,
                last: parseInt(FIRST_ACCESSION_CODE, ALPHANUMERIC)
            });
            if (!result.acknowledged) throw Error(`Failed to create new counter`);
            accessionCode = FIRST_ACCESSION_CODE;
        }
        // Make sure the new accession does not exist yet in the database
        const alreadyExistingProject = await this.projects.findOne({ accession: accessionCode });
        if (alreadyExistingProject) throw Error(`New issued accession ${accessionCode} already exists`);
        // Set the new accession issued flag as true
        // This allows to substract 1 from the counter if load is aborted to dont burn accessions
        this.new_accession_issued = true;
        // Return the new accession
        return `${accessionCode}`;
    };

    // Unload things loaded in the database during the last run
    revertLoad = async (confirmed = false) => {
        // Check if any data was loaded
        // If not, there is no point in asking the user
        if (this.inserted_data.length === 0 && this.new_accession_issued === false) return;
        // Stop the logs if it they are still alive
        if (logger.isLogRunning()) logger.failLog(`Interrupted while doing: ${logger.logText}`);
        // Ask the user if already loaded data is to be conserved or cleaned up
        const confirm = confirmed || await userConfirm(
            `There was some problem and load has been aborted. Confirm further instructions:
            C - Conserve already loaded data
            * - Delete already loaded data`);
        // If data is to be conserved there is nothing to do here
        if (confirm === 'C') return;
        // If a new accession was issued then substract 1 from the count
        if (this.new_accession_issued) {
            // First we must find the current count
            const currentCounter = await this.counters.findOne({ accessions: true });
            // Now substract 1
            const previousAccessionCode = currentCounter.last - 1;
            // Now update the counter
            const result = await this.counters.updateOne(
                { accessions: true },
                { $set: { last: previousAccessionCode } });
            if (!result.acknowledged) throw new Error(`Failed to revert counter`);
            console.log('Reverted accession counter');
        }
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

    // Define for each collection its parental relationship
    // This allows to identify when a document is orphan
    COLLECTION_PARENTS = {
        projects: null, // Projects have no parent
        references: { collectionKey: 'projects', referenceField: 'metadata.REFERENCES', localField: 'uniprot' },
        topologies: { collectionKey: 'projects', referenceField: '_id', localField: 'project' },
        files: { collectionKey: 'projects', referenceField: '_id', localField: 'metadata.project' },
        chunks: { collectionKey: 'files', referenceField: '_id', localField: 'files_id' },
        analyses: { collectionKey: 'projects', referenceField: '_id', localField: 'project' },
        chains: { collectionKey: 'projects', referenceField: '_id', localField: 'project' },
        counters: null // Counters are not related to anything
    }

    // Get the ids of orphan documents to be deleted in a given collection
    // WARNING: Although it should work, this functions is slower than functions below
    // WARNING: It is written here for conservation reason but it will be deleted in further commits
    DEPRECATEDfindOrphanData = async collectionKey => {
        // Get the collection
        const collection = this[collectionKey];
        if (!collection) throw new Error(`Collection ${collectionKey} does not exist`);
        // Get the collection parental details
        const parent = this.COLLECTION_PARENTS[collectionKey];
        if (!parent) throw new Error(`Collection ${collectionKey} has no parenting`); 
        const parentCollectionName = this.COLLECTION_NAMES[parent.collectionKey];
        // Set a complex query
        const cursor = await collection.aggregate([
            // Get documents in the parent collection whose reference value matches/contains the local value
            { $lookup: {
                from: parentCollectionName, as: 'foreign',
                localField: parent.localField, foreignField: parent.referenceField,
                // WARNING
                // The lookup returns, for each document, the doucment itself and all foreign matches
                // The $match step below consumes the whole lookup output to start working which may be a lot
                // If this intermediate result exceeds the MongoDB limit of 16 Mb then we have an error
                // To prevent this we must reduce the lookup output by projecting minimal data in foreign matches
                // Note that we could actually project nothing since we are interested in the number of foreigns
                pipeline:[{ $project:{ _id: true } }]
            }},
            // In order to further reduce the output we remove also all the original document data but the id
            // Get only the internal id and the foreign field from each result
            { $project: { _id: true, foreign: true } },
            // Get only those documents who what no matching results in the lookup (i.e. they have no parent document)
            { $match: { foreign: { $size: 0 } } }
        ]);
        // Warn the user we are about to start the search since this may take a long time
        console.log(`Searching for orphan ${this.nameCollectionDocuments(collectionKey)}`);
        // Consume the cursor thus running the aggregate
        const result = await cursor.toArray();
        // Get only the internal ids
        const resultIds = result.map(r => r._id);
        // Log the number of documents found
        const documentsName = this.nameCollectionDocuments(collectionKey, resultIds.length);
        console.log(`Found ${resultIds.length} orphan ${documentsName} to delete`);
        // If there are no documents then we return null
        if (resultIds.length === 0) return null;
        console.log(`   e.g. ${resultIds[0]}`);
        return resultIds
    }

    // Get the ids of orphan documents to be deleted in a given collection
    findOrphanData = async collectionKey => {
        // Get the collection
        const collection = this[collectionKey];
        if (!collection) throw new Error(`Collection ${collectionKey} does not exist`);
        // Get the collection parental details
        const parent = this.COLLECTION_PARENTS[collectionKey];
        if (!parent) throw new Error(`Collection ${collectionKey} has no parenting`);
        console.log(`Searching for orphan ${this.nameCollectionDocuments(collectionKey)}`);
        // Get parent reference field values
        const parentCollection = this[parent.collectionKey];
        const projection = {};
        projection[parent.referenceField] = true;
        const parentCursor = await parentCollection.find({}, { projection });
        // Warn the user we are about to start the search since this may take a long time
        console.log(`  Searching for parent collection (${parent.collectionKey}) reference field (${parent.referenceField}) values`);
        // Consume the cursor thus running the query
        const parentResults = await parentCursor.toArray();
        // Mine the parent reference field values
        const parentValues = new Set();
        parentResults.forEach(result => {
            // Get the actual value
            // The reference field may be declared as 'metadata.REFERENCES' and thus we have to parse it
            const fields = parent.referenceField.split('.');
            let value = result;
            for (const field of fields) { value = value[field] };
            // Skip null/undefined values
            if (value === null || value === undefined) return;
            // If the value is an array then add every value on it
            if (value.constructor === Array) value.forEach(v => parentValues.add(v));
            // Otherwise simply add the value
            else parentValues.add(value);
        });
        // Get documents in the requested collection not having any parent value in their local fields
        const query = {};
        query[parent.localField] = { $nin: Array.from(parentValues) };
        console.log(`  Searching for current collection (${collectionKey}) documents not including any parent value in their local field (${parent.localField})`);
        const cursor = await collection.find(query, { projection: { _id: true } });
        const results = await cursor.toArray();
        // Get only the internal ids
        const resultIds = results.map(r => r._id);
        // Log the number of documents found
        const documentsName = this.nameCollectionDocuments(collectionKey, resultIds.length);
        console.log(`  Found ${resultIds.length} orphan ${documentsName} to delete`);
        // If there are no documents then we return null
        if (resultIds.length === 0) return null;
        console.log(`    e.g. ${resultIds[0]}`);
        return resultIds;
    }

    // Get the ids of orphan documents to be deleted in a given collection
    // DANI: This is the fastest aproach to the problem and it would show the progress
    // DANI: However it is not working properly and I think it is a Mongo problem
    // DANI: For some reason teh find command does not behave normally with the fs.chunks collection
    // DANI: It takes a lot to iterate over documents
    // DANI: Other collections also have this problem if a batch size is not specified
    // DANI: In the other hand, the aggregate command responds inmediately but it is not able to project iteratively
    // DANI: Chunks are heavy so it is very slow if not projected
    // DANI: If we project then the aggregate processes all docuemnts before responding
    // DANI: The distinc command has been tried and it is killed by overcoming a 64 Mb limit somewhere
    EXPERIMENTALfindOrphanData = async collectionKey => {
        // Get the collection
        const collection = this[collectionKey];
        if (!collection) throw new Error(`Collection ${collectionKey} does not exist`);
        // Get the collection parental details
        const parent = this.COLLECTION_PARENTS[collectionKey];
        if (!parent) throw new Error(`Collection ${collectionKey} has no parenting`);
        console.log(`Searching for orphan ${this.nameCollectionDocuments(collectionKey)}`);
        // Get parent reference field values
        const parentCollection = this[parent.collectionKey];
        const parentProjection = {};
        parentProjection[parent.referenceField] = true;
        const parentCursor = await parentCollection.find({}, { projection: parentProjection });
        // Warn the user we are about to start the search since this may take a long time
        console.log(`  Getting all parent collection (${parent.collectionKey}) reference field (${parent.referenceField}) values`);
        // Consume the cursor thus running the query
        const parentResults = await parentCursor.toArray();
        // The reference field may be declared as 'metadata.REFERENCES' and thus we have to parse it
        const referenceFields = parent.referenceField.split('.');
        // Mine the parent reference field values
        const parentValues = new Set();
        parentResults.forEach(result => {
            // Get the actual value
            let value = result;
            for (const field of referenceFields) { value = value[field] };
            // Skip null/undefined values
            if (value === null || value === undefined) return;
            // If the value is an array then add every value on it
            if (value.constructor === Array) value.forEach(v => parentValues.add(v));
            // If the value is a mongo object id then keep only the id string
            if (value.constructor === ObjectId) parentValues.add(value.toString());
            // Otherwise simply add the value
            else parentValues.add(value);
        });
        // Get documents in the requested collection not having any parent value in their local fields
        console.log(`  Getting all current collection (${collectionKey}) local field (${parent.localField}) values per id`);
        const projection = {};
        projection[parent.localField] = true;
        const cursor = await collection.find({}, { projection: projection });
        const totalCount = await collection.count();
        // Set the singular name of a document to be deleted, for the logs
        const singleDocumentName = this.nameCollectionDocuments(collectionKey, 1);
        // The reference field may be declared as 'metadata.REFERENCES' and thus we have to parse it
        const localFields = parent.localField.split('.');
        // Set a counter to keep the user updated of the processing progress
        let count = 1;
        logger.startLog(`Processing ${totalCount} ${this.nameCollectionDocuments(collectionKey)}`);
        // Now filter the results
        const filteredResultIds = [];
        // Get only ids from those results whose local field is not found among the parent values
        for await (const doc of cursor) {
            logger.updateLog(`Processing ${singleDocumentName} ${count}/${totalCount}`);
            count += 1;
            // Get the actual value
            let value = doc;
            for (const field of localFields) { value = value[field] };
            // If the value is a mongo object id then make it a string
            if (value.constructor === ObjectId) value = value.toString();
            // If value is among the parent values then skip to the next
            if (parentValues.has(value)) continue;
            // If the value is not among the parent values then add the result id to the list of orphan ids
            filteredResultIds.push(doc._id);
        };
        // Log the number of documents found
        const documentsName = this.nameCollectionDocuments(collectionKey, filteredResultIds.length);
        logger.successLog(`Found ${filteredResultIds.length} orphan ${documentsName} to delete`);
        // If there are no documents then we return null
        if (filteredResultIds.length === 0) return null;
        console.log(`  e.g. ${filteredResultIds[0]}`);
        return filteredResultIds;
    }

    // Find and delete all orphan documents in a collection
    deleteOrphanData = async (collectionKey, confirmed = false) => {
        // Get orphan document ids
        const resultIds = await this.findOrphanData(collectionKey);
        if (!resultIds) return;
        // Ask the user before deleting
        const documentsName = this.nameCollectionDocuments(collectionKey, resultIds.length);
        const confirm = confirmed || await userConfirmOrphanDataDeletion(documentsName);
        if (!confirm) return;
        // Get the collection
        const collection = this[collectionKey];
        // If data deletion is confirmed then go ahead
        // Set the deleting function, which is different if we are to delete a bucket file
        // Note that deleting a file using the bucket also deletes all its chunks
        const deleteDocument = collectionKey === 'files'
            ? async id => this.bucket.delete(id)
            : async id => collection.deleteOne({ _id: id });
        // Set the singular name of a document to be deleted, for the logs
        const singleDocumentName = this.nameCollectionDocuments(collectionKey, 1);
        // Iterate over the found Ids
        let count = 1;
        for await (const id of resultIds) {
            const label = `${singleDocumentName} ${count}/${resultIds.length} <- ${id}`;
            logger.startLog(`🗑️  Deleting orphan ${label}`);
            await deleteDocument(id);
            logger.successLog(`🗑️  Deleted orphan ${label}`);
            count += 1;
        }
    }
}

// Connect to the database
// Then construct and return the database handler
const getDatabase = async () => {
    const { client, db, bucket } = await connectToMongo();
    return new Database(client, db, bucket);
};

module.exports = getDatabase;