const promisify = require('util').promisify;
const fs = require('fs');

const readdir = promisify(fs.readdir);

const rawFilePatternToLoad = /\.(dcd|pdb)$/i;
const analysisFilePatternToLoad = /\.xvg$/i;
const trajectoryFilePatternToLoad = /\.trj$/i;

const categorizeFilesInFolder = async folder => {
  const allFiles = await readdir(folder);
  const rawFiles = allFiles.filter(filename =>
    rawFilePatternToLoad.test(filename),
  );
  const trajectoryFile = allFiles.find(filename =>
    trajectoryFilePatternToLoad.test(filename),
  );
  const analysisFiles = allFiles.filter(filename =>
    analysisFilePatternToLoad.test(filename),
  );
  return { allFiles, rawFiles, trajectoryFile, analysisFiles };
};

module.exports = categorizeFilesInFolder;
