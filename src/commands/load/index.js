const fetch = require('node-fetch');
const chalk = require('chalk');
const prettyMs = require('pretty-ms');

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

const loadFolder = async (
  folder,
  bucket,
  files,
  projectID,
  gromacsPath,
  dryRun,
  spinnerRef,
) => {
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
    EBIJobs = await analyzeProteins(folder, pdbFile, spinnerRef);
  }

  // process files
  const metadata = await loadMetadata(folder, spinnerRef);

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
    files: [...storedFiles, ...trajectoryFileDescriptors].filter(Boolean),
    analyses,
  };

  if (chains) output.chains = chains;

  return output;
};

const loadPdbInfo = (pdbID, spinnerRef) => {
  spinnerRef.current = getSpinner().start(
    `Loading PDB Info for ${pdbID} from API`,
  );

  return pdbID
    ? fetch(`http://mmb.pcb.ub.es/api/pdb/${pdbID}/entry`)
        .then(response => response.json())
        .then(data => {
          spinnerRef.current.succeed(`Loaded PDB Info for ${pdbID} from API`);
          return data;
        })
        .catch(error => {
          spinnerRef.current.fail(error);
        })
    : undefined;
};

const load = async (
  { folder, dryRun = false, gromacsPath },
  { db, bucket, spinnerRef, projectIdRef },
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
    projectIdRef.current = insertedId;

    const pdbInfo = await loadPdbInfo(
      (folder.match(/\/(\w{4})[^/]+\/?$/i) || [])[1],
      spinnerRef,
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
        spinnerRef,
      )),
    };

    spinnerRef.current = getSpinner().start('Adding to database');

    // separate analyses for insertion in other collection
    let analyses = project.analyses;
    // keep an array of analysis names
    project.analyses = Object.keys(project.analyses);

    // separate chains for insertion in other collection
    const chains = project.chains;
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
