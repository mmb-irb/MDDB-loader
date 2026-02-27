// This script is used to rename an analysis in the whole database
// This script was used to rename md.imaged.rot.dry.pdb as structure.pdb and md.imaged.rot.xtc as trajectory.xtc

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

// Get the database handler
const getDatabase = require('../src/database');

// Get auxiliar functions
const { userConfirm } =  require('../src/utils/auxiliar-functions');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
if (process.argv.length !== 3) throw new Error('1 argument is expected: target analysis name');

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
    const targetName = process.argv[2];

    // Set the database handler
    const database = await getDatabase();

    // Find all analyses with the old name
    console.log(`Searching all analyses with name '${targetName}'`);
    const targetAnalyses = await database.analyses.find({ name: targetName }, { _id: true }).toArray();
    console.log(`  Target analyses found: ${targetAnalyses.length}`);
    // Get the ids of the affected projects
    console.log(`Searching projects which contain target analyses`);
    const allProjectsIds = new Set(targetAnalyses.map(analysis => analysis.project.toString()));
    console.log(`  Affected projects found: ${allProjectsIds.size}`);

    // Ask the user for confirmation
    const userAnswer = await userConfirm(`Are you sure you want to delete all these analyses? (Y/*)`);
    if (userAnswer !== 'Y') {
        console.log('Aborted by user');
        process.exit(0);
    }

    // Iterate over every project
    for await (const projectId of allProjectsIds) {
        console.log('Project ID: ' + projectId);
        // Get the current project
        const project = await database.syncProject(projectId);
        if (!project) throw new Error(`Can't find project with id '${projectId}'`);
        // Find the target analysis among project analyses
        const targetAnalysis = project.data.analyses && project.data.analyses.find(
            analysis => analysis.name === targetName);
        if (targetAnalysis) await project.deleteAnalysis(targetName, undefined);
        // Iterate over MDs
        for (const [mdIndex, md] of Object.entries(project.data.mds)) {
            console.log('   MD: ' + mdIndex);
            const mdtargetAnalysis = md.analyses.find(analysis => analysis.name === targetName);
            if (mdtargetAnalysis) await project.deleteAnalysis(targetName, +mdIndex);
        }
    }

    // Clean exit
    console.log('Allright :)');
    process.exit(0);
};

main();