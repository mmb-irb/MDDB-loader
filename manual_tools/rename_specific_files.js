// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// The main function
// This is an async wrapper to be able to call await
const renameFiles = async (oldFilename, newFilename) => {
  // Warn the user about what is about to happen
  console.log(`Renaming all files with name ${oldFilename} as ${newFilename}`);

  // Set the database handler
  const database = await getDatabase();

  // Find all files with the old filename
  const projects = await database.files.find({filename: oldFilename},{ 'metadata.project': true }).toArray();
  const projectIds = projects.map(doc => doc.metadata.project);
  console.log(`${projectIds.length} projects were found`);

  // Iterate over every project
  for await (const projectId of projectIds) {
    console.log('   Project ID: ' + projectId);
    // Get the current project
    const project = await database.syncProject(projectId);
    // Find the target file among project files
    const targetFile = project.data.files.find(file => file.name === oldFilename);
    if (targetFile) await project.renameFile(oldFilename, undefined, newFilename);
    // Iterate over MDs
    for (const [mdIndex, md] of Object.entries(project.data.mds)) {
      const mdTargetFile = md.files.find(file => file.name === oldFilename);
      if (mdTargetFile) await project.renameFile(oldFilename, mdIndex, newFilename);
    }
  }

  // Clean exit
  console.log('Allright :)');
};

const targetFiles = [
    "helical_parameters/mdf.canal_output_alphaC.bin",
    "helical_parameters/mdf.canal_output_mind.bin",
    "helical_parameters/mdf.canal_output_alphaW.bin",
    "helical_parameters/mdf.canal_output_minw.bin",
    "helical_parameters/mdf.canal_output_ampC.bin",
    "helical_parameters/mdf.canal_output_opening.bin",
    "helical_parameters/mdf.canal_output_ampW.bin",
    "helical_parameters/mdf.canal_output_phaseC.bin",
    "helical_parameters/mdf.canal_output_ax-bend.bin",
    "helical_parameters/mdf.canal_output_phaseW.bin",
    "helical_parameters/mdf.canal_output_betaC.bin",
    "helical_parameters/mdf.canal_output_propel.bin",
    "helical_parameters/mdf.canal_output_betaW.bin",
    "helical_parameters/mdf.canal_output_reg.bin",
    "helical_parameters/mdf.canal_output_buckle.bin",
    "helical_parameters/mdf.canal_output_rise.bin",
    "helical_parameters/mdf.canal_output_chiC.bin",
    "helical_parameters/mdf.canal_output_roll.bin",
    "helical_parameters/mdf.canal_output_chiW.bin",
    "helical_parameters/mdf.canal_output_shear.bin",
    "helical_parameters/mdf.canal_output_curv.bin",
    "helical_parameters/mdf.canal_output_shift.bin",
    "helical_parameters/mdf.canal_output_deltaC.bin",
    "helical_parameters/mdf.canal_output_slide.bin",
    "helical_parameters/mdf.canal_output_deltaW.bin",
    "helical_parameters/mdf.canal_output_stagger.bin",
    "helical_parameters/mdf.canal_output_epsilC.bin",
    "helical_parameters/mdf.canal_output_stretch.bin",
    "helical_parameters/mdf.canal_output_epsilW.bin",
    "helical_parameters/mdf.canal_output_tbend.bin",
    "helical_parameters/mdf.canal_output_gammaC.bin",
    "helical_parameters/mdf.canal_output_tilt.bin",
    "helical_parameters/mdf.canal_output_gammaW.bin",
    "helical_parameters/mdf.canal_output_tip.bin",
    "helical_parameters/mdf.canal_output_h-ris.bin",
    "helical_parameters/mdf.canal_output_twist.bin",
    "helical_parameters/mdf.canal_output_h-twi.bin",
    "helical_parameters/mdf.canal_output_xdisp.bin",
    "helical_parameters/mdf.canal_output_inclin.bin",
    "helical_parameters/mdf.canal_output_ydisp.bin",
    "helical_parameters/mdf.canal_output_majd.bin",
    "helical_parameters/mdf.canal_output_zetaC.bin",
    "helical_parameters/mdf.canal_output_majw.bin",
    "helical_parameters/mdf.canal_output_zetaW.bin"
];

const main = async () => {
    for await (const filename of targetFiles) {
        const newFilename = filename.replace('helical_parameters/mdf.', '');
        await renameFiles(filename, newFilename);
    };
    process.exit(0);
}

main();

