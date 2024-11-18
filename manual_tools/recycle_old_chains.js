// This script is used to rename a file in the whole database
// This script was used to rename md.imaged.rot.dry.pdb as structure.pdb and md.imaged.rot.xtc as trajectory.xtc

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
    // Warn the user about what is about to happen
    console.log(`Recycling old chains as new chain_refs`);

    // Set the database handler
    const database = await getDatabase();

    // Get the old chains collection
    const oldChainsCollection = database.db.collection('chains');

    // Make sure we have old chains to recycle
    const oldChainsCount = await oldChainsCollection.count();
    if (oldChainsCount === 0) throw new Error('There are no old chains');
    console.log(`Found ${oldChainsCount} old chains`);

    let count = 0;
    let recycledCount = 0;

    // Iterate old chains
    // Get rid of internal Ids and the 'name' field, which is is the old chain letter 
    const oldChainsCursor = await oldChainsCollection.find({}, { projection: { _id: false, name: false }});
    for await (const oldChain of oldChainsCursor) {
        count += 1;
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`  Checking old chain ${count} / ${oldChainsCount} -> ${recycledCount} chains recycled so far`);
        // If the old chain sequence is already among the chain references then stop here
        const alreadyExistingChainRef = await database.chain_refs.findOne({ sequence: oldChain.sequence });
        if (alreadyExistingChainRef !== null) continue;
        // Otherwise add this chain to the chain_refs collection
        const confirm = await database.chain_refs.insertOne(oldChain);
        if (!confirm.acknowledged) throw new Error('Something went wrong when inserting new chain reference');
        recycledCount += 1;
    }

    // Log the result
    process.stdout.write("\n");
    console.log(`We successfully recycled ${recycledCount} old chains`);

    // Clean exit
    process.exit(0);
};

main();