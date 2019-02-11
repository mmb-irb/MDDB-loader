const promisify = require('util').promisify;
const fs = require('fs');

const _ = require('lodash');
const ora = require('ora');

const readFile = promisify(fs.readFile);

const NEW_LINES = /\s*\n+\s*/g;
const SEPARATORS = /\s*,\s*/g;

const loadMetadata = async folder => {
  const spinner = ora().start(`Loading metadata`);
  spinner.time = Date.now();
  try {
    const fileContent = await readFile(folder + '/metadata', 'utf8');
    const output = _.fromPairs(
      fileContent
        .split(NEW_LINES)
        .filter(Boolean)
        .map(line => {
          const split = line.split(SEPARATORS);
          const numberMaybe = +split[1];
          return [
            split[0],
            Number.isFinite(numberMaybe) ? numberMaybe : split[1],
          ];
        }),
    );
    spinner.succeed(
      `Loaded metadata (${Math.round((Date.now() - spinner.time) / 1000)}s)`,
    );
    return output;
  } catch (error) {
    spinner.fail(error);
  }
};

module.exports = loadMetadata;
