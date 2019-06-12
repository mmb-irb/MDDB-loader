const fetch = require('node-fetch');
const chalk = require('chalk');
const prettyMs = require('pretty-ms');
const fromPairs = require('lodash.frompairs');

const getSpinner = require('../../utils/get-spinner');
const plural = require('../../utils/plural');
const printHighlight = require('../../utils/print-highlight');

const categorizeFilesInFolder = require('./categorize-files-in-folder');
const analyzeProteins = require('./protein-analyses');
const loadTrajectories = require('./load-trajectory');
const loadMetadata = require('./load-metadata');
const loadFile = require('./load-file');
const loadPCA = require('./load-pca');
const loadAnalysis = require('./load-analysis');

let spinner;

const loadFolder = async (
  folder,
  bucket,
  files,
  projectID,
  gromacsPath,
  dryRun,
) => {
  let spinner;
  // find files
  const {
    rawFiles,
    trajectoryFiles,
    pcaFiles,
    analysisFiles,
  } = await categorizeFilesInFolder(folder);

  const pdbFile = rawFiles.find(file => /^md\..+\.pdb$/i.test(file));
  let EBIJobs;
  if (pdbFile) {
    // submit to InterProScan
    EBIJobs = await analyzeProteins(folder, pdbFile);
  }

  // process files
  const metadata = await loadMetadata(folder);

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
  spinner = getSpinner().start(
    `Loading ${plural('file', rawFiles.length, true)}`,
  );

  for (const [index, filename] of rawFiles.entries()) {
    spinner.text = `Loading file ${index + 1} out of ${
      rawFiles.length
    } (${filename})`;
    storedFiles.push(
      await loadFile(folder, filename, bucket, projectID, dryRun),
    );
  }
  spinner.succeed(
    `Loaded ${plural('file', rawFiles.length, true)} (${prettyMs(
      Date.now() - spinner.time,
    )})`,
  );

  // Analyses files
  const analyses = {};
  // PCA
  if (pcaFiles.length) analyses.pca = await loadPCA(folder, pcaFiles);

  // Rest of analyses
  spinner = getSpinner().start(
    `Loading ${plural('analysis', analysisFiles.length, true)}`,
  );

  for (const [index, filename] of analysisFiles.entries()) {
    spinner.text = `Loading analysis ${index + 1} out of ${
      rawFiles.length
    } (${filename})`;
    const { name, value } = await loadAnalysis(folder, filename);
    analyses[name] = value;
  }
  spinner.succeed(`Loaded ${plural('analysis', analysisFiles.length, true)}`);

  let chains;
  if (EBIJobs) {
    // retrieve jobs from InterProScan
    spinner = getSpinner().start(
      `Retrieving ${plural(
        'job',
        EBIJobs.size,
        true,
      )} from InterProScan and HMMER`,
    );

    let finished = 0;
    chains = fromPairs(
      await Promise.all(
        Array.from(EBIJobs.entries()).map(([chain, job]) =>
          job.then(document => {
            finished++;
            spinner.text = `Retrieved ${plural('job', finished, true)} out of ${
              EBIJobs.size
            } from InterProScan and HMMER`;
            return [chain, document];
          }),
        ),
      ),
    );
    spinner.succeed(
      `Retrieved ${plural(
        'job',
        finished,
        true,
      )} jobs from InterProScan and HMMER`,
    );
  }

  const output = {
    metadata,
    files: [...storedFiles, ...trajectoryFileDescriptors].filter(Boolean),
    analyses,
  };

  if (chains) output.chains = chains;

  return output;
};

const loadPdbInfo = pdbID => {
  const spinner = getSpinner().start(`Loading PDB Info for ${pdbID} from API`);

  return pdbID
    ? fetch(`http://mmb.pcb.ub.es/api/pdb/${pdbID}/entry`)
        .then(response => response.json())
        .then(data => {
          spinner.succeed(`Loaded PDB Info for ${pdbID} from API`);
          return data;
        })
        .catch(error => {
          spinner.fail(error);
        })
    : undefined;
};

const loadFolders = async (
  { folder, dryRun = false, gromacsPath },
  { db, bucket },
) => {
  if (dryRun) {
    console.log(
      chalk.yellow("running in 'dry-run' mode, won't affect the database"),
    );
  }

  const startTime = Date.now();
  try {
    console.log(chalk.cyan(`== starting load of '${folder}'`));

    const { insertedId } = await db.collection('projects').insertOne({
      accession: null,
      published: false,
    });

    const pdbInfo = await loadPdbInfo(
      (folder.match(/\/(\w{4})[^/]+\/?$/i) || [])[1],
    );

    const project = {
      pdbInfo,
      ...(await loadFolder(
        folder,
        bucket,
        db.collection('fs.files'),
        insertedId,
        gromacsPath,
        dryRun,
      )),
    };

    spinner = getSpinner().start('Adding to database');

    // separate analyses for insertion in other collection
    let analyses = project.analyses;
    // keep an array of analysis names
    project.analyses = Object.keys(project.analyses);

    // separate chains for insertion in other collection
    const chains = project.chains;
    // keep an array of chain names
    project.chains = Object.keys(project.chains);

    if (!dryRun) {
      // insert trimmed project into collection
      // and keep automatically generated UUID for data consistency
      await db
        .collection('projects')
        .findOneAndUpdate({ _id: insertedId }, { $set: project });
      // link each analysis back to their original project and insert
      await db.collection('analyses').insert(
        Object.entries(analyses).map((name, value) => ({
          name,
          value,
          project: insertedId,
        })),
      );
      // link chain information back to its original project and insert
      await db
        .collection('chains')
        .insertOne({ ...chains, project: insertedId });
    }

    spinner.succeed('Added to database');

    console.log(
      chalk.cyan(
        `== finished loading '${folder}' in ${prettyMs(
          Date.now() - startTime,
        )} with id:`,
      ),
    );
    printHighlight(insertedId);
  } catch (error) {
    console.error(chalk.bgRed(`failed to load '${folder}'`));

    throw error;
  }
};

module.exports = loadFolders;
