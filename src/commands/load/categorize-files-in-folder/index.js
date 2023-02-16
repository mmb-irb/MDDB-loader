// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// Files system from node
const fs = require('fs');
// Function fs.readdir returns all files in a directory
// In this case return them as a promise
const readdir = promisify(fs.readdir);
// RegExp patterns
//const pdbFilePatternToLoad = /^md\..+\.pdb$/i;
const pdbFilePatternToLoad = /^md.imaged.rot.dry.pdb$/i;
const metadataFilePatternToLoad = /^metadata.json$/i;
// Load as raw files all .pdb and .xtc files
// Load also as raw files all files whose name starts with 'fs.'
const rawFilePatternToLoad = /^fs.|\.(pdb|xtc)$/i;
// The main trajectory
const mainTrajectoryFilePatternToLoad = /^md.imaged.rot.xtc$/i;
// PCA projected trajectories
const pcaTrajectoryFilePatternToLoad = /pca.trajectory_\d+.xtc$/i;
// Analyses
const analysisFilePatternToLoad = /^md.[\s\S]*.(xvg|json)$/i;
// Topology files
const topologyFilePatternToLoad = /^topology.(prmtop|top|psf|tpr)$/i;
const itpFilesPatternToLoad = /\.(itp)$/i;
// The topology data file
const topologyDataFilePatternToLoad = /^topology.json$/i;
// The references data file
const referencesDataFilePatternToLoad = /^references.json$/i;
// The populations data file
const populationsDataFilePatternToLoad = /^populations.json$/i;

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
  const mainTrajectory = allFiles.find(filename =>
    mainTrajectoryFilePatternToLoad.test(filename),
  );
  // Trajectory files are those which end in ".xtc". Some other restrictions are taken
  const pcaTrajectories = allFiles.filter(filename =>
    pcaTrajectoryFilePatternToLoad.test(filename),
  );
  // Analysis files are those which end in ".xvg" and do not belong to the PCA files
  const analysisFiles = allFiles.filter(filename =>
    analysisFilePatternToLoad.test(filename),
  );
  // Topology files are those like 'topology.prmtop' or 'topology.top'
  // There should be one or none
  const topologyFiles = allFiles.filter(filename =>
    topologyFilePatternToLoad.test(filename),
  );
  // ITP files are thouse ended in '.tip' and they go together with a 'topology.top' file
  // There may be no itp files as well
  const itpFiles = allFiles.filter(filename =>
    itpFilesPatternToLoad.test(filename),
  );
  // Look for a file which is called exactly 'topology.json'
  const topologyDataFile = allFiles.find(filename =>
    topologyDataFilePatternToLoad.test(filename),
  );
  // Look for a file which is called exactly 'references.json'
  const referencesDataFile = allFiles.find(filename =>
    referencesDataFilePatternToLoad.test(filename),
  );
  // Look for a file which is called exactly 'populations.json'
  const populationsDataFile = allFiles.find(filename =>
    populationsDataFilePatternToLoad.test(filename),
  );

  // Finally, return all classified groups and the group which contain all files
  return {
    allFiles,
    rawFiles,
    pdbFile,
    metadataFile,
    mainTrajectory,
    pcaTrajectories,
    analysisFiles,
    topologyFiles,
    itpFiles,
    topologyDataFile,
    referencesDataFile,
    populationsDataFile,
  };
};

module.exports = categorizeFilesInFolder;
