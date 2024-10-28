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
  getBasename,
  loadJSON,
  loadYAMLorJSON
} = require('../../utils/auxiliar-functions');
// Return a word's plural when the numeric argument is bigger than 1
const plural = require('../../utils/plural');
// Displays data in console inside a big colorful rectangle
const printHighlight = require('../../utils/print-highlight');
// A function for just wait
const { sleep } = require('timing-functions');
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
// Get project id trace handlers
const { leaveTrace, findTrace, removeTrace } = require('./project-id-trace');

// Set some essential files we need for a new entry to work in the web client
// Keys correspond to the file keys in the file categorizer
// Values correspond to the human-firendly label to be shown in the logs when they are missing
const ESSENTIAL_PROJECT_FILES = {
  metadataFile: 'project metadata file',
  topologyDataFile: 'project topology data file'
};
const ESSENTIAL_MD_FILES = {
  metadataFile: 'MD metadata file',
  structureFile: 'MD structure file',
  mainTrajectory: 'MD trajectory file'
};

// Given a analysis filename, get the name of the analysis from the filename itself
const ANALYSIS_PATTERN = new RegExp('^mda.([A-Za-z0-9_-]*).json$');
const nameAnalysis = filename => {
  // Mine the file name without header and without extension tail
  const match = filename.match(ANALYSIS_PATTERN);
  if (!match) throw new Error(`Filename ${filename} has not the expected analysis filename format`);
  let name = match[1];
  // Legacy fixes
  if (name === 'rmsf') name = 'fluctuation';
  name = name.replace('_', '-');
  // Return the final name
  return name;
};

