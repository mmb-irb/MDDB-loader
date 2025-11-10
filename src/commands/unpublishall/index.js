const publishall = require('../publishall');

const unpublishall = (...args) => publishall(...args, false);

module.exports = unpublishall;
