const publishCommand = require('../publish');

// Publish/Unpublish a project
const publishall = async ({ query }, database, publish = true) => {
  // Parse the query
  const parsedQuery = JSON.parse(query);
  // Iterate over matched projects
  const availableProjectIds = await database.iterateProjectIds(parsedQuery);
  for await (const projectId of availableProjectIds) {
    console.log('   Project ID: ' + projectId);
    const logger = await publishCommand({ id: projectId }, database, publish);
    logger();
  }
};

module.exports = publishall;
