const publish = require('../publish');

const unpublish = (...args) => publish(...args, false);

module.exports = unpublish;
