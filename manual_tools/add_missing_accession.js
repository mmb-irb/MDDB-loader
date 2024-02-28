// This script fixes a mess

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');
const { idOrAccessionCoerce } = require('../src/utils/auxiliar-functions');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
const projectIdsOrAccessions = [];
process.argv.forEach((arg, i) => {
  // Skip the first 2 arguments: the path to the command and the path to the script
  if (i < 2) return;
  // Parse the argument to an id or accesion
  // If it fails then it will throw an error
  const idOrAccesion = idOrAccessionCoerce(arg);
  projectIdsOrAccessions.push(idOrAccesion);
});

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
  // Warn the user about what it about to happen
  if (projectIdsOrAccessions.length === 0)
    return console.log('No projects were passed');
  if (projectIdsOrAccessions.length === 1)
    console.log('Updating project ' + projectIdsOrAccessions[0]);
  else return console.log('There must be 1 project only');

  const idOrAccession = projectIdsOrAccessions[0];

  // Set the database handler
  const database = await getDatabase();
  // Sync the requested project
  const project = await database.syncProject(id = idOrAccession);
  console.log('   Project ID: ' + project.id);
  // Set a new accession for the project
  const accession = await database.issueNewAccession();
  project.data.accession = accession;
  await project.updateRemote();
  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();
