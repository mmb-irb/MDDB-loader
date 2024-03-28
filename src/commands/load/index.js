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

  // Read project metadata, which is expected to have most of the metadata
  // Note that we read it even if it is not to be loaded since it may contain data useful for the loading process
  let projectMetadata;
  const projectMetadataFile = categorizedProjectFiles.metadataFile;
  if (projectMetadataFile) {
    const projectMetadataFilepath = projectDirectory + '/' + projectMetadataFile;
    projectMetadata = await loadJSON(projectMetadataFilepath);
    if (!projectMetadata) throw new Error('There is something wrong with the project metadata file');
  }

  // Find if there is a prefeined accession to use such as:
  // 1 - A command line forced accession (append option)
  // 2 - A metadata forced accession
  // 3 - A trace from a previous run
  // If no accession is predefined we asume it is a new project and we create it
  // Set the project data handler and update the 'isNew' variable accordingly
  // This part of the code is set as a function just to use return
  let isNew = false;
  const project = await (async () => {
    // If we have an explicit append option in the command line then check it is valid
    if (append) {
      const alreadyExistingProject = await database.syncProject(append);
      // If the project exists then use it
      if (alreadyExistingProject) return alreadyExistingProject;
      // If it does not exist then stop here and warn the user
      throw new Error(`Project ${append} was not found`);
    }
    // If we have a forced accession in the metadata then use it
    const metadataForcedAccession = projectMetadata && projectMetadata.FORCED_ACCESSION;
    if (metadataForcedAccession) {
      // If the project exists then we sync it
      const alreadyExistingProject = await database.syncProject(metadataForcedAccession);
      if (alreadyExistingProject) return alreadyExistingProject;
      // If the project does not exist then create it and set its accession as requested
      isNew = true;
      return await database.createProject(metadataForcedAccession);
    }
    // If we had a trace then check it belongs to an existing project
    const trace = findTrace(projectDirectory);
    if (trace) {
      const alreadyExistingProject = await database.syncProject(trace);
      // If we had a trace and the project exists then use it
      if (alreadyExistingProject) return alreadyExistingProject;
      // If we had a trace but the project does not exist then print a warning but keep going and create a new project
      // Also remove the trace since it is not valid anymore
      console.log(chalk.yellow(`WARNING: There was a trace of project '${trace}' but it does not exist anymore`));
      removeTrace(projectDirectory);
    }
    // If there is no valid predefined accession then create a new project with a default formatted accession
    isNew = true;
    return await database.createProject();
  })();

  // Display the project id. It may be useful if the load is abruptly interrupted to clean
  console.log(chalk.cyan(`== Project '${project.data.accession}'`));

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

  // Load project metadata
  if ( !skipMetadata && projectMetadata ) {
    console.log('Loading project metadata');
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
  for await (const mdir of mdDirectories) {
    // Get the MD directory basename
    const mdirBasename = getBasename(mdir);
    const mdName = mdirBasename.replaceAll('_', ' ');
    // If the project already exists then search for an already existing MD with the same name
    const alreadyExistingMdIndex = isNew === false && project.data.mds.findIndex(md => md.name === mdName);
    const mdExists = typeof alreadyExistingMdIndex === 'number' && alreadyExistingMdIndex !== -1;
    // Set the MD index both if it already exists or if it is a new MD
    const mdIndex = mdExists ? alreadyExistingMdIndex : project.data.mds.length;
    if (mdIndex === -1) throw new Error(`Non-existent MD name: ${mdName}`);
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
    printHighlight(project.data.accession);
  };
};

module.exports = load;