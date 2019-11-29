// Allow reading to the current working directory
const process = require('process');
// RegExp formula to find multiple slashes
const MULTIPLE_SLASHES = /\/+/g;

// Convert the input local path into a "fs" library valid global path
// This function is called only from root and "isFolder" is always true in this repository
const resolvePath = (path, isFolder) => {
  // Save current working directory
  const workingDirectory = process.cwd();
  return `${path.startsWith('/') ? '' : `${workingDirectory}/`}${path}${
    isFolder ? '/' : ''
  }`.replace(MULTIPLE_SLASHES, '/'); // Replace multiple slashes by a single slash
};

module.exports = resolvePath;
