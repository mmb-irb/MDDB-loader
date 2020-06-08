const fromPairs = require('lodash.frompairs');
const mathjs = require('mathjs');

const readFilePerLine = require('../../../utils/read-file-per-line');
const statFileLinesToDataLines = require('../../../utils/stat-file-lines-to-data-lines');

// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');

// Lines which start by #, @ or &
const COMMENT_LINE = statFileLinesToDataLines.COMMENT_LINE;
// Lines which define keys
const KEY_MINER = /^@ key (.*$)/;
// Label miners
const COLUMN = /^@ column (.*$)/;
const MATRIX = /^@ matrix (.*$)/;

// Set the analysis in a standarized format for mongo
// Data is harvested according to a provided list of keys
const processByKeys = (...keys) => async dataAsyncGenerator => {
  // The 'keys' are defined below. They change through each analysis
  // Keys define the number of data arrays and their names
  const output = {
    start: null,
    step: null,
    y: new Map(keys.map(y => [y, { average: 0, stddev: 0, data: [] }])),
  };
  // Read the main data, which comes from the generator
  for await (const data of dataAsyncGenerator) {
    if (COMMENT_LINE.test(data)) continue;
    // Define the time step as the diference bwetween the first and the second values
    if (output.start !== null && output.step === null)
      output.step = data[0] - output.start;
    // Save the first value as start
    if (output.start === null) output.start = data[0];
    // Append the main data to each key array
    for (const [index, value] of Array.from(output.y.keys()).entries()) {
      output.y.get(value).data.push(data[index + 1]);
    }
  }
  // Harvest some metadata and include it in the object
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

// Set the analysis in a standarized format for mongo
// Data is harvested according to a provided list of keys
// Keys are declared in file comments as '@ key ...'
// The first data column is ignored and it is mean to be a regularly stepped 'x' edge
const processAutoKeys = () => async dataAsyncGenerator => {
  // The 'keys' are defined below. They change through each analysis
  // Keys define the number of data arrays and their names
  const output = {
    start: null,
    step: null,
    y: new Map(),
  };
  // Read the main data, which comes from the generator
  for await (const data of dataAsyncGenerator) {
    // The comments go first
    if (COMMENT_LINE.test(data)) {
      // Harvest the keys if we are meant to
      const key = KEY_MINER.exec(data);
      // Set the key
      if (key) output.y.set(key[1], { average: 0, stddev: 0, data: [] });
      continue;
    }
    // Define the time step as the diference bwetween the first and the second values
    if (output.start !== null && output.step === null)
      output.step = data[0] - output.start;
    // Save the first value as start
    if (output.start === null) output.start = data[0];
    // Append the main data to each key array
    for (const [index, value] of Array.from(output.y.keys()).entries()) {
      // The '+ 1' makes the first file column to be ignored
      output.y.get(value).data.push(data[index + 1]);
    }
  }
  // Harvest some metadata and include it in the object
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

// Set the analysis in a standarized format for mongo
// Data is harvested according to a provided list of keys
const processMatrix = () => async dataAsyncGenerator => {
  // The 'keys' are defined below. They change through each analysis
  // Keys define the number of data arrays and their names
  const output = {};
  // Name of the field to be filled with new data
  let label;
  // Set the method to fill the field with new data
  let protocol;
  // 1 - Column
  // 2 - Matrix

  // Read the main data, which comes from the generator
  for await (const data of dataAsyncGenerator) {
    // The comments go first
    // They set the new data label and organizing method
    if (COMMENT_LINE.test(data)) {
      const column = COLUMN.exec(data);
      if (column) {
        protocol = 1;
        label = column[1];
        output[label] = [];
        continue;
      }
      const matrix = MATRIX.exec(data);
      if (matrix) {
        protocol = 2;
        label = matrix[1];
        output[label] = [];
        continue;
      }
      continue;
    }
    // When it is not a comment
    // Append the main data to the output object
    if (protocol === 1) output[label] = data;
    if (protocol === 2) output[label].push(data);
  }
  //console.log(output);
  return output;
};

// Keys are automatically harvested to tag each column
const processColumns = () => async dataAsyncGenerator => {
  // The 'keys' are defined below. They change through each analysis
  // Keys define the number of data arrays and their names
  const output = new Map();
  // Read the main data, which comes from the generator
  for await (const data of dataAsyncGenerator) {
    // The comments go first
    if (COMMENT_LINE.test(data)) {
      // Harvest the keys if we are meant to
      const key = KEY_MINER.exec(data);
      // Set the key
      if (key) output.set(key[1], []);
      continue;
    }
    // Append the main data to each key array
    for (const [index, value] of Array.from(output.keys()).entries()) {
      // The '+ 1' makes the first file column to be ignored
      output.get(value).push(data[index]);
    }
  }
  return output;
};

// List of recognized analyses
// If any of the patterns here match the analysis file, it won't be loaded
const acceptedAnalyses = [
  {
    name: 'dist',
    pattern: /dist.xvg/,
    process: processByKeys('dist'),
  },
  {
    name: 'dist-perres',
    pattern: /dist.perres.xvg/,
    process: processMatrix(),
  },
  {
    name: 'rgyr', // Name to be set in mongo for this file
    pattern: /rgyr.xvg/, // Regular expression to match analysis files
    // Logic used to mine and tag data
    process: processByKeys('rgyr', 'rgyrx', 'rgyry', 'rgyrz'),
  },
  {
    name: 'rmsd',
    pattern: /rmsd.xvg/,
    process: processByKeys('rmsd'),
  },
  {
    name: 'rmsd-perres',
    pattern: /rmsd.perres.xvg/,
    process: processAutoKeys(),
  },
  {
    name: 'rmsd-pairwise',
    pattern: /rmsd.pairwise.xvg/,
    process: processMatrix(),
  },
  {
    name: 'fluctuation',
    pattern: /rmsf.xvg/,
    process: processByKeys('rmsf'),
  },
  {
    name: 'hbonds',
    pattern: /hbonds.xvg/,
    process: processColumns(),
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
  if (spinnerRef)
    spinnerRef.current.succeed(`Loaded analysis [${analysisFile}]`);
  return { value };
};

module.exports = {
  loadAnalysis,
  nameAnalysis,
};
