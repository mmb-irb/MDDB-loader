// Set project files to be found and loaded
const expectedProjectFiles = {
  // Metadata file, one for project
  metadataFile: {
    pattern: /metadata.json$/i,
    singleFile: true,
  },
  // Topology files, one for project
  topologyFile: {
    pattern: /^topology.(prmtop|top|psf|tpr)$/i,
    singleFile: true,
  },
  // Charges files, any number for project (for .top topologies only)
  itpFiles: {
    pattern: /\.(itp)$/i,
  },
  // The topology data file, one for project
  topologyDataFile: {
    pattern: /^topology.json$/i,
    singleFile: true,
  },
  // The references data file, one for project
  referencesDataFile: {
    pattern: /^references.json$/i,
    singleFile: true,
  },
  // Inputs file, which is not to be loaded but simply readed
  ligandsDataFile: {
    pattern: /^ligands.json$/i,
    singleFile: true,
  },
  // The populations data file, one for project
  populationsDataFile: {
    pattern: /^populations.json$/i,
    singleFile: true,
  },
  // Additional files to load, any number
  uploadableFiles: {
    pattern: /^mdf./i,
  },
  // Inputs file, which is not to be loaded but simply readed
  inputsFile: {
    pattern: /^inputs.(yaml|yml|json)$/i,
    singleFile: true,
  }
};

// Set project files to be found and loaded
const expectedMdFiles = {
  // Metadata file, one for project
  metadataFile: {
    pattern: /metadata.json$/i,
    singleFile: true,
  },
  // Structure file, one for every MD directory
  structureFile: {
    pattern: /^structure.pdb$/i,
    singleFile: true,
  },
  // The main trajectory, one for every MD directory
  mainTrajectory: {
    pattern: /^trajectory.xtc$/i,
    singleFile: true,
  },
  // Analyses, any number for every MD directory
  analysisFiles: {
    pattern: /^mda.[\s\S]*.(json)$/i,
  },
  // Additional files to load, any number
  uploadableFiles: {
    pattern: /^mdf./i,
  },
  // Additional trajectory files to parse-load, any number for every MD directory
  uploadableTrajectories: {
    pattern: /^mdt.[\s\S]*.xtc/i,
  }
}

// This function classifies all files according to their names
const categorizeFiles = (projectFiles, mdFiles) => {
  // Classify project files
  const categorizedProjectFiles = {};
  // Iterate over the different expected project files
  for (const [ fileKey, fileAttributes ] of Object.entries(expectedProjectFiles)) {
    categorizedProjectFiles[fileKey] = fileAttributes.singleFile
      ? projectFiles.find(filename => fileAttributes.pattern.test(filename))
      : projectFiles.filter(filename => fileAttributes.pattern.test(filename));
  }
  // Classify MD files
  const categorizedMdFiles = {};
  // Iterate over the different MDs
  for (const [mdKey, currentMDfiles] of Object.entries(mdFiles)) {
    const categorizedFiles = {};
    // Iterate over the different expected MD files
    for (const [ fileKey, fileAttributes ] of Object.entries(expectedMdFiles)) {
      categorizedFiles[fileKey] = fileAttributes.singleFile
        ? currentMDfiles.find(filename => fileAttributes.pattern.test(filename))
        : currentMDfiles.filter(filename => fileAttributes.pattern.test(filename));
    }
    categorizedMdFiles[mdKey] = categorizedFiles;
  }
  return [categorizedProjectFiles, categorizedMdFiles];
};

module.exports = categorizeFiles;
