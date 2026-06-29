// This script updates all projects with the new totalSize, totalFrames and totalTime fields
// Also add the creationDate and mdcount fields if they don't exist yet
// Run this once to populate these fields for existing projects



const getDatabase = require('../../database');
const logger = require('../../utils/logger');
const Project = require('../../database/project');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// The main function
// This is an async wrapper to be able to call await
const addTotals = async (database, verbose) => {
    // Get the number of projects just for the logs
    const projectCount = await database.projects.countDocuments();
    console.log(`\n📊 Updating totalSize, totalTime, and creationDate for ${projectCount} projects\n`);

    // Iterate over all projects and calculate their total size and time
    const availableProjects = await database.projects.find({});
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for await (const projectData of availableProjects) {
        try {
            // Create a Project instance to reuse the updateTotalSize and updateTotalTime methods
            const project = new Project(projectData, database);

            // Check if project already has all fields
            const hasTotalSize = project.data.totalSize !== undefined && project.data.totalSize !== 0;
            const hasTotalTime = project.data.totalTime !== undefined && project.data.totalTime !== 0;
            const hasCreationDate = project.data.creationDate !== undefined;
            const hasMdCount = project.data.mdcount !== undefined && project.data.mdcount !== 0;

            if (hasTotalSize && hasTotalTime && hasCreationDate && hasMdCount) {
                skippedCount++;
                continue;
            }

            // Add creationDate if not already set
            if (!hasCreationDate) {
                project.data.creationDate = projectData._id.getTimestamp();
                if (verbose) console.log(`📅 Added creationDate for ${project.accession || 'no accession'} (${project.id})`);
            }

            // Add mdcount if not already set
            if (!hasMdCount) {
                project.data.mdcount = project.countAvailableMDs();
                if (verbose) console.log(`🔢 Added mdcount for ${project.accession || 'no accession'} (${project.id})`);
            }

            if (!hasCreationDate || !hasMdCount)
                await project.updateRemote();

            // Calculate total size if not already set
            if (!hasTotalSize) {
                await project.updateTotalSize();
                if (verbose) console.log(`💾 Updated totalSize for ${project.accession || 'no accession'} (${project.id})`);
            }
            // Calculate total time if not already set
            if (!hasTotalTime) {
                const result = await project.updateTotalTime();
                if (result) {
                    skippedCount++;
                    continue;
                }
                if (verbose) console.log(`⏱️ Updated totalTime for ${project.accession || 'no accession'} (${project.id})`);
            }
            updatedCount++;
            console.log(`✅ Updated ${project.accession || 'no accession'} (${project.id})`);
        } catch (error) {
            errorCount++;
            console.log(`❌ Error processing ${projectData.accession || 'no accession'} (${projectData._id}): ${error.message}`);
        }
    }
    
    // Summary
    console.log(`\n📈 Summary:`);
    console.log(`   Updated: ${updatedCount} projects`);
    console.log(`   Skipped: ${skippedCount} projects`);
    console.log(`   Errors:  ${errorCount} projects`);
    console.log(`\n✅ Done!\n`);
};

module.exports = { addTotals };