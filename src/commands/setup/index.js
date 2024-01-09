// Setup the database for the first time
// At this point the mongo database must exist already and it must be empty
// If the database is not empty then this process is aborted to avoid data loss
const setup = async ({}, database) => {
    // Check the number of collections already existing in the database
    const currentCollections = await database.db.listCollections().toArray();
    // If there is any collection we stop here
    if (currentCollections.length > 0) throw new Error('Database is not empty');
    // Create the required collections
    for await (const collectionName of Object.values(database.COLLECTION_NAMES)) {
        await database.db.createCollection(collectionName);
    }
    // Set some indices to accelerate specific queries
    // Index projects by their published status
    await database.projects.createIndex({ published: 1 });
    // Index files, analyses, chains and topologies by their project
    await database.files.createIndex({ 'metadata.project': 1 });
    await database.analyses.createIndex({ project: 1 });
    await database.chains.createIndex({ project: 1 });
    await database.topologies.createIndex({ project: 1 });
    // Set a document in the counters collection
    await database.counters.insertOne({ name: 'identifier', count: 0 });
    // We are done :)
    console.log('Database has been setup successfully');
};


module.exports = setup;