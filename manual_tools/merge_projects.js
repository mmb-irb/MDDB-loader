// WARNING: This script changes iteratively the database structure in many collections
// WARNING: Do not use it if you are not VERY SURE of what you are doing

// This script merges several projects with the old format in a single project with the new format
// Arguments for this script are the projects to be merged and the first argument is the project to remian

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');
const { idOrAccessionCoerce, mongoidFormat } = require('../src/utils/auxiliar-functions');

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
    console.log('Updating project ' + projectIdsOrAccessions[0] + ' format');
  else
    console.log(
      'Merging projects ' + projectIdsOrAccessions.join(', ') +
      ' to remian as ' + projectIdsOrAccessions[0],
    );

  // Set the database handler
  const database = await getDatabase();

  // Save the id of the first project when it is possible
  let remainerProject;

  // Set a function to build a new 'md' from data in a 'project'
  const setMD = async idOrAccession => {
    // Set a query for the coressponding project or id
    const query = mongoidFormat.test(idOrAccession) ? idOrAccession : { accession: idOrAccession };
    // Get the project data
    const projectData = await database.projects.findOne(query);
    console.log('   Project ID: ' + projectData._id);
    // If this is the first project then set its id as the reamining id and go to the next project
    if (!remainerProject) {
      remainerProject = projectData;
      return;
    }
    // If this project is not the first project then add its MDs to the first project
    for await (const md of projectData.mds) {
      // Get the new MD index
      const mdIndex = remainerProject.mds.length;
      // Set a new name for the current MD
      const mdName = 'replica ' + (mdIndex + 1);
      md.name = mdName;
      // Add the MD as it is to the remaining project
      remainerProject.mds.push(md);
      // Now modifiy the project id and MD index in every MD analysis and file
      for await (const analysis of md.analyses) {
        // Find the analysis using the id and update its contents
        await database.analyses.findOneAndUpdate(
          { _id: analysis.id },
          { $set: { project: remainerProject._id, md: mdIndex } },
        );
      }
      // Update each file project id and add the md index
      for (const file of md.files) {
        await database.files.findOneAndUpdate(
          { _id: file.id },
          { $set: {
            'metadata.project': remainerProject._id,
            'metadata.md': mdIndex },
          },
        );
      }
    };
    // If this project is not the remaining one then remove its project entry, topology and chains
    await database.projects.deleteOne(query);
    await database.topologies.deleteOne({ project: projectData._id });
    await database.chains.deleteMany({ project: projectData._id });
  };

  // Set MDs for each project
  for (const idOrAccession of projectIdsOrAccessions) {
    console.log('Processing ' + idOrAccession);
    await setMD(idOrAccession);
  }

  // Update the remaining project with the MDs
  // WARNING: This changes the projects collection
  const query = { _id: remainerProject._id };
  await database.projects.replaceOne(query, remainerProject);

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();
