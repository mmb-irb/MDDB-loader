// This script is used to rename an analysis in the whole database
// This script was used to rename md.imaged.rot.dry.pdb as structure.pdb and md.imaged.rot.xtc as trajectory.xtc

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
if (process.argv.length !== 4) throw new Error('2 arguments are expected: old analysis name and new analysis name');

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
  const oldName = process.argv[2];
  const newName = process.argv[3];
  // Warn the user about what is about to happen
  console.log(`Renaming all analyses with name ${oldName} as ${newName}`);

  // Set the database handler
  const database = await getDatabase();

  // Find all analyses with the old name
  const oldAnalyses = await database.analyses.find({ name: oldName }, { _id: true }).toArray();
  console.log(`  Old-named analyses found: ${oldAnalyses.length}`);
  // Get the ids of the affected projects
  const allProjectsIds = new Set(oldAnalyses.map(analysis => analysis.project.toString()));
  console.log(`  Affected projects found: ${allProjectsIds.size}`);

  // Iterate over every project
  for await (const projectId of allProjectsIds) {
    console.log('   Project ID: ' + projectId);
    // Get the current project
    const project = await database.syncProject(projectId);
    if (!project) throw new Error(`Can't find project with id ${projectId}`);
    // Find the target analysis among project analyses
    const targetAnalysis = project.data.analyses && project.data.analyses.find(analysis => analysis.name === oldName);
    if (targetAnalysis) await project.renameAnalysis(oldName, undefined, newName);
    // Iterate over MDs
    for (const [mdIndex, md] of Object.entries(project.data.mds)) {
      const mdtargetAnalysis = md.analyses.find(analysis => analysis.name === oldName);
      if (mdtargetAnalysis) await project.renameAnalysis(oldName, mdIndex, newName);
    }
  }

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();