const publish = require('../publish');

const unpublish = (...args) => publish(...args, true);

module.exports = unpublish;
