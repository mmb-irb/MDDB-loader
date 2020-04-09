// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// Files system from node
const fs = require('fs');
// readFile allows to get data from a local file
// In this case data is retuned as a promise
const readFile = promisify(fs.readFile);
// The "fromPairs" function combine different objects into a single one
const fromPairs = require('lodash.frompairs');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');
// RegExp patterns
const NEW_LINES = /\s*\n+\s*/g;
const SEPARATORS = /\s*,\s*/g;

// This function extracts metadata from a local file
const loadMetadata = async (filename, folder, spinnerRef) => {
  // Display the start of this action in the console
  spinnerRef.current = getSpinner().start('Loading ' + filename);
  try {
    // Read metadata from local file
    const fileContent = await readFile(folder + '/' + filename, 'utf8');
    // Process metadata by splitting, transforming and joining back again data as a unique object
    const output = fromPairs(
      fileContent
        .split(NEW_LINES) // Split accoridng to a RegExp pattern
        .filter(Boolean) // Discard empty strings
        .map(line => {
          const split = line.split(SEPARATORS); // Split again by a different RegExp pattern
          console.log(split[0] + ' / ' + split[1]);
          const numberMaybe = +split[1]; // Get the second splitted fragment as an integer
          return [
            split[0], // Return first fragment as a string
            // Second fragment is returned as an integer or as string depending on if it is a number
            Number.isFinite(numberMaybe) ? numberMaybe : split[1],
          ];
        }),
    );
    // Display the end of this action as a success in the console
    spinnerRef.current.succeed('Loaded ' + filename);

    return output;
  } catch (error) {
    // Display the end of this action as a failure in the console
    spinnerRef.current.fail(error);
  }
};

module.exports = loadMetadata;
