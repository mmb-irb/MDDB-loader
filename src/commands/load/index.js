// Visual tool which allows to add colors in console
const chalk = require('chalk');
// Allows asking user for confirmation
const prompts = require('prompts');
// This tool converts miliseconds (ms) to a more human friendly string
// (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../utils/get-spinner');
// Allows to call a unix command or run another script
// The execution of this code keeps running
const { exec } = require('child_process');
// Return a word's plural when the numeric argument is bigger than 1
const plural = require('../../utils/plural');
// Displays data in console inside a big colorful rectangle
const printHighlight = require('../../utils/print-highlight');
// A function for just wait
const { sleep } = require('timing-functions');
// Allows to call a function in a version that returns promises
const { promisify } = require('util');
// Files system from node
const fs = require('fs');
// readFile allows to get data from a local file
// In this case data is retuned as a promise
const readFile = promisify(fs.readFile);

// Local scripts listed in order of execution
const categorizeFilesInFolder = require('./categorize-files-in-folder');
const analyzeProteins = require('./protein-analyses');
const loadTrajectory = require('./load-trajectory');
const loadFile = require('./load-file');
const { loadAnalysis, nameAnalysis } = require('./load-analysis');
const loadReferences = require('./load-references');

// Util to read and parse json files
const loadJSON = require('../../utils/load-json');

// In case of load abort we need to clean up
const cleanup = require('../cleanup');

// Throw a question for the user trough the console
// Await for the user to confirm
const userConfirm = async question => {
  const response = await prompts({
    type: 'text',
    name: 'confirm',
    message: question,
  });
  if (response.confirm) return response.confirm;
  return null;
};

