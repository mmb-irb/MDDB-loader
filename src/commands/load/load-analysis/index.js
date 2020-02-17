const fromPairs = require('lodash.frompairs');
const mathjs = require('mathjs');

const readFilePerLine = require('../../../utils/read-file-per-line');
const statFileLinesToDataLines = require('../../../utils/stat-file-lines-to-data-lines');

// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');

const processFunctionCreator = (...keys) => async dataAsyncGenerator => {
  const output = {
    step: 0,
    y: new Map(keys.map(y => [y, { average: 0, stddev: 0, data: [] }])),
  };
  for await (const data of dataAsyncGenerator) {
    if (!output.step) output.step = data[0];
    for (const [index, value] of Array.from(output.y.keys()).entries()) {
      output.y.get(value).data.push(data[index + 1]);
    }
  }
  for (const key of output.y.keys()) {
    const y = output.y.get(key);
    y.min = mathjs.min(y.data);
    y.max = mathjs.max(y.data);
    y.average = mathjs.mean(y.data);
    y.stddev = mathjs.std(y.data);
  }
  output.y = fromPairs(Array.from(output.y.entries()));
  return output;
};

// List of recognized analyses
// If any of the patterns here match the analysis file, it won't be loaded
const acceptedAnalyses = [
  {
    name: 'dist',
    pattern: /dist/,
    process: processFunctionCreator('dist'),
  },
  {
    name: 'rgyr', // Name to be set in mongo for this file
    pattern: /rgyr/, // Regular expression to match analysis files
    // Logic used to mine and tag data
    process: processFunctionCreator('rgyr', 'rgyrx', 'rgyry', 'rgyrz'),
  },
  {
    name: 'rmsd',
    pattern: /rmsd/,
    process: processFunctionCreator('rmsd'),
  },
  {
    name: 'fluctuation',
    pattern: /rmsf/,
    process: processFunctionCreator('rmsf'),
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
  spinnerRef.current = getSpinner().start(
    `Loading analysis ${index} out of ${analysisLenght} [${analysisFile}]`,
  );
  // Retrieve the 'process' function
  const { process } =
    acceptedAnalyses.find(({ pattern }) => pattern.test(analysisFile)) || {};
  // Mine the analysis data
  const value = await process(
    statFileLinesToDataLines(readFilePerLine(folder + analysisFile)),
  );
  // If mining was unsuccessful return undefined value
  if (!value) return { undefined };
  // When everything was fine
  spinnerRef.current.succeed(`Loaded analysis [${analysisFile}]`);
  return { value };
};

module.exports = {
  loadAnalysis,
  nameAnalysis,
};
