// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// Files system from node
const fs = require('fs');
// readFile allows to get data from a local file
// In this case data is retuned as a promise
const readFile = promisify(fs.readFile);

// Read and parse a JSON file
const loadJSON = async (filepath) => {
  try {
    const fileContent = await readFile(filepath, 'utf8');
    const output = JSON.parse(fileContent);
    return output;
  } catch (error) {
    console.error(error);
    return null;
  }
};

module.exports = loadJSON;
