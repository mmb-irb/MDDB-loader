// Files system from node
const fs = require('fs');

// Find all files according to the input path, which may be a file or a directory
const findAllFiles = (fileOrFolder, mdirs) => {
    let projectFiles = [];
    const mdFiles = {};
    // Find out if the input path is a file or a folder
    const stats = fs.statSync(fileOrFolder);
    // If it is a directory then search all files inside of it and its MD directories
    if (stats.isDirectory()) {
        projectFiles = fs.readdirSync(fileOrFolder);
        for (const mdDirectory of mdirs) {
            const mdPath = fileOrFolder + '/' + mdDirectory;
            mdFiles[mdDirectory] = fs.readdirSync(mdPath);
        }
        return [projectFiles, mdFiles];
    }
    // Otherwise we treat the path as a file, which may be relative to the project path or to each MD directory
    // In case it is in the projects directory
    if (fs.existsSync(fileOrFolder)) {
        projectFiles = [fileOrFolder];
        return [projectFiles, mdFiles];
    }
    // In case it is in any number of MD directories
    for (const mdDirectory of mdirs) {
        const filepath = mdDirectory + '/' + fileOrFolder;
        if (fs.existsSync(filepath)) allFiles[mdDirectory] = [filepath];
    }
    // At this point there should be files in the list
    let totalFiles = 0;
    Object.values(mdFiles).forEach(files => {totalFiles += files.length});
    if (totalFiles === 0)
        throw new Error('Path ' + fileOrFolder + ' does not exist in the project neither any MD directory');
    return [projectFiles, mdFiles];
}

module.exports = findAllFiles;