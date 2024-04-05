// Visual tool which allows to add colors in console
const chalk = require('chalk');
// Load auxiliar functions
const { mongoidFormat, userConfirm } = require('../../utils/auxiliar-functions');

// Delete anything in the database by its ID
// Note that a function cannot be named 'delete' in node
const deleteFunction = async (
    // Command additional arguments
    { id, confirm },
    // Database handler
    database,
) => {
    console.log(chalk.cyan(`== Deletion of '${id}'`));
    // Set the project affected by this deletion
    let project;
    // Find the document with the requested Id, no matter in which collection it is
    // Find also the collection it belongs to
    let target;
    // Check if the input id is actually an id
    // If not then consider it is an accession
    const isMongoId = mongoidFormat.test(id);
    if (isMongoId) target = await database.findId(id);
    else {
        // Find the project this accession belongs to
        project = await database.syncProject(id);
        if (!project) return console.error(chalk.yellow(`No project found for accession '${id}'`));
        target = { document: project.data, collectionKey: 'projects' };
    }
    // If nothing is found then we are done
    if (!target) return console.error(chalk.yellow(`Nothing found for ID '${id}'`));
    // If this is a project then we must log a summary of the project
    if (target.collectionKey === 'projects') {
        if (!project) project = await database.syncProject(target.document._id);
        await project.logProjectSummary();
    }
    // Warn the user about the document we are about to delete and ask for confirmation
    const documentName = database.nameCollectionDocuments(target.collectionKey);
    // If the confirm argument has not been passed then ask the user for confirmation
    const confirmation = confirm || await userConfirm(`Confirm deletion of ${documentName} with ${isMongoId ? 'id' : 'accession'} ${id} [y/*]`);
    // If we have no confirmation then we abort here
    if (confirmation !== 'y' && confirmation !== 'Y') return console.log('Data deletion has been aborted');
    // Use the right deleting protocol according to the type of document we are about to delete
    // ----- Projects -----
    if (target.collectionKey === 'projects') {
        // Remote project data should be loaded already
        return await project.deleteProject();
    }
    // ----- Analysis -----
    if (target.collectionKey === 'analyses') {
        // Load remote project data in the database handler
        const projectId = target.document.project;
        project = await database.syncProject(projectId);
        if (!project) throw new Error(`Parent project ${projectId} not found. Is the analysis orphan?`);
        // Delete the analysis
        const name = target.document.name;
        const mdIndex = target.document.md;
        return await project.deleteAnalysis(name, mdIndex);
    }
    // ----- Files -----
    if (target.collectionKey === 'files') {
        // Load remote project data in the database handler
        const projectId = target.document.metadata.project;
        project = await database.syncProject(projectId);
        if (!project) throw new Error(`Parent project ${projectId} not found. Is the file orphan?`);
        // Delete the file
        const filename = target.document.filename;
        const mdIndex = target.document.metadata.md;
        return await project.deleteFile(filename, mdIndex);
    }
    throw new Error(`Deletion of ${documentName} is not yet supported`);
};

module.exports = deleteFunction;