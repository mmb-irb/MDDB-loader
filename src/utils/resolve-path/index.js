const process = require('process');

const MULTIPLE_SLASHES = /\/+/g;

const resolvePath = (path, isFolder) => {
  const workingDirectory = process.cwd();
  return `${path.startsWith('/') ? '' : `${workingDirectory}/`}${path}${
    isFolder ? '/' : ''
  }`.replace(MULTIPLE_SLASHES, '/');
};

module.exports = resolvePath;
