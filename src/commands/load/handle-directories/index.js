// Files system from node
const fs = require('fs');
// Glob allows to parse wildcards in paths
const glob = require("glob");
// Load a tool to normalize paths
const { normalize } = require('path');
// Directories left incomplete by the workflow are never loaded
const { INCOMPLETE_DIRECTORY_PREFIX } = require('../../../utils/constants');

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
    return finalPaths.map(path => normalize(path));
}

// Find which directories belong to MD directories
// To do so, find directories which contain a register file
const findMdDirectories = projectDirectory => {
    // Get all available directories
    // Skip directories left incomplete by the workflow (findAllFiles warns about them)
    const subentries = fs.readdirSync(projectDirectory)
        .filter(entry => !entry.startsWith(INCOMPLETE_DIRECTORY_PREFIX))
        .map(entry => projectDirectory + entry);
    const subdirectories = subentries.filter(entry => fs.lstatSync(entry).isDirectory());
    const mdDirectories = subdirectories.filter(dir => fs.existsSync(dir + '/' + REGISTER_FILENAME));
    return mdDirectories.map(dir => normalize(dir));
}

// Given a list of directories relative to the project directory, parse these directories by adding the whole path
const parseDirectories = (projectDirectory, mdDirectories) => {
    return mdDirectories.map(dir => normalize(projectDirectory + dir));
}

module.exports = {
    findWildcardPaths,
    findMdDirectories,
    parseDirectories
}