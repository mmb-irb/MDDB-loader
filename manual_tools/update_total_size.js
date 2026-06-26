// This script updates all projects with the new totalSize field
// Run this once to populate the totalSize field for existing projects

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');
const logger = require('../src/utils/logger');
const Project = require('../src/database/project');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
    // Set the database handler
    const database = await getDatabase();
    
    // Get the number of projects just for the logs
    const projectCount = await database.projects.countDocuments();
    console.log(`\n📊 Updating totalSize for ${projectCount} projects\n`);
    
    // Iterate over all projects and calculate their total size
    const availableProjects = await database.projects.find({});
    let updatedCount = 0;
    let errorCount = 0;
    
    for await (const projectData of availableProjects) {
        try {
            // Create a Project instance to reuse the updateTotalSize method
            const project = new Project(projectData, database);
            
            // Call the Project.updateTotalSize method
            await project.updateTotalSize();
            
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
    console.log(`   Errors:  ${errorCount} projects`);
    console.log(`\n✅ Done!\n`);
    
    // Clean exit
    process.exit(0);
};

main();
