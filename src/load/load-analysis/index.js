const _ = require('lodash');
const mathjs = require('mathjs');

const readFilePerLine = require('../../utils/read-file-per-line');
const statFileLinesToDataLines = require('./stat-file-lines-to-data-lines');

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
    y.average = mathjs.mean(y.data);
    y.stddev = mathjs.std(y.data);
  }
  output.y = _.fromPairs(Array.from(output.y.entries()));
  return output;
};

const analyses = [
  {
    name: 'rgyr',
    pattern: /rgyr/,
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

const loadAnalysis = async (folder, analysisFile) => {
  const { name, process } =
    analyses.find(({ pattern }) => pattern.test(analysisFile)) || {};
  if (!name) return;
  return [
    name,
    await process(
      statFileLinesToDataLines(readFilePerLine(folder + analysisFile)),
    ),
  ];
};

module.exports = loadAnalysis;
