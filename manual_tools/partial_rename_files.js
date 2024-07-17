// This script is used to rename a file in the whole database
// This script was used to rename md.imaged.rot.dry.pdb as structure.pdb and md.imaged.rot.xtc as trajectory.xtc

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
if (process.argv.length !== 4) throw new Error('2 arguments are expected: old string and new string');

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
  const oldString = process.argv[2];
  const newString = process.argv[3];
  // Warn the user about what is about to happen
  console.log(`Renaming all files with '${oldString}' in their names by replacing it with '${newString}'`);

  // Set the database handler
  const database = await getDatabase();

  // Get all available projects
  const allProjects = await database.projects.find({},{_id:true}).toArray();
  const allProjectsIds = allProjects.map(project => project._id);
  console.log(`${allProjectsIds.length} projects were found`);

  // Iterate over every project
  for await (const projectId of allProjectsIds) {
    console.log('   Project ID: ' + projectId);
    // Get the current project
    await database.syncProject(projectId);
    // Iterate over project pca files (there should be none, but just in case)
    const files = database.project_data.files.filter(file => file.name.includes(oldString));
    for await (const file of files) {
      const oldFilename = file.name;
      const newFilename = file.name.replace(oldString, newString);
      await database.renameFile(oldFilename, undefined, newFilename);
    }
    // Iterate over MDs
    for (const [mdIndex, md] of Object.entries(database.project_data.mds)) {
      // Iterate over MD pca files
      const files = md.files.filter(file => file.name.includes(oldString));
      for await (const file of files) {
        const oldFilename = file.name;
        const newFilename = file.name.replace(oldString, newString);
        await database.renameFile(oldFilename, mdIndex, newFilename);
      }
    }
  }

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();