// Load data from the specified folder into mongo
const load = async (
  {
    folder,
    append,
    conserve,
    overwrite,
    skipChains,
    skipMetadata,
    skipTrajectories,
    skipFiles,
    skipAnalyses,
    dryRun = false,
    gromacsPath,
  }, // These variables belong to the "argv" object
  { db, bucket, spinnerRef, projectIdRef }, // These variables are extra stuff from the handler
) => {
  // Check that Gromacs is installed in the system
  // WARNING: "error" is not used, but it must be declared in order to obtain the output
  exec('command -v gmx', (error, output) => {
    // If there is no output it means Gromacs is not installed in the system
    // In this case warn the user and stop here
    if (!output) {
      console.error(
        chalk.bgRed('Gromacs is not installed or its source is not in $PATH'),
      );
      console.log(
        'In order to install Gromacs type the following command:\n' +
          'sudo apt-get install gromacs',
      );
      process.exit(0);
    }
  });
  // If the dry-run option is set as true, send a console message
  if (dryRun) {
    console.log(
      chalk.yellow("running in 'dry-run' mode, won't affect the database"),
    );
  }
  // Track list of appended data
  var appended = [];
  // Check if load has been aborted
  // If so, exit the load function and ask the user permission to clean the already loaded data
  const checkLoadAborted = async () => {
    // Return here if there is no abort
    if (!process.env.abort) return false;
    const confirm = await userConfirm(
      `Load has been interrupted. Confirm further instructions:
      C - Abort load and conserve already loaded data
      D - Abort load and delete already loaded data
      * - Resume load`,
    );
    if (confirm === 'C') {
      return true;
    } else if (confirm === 'D') {
      // Delete the current uploaded data
      if (append) {
        for await (const doc of appended) {
          await cleanup(
            { id: doc, deleteAllOrphans: false },
            { db, bucket, spinnerRef },
          );
        }
      }
      // If this is not an append, delete the current project
      else
        await cleanup(
          { id: projectIdRef.current, deleteAllOrphans: false },
          { db, bucket, spinnerRef },
        );
      return true;
    } else {
      // Reverse the 'abort' environmental variable and restart the spinner
      process.env.abort = '';
      spinnerRef.current = getSpinner().start();
      return false;
    }
  };

  // This function asks mongo to check if the specified data already exists
  // It is sensible to uploading things with the same name, in which case asks the user
  // Mongo management and asking the user requieres an await promise format
  const updateAnticipation = async (command, updater) => {
    // If the dryRun option is set as true, let it go
    // The loading process will be runned but later in the code nothing is loaded in mongo
    // Thus, there is no need to check if there are duplicates
    if (dryRun) return true;
    // Get the name of the first (and only) key in the updater
    const updaterKey = Object.keys(updater)[0];
    // Set the name to refer this data when asking the user
    let name;
    // Set the a path object to find the updater fields
    let finder = {};
    // If the command is set it means the document must be directly in the project
    if (command === 'set') {
      name = updaterKey;
      finder[updaterKey] = { $exists: true };
    }
    // If the command is push it means the value or document must be part of an array
    else if (command === 'push') {
      // In case of 'analyses' and 'chains'
      if (typeof updater[updaterKey] === 'string') {
        name = updater[updaterKey];
        finder = updater;
      }
      // In case of 'files'
      // Here, the updater format is { files: { filename: name }}
      // In order to access the filename, we access the first key inside the first key
      else {
        name = updater[updaterKey].filename;
        finder = { [updaterKey]: { $elemMatch: updater[updaterKey] } };
      }
    } else console.error('wrong call');
    // Check if the path to the updater already exists in the database
    const exist = await db.collection('projects').findOne(
      // *** WARNING: Do not use '...updater' instead of '...finder'
      // This would make the filter sensible to the whole document
      // (i.e. it would filter by each name and value of each field inside the document)
      // Thus, it would only ask the user when documents are identical, which is useless
      { _id: projectIdRef.current, ...finder },
    );
    // In case it does
    if (exist) {
      // In case it is 'conserve', skip this part
      // This is equal to always choosing the 'C' option
      if (conserve) return false;
      // Find out the collection where the data to delete is placed
      // i.e. 'fs.files', 'analyses' or 'chains'
      let collection = updaterKey;
      if (collection === 'files') collection = 'fs.files';
      // The 'set' command would overwrite the existing data
      // This is applied to chains
      if (command === 'set') {
        // Ask the user
        const confirm = overwrite
          ? '*'
          : await userConfirm(
              `'${name}' already exists in the project. Confirm data loading:
        C - Conserve current data and discard new data
        * - Overwrite current data with new data `,
            );
        // Abort the process
        if (confirm === 'C') {
          console.log(chalk.yellow('New data will be discarded'));
          return false;
        } else {
          console.log(chalk.yellow('Current data will be overwritten'));
          spinnerRef.current = getSpinner().start(
            '   Overwritting current data',
          );
          // The '$set' command in mongo will override the previous value
          await new Promise(resolve => {
            db.collection('projects').findOneAndUpdate(
              { _id: projectIdRef.current },
              { $set: updater },
              err => {
                if (err)
                  spinnerRef.current.fail(
                    '   Error while setting new data:' + err,
                  );
                resolve();
              },
            );
          });
          // Delete documents related to the overwritten field
          await new Promise(resolve => {
            // NEVER FORGET: Although all collections are supported this is only used for chains
            db.collection(collection).deleteMany(
              {
                $or: [
                  // 'analyses' and 'chains'
                  { project: projectIdRef.current },
                  // 'fs.files'
                  {
                    metadata: { project: projectIdRef.current },
                  },
                ],
              },
              // Callback function
              err => {
                if (err)
                  spinnerRef.current.fail(
                    '   Error while deleting current data:' + err,
                  );
                else spinnerRef.current.succeed('   Deleted current data');
                resolve();
              },
            );
          });
          return true;
        }
      }
      // The 'push' command would NOT override the existing data and just add new data
      // This is applied to files and analyses
      else if (command === 'push') {
        // Ask the user
        // In case it is 'overwrite', proceed to delete previous data and load the new one
        const confirm = overwrite
          ? 'D'
          : await userConfirm(
              `'${name}' already exists in the project. Confirm data loading:
        C - Conserve current data and discard new data
        * - Overwrite current data (delete all duplicates) with new data`,
            );
        // Abort the process
        if (confirm === 'C') {
          console.log(chalk.yellow('New data will be discarded'));
          return false;
        }
        // Continue the process but first delete current data
        else {
          console.log(chalk.yellow('Current data will be deleted'));
          spinnerRef.current = getSpinner().start('   Deleting current data');
          // Delete the 'projects' associated data
          await new Promise(resolve => {
            db.collection('projects').findOneAndUpdate(
              { _id: projectIdRef.current },
              { $pull: updater },
              err => {
                if (err)
                  spinnerRef.current.fail(
                    '   Error while deleting current data:' + err,
                  );
                resolve();
              },
            );
          });
          // Delete the current document
          await new Promise(resolve => {
            // NEVER FORGET: Although all collections are supported this is only used for files and analyses
            db.collection(collection).deleteMany(
              {
                $or: [
                  // 'analyses' and 'chains'
                  { project: projectIdRef.current, name: name },
                  // 'fs.files'
                  {
                    'metadata.project': projectIdRef.current,
                    filename: name,
                  },
                ],
              },
              // Callback function
              err => {
                if (err)
                  spinnerRef.current.fail(
                    '   Error while deleting current data:' + err,
                  );
                else spinnerRef.current.succeed('   Deleted current data');
                resolve();
              },
            );
          });
          // Continue the loading process
          return true;
        }
      }
    }
    // If does not exist then there is no problem
    return true;
  };

  // Set a general handler to update the 'projects' collection
  // The 'command' argument stands for the command to be executed by mongo
  // The 'command' argument expects 'set' or 'push' as string
  // The 'updater' argument stands for the changes to be performed in mongo
  // The 'updater' argument expects an object with a single key (e.g. { metadata })
  const updateProject = async (command, updater) => {
    // If the dryRun option is set as true, do nothing
    if (dryRun) return 'abort';
    // Mongo upload must be done in 'await Promise' format. Otherwise, it is prone to fail
    return new Promise((resolve, reject) => {
      db.collection('projects').findOneAndUpdate(
        { _id: projectIdRef.current },
        { ['$' + command]: updater },
        // Callback function
        err => {
          // In case the load fails
          if (err) {
            console.error(err);
            reject();
          }
          // In case the load is successfull
          else resolve();
        },
      );
    });
  };

  // Set a handler to update the 'projects.metadata' field
  const updateMetadata = async newMetadata => {
    // Check if the project has metadata already
    const { metadata } = await db
      .collection('projects')
      .findOne(
        { _id: projectIdRef.current },
        { projection: { _id: 0, metadata: 1 } },
      );
    // In case it does, we modify the received metadata and send it back to mongo
    // WARNING: Note that values in current metadata which are missing in new metadata will remain
    // This is logic since we must be 'appending' new data
    if (metadata) {
      // Check the status of each new metadata key in the current metadata
      for (const [key, newValue] of Object.entries(newMetadata)) {
        const currentValue = metadata[key];
        // Missing keys are added from current metadata
        if (currentValue === undefined) metadata[key] = newValue;
        // Keys with the same value are ignored since there is nothing to change
        else if (currentValue === newValue) continue;
        // Keys with different values are conflictive and we must ask the user for each one
        else {
          // Arrays and objects are not considered 'equal' even when they store identical values
          // We have to check this is not the case
          // NEVER FORGET: Both objects and arrays return 'object' when checked with 'typeof'
          if (
            typeof currentValue === 'object' &&
            typeof newValue === 'object'
          ) {
            if (JSON.stringify(currentValue) === JSON.stringify(newValue))
              continue;
          }
          // When this is a real conflict...
          // If the 'conserve' option is passed
          if (conserve) continue;
          // Else, if the 'overwrite' option is passed
          else if (overwrite) metadata[key] = newValue;
          // Else, ask the user
          else {
            const confirm = await userConfirm(
              `Metadata '${key}' field already exists and its value does not match new metadata.
              Current value: ${JSON.stringify(currentValue, null, 4)}
              New value: ${JSON.stringify(newValue, null, 4)}
              Confirm data loading:
              C - Conserve current value and discard new value
              * - Overwrite current value with the new value`,
            );
            // If 'C' do nothing
            if (confirm === 'C') {
              console.log(chalk.yellow('New value will be discarded'));
              continue;
            }
            // Otherwise, overwrite
            else {
              console.log(chalk.yellow('Current value will be overwritten'));
              metadata[key] = newValue;
            }
          }
        }
      }
      // Finally, load the new metadata object into a mongo
      await updateProject('set', { metadata: metadata });
    }
    // If there is no previous metadata, load the new metadata object into a mongo
    else {
      await updateProject('set', { metadata: newMetadata });
    }
  };

  // Set a general handler to update 'analyses' and 'chains' collections
  // Previously, update the 'projects' collection through the updateProject function
  // The 'collection' argument stands for the mongo collection to be selected
  // The 'collection' argument expects 'analyses' or 'chains' as string
  // The 'updater' argument stands for the data to be uploaded to mongo
  // The 'updater' argument expects an object (e.g. { name, value, projectId })
  // Some key of the updater must be named 'name'
  const updateCollection = async (collection, updater) => {
    const previous = await updateProject('push', {
      [collection]: updater.name,
    });
    // Previous may abort in case of dryRun
    if (previous === 'abort') return;
    // Mongo upload must be done in 'await Promise' format. Otherwise, it is prone to fail
    return new Promise((resolve, reject) => {
      db.collection(collection).insertOne(
        updater,
        // Callback function
        (error, result) => {
          // In case the load fails
          if (error) {
            console.error(error);
            reject();
          }
          // In case the load is successfull
          else {
            if (append) appended.push(result.insertedId);
            resolve();
          }
        },
      );
    });
  };

  // Check if there is a previous document already saved
  // If so, check if we must delete it or conserve it
  const anticipateTopologiesUpdate = async updater => {
    const collection = 'topologies';
    // Check if the path to the updater already exists in the database
    const exist = await db
      .collection(collection)
      .findOne({ project: projectIdRef.current });
    // In case it does not exist
    if (!exist) return true;
    // In case it exists and the 'conserve' flag has been passed we end here
    // This is equal to always choosing the 'C' option, so we return false
    if (conserve) return false;
    // Check if both documents are identical
    // In this case we stop here since it makes not sense uploading the same
    if (JSON.stringify(exist) === JSON.stringify(updater)) return false;
    // const equalAtoms = JSON.stringify(exist.atoms) === JSON.stringify(updater.atoms);
    // const equalResidues = JSON.stringify(exist.residues) === JSON.stringify(updater.residues);
    // const equalChains = JSON.stringify(exist.chains) === JSON.stringify(updater.chains);
    // if (equalAtoms && equalResidues && equalChains) return false;
    // Ask the user in case the 'overwrite' flag has not been passed
    const confirm = overwrite
      ? '*'
      : await userConfirm(
          `This project has a topology already and it is different. Confirm data loading:
          C - Conserve current data and discard new data
          * - Overwrite current data with new data `,
        );
    // If the user has asked to converve current data then abort the process
    if (confirm === 'C') {
      console.log(chalk.yellow('New data will be discarded'));
      return false;
    } else {
      console.log(chalk.yellow('Current data will be overwritten'));
      spinnerRef.current = getSpinner().start('   Overwritting current data');
      // We must delete the current document in mongo
      await new Promise(resolve => {
        db.collection(collection).deleteOne(
          { project: projectIdRef.current },
          {},
          err => {
            if (err)
              spinnerRef.current.fail('   Error while deleting data:' + err);
            else spinnerRef.current.succeed('   Deleted current data');
            resolve();
          },
        );
      });
      return true;
    }
  };

  // Set handler to update the topologies collection, which is not coordinated with 'projects'
  // Check if there is already a loaded value different from the the new value to warn the user
  // The 'updater' argument stands for the object data to be uploaded to mongo
  const updateTopologies = async updater => {
    const collection = 'topologies';
    // Anticipate the load
    const userConsent = await anticipateTopologiesUpdate(updater);
    if (!userConsent) return;
    // Stop here in case of dryRun
    if (dryRun) return;
    // Mongo upload must be done in 'await Promise' format. Otherwise, it is prone to fail
    return new Promise((resolve, reject) => {
      db.collection(collection).insertOne(
        updater,
        // Callback function
        (error, result) => {
          // In case the load fails
          if (error) {
            console.error(error);
            reject();
          }
          // In case the load is successfull
          else {
            if (append) appended.push(result.insertedId);
            resolve();
          }
        },
      );
    });
  };

  // Save the current time
  const startTime = Date.now();
  console.log(chalk.cyan(`== starting load of '${folder}'`));

  try {
    // Find all files in the "folder" argument path and classify them
    // Classification is performed according to the file names
    const {
      rawFiles,
      pdbFile,
      metadataFile,
      mainTrajectory,
      pcaTrajectories,
      analysisFiles,
      topologyFiles,
      itpFiles,
      topologyDataFile,
      referencesDataFile,
      populationsDataFile,
    } = await categorizeFilesInFolder(folder);

    let EBIJobs;
    // If the append option is passed, look for the already existing project
    if (append) {
      // Use regexp to check if 'append' is an accession or an object ID
      const accessionFormat = new RegExp(
        '^' + process.env.ACCESSION_PREFIX + '\\d{5}$',
      );
      // If it is an accession we have to query in a specific format
      // If it is an object id we can directly query with it
      const query = accessionFormat.test(append)
        ? { accession: append }
        : append;
      // Find the already existing project in mongo
      const selectedProject = await db.collection('projects').findOne(query);
      if (!selectedProject)
        return console.error(
          chalk.bgRed(`No project found for ID/Accession '${append}'`),
        );

      projectIdRef.current = selectedProject._id;
      // Display the project id. It may be useful if the load is abruptly interrupted to clean
      console.log(
        chalk.cyan(
          `== new data will be added to project '${projectIdRef.current}'`,
        ),
      );
    }
    // If the append option is NOT passed, create a new project
    else {
      // Create a new document in mongo
      // 'insertedId' is a standarized name inside the returned object. Do not change it.
      const newProject = dryRun
        ? { insertedId: 'This is a fake mongo id' }
        : await db.collection('projects').insertOne({
            accession: null,
            published: false,
          });
      // Save it to the projectIdRef so the command index.js can access the document
      projectIdRef.current = newProject.insertedId;
      // Display the project id. It may be useful if the load is abruptly interrupted to clean
      console.log(
        chalk.cyan(
          `== new project will be stored with the id '${projectIdRef.current}'`,
        ),
      );
    }
    // Check if the load has been aborted at this point
    if (await checkLoadAborted()) return;

    // Send data to the IPS and HMMER web pages to get it analized and retrieve the results
    // One analysis is performed for each protein chain
    // Results are not awaited, but the code keeps running
    // The resulting 'EBIJobs' is used later but it is not uploaded to mongo directly
    // This analysis may be skipped by user if we are appending data to an existing proyect
    if (
      !skipChains &&
      pdbFile &&
      (await updateAnticipation('set', { chains: [] }))
    ) {
      EBIJobs = await analyzeProteins(
        folder,
        pdbFile,
        spinnerRef,
        checkLoadAborted,
        db,
      );
      if (EBIJobs === 'abort') return;
    }

    // Process metadata files
    // The resulting 'metadata' is modified later so it must not be uploaded to mongo yet
    let metadata = {};
    if (!skipMetadata && metadataFile) {
      // Display the start of this action in the console
      spinnerRef.current = getSpinner().start('Loading metadata');

      // Harvest metadata
      metadata = await loadJSON(metadataFile, folder);
      if (metadata) {
        // Display the end of this action as a success in the console
        spinnerRef.current.succeed('Loaded metadata');
        // Check duplicates and load the metadata into mongo
        await updateMetadata(metadata);
      } else {
        spinnerRef.current.fail('Failed to load metadata');
      }
    }

    // Check if the load has been aborted at this point
    if (await checkLoadAborted()) return;

    if (referencesDataFile)
      await loadReferences(referencesDataFile, folder, spinnerRef, db);

    // Check if the load has been aborted at this point
    if (await checkLoadAborted()) return;

    // Load the basic topology using the pdb file
    if (topologyDataFile) {
      // Display the start of this action in the console
      spinnerRef.current = getSpinner().start('Loading topology');
      // Load topology
      const fileContent = await readFile(folder + '/' + topologyDataFile);
      const topology = JSON.parse(fileContent);
      // Add the current project id to the topology object
      topology.project = projectIdRef.current;
      // Display the end of this action as a success in the console
      spinnerRef.current.succeed('Loaded topology');
      // Load it to mongo
      await updateTopologies(topology);
    }

    // Check if the load has been aborted at this point
    if (await checkLoadAborted()) return;

    // Load trajectories into mongo
    if (!skipTrajectories) {
      const dbFilenames = {};
      if (mainTrajectory) {
        dbFilenames[mainTrajectory] = `trajectory.bin`;
      }
      pcaTrajectories.forEach(filename => {
        dbFilenames[filename] = filename.replace('.xtc', '.bin');
      });
      for (const [filename, dbFilename] of Object.entries(dbFilenames)) {
        // Check duplicates
        const confirm = await updateAnticipation('push', {
          files: { filename: dbFilename },
        });
        if (!confirm) continue;
        // Load the trajectory
        const loadedTrajectory = await loadTrajectory(
          folder,
          filename,
          dbFilename,
          bucket,
          db.collection('fs.files'),
          projectIdRef.current,
          gromacsPath,
          dryRun,
          appended,
          spinnerRef,
          checkLoadAborted,
        );
        // If there are no results, we continue to the next iteration
        if (!loadedTrajectory) continue;
        // If process was aborted
        else if (loadedTrajectory === 'abort') return;
        // If there are results, update the project in mongodb
        await updateProject('push', { files: loadedTrajectory });
        // Modify the metadata with data from the main trajectory (no pca)
        if (filename === mainTrajectory && metadata) {
          metadata.frameCount = loadedTrajectory.metadata.frames;
          metadata.atomCount = loadedTrajectory.metadata.atoms;
          await updateProject('set', {
            'metadata.frameCount': metadata.frameCount,
            'metadata.atomCount': metadata.atomCount,
          });
        }
      }
    }

    // Load files into mongo
    const loadableFiles = [
      ...rawFiles,
      ...topologyFiles,
      ...itpFiles,
      populationsDataFile,
    ];
    for (const [index, filename] of loadableFiles.entries()) {
      if (!filename) continue;
      if (skipFiles) break;
      // Check duplicates
      if (
        !(await updateAnticipation('push', { files: { filename: filename } }))
      )
        continue;
      // 'loadFile' is the main function which opens the stream from the file and mongo
      // The spinner is sent for this function to output its status to the console
      const loadedFile = await loadFile(
        folder,
        filename,
        bucket,
        db.collection('fs.files'),
        projectIdRef.current,
        dryRun,
        appended,
        spinnerRef,
        index + 1,
        rawFiles.length,
        checkLoadAborted,
      );
      // If there are no results, we continue to the next iteration
      if (!loadedFile) continue;
      // If process was aborted
      else if (loadedFile === 'abort') return;
      // If there are results, update the project in mongodb
      await updateProject('push', { files: loadedFile });
    }

    // Check if the load has been aborted at this point
    if (await checkLoadAborted()) return;

    // The rest of analyses
    for (const [index, filename] of analysisFiles.entries()) {
      if (skipAnalyses) break;
      // Check if the load has been aborted before each analysis load
      if (await checkLoadAborted()) return;
      // Get the name of the analysis type
      const name = nameAnalysis(filename);
      // Check if name exists and ask for duplicates
      if (!name || !(await updateAnticipation('push', { analyses: name })))
        continue;
      // Load the analysis
      const { value } = await loadAnalysis(
        folder,
        filename,
        spinnerRef,
        index,
        analysisFiles.length,
      );
      // If there are no results, go to the next iteration
      if (!value) continue;
      // Update the database with the new analysis
      await updateCollection('analyses', {
        name,
        value,
        project: projectIdRef.current,
      });
    }

    // Load the chains as soon as they are retrieved from the EBI
    if (EBIJobs && EBIJobs.length) {
      spinnerRef.current = getSpinner().start(
        `Retrieving ${plural(
          'chain',
          EBIJobs.length,
          true,
        )}, including from InterProScan and HMMER`,
      );

      // Track the number of finished 'chains'
      let finished = 0;
      // Done is true when the 'jobs' promise is returned and aborted is used to store a promise
      let done = false;
      let aborted;
      await Promise.race([
        Promise.all(
          EBIJobs.map(([chain, job]) =>
            job.then(async document => {
              spinnerRef.current.text = `Retrieved ${plural(
                'chain',
                ++finished,
                true,
              )} out of ${
                EBIJobs.length
              }, including from InterProScan and HMMER`;
              // Sometimes, when chain sequences are repeated, chain may be e.g. 'A, B, C'
              // In those cases we must load a new chain for each chain letter
              const chains = chain.split(', ');
              chains.forEach(async c => {
                // Update the database with the new analysis
                await updateCollection('chains', {
                  name: c,
                  ...document,
                  project: projectIdRef.current,
                });
              });

              return [chain, document];
            }),
          ),
        ),
        // Alternative promise for the Promise.race: A vigilant abort promise
        // Check if the load has been aborted once per second
        (aborted = new Promise(async resolve => {
          // Stay vigilant until the 'jobs' promise is resolved
          while (!done) {
            await sleep(1000);
            if (await checkLoadAborted()) return resolve('abort');
          }
          resolve();
        })),
      ]);
      // The 'done' / 'aborted' workaround is useful to manage some situations
      // e.g. The user has canceled the load during the last promise but not answered to confirm
      done = true;
      // Check if the load has been aborted
      if ((await aborted) === 'abort') return;
      // Finish the spinner
      spinnerRef.current.succeed(
        `Retrieved ${plural(
          'chain',
          finished,
          true,
        )}, including from InterProScan and HMMER`,
      );
    }

    return () => {
      console.log(
        chalk.cyan(
          `== finished loading '${folder}' in ${prettyMs(
            Date.now() - startTime,
          )} with id:`,
        ),
      );
      printHighlight(projectIdRef.current);
    };
  } catch (error) {
    console.error(chalk.bgRed(`\n failed to load '${folder}'`));

    throw error;
  }
};

module.exports = load;
