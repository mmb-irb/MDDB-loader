// This script is used to rename a file in the whole database
// This script was used to rename md.imaged.rot.dry.pdb as structure.pdb and md.imaged.rot.xtc as trajectory.xtc

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
if (process.argv.length !== 4) throw new Error('2 arguments are expected: old filename and new filename');

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
  const oldFilename = process.argv[2];
  const newFilename = process.argv[3];
  // Warn the user about what is about to happen
  console.log(`Renaming all files with name ${oldFilename} as ${newFilename}`);

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
    const project = await database.syncProject(projectId);
    // Find the target file among project files
    const targetFile = project.data.files.find(file => file.name === oldFilename);
    if (targetFile) await project.renameFile(oldFilename, undefined, newFilename);
    // Iterate over MDs
    for (const [mdIndex, md] of Object.entries(project.data.mds)) {
      const mdTargetFile = md.files.find(file => file.name === oldFilename);
      if (mdTargetFile) await project.renameFile(oldFilename, mdIndex, newFilename);
    }
  }

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();