// This script fixes a mess

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const { ObjectId } = require('mongodb');
const Database = require('../src/database');
const connectToMongo = require('../src/utils/connect-to-mongo/index');

// Save the object from mongo which is associated to the provided id
// WARNING: If the argument passed to this function is null a new ObjectId is generated
const idCoerce = id => new ObjectId(id);

// RegExp formula to check if a string is in accession format
//const accessionFormat = /^MCNS\d{5}$/;
const accessionFormat = new RegExp(
  '^' + process.env.ACCESSION_PREFIX + '\\d{5}$',
);

// Convert the input accession string into a valid accession format
const accessionCoerce = accession => {
  // Remove spaces from the accession argument and make all characters upper case
  const output = accession.trim().toUpperCase();
  // Check if the new accession (output) is a valid accession format. If not, send an error
  if (!accessionFormat.test(output)) throw new Error('Not a valid accession');
  return output;
};

// Try to coerce the input argument as a mongo id
// If fails, try it as an accession
const idOrAccessionCoerce = idOrAccession => {
  let output;
  // This is to prevent idCoerce() to generate a new ObjectId if the passed argument is null
  if (!idOrAccession) return null;
  try {
    output = idCoerce(idOrAccession);
  } catch (_) {
    try {
      output = accessionCoerce(idOrAccession);
    } catch (_) {
      /**/
    }
  }
  if (output) return output;
  throw new Error('Invalid ID or accession: ' + idOrAccession);
};

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

  // Connect to mongo
  const { client, db, bucket } = await connectToMongo();
  // Set the database handler
  const database = new Database(db, bucket);
  await database.setupProject(id = idOrAccession);


  // Set a query for the coressponding project or id
  const query = accessionFormat.test(idOrAccession)
    ? { accession: idOrAccession }
    : { _id: new ObjectId(idOrAccession) };
  // Get the project data
  const projectData = await db.collection('projects').findOne(query);
  const projectId = projectData._id;
  console.log('   Project ID: ' + projectId);
  // Iterate over MDs
  for await (const [mdIndex, md] of projectData.mds.entries()) {
    // Iterate over analyses
    // for await (const analysis of md.analyses) {
    //   console.log(`Fixing ${analysis.name} with id ${analysis._id}`);
    //   // Find the actual analysis and add the MD index to it
    //   await db.collection('analyses').findOneAndUpdate(
    //     { _id: analysis._id },
    //     { $set: { md: mdIndex } }
    //   );
    // }
    // Iterate over files
    for await (const file of md.files) {
      console.log(`Fixing ${file.name} with id ${file.id}`);
      // Find the actual file and add the MD index to it
      await db.collection('fs.files').findOneAndUpdate(
        { _id: file.id },
        { $set: { 'metadata.md': mdIndex } }
      );
      // Skip the file if it is the main trajectory
      //if (file.name === 'trajectory.xtc' || file.name === 'trajectory.bin') continue;
      // Remove the file
      //await database.deleteFile(file.name, mdIndex);
    }
  }

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();
