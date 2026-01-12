// Connect to the actual database (MongoDB)
const connectToMongo = require('../utils/connect-to-mongo/index');
// This utility displays in console a dynamic loading status
const logger = require('../utils/logger');
// Add colors in console
const chalk = require('chalk');
// Load auxiliar functions
const {
    mongoidFormat,
    userConfirm,
    userConfirmOrphanDataDeletion,
    areObjectsIdentical,
} = require('../utils/auxiliar-functions');
// Mongo ObjectId class
const { ObjectId } = require('mongodb');
// The project class is used to handle database data from a specific project
const Project = require('./project');
const { merge_metadata } = require('./project/metadata-handlers');

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
        this.collections = {};
        for (const [ collectionKey, collectionConfig ] of Object.entries(this.COLLECTIONS)) {
            this[collectionKey] = db.collection(collectionConfig.name);
            this.collections[collectionKey] = this[collectionKey];
        }
        // Keep track of the newly inserted data
        // This way, in case anything goes wrong, we can revert changes
        this.inserted_data = [];
        this.new_accession_issued = false;
    };

    // ----- Constants -----

    // Set the collection configuration
    // name - Actual name of the collection inside the database
    // index - Index configuration in the database, for the collections setup
    // documentNames - Document names used for displaying only
    COLLECTIONS = {
        projects: {
            name: 'projects',
            indexes: [{ published: 1 }],
            documentNames: { singular: 'project', plural: 'projects' },
        },
        references: {
            name: 'references',
            documentNames: { singular: 'reference', plural: 'references' },
        },
        ligands: {
            name: 'ligands',
            documentNames: { singular: 'ligand', plural: 'ligands' },
        },
        pdb_refs: {
            name: 'pdb_refs',
            documentNames: { singular: 'PDB', plural: 'PDBs' },
        },
        chain_refs: {
            name: 'chain_refs',
            documentNames: { singular: 'chain', plural: 'chains' },
        },
        inchikey_refs: {
            name: 'inchikey_refs',
            documentNames: { singular: 'inchikey', plural: 'inchikeys' },
        },
        topologies: {
            name: 'topologies',
            indexes: [{ project: 1 }],
            documentNames: { singular: 'topology', plural: 'topologies' },
        },
        files: {
            name: 'fs.files',
            indexes: [{ 'metadata.project': 1 }],
            documentNames: { singular: 'file', plural: 'files' },
        },
        chunks: {
            name: 'fs.chunks',
            documentNames: { singular: 'chunk', plural: 'chunks' },
        },
        analyses: {
            name: 'analyses',
            indexes: [{ project: 1 }],
            documentNames: { singular: 'analysis', plural: 'analyses' },
        },
        counters: {
            name: 'counters',
            documentNames: { singular: 'counter', plural: 'counters' }
        },
    };

    // Set every reference configuration
    // collection - The collection key in the COLLECTIONS object
    // idField - The field in every reference document which stands for its id
    // projectIdsField - The field in every project document which lists the included reference ids
    REFERENCES = {
        proteins: {
            collection: 'references',
            idField: 'uniprot',
            projectIdsField: 'metadata.REFERENCES'
        },
        ligands: {
            collection: 'ligands',
            idField: 'pubchem',
            projectIdsField: 'metadata.LIGANDS'
        },
        pdbs: {
            collection: 'pdb_refs',
            idField: 'id',
            projectIdsField: 'metadata.PDBIDS'
        },
        chains: {
            collection: 'chain_refs',
            idField: 'sequence',
            projectIdsField: 'metadata.PROTSEQ'
        },
        inchikeys: {
            collection: 'inchikey_refs',
            idField: 'inchikey',
            projectIdsField: 'metadata.INCHIKEYS'
        }
    };

    // ----------------------

    // Setup the database by creating and indexing the configured collections
    setup = async () => {
        // Check the collections already existing in the database
        const currentCollections = await this.db.listCollections().toArray()
        const currentCollectionNames = currentCollections.map(collection => collection.name);
        // Iterate over the configured collections
        for await (const [collectionKey, collectionConfig] of Object.entries(this.COLLECTIONS)) {
            // If the collection already exists then do nothing
            if (currentCollectionNames.includes(collectionConfig.name)) {
                // Get the configuration indexes for this collection
                const configIndexes = collectionConfig.indexes;
                // If there are no configuration indexes at all then we are done
                if (!configIndexes) continue;
                // Get the current collection indexes
                const currentIndexesData = await this[collectionKey].indexes();
                const currentIndexes = currentIndexesData.map(indexData => indexData.key);
                // Iterate the expected indexes
                for await (const configIndex of configIndexes) {
                    // Make sure the index exists among the current indexes
                    let found = false;
                    for (const collectionIndex of currentIndexes) {
                        // Compare indices
                        if (areObjectsIdentical(collectionIndex,  configIndex)) {
                            found = true;
                            break;
                        }
                    }
                    // If the index does not exist then we create it
                    if (!found) {
                        console.log(`🛠️  Setting a missing index in "${collectionKey}" collection: ${JSON.stringify(configIndex)}`);
                        await this[collectionKey].createIndex(configIndex);
                    }
                }
                // Proceed to the next collection
                continue;
            }
            console.log(`🛠️  Setting up ${collectionKey} collection`);
            // Create the collection
            await this.db.createCollection(collectionConfig.name);
            // Set some indices if specified to accelerate specific queries
            if (collectionConfig.indexes) {
                for await (const index of collectionConfig.indexes) {
                    await this[collectionKey].createIndex(index);
                }
            }
        }
    };

    // Get the generic name of a document by the collection it belongs to
    // Plural is returned by default but you can provide the number of ducments
    // Thus in case it is a single document the singular is returned
    // This is used for displaying only
    nameCollectionDocuments = (collectionKey, numberOfDocuments = 0) => {
        const collectionConfig = this.COLLECTIONS[collectionKey];
        const documentNames = collectionConfig.documentNames;
        if (!documentNames) throw new Error(`Not supported collection ${collectionKey}`);
        return numberOfDocuments === 1 ? documentNames.singular : documentNames.plural;
    }

    // Find a project by its id or accession
    // Return null if project does not exist
    findProject = async idOrAccession => {
        // WARNING: Here we must kill the process if the input id or accession is undefined or null
        // WARNING: The query would just return the first project in the database which is very dangerous
        if (!idOrAccession) throw new Error('Missing ID or Accession');
        // Set the project query
        let query;
        // If it is an object id we can directly query with it
        if (mongoidFormat.test(idOrAccession)) {
            // If it is a mongo object id already then use it as is
            if (idOrAccession.constructor === ObjectId) query = idOrAccession;
            // If it is a string the set the mongo object id from it
            else query = new ObjectId(idOrAccession);
        }
        // If it is an accession we have to query in a specific format
        else query = { accession: idOrAccession };
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
        const projectData = {
            accession: newAccession,
            published: false,
            metadata: {},
            mds: [],
            mdref: 0,
            files: [],
            analyses: []
        };
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
        // Set the new project handler
        const project = new Project(projectData, this);
        // Make sure the new accession does not exist yet in the database after adding the project
        // This may seem redundant since we already checked it when we issued the accession
        // However in a highly concurrent environment another project may have been added meanwhile
        // This has happened
        const projectCount = await this.projects.countDocuments({ accession: newAccession });
        if (projectCount > 1) {
            await project.deleteProject();
            throw Error(`Multple projects (${projectCount}) with accession ${newAccession}. The new project has been deleted.`);
        }
        // Finally return the project handler
        return project;
    }

    // Iterate over projects ids in the database
    iterateProjectIds = async function* (query = {}) {
        const availableProjects = await this.projects.find(query, { projection: { _id: true } });
        const projectCount = await availableProjects.count();
        console.log(`Iterating ${projectCount} project ids`);
        for await (const project of availableProjects) yield project._id;
    }

    // Iterate over projects in the database
    iterateProjects = async function* (query = {}) {
        const availableProjects = await this.projects.find(query, { projection: { _id: true } });
        const projectCount = await availableProjects.count();
        console.log(`Iterating ${projectCount} projects`);
        for await (const project of availableProjects) {
            yield this.syncProject(project._id);
        }
    }

    // Add a new reference in the references collection in case it does not exist yet
    loadReferenceIfProper = async (referenceName, referenceData, conserve, overwrite) => {
        // Set the reference configuration
        const refereceConfig = this.REFERENCES[referenceName];
        const collection = this[refereceConfig.collection];
        const idField = refereceConfig.idField;
        const label = `${referenceName} reference ${referenceData[idField]}`;
        // Check if the reference is already in the database
        const referenceQuery = { [idField]: referenceData[idField] };
        const previousData = await collection.findOne(referenceQuery);
        // If so we must compare previous and new reference data
        if (previousData) {
            // Check if there is anything new or different in the current reference
            const changed = await merge_metadata(previousData, referenceData, conserve, overwrite);
            // If there are no changes then there is nothing to upload
            if (!changed) return console.log(chalk.grey(`  The ${label} is already in the database and updated`));
            // Otherwise we must load the updated reference data
            logger.startLog(`💽 Updating ${label}`);
            // Replace the old reference with the updated data
            const result = await collection.replaceOne(referenceQuery, previousData);
            // If the operation failed
            if (result.acknowledged === false) return logger.failLog(`💽 Failed to update ${label}`);
            logger.successLog(`💽 Updated ${label}`);
        }
        else {
            // Otherwise load the new reference data as it is
            logger.startLog(`💽 Loading ${label}`);
            // Load the new reference
            const result = await collection.insertOne(referenceData);
            // If the operation failed
            if (result.acknowledged === false) return logger.failLog(`💽 Failed to load ${label}`);
            logger.successLog(`💽 Loaded new ${label} -> ${result.insertedId}`);
            // Update the inserted data in case we need to revert the change
            this.inserted_data.push({
                name: `new ${label}`,
                collection: collection,
                id: result.insertedId
            });
        }
    };

    // Check if a reference is still under usage
    // i.e. there is at least one project using it
    // Delete the reference otherwise
    deleteReferenceIfProper = async (referenceName, referenceId) => {
        // Set the reference configuration
        const refereceConfig = this.REFERENCES[referenceName];
        const projectIdsField = refereceConfig.projectIdsField;
        const label = `${referenceName} reference ${referenceId}`;
        const collection = this[refereceConfig.collection];
        const idField = refereceConfig.idField;
        // If the reference is still used by at least 1 project then stop here
        const count = await this.projects.count({ [projectIdsField]: referenceId });
        if (count > 0) return console.log(chalk.grey(`  The ${label} is still used by ${count} other projects`));
        // Delete the reference
        logger.startLog(`🗑️  Deleting ${label}`);
        const result = await collection.deleteOne({ [idField]: referenceId });
        if (!result) return logger.failLog(`🗑️  Failed to delete ${label}`);
        logger.successLog(`🗑️  Deleted ${label}`);
    }

    // Given an id, find the document and the collection it belongs to
    findId = async id => {
        // Iterate over all collections until we find the id
        for await (const [ collectionKey, collection ] of Object.entries(this.collections)) {
            const document = await collection.findOne({ _id: id });
            if (document) return { document, collectionKey };
        }
        // If there was no result then null is returned
        return null;
    }

    // Get the current counter status
    // If the counter does not exist yet then create it
    getCounter = async () => {
        // Find the counter document
        let counter = await this.counters.findOne({ accessions: true });
        // If the counter does not exist yet then create it
        if (!counter) {
            // Set the "zero" count for the counter
            // Note that this is not zero since we want the first issued accession to star with 'A'
            const zeroCount = parseInt(FIRST_ACCESSION_CODE, ALPHANUMERIC) - 1;
            // Set the counter document
            counter = { accessions: true, last: zeroCount };
            // Insert the new document
            logger.startLog(`🧮 Creating new accession counter`);
            const result = await this.counters.insertOne(counter);
            if (!result.acknowledged) logger.failLog(`🧮 Failed to create new accession counter`);
            logger.successLog('🧮 Created new accession counter');
        }
        // Now return the actual count
        return counter.last;
    };

    // Update the project counter by adding or substracting to the count
    updateCounter = async difference => {
        // First get the current count
        const currentCounter = await this.getCounter();
        // Now substract 1
        const newCounter = currentCounter + difference;
        // Now update the counter
        const differenceMessage = `${difference > 0 ? '+' : ''}${difference}`;
        logger.startLog(`🧮 Updating accession counter (${differenceMessage})`);
        const result = await this.counters.updateOne(
            { accessions: true },
            { $set: { last: newCounter } });
        if (!result.acknowledged)
            logger.failLog(`🧮 Failed to update accession counter (${differenceMessage})`);
        logger.successLog(`🧮 Updated accession counter (${differenceMessage})`);
    };

    // Check if an accession is the last issued accession according to the counter
    getLastAccession = async () => {
        // First get the current count
        const currentCounter = await this.getCounter();
        // Conver the current count to its corresponding accession
        return currentCounter.toString(ALPHANUMERIC).toUpperCase();
    };

    // Create a new accession and add 1 to the last accession count
    // Note that this is the default accession but it is not mandatory to use this accession format
    // A custom accession may be forced through command line
    issueNewAccession = async () => {
        // First get the current count
        const currentCounter = await this.getCounter();
        // Add one to the count
        const newCounter = currentCounter + 1;
        // Set the new accession
        const newAccessionCode = newCounter.toString(ALPHANUMERIC).toUpperCase();
        // Make sure we did not reach the limit
        if (newAccessionCode.length > ACCESSION_CHARACTERS_LIMIT)
            throw new Error(`You have reached the limit of accession codes. Next would be ${accessionCode}`);
        // Add one to the counter
        await this.updateCounter(1);
        // Make sure the new accession does not exist yet in the database
        const alreadyExistingProject = await this.projects.findOne({ accession: newAccessionCode });
        if (alreadyExistingProject) throw Error(`New issued accession ${newAccessionCode} already exists`);
        // Set the new accession issued flag as true
        // This allows to substract 1 from the counter if load is aborted to dont burn accessions
        this.new_accession_issued = true;
        // Return the new accession
        return newAccessionCode;
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
        // This means the last issued accession will be reused the next time we load a new project
        if (this.new_accession_issued) await this.updateCounter(-1);
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
        ligands: { collectionKey: 'projects', referenceField: 'metadata.LIGANDS', localField: 'pubchem' },
        pdb_refs: { collectionKey: 'projects', referenceField: 'metadata.PROTSEQ', localField: 'sequence' },
        chain_refs: { collectionKey: 'projects', referenceField: 'metadata.PDBIDS', localField: 'id' },
        topologies: { collectionKey: 'projects', referenceField: '_id', localField: 'project' },
        files: { collectionKey: 'projects', referenceField: '_id', localField: 'metadata.project' },
        chunks: { collectionKey: 'files', referenceField: '_id', localField: 'files_id' },
        analyses: { collectionKey: 'projects', referenceField: '_id', localField: 'project' },
        counters: null // Counters are not related to anything
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