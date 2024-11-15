// Visual tool which allows to add colors in console
const chalk = require('chalk');

// Delete orphan data from the database
const cleanup = async (
    // Command additional arguments
    { confirm },
    // Database handler
    database,
) => {
    console.log(chalk.cyan(`== Orphan data cleanup`));
    console.log(`⚠️  Make sure you are not loading data to the database when running a cleanup`);
    // Delete orphan references
    await database.deleteOrphanData('references', confirm);
    // Delete orphan topologies
    await database.deleteOrphanData('topologies', confirm);
    // Delete orphan analyses
    await database.deleteOrphanData('analyses', confirm);
    // Delete orphan files
    await database.deleteOrphanData('files', confirm);
    // Delete orphan chunks
    await database.deleteOrphanData('chunks', confirm);
};

module.exports = cleanup;