// Load data from the specified folder into mongo
const load = async (
  // Command additional arguments
  {
    pdir,
    mdirs,
    accession,
    include,
    exclude,
    conserve,
    overwrite,
    skipChains,
    skipTrajectories,
    skipFiles,
    skipAnalyses,
    gromacsPath,
  },
  // Database handler
  database,
) => {
  // Run the database setup
  // This makes only sense the first time but it is run always just in case there is a new collection
  await database.setup();
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

  // Note that include and exclude arguments are 'undefined' when not passed by the user
  // If passed empty, which should not happen, they become an empty array
  // This may happen when using an empty variable as input (e.g. -i $accidentally_empty_variable)
  // This may be dangerous because an empty include becomes all files and an empty exlcude will not exclude
  // For this reason, if this happens we must stop here and warn the user
  if (include && include.length === 0)
    throw new Error(`The 'include' option is empty. This should not happen. Load has been stopped to prevent damage.`);
  if (exclude && exclude.length === 0)
    throw new Error(`The 'exclude' option is empty. This should not happen. Load has been stopped to prevent damage.`);

  // Make sure both include and exclude options are not passed together since they are not compatible
  if (include && exclude)
    throw new Error(`Options 'include' and 'exclude' are not compatible. Please use only one of them at a time`);

  // Parse the included files
  const includedFiles = findWildcardPaths(projectDirectory, include);
  if (include && includedFiles.length === 0) throw new Error('No files were found among included');

  // Parse the excluded files
  const excludedFiles = findWildcardPaths(projectDirectory, exclude);

  // Find all available files according to the input paths
  const [projectFiles, mdFiles] = findAllFiles(projectDirectory, mdDirectories, includedFiles, excludedFiles);

  // Find all files in the "projectDirectory" argument path and classify them
  // Classification is performed according to file names
  const [categorizedProjectFiles, categorizedMdFiles] = await categorizeFiles(projectFiles, mdFiles);

  // Set a function to verify we have the essential files required for the project to run flawlessly in the web
  // Do not run it yet, since we only care about this if it is a new project load
  const hasEssentials = () => {
    const missingFiles = [];
    // Check project files
    for (const [essentialFile, logMessage] of Object.entries(ESSENTIAL_PROJECT_FILES)) {
      if (!categorizedProjectFiles[essentialFile]) missingFiles.push(logMessage);
    }
    // Iterate MDs
    for (const [mdDirectory, availableMdFiles] of Object.entries(categorizedMdFiles)) {
      // Check MD files
      for (const [essentialFile, logMessage] of Object.entries(ESSENTIAL_MD_FILES)) {
        if (!availableMdFiles[essentialFile]) missingFiles.push(`${logMessage} in ${mdDirectory}`);
      }
    }
    // If we are missing at least 1 file then log it and return false
    if (missingFiles.length > 0) {
      console.log('Missing essential files: ' + missingFiles.join(', '));
      return false
    }
    return true;
  };

  // Read the inputs file
  // Inputs file is not to be loaded but it may contain parameters which are to be considered during the load
  const inputsFile = categorizedProjectFiles.inputsFile;
  const inputs = inputsFile && loadYAMLorJSON(projectDirectory + inputsFile);

  // Find if there is a prefeined accession to use such as:
  // 1 - A command line forced accession (-a)
  // 2 - A metadata forced accession
  // 3 - A trace from a previous run
  // If no accession is predefined we asume it is a new project and we create it
  // Set the project data handler and update the 'isNewProject' variable accordingly
  // This part of the code is set as a function just to use return
  let isNewProject = false;
  const project = await (async () => {
    // If we have a forced accession in the coomand line or in the metadata then use it
    const forcedAccession = accession || (inputs && inputs.accession);
    if (forcedAccession) {
      console.log('Forced accession: ' + forcedAccession);
      // Make sure the forced accession has no white spaces
      // This would be a problem further in the web client
      if (forcedAccession.includes(' ')) throw new Error(`Accessions must not include white spaces`);
      // Make sure the forced accession has no white spaces
      // This would be a problem further when separating the accession from the MD number
      if (forcedAccession.includes('.')) throw new Error(`Accessions must not include dots`);
      // If the project exists then we sync it
      const alreadyExistingProject = await database.syncProject(forcedAccession);
      if (alreadyExistingProject) return alreadyExistingProject;
      // Check we have the essentials
      if (!hasEssentials()) throw new Error(`Missing essential files`);
      // If the project does not exist then create it and set its accession as requested
      isNewProject = true;
      return await database.createProject(forcedAccession);
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
    // Check we have the essentials
    if (!hasEssentials()) throw new Error(`Missing essential files`);
    // If there is no valid predefined accession then create a new project with a default formatted accession
    isNewProject = true;
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

  // Load project metadata, which is expected to have most of the metadata
  const projectMetadataFile = categorizedProjectFiles.metadataFile;
  if (projectMetadataFile) {
    console.log('Loading project metadata');
    const projectMetadataFilepath = projectDirectory + projectMetadataFile;
    const projectMetadata = await loadJSON(projectMetadataFilepath);
    if (!projectMetadata) throw new Error('There is something wrong with the project metadata file');
    await project.updateProjectMetadata(projectMetadata, conserve, overwrite);
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---- References ----

  // Set the input files to be read for every different reference type
  const referenceInputDataFiles = {
    proteins: categorizedProjectFiles.referencesDataFile,
    ligands: categorizedProjectFiles.ligandsDataFile,
    pdb_refs: categorizedProjectFiles.pdbRefDataFile
  };

  // Iterate the different type of references (proteins, ligands)
  for await (const referenceName of Object.keys(database.REFERENCES)) {
    // Get the input data filepath
    const referenceInputDataFile = referenceInputDataFiles[referenceName];
    // If there is no input data filepath then go to the next reference
    if (!referenceInputDataFile) continue;
    // Load the reference input data
    const referenceInputDataFilepath = projectDirectory + referenceInputDataFile;
    const referenceInputData = await loadJSON(referenceInputDataFilepath);
    if (!referenceInputData)
      throw new Error(`There is something wrong with the references file ${referenceInputDataFilepath}`);
    // Iterate over the different references among the input data
    for await (const referenceData of referenceInputData) {
      await database.loadReferenceIfProper(referenceName, referenceData, conserve, overwrite);
    }
  }

  // Check if the load has been aborted at this point
  await checkAbort();

  // ---- Topology ----

  // Load the basic topology using the pdb file
  const topologyDataFile = categorizedProjectFiles.topologyDataFile;
  if (topologyDataFile) {
    // Load topology
    const topologyDataFilepath = projectDirectory + topologyDataFile;
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
      const filepath = projectDirectory + file;
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
    console.log(chalk.cyan(`== MD directory '${mdir}'`));
    let mdName;
    let mdIndex;
    let isNewMD = false;
    // Get the MD directory files
    const directoryFiles = categorizedMdFiles[mdir];
    // Get the metadata filename
    const mdMetadataFile = directoryFiles.metadataFile;
    if (mdMetadataFile) {
      // Load the metadata file
      const mdMetadata = await loadJSON(mdir + '/' + mdMetadataFile);
      if (!mdMetadata) throw new Error(`There is something wrong with the MD metadata file in ${mdir}`);
      // Use the metadata name to find out if the MD already exists and which is its index
      mdName = mdMetadata.name;
      mdIndex = project.findMDIndexByName(mdName);
      if (mdIndex === null) {
        isNewMD = true;
        mdIndex = project.data.mds.length;
        await project.addMDirectory(mdMetadata);
      }
      else{
        // Finally load the rest of the metadata
        await project.updateMdMetadata(mdMetadata, mdIndex, conserve, overwrite);
      }
      
    }
    // If no metadata is found
    else {
      mdIndex = project.findMDIndexByDirectory(mdir);
      // If the MD is new and there is no metadata we must stop here
      if (mdIndex === null) {
        console.log(chalk.red(`New MD directory '${mdir}' has no metadata so the load will be skipped`));
        continue;
      }
      // Get the MD name from the already existing metadata
      mdName = project.data.mds[mdIndex].name;
    }
    // Get the MD name form the metadata
    console.log(`== MD directory '${mdir}' named as '${mdName}' (MD index ${mdIndex})`);

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