const fetch = require('node-fetch');
const mongodb = require('mongodb');
const _ = require('lodash');

const categorizeFilesInFolder = require('./categorize-files-in-folder');
const loadTrajectory = require('./load-trajectory');
const loadMetadata = require('./load-metadata');
const loadFile = require('./load-file');
const loadAnalysis = require('./load-analysis');

const loadFolder = async (folder, bucket, dryRun) => {
  // find files
  const {
    rawFiles,
    trajectoryFile,
    analysisFiles,
  } = await categorizeFilesInFolder(folder);

  // process files
  const trajectory =
    trajectoryFile &&
    (await loadTrajectory(folder, trajectoryFile, bucket, dryRun));
  const metadata = await loadMetadata(folder);
  const storedFiles = await Promise.all(
    rawFiles.map(filename => loadFile(folder, filename, bucket, dryRun)),
  );
  const analyses = _.fromPairs(
    (await Promise.all(
      analysisFiles.map(filename => loadAnalysis(folder, filename)),
    )).filter(Boolean),
  );
  return {
    metadata,
    files: [...storedFiles, trajectory].filter(Boolean),
    analyses,
  };
};

const loadPdbInfo = pdbID =>
  pdbID
    ? fetch(`http://mmb.pcb.ub.es/api/pdb/${pdbID}/entry`).then(response =>
        response.json(),
      )
    : undefined;

const getNextId = async (counters, dryRun) => {
  const result = await counters.findOneAndUpdate(
    { name: 'identifier' },
    { $inc: { count: dryRun ? 0 : 1 } },
    {
      projection: { _id: false, count: true },
      // return the new document with the new counter for the custom identifier
      returnOriginal: false,
    },
  );
  return `MCNS${`${result.value.count}`.padStart(5, '0')}`;
};

const loadFolders = async ({ folders, dryRun = false, output }) => {
  let mongoConfig;
  try {
    // mongo config file, can be json or js code
    mongoConfig = require('../../configs/mongo');
  } catch (_) {
    console.error("couldn't find mongo config file");
    return;
  }
  let client;
  let writer;
  try {
    const { server, port, db: dbName, ...config } = mongoConfig;
    client = await mongodb.MongoClient.connect(
      `mongodb://${server}:${port}`,
      config,
    );
    const db = client.db(dbName);
    const bucket = new mongodb.GridFSBucket(db);
    if (dryRun) {
      console.log('running in "dry-run" mode, won\'t affect the database');
    }
    writer = output && (await require('./output-writer')(output));
    for (const [index, folder] of folders.entries()) {
      try {
        console.log(`processing folder ${index + 1} out of ${folders.length}`);
        console.log(`== starting load of '${folder}'`);
        const projects = db.collection('projects');
        const document = {
          pdbInfo: await loadPdbInfo(
            (folder.match(/\/(\w{4})[^/]+\/?$/i) || [])[1],
          ),
          ...(await loadFolder(folder, bucket, dryRun)),
          // do this last, in case something fails before doesn't trigger the
          // counter increment (side-effect)
          _id: await getNextId(db.collection('counters'), dryRun),
        };
        const tasks = [
          writer && writer.writeToOutput(document),
          !dryRun && projects.insertOne(document),
        ].filter(Boolean);
        await Promise.all(tasks);
        console.log(`== finished loading '${folder}'`);
      } catch (error) {
        console.error(error);
        console.error(`failed to load '${folder}'`);
      }
    }
  } catch (error) {
    console.error(error);
  } finally {
    if (client && 'close' in client) client.close();
    if (writer) await writer.closeOutput();
  }
};

module.exports = loadFolders;
