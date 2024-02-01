// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This tool converts miliseconds (ms) to a more human friendly string
// (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// This utility displays in console a dynamic loading status
const logger = require('../../utils/logger');
// Load auxiliar functions
const {
  getGromacsCommand,
  directoryCoerce,
  getBasename
} = require('../../utils/auxiliar-functions');
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
const {
  findWildcardPaths,
  findMdDirectories,
  parseDirectories
} = require('./handle-directories');
const findAllFiles = require('./find-all-files');
const categorizeFiles = require('./categorize-files');
const analyzeProteins = require('./protein-analyses');
const nameAnalysis = require('./name-analysis');
// Get project id trace handlers
const { leaveTrace, findTrace, removeTrace } = require('./project-id-trace');

// Load data from the specified folder into mongo
const load = async (
  // Command additional arguments
  {
    pdir,
    mdirs,
    append,
    include,
    exclude,
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
  // Set the aborting function in case the load is interrupted further
  const checkAbort = getAbortingFunction(database);

  // Save the current time
  const startTime = Date.now();
  console.log(chalk.cyan(`== Load of '${pdir}'`));

  // Set the project directory
  const projectDirectory = directoryCoerce(pdir);
  // Guess MD directories in case they are missing
  const mdDirectories = mdirs ? parseDirectories(projectDirectory, mdirs) : findMdDirectories(projectDirectory);

  // Make sure both include and exclude options are not passed together since they are not compatible
  if (include && include.length > 0 && exclude && exclude.length > 0)
    throw new Error(`Options 'include' and 'exclude' are not compatible. Please use only one of them at a time`);

  // Parse the included files
  const includedFiles = findWildcardPaths(projectDirectory, include);
  if (include.length > 0 && includedFiles.length === 0) throw new Error('No files were found among included');

  // Parse the excluded files
  const excludedFiles = findWildcardPaths(projectDirectory, exclude);

  // Find all available files according to the input paths
  const [projectFiles, mdFiles] = findAllFiles(projectDirectory, mdDirectories, includedFiles, excludedFiles);

  // Find all files in the "projectDirectory" argument path and classify them
  // Classification is performed according to file names
  const [categorizedProjectFiles, categorizedMdFiles] = await categorizeFiles(projectFiles, mdFiles);

  // If there is any available project id or accession then check if the project already exists in the database
  let previousIdOrAccession;
  // If we had an explicit append then check it exists
  if (append) {
    // If it exists then use it
    if (await database.findProject(append)) previousIdOrAccession = append;
    // If it does not exist then stop here and warn the user
    else throw new Error(`Project ${append} was not found`);
  }
  // If we had not and append then search for a trace
  else {
    const trace = findTrace(projectDirectory);
    if (trace) {
      // If we had a trace and the project exists then use it
      if (await database.findProject(trace)) previousIdOrAccession = trace;
      // If we had a trace but the project does not exist then print a warning but keep going and create a new project
      // Also remove the trace since it is not valid anymore
      else {
        console.log(chalk.yellow(`WARNING: There was a trace of project '${trace}' but it does not exist anymore`));
        removeTrace(projectDirectory);
      }
    }
  }

  // If the project already exists in the database then sync it
  // If no ID was passed (i.e. the project is not yet in the database) then create it
  const project = previousIdOrAccession
    ? await database.syncProject(previousIdOrAccession)
    : await database.createProject();
  // Display the project id. It may be useful if the load is abruptly interrupted to clean
  console.log(chalk.cyan(`== Project '${project.id}'`));

  // Leave a trace of the project id
  leaveTrace(projectDirectory, project.id);

  // Send data to the IPS and HMMER web pages to get it analized and retrieve the results
  // One analysis is performed for each protein chain
  // Results are not awaited but the code keeps running since the analysis takes some time
  // The resulting 'EBIJobs' is used later but it is not uploaded to mongo directly
  let EBIJobs;
  // Get any of the structure files
  // Sequence should be same along the different MD directories
  const sampleMd = mdDirectories[0];
  const sampleMdFiles = categorizedMdFiles[sampleMd]
  const sampleStructureFile = sampleMdFiles && sampleMdFiles.structureFile;
  if ( !skipChains && sampleStructureFile && (await project.forestallChainsUpdate(conserve, overwrite)) ) {
    const sampleStructurePath = sampleMd + sampleStructureFile;
    EBIJobs = await analyzeProteins(sampleStructurePath, checkAbort, database);
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---- Metadata ----

  // Load project metadata, which is expected to have most of the metadata
  const projectMetadataFile = categorizedProjectFiles.metadataFile;
  if ( !skipMetadata && projectMetadataFile ) {
    console.log('Loading project metadata');
    const projectMetadataFilepath = projectDirectory + '/' + projectMetadataFile;
    const projectMetadata = await loadJSON(projectMetadataFilepath);
    if (!projectMetadata) throw new Error('There is something wrong with the project metadata file');
    await project.updateProjectMetadata(projectMetadata, conserve, overwrite);
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---- References ----

  // Load references
  const referencesDataFile = categorizedProjectFiles.referencesDataFile;
  if (referencesDataFile) {
    // Read the references data file
    const referencesFilepath = projectDirectory + '/' + referencesDataFile;
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
    const topologyDataFilepath = projectDirectory + '/' + topologyDataFile;
    const topology = await loadJSON(topologyDataFilepath);
    if (!topology) throw new Error('There is something wrong with the topology data file')
    // Add the current project id to the topology object
    topology.project = project.id;
    // Load it to mongo
    await project.loadTopology(topology, conserve, overwrite);
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
      ...categorizedProjectFiles.uploadableFiles
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
      const confirm = await project.forestallFileLoad(databaseFilename, undefined, conserve, overwrite);
      if (!confirm) continue;
      // Set the path to the current file
      const filepath = projectDirectory + '/' + file;
      // Load the actual file
      await project.loadFile(databaseFilename, undefined, filepath, checkAbort);
    }
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---------------------------
  // ----- MD Directories ------
  // ---------------------------

  // Iterate over the different MD directores
  let mdCount = 0;
  for await (const mdir of mdDirectories) {
    // Get the MD directory basename
    const mdirBasename = getBasename(mdir);
    const mdName = mdirBasename.replaceAll('_', ' ');
    const mdIndex = previousIdOrAccession ? project.data.mds.findIndex(md => md.name === mdName) : mdCount;
    if (mdIndex === -1) throw new Error(`Non-existent MD name: ${mdName}`);
    mdCount += 1;
    console.log(chalk.cyan(`== MD directory '${mdirBasename}' named as '${mdName}' (MD index ${mdIndex})`));
    // If the MD does not exist then add it to the project data
    if (!project.data.mds[mdIndex]) await project.addMDirectory(mdName);
    // Get the MD directory files
    const directoryFiles = categorizedMdFiles[mdir];

    // ---- Metadata ----

    // Load the MD metadata if it is not to be skipped
    // Get the metadata filename and if it is missing then skip the load
    const mdMetadataFile = directoryFiles.metadataFile;
    if (!skipMetadata && mdMetadataFile) {
      console.log('Loading MD metadata');
      // Load the metadata file
      const mdMetadata = await loadJSON(mdir + '/' + mdMetadataFile);
      if (!mdMetadata) throw new Error(`There is something wrong with the MD metadata file in ${mdirBasename}`);
      await project.updateMdMetadata(mdMetadata, mdIndex, conserve, overwrite);
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
        const confirm = await project.forestallFileLoad(databaseFilename, mdIndex, conserve, overwrite);
        if (!confirm) continue;
        // Set the path to the current file
        const trajectoryPath = mdir + '/' + file;
        // Load the trajectory parsedly
        await project.loadTrajectoryFile(
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
        const confirm = await project.forestallFileLoad(databaseFilename, mdIndex, conserve, overwrite);
        if (!confirm) continue;
        // Set the path to the current file
        const filepath = mdir + '/' + file;
        // Load the actual file
        await project.loadFile(databaseFilename, mdIndex, filepath, checkAbort);
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
        const confirm = await project.forestallAnalysisLoad(name, mdIndex, conserve, overwrite);
        if (!confirm) continue;
        // Load the analysis
        const filepath = mdir + '/' + file;
        // Read the analysis data
        const content = await loadJSON(filepath);
        // If mining was unsuccessful return undefined value
        if (!content) throw new Error(`There is something wrong with the ${name} analysis file`);
        // Upload new data to the database
        const analysis = { name: name, value: content };
        await project.loadAnalysis(analysis, mdIndex);
      }
    }

  }

  //throw new Error('Hasta aqui :)');

  // Load the chains as soon as they are retrieved from the EBI
  if (EBIJobs && EBIJobs.length) {
    logger.startLog(`Retrieving ${plural('chain', EBIJobs.length, true)}, including from InterProScan and HMMER`);

    // Track the number of finished 'chains'
    let finished = 0;
    await Promise.race([
      Promise.all(
        EBIJobs.map(([chain, job]) =>
          job.then(async document => {
            logger.updateLog(`Retrieved ${plural('chain', ++finished, true)} out of ${EBIJobs.length}, including from InterProScan and HMMER`);
            // Sometimes, when chain sequences are repeated, chain may be e.g. 'A, B, C'
            // In those cases we must load a new chain for each chain letter
            const chains = chain.split(', ');
            for await (const c of chains) {
              // Update the database with the new analysis
              await project.loadChain({ name: c, ...document });
            }
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
    // Finish the logger
    logger.successLog(`Retrieved ${plural('chain', finished, true)}, including from InterProScan and HMMER`);
  }

  return () => {
    console.log(
      chalk.cyan(`== finished loading '${projectDirectory}' in ${prettyMs(Date.now() - startTime)} with id:`),
    );
    printHighlight(project.id);
  };
};

module.exports = load;