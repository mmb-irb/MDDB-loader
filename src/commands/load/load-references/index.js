// Read and parse a JSON file
const loadJSON = require('../../../utils/load-json');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');

// This function extracts metadata from a local file
const loadReferences = async (filename, folder, spinnerRef, db) => {
  // Read the references data file
  const references = await loadJSON(filename, folder);
  if (!references) return;
  // Iterate over the different references
  for (const reference of references) {
    spinnerRef.current = getSpinner().start(
      'Loading reference ' + reference.uniprot,
    );
    // Check if the reference is already in the database and, if so, skip it
    const current = await db
      .collection('references')
      .findOne({ uniprot: reference.uniprot });
    if (current) {
      spinnerRef.current.succeed(
        'Reference ' + reference.uniprot + ' is already in the database',
      );
      continue;
    }
    // Load the new reference
    await new Promise((resolve, reject) => {
      db.collection('references').insertOne(
        reference,
        // Callback function
        (error, result) => {
          // In case the load fails
          if (error) {
            spinnerRef.current.fail(
              'Failed to load reference ' +
                reference.uniprot +
                ' with error ' +
                error,
            );
            reject();
          }
          // In case the load is successfull
          else {
            spinnerRef.current.succeed(
              'Loaded new reference ' +
                reference.uniprot +
                ' -> ' +
                result.insertedId,
            );
            resolve();
          }
        },
      );
    });
  }
};

module.exports = loadReferences;
