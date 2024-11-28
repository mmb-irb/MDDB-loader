// This script is used to move MD files to project files
// WARNING: Note that in case the project have multiple replicas only one will be moved
// WARNING: The rest will be deleted
// This script was used to relocate files such as 'topology.tpr' from old projects

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
if (process.argv.length !== 3) {
  console.error('One an only one argument is expected: target filename');
  process.exit(1);
}

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
  const targetFilename = process.argv[2];
  // Warn the user about what is about to happen
  console.log(`Moving MD files with name ${targetFilename} to project files`);

  // Set the database handler
  const database = await getDatabase();

  // Get all projects which have the target filename among their MD files
  const targetProjects = await database.projects.find({'mds.files.name': targetFilename},{_id:true}).toArray();
  console.log(`A total of ${targetProjects.length} projects have a ${targetFilename} among their MD files`);

  // Get target project ids
  const targetProjectsIds = targetProjects.map(project => project._id);

  // Iterate over every project
  for await (const projectId of targetProjectsIds) {
    // Track when we already moved a file from one of the MDs
    let movedFile = false
    // Get the current project
    const project = await database.syncProject(projectId);
    console.log('\x1b[33m%s\x1b[0m', ` Project ${project.accession} (${projectId})`);
    // Iterate over MDs
    for (const [mdIndex, md] of Object.entries(project.data.mds)) {
      // Find the target file among project files
      const targetFile = md.files.find(file => file.name === targetFilename);
      // If this replicas has not the target file then go to the next MD
      if (!targetFile) continue;
      // If we found the target file...
      // If we did not move any file yet then we must move it
      if (!movedFile) {
        console.log('\x1b[32m%s\x1b[0m', '  MOVING');
        // Add it to project files
        project.data.files.push(targetFile);
        // Remove it from MD files
        const targetFileIndex = md.files.indexOf(targetFile);
        md.files.splice(targetFileIndex, 1);
        // Update the project
        await project.updateRemote();
        // Edit the file itself to remove the MD index from it
        await database.files.findOneAndUpdate({ _id: targetFile.id }, {$set: { 'metadata.md': null }});
        // Update the tracker so files in further MDs are deleted
        movedFile = true;
      }
      // If we already moved a file from the current project then we must delete it
      else {
        console.log('\x1b[31m%s\x1b[0m', '  DELETING');
        await project.deleteFile(targetFilename, mdIndex);
      }

      //throw new Error('Hold up');
    }
  }

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();