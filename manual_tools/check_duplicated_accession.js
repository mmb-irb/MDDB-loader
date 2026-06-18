// This script was used to reset accessions in the ABC database based on their names

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
    // Set the database handler
    const database = await getDatabase();
    // Get the number of projects just for the logs
    const projectCount = await database.projects.countDocuments();
    console.log(`Iterating ${projectCount} projects`);
    // Iterate over all database projects and count how many times every accession is present
    const availableProjects = await database.projects.find({}, { projection: { _id: false, accession: true } });
    const accessionCounts = {};
    for await (const project of availableProjects) {
        accessionCounts[project.accession] = (accessionCounts[project.accession] + 1) || 1;
    }
    // Log those accession with more than 1 count
    for await (const [accession, count] of Object.entries(accessionCounts)) {
        if (count === 1) continue;
        console.log(`   Accession ${accession} -> ${count} repeats`);
    }

    // Clean exit
    console.log('Allright :)');
    process.exit(0);
};

main();
