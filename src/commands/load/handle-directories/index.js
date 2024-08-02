// Files system from node
const fs = require('fs');
// Glob allows to parse wildcards in paths
const glob = require("glob")

// Set the register filename
// This file is created by the workflow
const REGISTER_FILENAME = '.register.json';

// Parse a list of file paths including wildcards to the real paths
const findWildcardPaths = (projectDirectory, paths) => {
    if (paths === undefined) return [];
    let finalPaths = [];
    // Iterate over the input paths
    for (const path of paths) {
        const fullpath = projectDirectory + path;
        const matches = glob.sync(fullpath);
        finalPaths = finalPaths.concat(matches);
    }
    return finalPaths;
}

// Find which directories belong to MD directories
// To do so, find directories which contain a register file
const findMdDirectories = projectDirectory => {
    // Get all available directories
    const subentries = fs.readdirSync(projectDirectory).map(entry => projectDirectory + entry);
    const subdirectories = subentries.filter(entry => fs.statSync(entry).isDirectory());
    const mdDirectories = subdirectories.filter(dir => fs.existsSync(dir + '/' + REGISTER_FILENAME));
    return mdDirectories.map(dir => dir + '/');
}

// Given a list of directories relative to the project directory, parse these directories by adding the whole path
const parseDirectories = (projectDirectory, mdDirectories) => {
    return mdDirectories.map(dir => projectDirectory + dir);
}

module.exports = {
    findWildcardPaths,
    findMdDirectories,
    parseDirectories
}