const promisify = require('util').promisify;
const fs = require('fs');
const readFile = promisify(fs.readFile);

const _ = require('lodash');

const NEW_LINES = /\s*\n+\s*/g;
const SEPARATORS = /\s*,\s*/g;

const loadMetadata = async folder =>
  _.fromPairs(
    (await readFile(folder + 'metadata', 'utf8'))
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

module.exports = loadMetadata;
