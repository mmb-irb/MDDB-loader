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
    // Check if the input id is actually a mongo id
    const isMongoId = mongoidFormat.test(id);
    if (isMongoId) target = await database.findId(id);
    // If not then consider it is an accession
    else {
        // Get the accession and the MD number, if any
        const idSplits = id.split('.');
        if (idSplits.length > 2) throw new Error(`ID ${id} has more dots than an accession would`);
        const accession = idSplits[0];
        const mdNumber = idSplits[1];
        // Find the project this accession belongs to
        project = await database.syncProject(accession);
        if (!project) return console.error(chalk.yellow(`No project found for accession '${accession}'`));
        target = { document: project.data, collectionKey: 'projects', mdIndex: null };
        // If a MD number was passed then include the corresponding MD index in the target object
        if (mdNumber) {
            // Make sure the MD number is actually a number
            const parsedMdNumber = +mdNumber;
            if (Number.isNaN(parsedMdNumber)) throw new Error(`MD Number ${mdNumber} should be a number`);
            // Set the corresponding MD index
            const mdIndex = parsedMdNumber - 1;
            // If the MD is the last available MD then stop here
            // It makes not sense having an empty project with no MDs
            // Ask the user to delete the project instead
            const availableMDs = project.findAvailableMDIndices();
            console.log(availableMDs);
            if (availableMDs.length === 1 && availableMDs.includes(mdIndex))
                throw new Error(`You are about to delete the last available MD in this project. Please delete the whole project instead.`);
            // Add the MD index to the target object
            target.mdIndex = mdIndex;
        }
    }
    // If nothing is found then we are done
    if (!target) return console.error(chalk.yellow(`Nothing found for ID '${id}'`));
    // Get the name of the type of document we are about to delete
    const documentName = database.nameCollectionDocuments(target.collectionKey, 1);
    // Now log some details about the found document
    // If this is a project then we must log a summary of the project
    if (target.collectionKey === 'projects') {
        if (!project) project = await database.syncProject(target.document._id);
        // Log the summary
        if (target.mdIndex === null) await project.logProjectSummary();
        else await project.logMDSummary(target.mdIndex);
    }
    // If it is an analysis then log its name and the project it belongs to
    else if (target.collectionKey === 'analyses') {
        // Load remote project data in the database handler
        const projectId = target.document.project;
        project = await database.syncProject(projectId);
        if (!project) throw new Error(`Parent project ${projectId} not found. Is the analysis orphan?`);
        // Get the MD name
        const mdIndex = target.document.md;
        const mdName = project.data.mds[mdIndex].name;
        // Get the analysis name
        const analysisName = target.document.name;
        // Log the summary
        console.log(`About to delete ${documentName} "${analysisName}" of project ${project.accession}, ${mdName}`);
    }
    // If it is a file log its filename and the project it belongs to
    else if (target.collectionKey === 'files') {
        // Load remote project data in the database handler
        const projectId = target.document.metadata.project;
        project = await database.syncProject(projectId);
        if (!project) throw new Error(`Parent project ${projectId} not found. Is the file orphan?`);
        // Get the MD name
        const mdIndex = target.document.metadata.md;
        const mdName = project.data.mds[mdIndex].name;
        // Get the analysis name
        const filename = target.document.filename;
        // Log the summary
        console.log(`About to delete ${documentName} "${filename}" of project ${project.accession}, ${mdName}`);
    }
    // If the confirm argument has not been passed then warn and ask the user for confirmation
    const confirmation = confirm || await userConfirm(`Confirm deletion of document with ${isMongoId ? 'id' : 'accession'} ${id} [y/*]`);
    // If we have no confirmation then we abort here
    if (confirmation !== 'y' && confirmation !== 'Y') return console.log('Data deletion has been aborted');
    // Use the right deleting protocol according to the type of document we are about to delete
    // ----- Projects -----
    if (target.collectionKey === 'projects') {
        // Remote project data should be loaded already
        // If no MD number was passed then we asume that the whole project is to be deleted
        if (target.mdIndex === null) return await project.deleteProject();
        // If a MD number was passed then we asume that only the specified MD is to be deleted
        return await project.removeMDirectory(target.mdIndex, forced=confirm);
    }
    // ----- Analysis -----
    if (target.collectionKey === 'analyses') {
        const name = target.document.name;
        const mdIndex = target.document.md;
        return await project.deleteAnalysis(name, mdIndex);
    }
    // ----- Files -----
    if (target.collectionKey === 'files') {
        const filename = target.document.filename;
        const mdIndex = target.document.metadata.md;
        return await project.deleteFile(filename, mdIndex);
    }
    throw new Error(`Deletion of ${documentName} is not yet supported`);
};

module.exports = deleteFunction;