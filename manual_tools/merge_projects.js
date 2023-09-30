// WARNING: This script changes iteratively the database structure in many collections
// WARNING: Do not use it if you are not VERY SURE of what you are doing

// This script merges several projects with the old format in a single project with the new format
// Arguments for this script are the projects to be merged and the first argument is the project to remian

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const { ObjectId, MongoClient } = require('mongodb');

// Save the object from mongo which is associated to the provided id
// WARNING: If the argument passed to this function is null a new ObjectId is generated
const idCoerce = id => ObjectId(id);

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
    console.log('Updating project ' + projectIdsOrAccessions[0] + ' format');
  else
    console.log(
      'Merging projects ' +
        projectIdsOrAccessions.join(', ') +
        ' to remian as ' +
        projectIdsOrAccessions[0],
    );

  // Connect to mongo
  const client = await MongoClient.connect(
    `mongodb://${process.env.DB_SERVER}:${process.env.DB_PORT}`,
    {
      auth: {
        user: process.env.DB_AUTH_USER,
        password: process.env.DB_AUTH_PASSWORD,
      },
      authSource: process.env.DB_AUTHSOURCE,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      connectTimeoutMS: 0,
      socketTimeoutMS: 0, // In order to avoid Mongo connection time out
    },
  );

  // Get the data base
  db = client.db(process.env.DB_NAME);

  // Save the id of the first project when it is possible
  let remainerProjectId;

  // Set a list with the list of MDs to be appended to the project
  const mds = [];

  // Set a function to build a new 'md' from data in a 'project'
  const setMD = async idOrAccession => {
    const mdIndex = mds.length;
    // Set a query for the coressponding project or id
    const query = accessionFormat.test(idOrAccession)
      ? { accession: idOrAccession }
      : { _id: ObjectId(idOrAccession) };
    // Get the project data
    const projectData = await db.collection('projects').findOne(query);
    const projectId = projectData._id;
    console.log('   Project ID: ' + projectId);
    // Save the id if this is the first projecy
    if (!remainerProjectId) remainerProjectId = projectId;
    // MD inherits analyses and files mostly but also a few metadata
    // Modify some values to a new more coherent format
    // Get the list of analysis names and add the id
    const newAnalyses = await Promise.all(
      projectData.analyses.map(async analysis => {
        // Get the analysis data just to the id
        // Also update the analysis project id and add the md index
        const analysisData = await db
          .collection('analyses')
          .findOneAndUpdate(
            { name: analysis, project: projectId },
            { $set: { project: remainerProjectId, md: mdIndex } },
            { projection: { _id: true } },
          );
        return { name: analysis, id: analysisData.value._id };
      }),
    );
    // Get the list of files and reduce the stored data to just name and id
    const newFiles = projectData.files.map(file => ({
      name: file.filename,
      id: file._id,
    }));
    // Update each file project id and add the md index
    for (const file of projectData.files) {
      await db.collection('fs.files').findOneAndUpdate(
        { _id: file._id },
        {
          $set: {
            'metadata.project': remainerProjectId,
            'metadata.md': mdIndex,
          },
        },
      );
    }
    // Set the MD document and mine only the MD independent data from the project data
    const mdName = 'replica ' + (mdIndex + 1);
    const projectMetadata = projectData.metadata;
    const newMD = {
      name: mdName,
      atoms: projectMetadata.atomCount,
      frames: projectMetadata.frameCount,
      analyses: newAnalyses,
      files: newFiles,
    };
    // Mine warnings only if they exist
    if (projectMetadata.WARNINGS) newMD.warnings = projectMetadata.WARNINGS;
    // Add the MD document to the list
    mds.push(newMD);
    // If this project is the remaining one then we stop here
    if (projectId === remainerProjectId) return;
    // If this project is not the remaining one then remove its project entry, topology and chains
    const removeProjectResponse = await db
      .collection('projects')
      .deleteOne(query);
    const removeTopologyResponse = await db
      .collection('topologies')
      .deleteOne({ project: projectId });
    const removeChainsResponse = await db
      .collection('chains')
      .deleteMany({ project: projectId });
  };

  // Set MDs for each project
  for (const idOrAccession of projectIdsOrAccessions) {
    console.log('Processing ' + idOrAccession);
    await setMD(idOrAccession);
  }

  // Update the remaining project with the MDs
  // Remove also the project files an analyses fields since noew they are inside the MDs field
  // WARNING: This changes the projects collection
  const query = { _id: remainerProjectId };
  const updateResponse = await db
    .collection('projects')
    .findOneAndUpdate(query, {
      $set: { mdref: 0, mds: mds },
      $unset: { analyses: true, files: true },
    });

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();
