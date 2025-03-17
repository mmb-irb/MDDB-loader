// Get project files to be found and loaded
const { EXPECTED_PROJECT_FILE, EXPECTED_MD_FILES } = require('../../../utils/constants');
// Set an auxiliar function to get the path last directory or filename
const getFilename = path => path.split('/').pop();

// This function classifies all files according to their names
const categorizeFiles = (projectFiles, mdFiles) => {
  // Classify project files
  const categorizedProjectFiles = {};
  // Iterate over the different expected project files
  for (const [ fileKey, fileAttributes ] of Object.entries(EXPECTED_PROJECT_FILE)) {
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
    for (const [ fileKey, fileAttributes ] of Object.entries(EXPECTED_MD_FILES)) {
      categorizedFiles[fileKey] = fileAttributes.singleFile
        ? currentMDfiles.find(filepath => fileAttributes.pattern.test(getFilename(filepath)))
        : currentMDfiles.filter(filepath => fileAttributes.pattern.test(getFilename(filepath)));
    }
    categorizedMdFiles[mdKey] = categorizedFiles;
  }
  return [categorizedProjectFiles, categorizedMdFiles];
};

module.exports = categorizeFiles;
