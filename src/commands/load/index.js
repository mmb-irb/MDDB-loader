// This library allows to extract data from a web page
const fetch = require('node-fetch');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This tool converts miliseconds (ms) to a more human friendly string
// (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../utils/get-spinner');

const plural = require('../../utils/plural');

const printHighlight = require('../../utils/print-highlight');
// Local scripts
const categorizeFilesInFolder = require('./categorize-files-in-folder');
const analyzeProteins = require('./protein-analyses');
const loadTrajectories = require('./load-trajectory');
const loadMetadata = require('./load-metadata');
const loadFile = require('./load-file');
const loadPCA = require('./load-pca');
const loadAnalysis = require('./load-analysis');

const loadFolder = async (
  folder, // Path to the folder with the files to load. It is provided by the user
  bucket,
  files, // Mongo db collection "fs.files"
  projectID, // ID of the current ptoject
  gromacsPath, // It is provided by the user optionally
  dryRun, // It is provided by the user optionally
  spinnerRef, // Reference which allows to use the spinner
) => {
  // Find all files in the "folder" argument path and classify them
  // Classification is performed according to the file names
  const {
    rawFiles,
    trajectoryFiles,
    pcaFiles,
    analysisFiles,
  } = await categorizeFilesInFolder(folder);

  // Save in a new group only files which end in ".pdb"
  // NO SERÍA LO SUYO METER ESTA CLASFICIACION DENTRO DEL categorizeFilesInFolder ???
  const pdbFile = rawFiles.find(file => /^md\..+\.pdb$/i.test(file));

  // Send data to the IPS and HMMER web pages to get it analized and retrieve the results
  let EBIJobs;
  if (pdbFile) {
    EBIJobs = await analyzeProteins(folder, pdbFile, spinnerRef);
  }

  // Process metadata files
  const metadata = (await loadMetadata(folder, spinnerRef)) || {};

  const trajectoryFileDescriptors =
    trajectoryFiles.length &&
    (await loadTrajectories(
      folder,
      trajectoryFiles,
      bucket,
      files,
      projectID,
      gromacsPath,
      dryRun,
      spinnerRef,
    ));

  if (trajectoryFileDescriptors) {
    for (const d of trajectoryFileDescriptors) {
      if (!d.filename.includes('pca') && d.metadata) {
        metadata.frameCount = d.metadata.frames;
        metadata.atomCount = d.metadata.atoms;
        break;
      }
    }
  }

  // Raw files
  const storedFiles = [];
  spinnerRef.current = getSpinner().start(
    `Loading ${plural('file', rawFiles.length, true)}`,
  );

  for (const [index, filename] of rawFiles.entries()) {
    spinnerRef.current.text = `Loading file ${index + 1} out of ${
      rawFiles.length
    } (${filename})`;
    storedFiles.push(
      await loadFile(folder, filename, bucket, projectID, dryRun),
    );
  }
  spinnerRef.current.succeed(
    `Loaded ${plural('file', rawFiles.length, true)} (${prettyMs(
      Date.now() - spinnerRef.current.time,
    )})`,
  );

  // Analyses files
  const analyses = {};
  // PCA
  if (pcaFiles.length)
    analyses.pca = await loadPCA(folder, pcaFiles, spinnerRef);

  // Rest of analyses
  spinnerRef.current = getSpinner().start(
    `Loading ${plural('analysis', analysisFiles.length, true)}`,
  );

  for (const [index, filename] of analysisFiles.entries()) {
    spinnerRef.current.text = `Loading analysis ${index + 1} out of ${
      rawFiles.length
    } (${filename})`;
    const { name, value } = await loadAnalysis(folder, filename, spinnerRef);
    analyses[name] = value;
  }
  spinnerRef.current.succeed(
    `Loaded ${plural('analysis', analysisFiles.length, true)}`,
  );

  let chains;
  if (EBIJobs && EBIJobs.length) {
    // retrieve jobs from InterProScan
    spinnerRef.current = getSpinner().start(
      `Retrieving ${plural(
        'analysis',
        EBIJobs.length,
        true,
      )} for sequences, including from InterProScan and HMMER`,
    );

    let finished = 0;
    chains = await Promise.all(
      EBIJobs.map(([chain, job]) =>
        job.then(document => {
          spinnerRef.current.text = `Retrieved ${plural(
            'analysis',
            ++finished,
            true,
          )} out of ${
            EBIJobs.length
          } for sequences, including from InterProScan and HMMER`;
          return [chain, document];
        }),
      ),
    );
    spinnerRef.current.succeed(
      `Retrieved ${plural(
        'analysis',
        finished,
        true,
      )} for sequences, including from InterProScan and HMMER`,
    );
  }

  const output = {
    metadata,
    files: [...storedFiles, ...(trajectoryFileDescriptors || [])].filter(
      Boolean,
    ),
    analyses,
  };

  if (chains) output.chains = chains;

  return output;
};

