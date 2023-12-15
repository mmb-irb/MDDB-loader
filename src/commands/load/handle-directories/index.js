// Files system from node
const fs = require('fs');

// Set the register filename
// This file is created by the workflow
const registerFilename = '.register.json';

// Find which directories belong to MD directories
// To do so, find directories which contain a register file
const findMdDirectories = fileOrFolder => {
    // Find out if the input path is a file or a folder
    const stats = fs.statSync(fileOrFolder);
    // If the target is a directory then we must check its subdirectories
    if (stats.isDirectory()) {
        // Get all available directories
        const subentries = fs.readdirSync(fileOrFolder).map(entry => fileOrFolder + entry);
        const subdirectories = subentries.filter(entry => fs.statSync(entry).isDirectory());
        const mdDirectories = subdirectories.filter(dir => fs.existsSync(dir + '/' + registerFilename));
        return mdDirectories;
    }
    // If the target is a file then we must find the MD directory it belongs to
    throw new Error('Laoding individual files is not yet supported');
}

// Given a list of directories relative to the project directory, parse these directories by adding the whole path
const parseDirectories = (fileOrFolder, mdDirectories) => {
    // Find out if the input path is a file or a folder
    const stats = fs.statSync(fileOrFolder);
    // If the target is a directory then we must check its subdirectories
    if (stats.isDirectory()) return mdDirectories.map(dir => fileOrFolder + dir);
    // If the target is a file then we must find the MD directory it belongs to
    throw new Error('Laoding individual files is not yet supported');
}

module.exports = {
    findMdDirectories,
    parseDirectories
}