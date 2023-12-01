// RegExp patterns
// Metadata files
// Note that there is one for the project + one for every MD directory
const metadataFilePatternToLoad = /metadata.json$/i;
// Structure file, one for every MD directory
const structureFilePatternToLoad = /^structure.pdb$/i;
// The main trajectory, one for every MD directory
const mainTrajectoryFilePatternToLoad = /^trajectory.xtc$/i;
// PCA projected trajectories, any number for every MD directory
const pcaTrajectoryFilePatternToLoad = /pca.trajectory_\d+.xtc$/i;
// Analyses, any number for every MD directory
const analysisFilePatternToLoad = /^mda.[\s\S]*.(json)$/i;
// Topology files, one for project
const topologyFilePatternToLoad = /^topology.(prmtop|top|psf|tpr)$/i;
// Charges files, any number for project (for .top topologies only)
const itpFilesPatternToLoad = /\.(itp)$/i;
// The topology data file, one for project
const topologyDataFilePatternToLoad = /^topology.json$/i;
// The references data file, one for project
const referencesDataFilePatternToLoad = /^references.json$/i;
// The populations data file, one for project
const populationsDataFilePatternToLoad = /^populations.json$/i;
// Additional files to load, any number for every MD directory
const uploadableFilesFilePatternToLoad = /^mdf./i;
// Additional trajectory files to parse-load, any number for every MD directory
const uploadableTrajectoriesFilePatternToLoad = /^mdt.[\s\S]*.xtc/i;

// This function classifies all files according to their names
const categorizeFiles = (projectFiles, mdFiles) => {
  const categorizedProjectFiles = categorizeProjectFiles(projectFiles);
  const categorizedMdFiles = {};
  for (const [key, files] of Object.entries(mdFiles)) {
    categorizedMdFiles[key] = categorizeMDFiles(files);
  }
  return [categorizedProjectFiles, categorizedMdFiles];
}

// This function classifies project files according to their names
const categorizeProjectFiles = projectFiles => {
  if (!projectFiles) return {};
  // Look for the metadata file
  const metadataFile = projectFiles.find(filename =>
    metadataFilePatternToLoad.test(filename),
  );
  // Look for the topology file
  const topologyFile = projectFiles.find(filename =>
    topologyFilePatternToLoad.test(filename),
  );
  // Look for itp files
  const itpFiles = projectFiles.filter(filename =>
    itpFilesPatternToLoad.test(filename),
  );
  // Look for a file which is called exactly 'topology.json'
  const topologyDataFile = projectFiles.find(filename =>
    topologyDataFilePatternToLoad.test(filename),
  );
  // Look for a file which is called exactly 'references.json'
  const referencesDataFile = projectFiles.find(filename =>
    referencesDataFilePatternToLoad.test(filename),
  );
  // Look for a file which is called exactly 'populations.json'
  const populationsDataFile = projectFiles.find(filename =>
    populationsDataFilePatternToLoad.test(filename),
  );

  // Finally, return all classified groups and the group which contain all files
  return {
    metadataFile,
    topologyFile,
    itpFiles,
    topologyDataFile,
    referencesDataFile,
    populationsDataFile,
  };
};

// This function classifies MD files according to their names
const categorizeMDFiles = mdFiles => {
  // Look for the metadata file
  const metadataFile = mdFiles.find(filename =>
    metadataFilePatternToLoad.test(filename),
  );
  // Now classify all files according to their names
  // Look for a file which matches de structureFile regular expression
  const structureFile = mdFiles.find(filename =>
    structureFilePatternToLoad.test(filename),
  );
  // Trajectory files are those which end in ".xtc". Some other restrictions are taken
  const mainTrajectory = mdFiles.find(filename =>
    mainTrajectoryFilePatternToLoad.test(filename),
  );
  // Trajectory files are those which end in ".xtc". Some other restrictions are taken
  const pcaTrajectories = mdFiles.filter(filename =>
    pcaTrajectoryFilePatternToLoad.test(filename),
  );
  // Look for analysis files
  const analysisFiles = mdFiles.filter(filename =>
    analysisFilePatternToLoad.test(filename),
  );
  // Additional files to be uploaded
  const uploadableFiles = mdFiles.filter(filename =>
    uploadableFilesFilePatternToLoad.test(filename),
  );
  // Additional trajectories to be uploaded while parsed to binary coordinates
  const uploadableTrajectories = mdFiles.filter(filename =>
    uploadableTrajectoriesFilePatternToLoad.test(filename),
  );

  // Finally, return all classified groups and the group which contain all files
  return {
    metadataFile,
    structureFile,
    mainTrajectory,
    pcaTrajectories,
    analysisFiles,
    uploadableFiles,
    uploadableTrajectories
  };
};

module.exports = categorizeFiles;
