// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');

// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// Files system from node
const fs = require('fs');
// readFile allows to get data from a local file
// In this case data is retuned as a promise
const readFile = promisify(fs.readFile);

// Parse a json file
const processJSON = async path => {
  const fileContent = await readFile(path);
  const output = JSON.parse(fileContent);
  return output;
};

// List of recognized analyses
// If any of the patterns here match the analysis file, it won't be loaded
const acceptedAnalyses = [
  {
    name: 'dist-perres',
    pattern: /dist.perres.json/,
  },
  {
    name: 'rgyr', // Name to be set in mongo for this file
    pattern: /rgyr.json/, // Regular expression to match analysis files
  },
  {
    name: 'rmsds',
    pattern: /rmsds.json/,
  },
  {
    name: 'tmscores',
    pattern: /tmscores.json/,
  },
  {
    name: 'rmsd-perres',
    pattern: /rmsd.perres.json/,
  },
  {
    name: 'rmsd-pairwise',
    pattern: /rmsd.pairwise.json/,
  },
  {
    name: 'fluctuation',
    pattern: /rmsf.json/,
  },
  {
    name: 'hbonds',
    pattern: /hbonds.json/,
  },
  {
    name: 'energies',
    pattern: /energies.json/,
  },
  {
    name: 'pockets',
    pattern: /pockets.json/,
  },
  {
    name: 'sasa',
    pattern: /sasa.json/,
  },
  {
    name: 'interactions',
    pattern: /interactions.json/,
  },
  {
    name: 'pca',
    pattern: /pca.json/,
  },
];

// This function finds if a given filename matches a recognized type of analysis
// If it does, return the analysis type name. If it does not, send console error.
// This function expects to receive a single argument: the analysis filename
const nameAnalysis = analysisFile => {
  // Rest of analyses
  const analysis =
    acceptedAnalyses.find(({ pattern }) => pattern.test(analysisFile)) || {};
  // If any of the patterns match this file, "name" is undefined
  if (!analysis.name) {
    console.error(
      chalk.red(
        `${analysisFile} has not been identified as any of the valid analysis`,
      ),
    );
    return undefined;
  }
  // Return the name
  return analysis.name;
};

// Mine the analysis file and return data in a standarized format
const loadAnalysis = async (
  folder,
  analysisFile,
  spinnerRef,
  index,
  analysisLenght,
) => {
  // Rest of analyses
  if (spinnerRef)
    spinnerRef.current = getSpinner().start(
      `Loading analysis ${index} out of ${analysisLenght} [${analysisFile}]`,
    );
  // Check the analysis to be a JSON file according to its name
  const isJSON = /.json$/i.test(analysisFile);
  if (!isJSON) throw new Error('Analyses must be JSON files');
  // Read the analysis data
  const value = await processJSON(folder + analysisFile);
  // If mining was unsuccessful return undefined value
  if (!value) return undefined;
  // When everything was fine
  if (spinnerRef)
    spinnerRef.current.succeed(`Loaded analysis [${analysisFile}]`);
  return { value };
};

module.exports = {
  loadAnalysis,
  nameAnalysis,
};
