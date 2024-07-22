// Files system from node
const fs = require('fs');
// Get project files to be found and loaded
const { EXPECTED_PROJECT_FILE } = require('../../../utils/constants');

// Find all files according to the input path, which may be a file or a directory
const findAllFiles = (projectDirectory, mdirs, included, excluded) => {
    // Set a filter based in include and exclude files
    // Remember that both included and excluded cannot be passed together
    const hasIncludes = included && included.length > 0;
    const hasExcludes = excluded && excluded.length > 0;
    // The file directroy is to be passed to generate the filter as well
    // This way the logic can be reused along both project and MD directories
    const filterCreator = directory => {
        // If there is nothing to filter than set a redundant filter
        if (!hasIncludes && !hasExcludes) return () => true;
        // Make sure this filter does not exclude the inputs file
        // Note that this file is not to be loaded anyway
        const inputsFilePattern = EXPECTED_PROJECT_FILE.inputsFile.pattern;
        // Otherwise set the actual filter
        if (hasIncludes) return filename => {
            if (inputsFilePattern.test(filename)) return true;
            const fullpath = directory + filename;
            return included.includes(fullpath);
        }
        if (hasExcludes) return filename => {
            // DANI: Including the inputs file when it is exlcuded is a bit shaddy
            // DANI: I don't think this will ever happen anyway
            if (inputsFilePattern.test(filename)) return true;
            const fullpath = directory + filename;
            return !excluded.includes(fullpath);
        }
    }
    // Find out if the input path is a file or a folder
    const stats = fs.statSync(projectDirectory);
    // If it is a directory then search all files inside of it and its MD directories
    if (!stats.isDirectory()) throw new Error(`${projectDirectory} should be a directory`);
    const projectFileFilter = filterCreator(projectDirectory);
    const projectFiles = fs.readdirSync(projectDirectory).filter(projectFileFilter);
    // Get all MD files and keep them with their corresponding MD directory as keys
    const mdFiles = {};
    for (const mdDirectory of mdirs) {
        const mdFileFilter = filterCreator(mdDirectory);
        mdFiles[mdDirectory] = fs.readdirSync(mdDirectory).filter(mdFileFilter);
    }
    return [projectFiles, mdFiles];
}

module.exports = findAllFiles;