// This function extracts data from the PDB section of the MMB web page in json format
const loadPdbInfo = (pdbID, spinnerRef) => {
  // Display the start of this action in the console
  spinnerRef.current = getSpinner().start(
    `Loading PDB Info for ${pdbID} from API`,
  );
  // pdbID is true when a valid folder path is provided
  // If the provided folder path is not valid then return undefined
  return pdbID
    ? // Extract data from the PDB section of the MMB web page
      fetch(`http://mmb.pcb.ub.es/api/pdb/${pdbID}/entry`)
        // Retrieve data in json format
        .then(response => response.json())
        .then(data => {
          // Display the succeed of this action in the console and return data
          spinnerRef.current.succeed(`Loaded PDB Info for ${pdbID} from API`);
          return data;
        })
        .catch(error => {
          // Display the failure of this action in the console
          spinnerRef.current.fail(error);
        })
    : undefined;
};

const load = async (
  // dryRun YA ES FALSE EN EL DEFAULT DEL ROOT, ESTO ODRÍA SER REDUNDANTE
  { folder, dryRun = false, gromacsPath }, // These variables belong to the "argv" object
  { db, bucket, spinnerRef, projectIdRef }, // These variables are extra stuff from the handler
) => {
  // If the dry-run option is set as true, send a console message
  if (dryRun) {
    console.log(
      chalk.yellow("running in 'dry-run' mode, won't affect the database"),
    );
  }

  // Save the current time
  const startTime = Date.now();
  try {
    console.log(chalk.cyan(`== starting load of '${folder}'`));
    // Create a new document in mongo
    const { insertedId } = await db.collection('projects').insertOne({
      accession: null,
      published: false,
    });
    // Save it to the projectIdRef so the command index.js can access the document
    projectIdRef.current = insertedId;

    // Save data from the PDB section in the MMB web page
    const pdbInfo = await loadPdbInfo(
      // Find all valid files in the provided folder and pick the second match value
      (folder.match(/\/(\w{4})[^/]+\/?$/i) || [])[1], // Y ESTE [1] ???
      // Send the spinnerRef to allow this function to call the spinner
      spinnerRef,
    );

    // Save all data returned from loadPdbInfo and loadFolder functions in a unique object
    const project = {
      pdbInfo, // Data already returned from loadPdbInfo function
      // Call loadFolder function
      ...(await loadFolder(
        folder,
        bucket,
        db.collection('fs.files'),
        insertedId,
        gromacsPath,
        dryRun,
        spinnerRef,
      )),
    };

    spinnerRef.current = getSpinner().start('Adding to database');

    // separate analyses for insertion in other collection
    let analyses = project.analyses;
    // keep an array of analysis names
    project.analyses = Object.keys(project.analyses);

    // separate chains for insertion in other collection
    const chains = project.chains || [];
    // keep an array of chain names
    project.chains = chains.map(([chain]) => chain);

    if (!dryRun) {
      // update project into collection (trimmed off of analyses and chains)
      await db
        .collection('projects')
        .findOneAndUpdate({ _id: insertedId }, { $set: project });

      // link each analysis back to their original project and insert
      const analysisEntries = Object.entries(analyses || {});
      if (analysisEntries.length) {
        await db.collection('analyses').insertMany(
          analysisEntries.map(([name, value]) => ({
            name,
            value,
            project: insertedId,
          })),
        );
      }

      // link chain information back to their original project and insert
      if (chains.length) {
        await db.collection('chains').insertMany(
          chains.map(([name, value]) => ({
            name,
            ...value,
            project: insertedId,
          })),
        );
      }
    }

    spinnerRef.current.succeed('Added to database');

    return () => {
      console.log(
        chalk.cyan(
          `== finished loading '${folder}' in ${prettyMs(
            Date.now() - startTime,
          )} with id:`,
        ),
      );
      printHighlight(insertedId);
    };
  } catch (error) {
    console.error(chalk.bgRed(`failed to load '${folder}'`));

    throw error;
  }
};

module.exports = load;
