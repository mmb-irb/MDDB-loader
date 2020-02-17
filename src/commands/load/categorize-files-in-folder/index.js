// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// Files system from node
const fs = require('fs');
// Function fs.readdir returns all files in a directory
// In this case return them as a promise
const readdir = promisify(fs.readdir);
// RegExp patterns
const pdbFilePatternToLoad = /^md\..+\.pdb$/i;
const metadataFilePatternToLoad = /metadata$/i;
const rawFilePatternToLoad = /\.(pdb|xtc)$/i;
const trajectoryFilePatternToLoad = /(^md.imaged.rot|pca-\d+).xtc$/i;
// Alternative regexp to test the code with a small trajectory
//const trajectoryFilePatternToLoad = /md.imaged.rot.100.xtc$/i;
const pcaFilePatternToLoad = /pca\./i;
const analysisFilePatternToLoad = /\.xvg$/i;

// This function finds all files in the "folder" argument path and classifies them
// Classification is performed according to the file names
const categorizeFilesInFolder = async folder => {
  // Save all files in the folder path as a strings array
  const allFiles = await readdir(folder);
  // Now classify all files according to their names
  // Raw files are those which end in ".pdb" or ".xtc"
  const rawFiles = allFiles.filter(filename =>
    rawFilePatternToLoad.test(filename),
  );
  // Look for a file which matches de pdbFile regular expression
  const pdbFile = rawFiles.find(filename =>
    pdbFilePatternToLoad.test(filename),
  );
  // Look for a file which is called exactly 'metadata'
  const metadataFile = allFiles.find(filename =>
    metadataFilePatternToLoad.test(filename),
  );
  // Trajectory files are those which end in ".xtc". Some other restrictions are taken
  const trajectoryFiles = allFiles.filter(filename =>
    trajectoryFilePatternToLoad.test(filename),
  );
  // PCA files are those which contain "pca" in their names
  const pcaFiles = allFiles.filter(filename =>
    pcaFilePatternToLoad.test(filename),
  );
  // Analysis files are those which end in ".xvg" and do not belong to the PCA files
  const analysisFiles = allFiles.filter(
    filename =>
      analysisFilePatternToLoad.test(filename) &&
      !pcaFilePatternToLoad.test(filename),
  );
  // Finally, return all classified groups and the group which contain all files
  // PORQUE DEVUELVES allFiles SI LUEGO NO LO USAS?
  return {
    allFiles,
    rawFiles,
    pdbFile,
    metadataFile,
    trajectoryFiles,
    pcaFiles,
    analysisFiles,
  };
};

module.exports = categorizeFilesInFolder;
