// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// Files system from node
const fs = require('fs');
// readFile allows to get data from a local file
// In this case data is retuned as a promise
const readFile = promisify(fs.readFile);

// This function extracts metadata from a local file
const loadMetadata = async (filename, folder, spinnerRef) => {
  try {
    const fileContent = await readFile(folder + '/' + filename, 'utf8');
    const output = JSON.parse(fileContent);

    return output;
  } catch (error) {
    // Display the end of this action as a failure in the console
    spinnerRef.current.fail(error);
  }
};

module.exports = loadMetadata;
