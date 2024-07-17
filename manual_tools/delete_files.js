// This script is used to delete all files with a given name in the database
// This script was used to delete old files, most of them uploaded by accident

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

// Get the database handler
const getDatabase = require('../src/database');

// Load the delete function
const deleteFunction = require('../src/commands/delete');

// Load auxiliar functions
const { userConfirm } = require('../src/utils/auxiliar-functions');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
if (process.argv.length !== 3) throw new Error('1 argument is expected: target name');

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
  const targetName = process.argv[2];
  // Warn the user about what is about to happen
  console.log(`Deleting all files named '${targetName}'`);

  // Set the database handler
  const database = await getDatabase();

  // Get all files with this target name
  const targetFiles = await database.files.find({filename : targetName},{_id : true}).toArray();
  const targetFilesIds = targetFiles.map(file => file._id);
  const targetCount = targetFilesIds.length;
  console.log(`${targetCount} files were found`);

  // If there ar eno files to delete then stop here
  if (targetCount === 0) process.exit(0);

  // If the confirm argument has not been passed then warn and ask the user for confirmation
  const confirmation = await userConfirm(`Confirm deletion of ${targetCount} files named ${targetName} [y/*]`);
  // If we have no confirmation then we abort here
  if (confirmation !== 'y' && confirmation !== 'Y') {
    console.log('Files deletion has been aborted');
    process.exit(0);
  }

  // Iterate over every project
  let count = 1;
  for await (const fileId of targetFilesIds) {
    console.log(`  ->  Deleting file with id ${fileId} (${count}/${targetCount})`);
    // Get the current project
    await deleteFunction({ id: fileId, confirm: 'Y' }, database);
    count += 1;
  }

  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();