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
// If 'getStats' is passed as true then it calculates data minimum, maximum, average and standard deviation
const processAutoKeys = getStats => async dataAsyncGenerator => {
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
      output.y.get(value).data.push(data[index + 1]);
    }
  }
  // Harvest some metadata and include it in the object
  if (getStats) {
    for (const key of output.y.keys()) {
      const y = output.y.get(key);
      y.min = mathjs.min(y.data);
      y.max = mathjs.max(y.data);
      y.average = mathjs.mean(y.data);
      y.stddev = mathjs.std(y.data);
    }
    output.y = fromPairs(Array.from(output.y.entries()));
  }

  return output;
};

// Set the analysis in a standarized format for mongo
// Data is harvested according to a provided list of keys
const processMatrix = () => async dataAsyncGenerator => {
  // The 'keys' are defined below. They change through each analysis
  // Keys define the number of data arrays and their names
  const output = {
    y: [],
  };
  // Read the main data, which comes from the generator
  for await (const data of dataAsyncGenerator) {
    // The comments go first
    if (COMMENT_LINE.test(data)) continue;
    // Append the main data to the output.y array
    output.y.push(data);
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
    name: 'dist-perres-mean',
    pattern: /dist.perres.mean.xvg/,
    process: processMatrix(),
  },
  {
    name: 'dist-perres-stdv',
    pattern: /dist.perres.stdv.xvg/,
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
    process: processAutoKeys(true),
  },
  {
    name: 'rmsd-pairwise',
    pattern: /rmsd.pairwise.xvg/,
    process: processMatrix(),
  },
  {
    name: 'rmsd-pairwise-interface',
    pattern: /rmsd.pairwise.interface.xvg/,
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
    process: processAutoKeys(false),
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
