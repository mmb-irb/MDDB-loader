const { promisify } = require('util');
const fs = require('fs');

const readdir = promisify(fs.readdir);

const rawFilePatternToLoad = /\.pdb$/i;
const trajectoryFilePatternToLoad = /^md.imaged.rot.xtc$/i;
const pcaFilePatternToLoad = /pca\./i;
const analysisFilePatternToLoad = /\.xvg$/i;

const categorizeFilesInFolder = async folder => {
  const allFiles = await readdir(folder);
  const rawFiles = allFiles.filter(filename =>
    rawFilePatternToLoad.test(filename),
  );
  const trajectoryFile = allFiles.find(filename =>
    trajectoryFilePatternToLoad.test(filename),
  );
  const pcaFiles = allFiles.filter(filename =>
    pcaFilePatternToLoad.test(filename),
  );
  const analysisFiles = allFiles.filter(
    filename =>
      analysisFilePatternToLoad.test(filename) &&
      !pcaFilePatternToLoad.test(filename),
  );
  return { allFiles, rawFiles, trajectoryFile, pcaFiles, analysisFiles };
};

module.exports = categorizeFilesInFolder;
