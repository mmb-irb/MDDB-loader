// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This tool converts miliseconds (ms) to a more human friendly string
// (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../utils/get-spinner');
// Load auxiliar functions
const { getGromacsCommand, getBasename } = require('../../utils/auxiliar-functions');
// Return a word's plural when the numeric argument is bigger than 1
const plural = require('../../utils/plural');
// Displays data in console inside a big colorful rectangle
const printHighlight = require('../../utils/print-highlight');
// A function for just wait
const { sleep } = require('timing-functions');
// Read and parse a JSON file
const loadJSON = require('../../utils/load-json');

// Local scripts listed in order of execution
const getAbortingFunction = require('./abort');
const { findMdDirectories, parseDirectories } = require('./handle-directories');
const findAllFiles = require('./find-all-files');
const categorizeFiles = require('./categorize-files');
const analyzeProteins = require('./protein-analyses');
const nameAnalysis = require('./name-analysis');

// Load data from the specified folder into mongo
const load = async (
  // Command additional arguments
  {
    fileOrFolder,
    mdDirectories,
    append,
    conserve,
    overwrite,
    skipChains,
    skipMetadata,
    skipTrajectories,
    skipFiles,
    skipAnalyses,
    gromacsPath,
  },
  // Database handler
  database,
) => {
  // Get the correct gromacs command while checking it is installed in the system
  // If trajectories are to be skipped then skip this part as well since Gromacs is used for loading trajectories only
  const gromacsCommand = skipTrajectories ? null : getGromacsCommand(gromacsPath);
  // Extract some fields from the database handler
  const spinnerRef = database.spinnerRef;
  // Set the aborting function in case the load is interrupted further
  const checkAbort = getAbortingFunction(database);

  // Save the current time
  const startTime = Date.now();
  console.log(chalk.cyan(`== Load of '${fileOrFolder}'`));

  // Set the project directory
  // DANI: Ahora esto es facil porque no damos soporte a archvios o subdirectorios sueltos
  const pdir = fileOrFolder;
  // Guess MD directories in case they are missing
  const mdirs = mdDirectories ? parseDirectories(fileOrFolder, mdDirectories) : findMdDirectories(fileOrFolder);

  // Find all available files according to the input paths
  const [projectFiles, mdFiles] = findAllFiles(fileOrFolder, mdirs);

  // Find all files in the "fileOrFolder" argument path and classify them
  // Classification is performed according to file names
  const [categorizedProjectFiles, categorizedMdFiles] = await categorizeFiles(projectFiles, mdFiles);

  // If the append option is passed then look for the already existing project
  // Else create a new project
  // Note that from this is the first change in the database
  // Thus if you reach this part and then the process fails the database will require some cleanup
  await database.setupProject(id = append, mdDirectories = mdirs);
  
  // Send data to the IPS and HMMER web pages to get it analized and retrieve the results
  // One analysis is performed for each protein chain
  // Results are not awaited but the code keeps running since the analysis takes some time
  // The resulting 'EBIJobs' is used later but it is not uploaded to mongo directly
  let EBIJobs;
  // Get any of the structure files
  // Sequence should be same along the different MD directories
  const sampleMd = mdirs[0];
  const sampleMdFiles = categorizedMdFiles[sampleMd]
  const sampleStructureFile = sampleMd + '/' + sampleMdFiles.structureFile;
  if ( !skipChains && sampleStructureFile && (await database.forestallChainsUpdate(conserve, overwrite)) )
    EBIJobs = await analyzeProteins(sampleStructureFile, spinnerRef, checkAbort, database);

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---- Metadata ----

  if (!skipMetadata) {
    // Load project metadata, which is expected to have most of the metadata
    const projectMetadataFile = categorizedProjectFiles.metadataFile;
    if (projectMetadataFile) {
      const projectMetadataFilepath = pdir + '/' + projectMetadataFile;
      const projectMetadata = await loadJSON(projectMetadataFilepath);
      if (!projectMetadata) throw new Error('There is something wrong with the project metadata file');
      await database.updateProjectMetadata(projectMetadata, conserve, overwrite);
    }
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---- References ----

  // Load references
  const referencesDataFile = categorizedProjectFiles.referencesDataFile;
  if (referencesDataFile) {
    // Read the references data file
    const referencesFilepath = pdir + '/' + referencesDataFile;
    const references = await loadJSON(referencesFilepath);
    if (!references) throw new Error('There is something wrong with the references file');
    // Iterate over the different references
    for await (const reference of references) {
      await database.loadReference(reference);
    }
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---- Topology ----

  // Load the basic topology using the pdb file
  const topologyDataFile = categorizedProjectFiles.topologyDataFile;
  if (topologyDataFile) {
    // Load topology
    const topologyDataFilepath = pdir + '/' + topologyDataFile;
    const topology = await loadJSON(topologyDataFilepath);
    if (!topology) throw new Error('There is something wrong with the topology data file')
    // Add the current project id to the topology object
    topology.project = database.project_id;
    // Load it to mongo
    await database.loadTopology(topology, conserve, overwrite);
  }

  // Note that there are no trajectories or analyses expected to be in the project nowadays
  // This may change in the future however

  // ---- Files ----

  if (!skipFiles) {
    // Set which files are to be uploaded to the database
    // Discard undefined values from missing files
    const loadableFiles = [
      categorizedProjectFiles.topologyFile,
      ...categorizedProjectFiles.itpFiles,
      categorizedProjectFiles.populationsDataFile,
    ].filter(file => file && file.length !== 0);
    // Iterate over loadable files
    let nfile = 0;
    for await (const file of loadableFiles) {
      nfile += 1;
      // Check if the load has been aborted at this point
      await checkAbort();
      // Set the name of the file once loaded in the database
      // In case the filename starts with 'mdf.' set the database filename without the prefix
      let databaseFilename = file;
      if (databaseFilename.slice(0, 4) === 'mdf.')
        databaseFilename = databaseFilename.slice(4);
      // Handle any conflicts and ask the user if necessary
      // Delete previous files in case we want to overwrite data
      const confirm = await database.forestallFileLoad(databaseFilename, undefined, conserve, overwrite);
      if (!confirm) continue;
      // Set the path to the current file
      const filepath = pdir + '/' + file;
      // Load the actual file
      await database.loadFile(databaseFilename, undefined, filepath, checkAbort);
    }
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---------------------------
  // ----- MD Directories ------
  // ---------------------------

  // Iterate over the different MD directores
  for await (const mdir of mdirs) {
    // Get the MD directory basename
    const mdirBasename = getBasename(mdir);
    const mdIndex = database.md_directory_indices[mdirBasename];
    console.log(chalk.cyan(`== MD directory '${mdirBasename}' (MD index ${mdIndex})`));
    // Get the directory files
    const directoryFiles = categorizedMdFiles[mdir];

    // ---- Metadata ----

    // Load the MD metadata if it is not to be skipped
    // Get the metadata filename and if it is missing then skip the load
    const mdMetadataFile = directoryFiles.metadataFile;
    if (!skipMetadata && mdMetadataFile) {
      // Load the metadata file
      const mdMetadata = await loadJSON(mdir + '/' + mdMetadataFile);
      if (!mdMetadata) throw new Error('There is something wrong with the MD metadata file in ' + mdirBasename);
      await database.updateMdMetadata(mdMetadata, mdIndex, conserve, overwrite);
    }

    // Check if the load has been aborted at this point
    await checkAbort();

    // ---- Trajectories ----

    // Load trajectories into the database
    if (!skipTrajectories) {
      // Get trajectory files which are to be loaded to the database in a parsed way
      const trajectoryFiles = [
        directoryFiles.mainTrajectory,
        ...directoryFiles.uploadableTrajectories
      ].filter(file => file && file.length !== 0);
      // Iterate over the different trajectory files
      let ntrajectory = 0;
      for (const file of trajectoryFiles) {
        ntrajectory += 1;
        // Check if the load has been aborted at this point
        await checkAbort();
        // Set the name of the file once loaded in the database
        let databaseFilename = file.replace('.xtc', '.bin');
        // In case the filename starts with 'mdt.' set the database filename without the prefix
        if (databaseFilename.slice(0, 4) === 'mdt.')
          databaseFilename = databaseFilename.slice(4);
        // Handle any conflicts and ask the user if necessary
        // Delete previous files in case we want to overwrite data
        const confirm = await database.forestallFileLoad(databaseFilename, mdIndex, conserve, overwrite);
        if (!confirm) continue;
        // Set the path to the current file
        const trajectoryPath = mdir + '/' + file;
        // Load the trajectory parsedly
        await database.loadTrajectoryFile(
          databaseFilename,
          mdIndex,
          trajectoryPath,
          gromacsCommand,
          checkAbort
        );
      }
    }

    // ---- Files ----

    if (!skipFiles) {
      // Set which files are to be uploaded to the database
      const loadableFiles = [
        directoryFiles.structureFile,
        directoryFiles.mainTrajectory,
        ...directoryFiles.uploadableFiles,
      ].filter(file => file && file.length !== 0);
      // Iterate over loadable files
      let nfile = 0;
      for await (const file of loadableFiles) {
        nfile += 1;
        // Check if the load has been aborted at this point
        await checkAbort();
        // Set the name of the file once loaded in the database
        // In case the filename starts with 'mdf.' set the database filename without the prefix
        let databaseFilename = file;
        if (databaseFilename.slice(0, 4) === 'mdf.')
          databaseFilename = databaseFilename.slice(4);
        // Handle any conflicts and ask the user if necessary
        // Delete previous files in case we want to overwrite data
        const confirm = await database.forestallFileLoad(databaseFilename, mdIndex, conserve, overwrite);
        if (!confirm) continue;
        // Set the path to the current file
        const filepath = mdir + '/' + file;
        // Load the actual file
        await database.loadFile(databaseFilename, mdIndex, filepath, checkAbort);
      }
    }

    // Check if the load has been aborted at this point
    await checkAbort();

    // ---- Analyses ----

    if (!skipAnalyses) {
      // Iterate over the different analysis files
      let nanalysis = 0;
      for await (const file of directoryFiles.analysisFiles) {
        nanalysis += 1;
        // Check if the load has been aborted before each analysis load
        await checkAbort();
        // Get the standard name of the analysis
        const name = nameAnalysis(file);
        if (!name) continue;
        // Handle any conflicts and ask the user if necessary
        // Delete previous analyses in case we want to overwrite data
        const confirm = await database.forestallAnalysisLoad(name, mdIndex, conserve, overwrite);
        if (!confirm) continue;
        // Load the analysis
        const filepath = mdir + '/' + file;
        // Read the analysis data
        const content = await loadJSON(filepath);
        // If mining was unsuccessful return undefined value
        if (!content) throw new Error(`There is something wrong with the ${name} analysis file`);
        // Upload new data to the database
        const analysis = { name: name, value: content };
        await database.loadAnalysis(analysis, mdIndex);
      }
    }

  }

  //throw new Error('Hasta aqui :)');

  // Load the chains as soon as they are retrieved from the EBI
  if (EBIJobs && EBIJobs.length) {
    spinnerRef.current = getSpinner().start(
      `Retrieving ${plural('chain', EBIJobs.length, true)}, including from InterProScan and HMMER`,
    );

    // Track the number of finished 'chains'
    let finished = 0;
    await Promise.race([
      Promise.all(
        EBIJobs.map(([chain, job]) =>
          job.then(async document => {
            spinnerRef.current.text = `Retrieved ${plural('chain', ++finished, true)} out of ${EBIJobs.length}, including from InterProScan and HMMER`;
            // Sometimes, when chain sequences are repeated, chain may be e.g. 'A, B, C'
            // In those cases we must load a new chain for each chain letter
            const chains = chain.split(', ');
            chains.forEach(async c => {
              // Update the database with the new analysis
              await database.loadChain({ name: c, ...document, project: database.project_id });
            });

            return [chain, document];
          }),
        ),
      ),
      // Alternative promise for the Promise.race: A vigilant abort promise
      // Check if the load has been aborted once per second
      new Promise(async () => {
        // Stay vigilant until the 'jobs' promise is resolved
        while (true) {
          await sleep(1000);
          await checkAbort();
        }
      }),
    ]);
    // Finish the spinner
    spinnerRef.current.succeed(`Retrieved ${plural('chain', finished, true)}, including from InterProScan and HMMER`);
  }

  return () => {
    console.log(
      chalk.cyan(`== finished loading '${fileOrFolder}' in ${prettyMs(Date.now() - startTime)} with id:`),
    );
    printHighlight(database.project_id);
  };
};

module.exports = load;