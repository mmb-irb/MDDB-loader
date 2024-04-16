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
  // Iterate over all database projects
  const availableProjects = await database.iterateProjects();
  for await (const project of availableProjects) {
    console.log('   Project ID: ' + project.id);
    // Set a new accession for the project using the metadata name
    const name = project.data.metadata.NAME;
    const number = name.slice(name.length - 3);
    const accession = `seq${number}`;
    project.data.accession = accession;
    console.log(accession);
    await project.updateRemote();
  }

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();
