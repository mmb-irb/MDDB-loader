const chalk = require('chalk');

// Publish/Unpublish a project
const publish = async ({ id: idOrAccession }, database, publish = true) => {
  // Sync the requested project
  const project = await database.syncProject(id = idOrAccession);
  // If the new published status is the current status then warn the user and stop here
  if (publish === project.data.published) return () => {
    console.log( chalk.yellow(`Project ${project.data.accession} is already ${publish ? 'published' : 'not published'}`) );
  };
  // Change the project published status
  await project.setPublished(publish);
  // Return feedback of what we just did
  const log = publish
    ? `== Published project '${project.data.accession}'`
    : `== Unpublished project '${project.data.accession}'`;
  return () => { console.log( chalk.cyan(log) ) };
};

module.exports = publish;
