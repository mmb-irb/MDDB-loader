const promisify = require('util').promisify;
const fs = require('fs');
const fetch = require('node-fetch');
const devNull = require('dev-null');

// Promisify All the things
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);

const mongodb = require('mongodb');
const _ = require('lodash');

const NEW_LINES = /\s*\n+\s*/g;
const SEPARATORS = /\s*,\s*/g;
const loadMetadata = async folder =>
  _.fromPairs(
    (await readFile(folder + 'metadata', 'utf8'))
      .split(NEW_LINES)
      .filter(Boolean)
      .map(line => {
        const split = line.split(SEPARATORS);
        const numberMaybe = +split[1];
        return [
          split[0],
          Number.isFinite(numberMaybe) ? numberMaybe : split[1],
        ];
      }),
  );

const loadFile = (folder, filename, bucket, dryRun) =>
  new Promise((resolve, reject) => {
    fs.createReadStream(folder + filename)
      .pipe(dryRun ? devNull() : bucket.openUploadStream(filename))
      .on('error', reject)
      .on('finish', resolve);
  });

// const filePatternToLoad = /\.(xtc|dcd|pdb)$/i;
const filePatternToLoad = /\.(dcd|pdb)$/i;

const loadFolder = async (folder, bucket, dryRun) => {
  const filenames = (await readdir(folder)).filter(filename =>
    filePatternToLoad.test(filename),
  );
  const metadata = await loadMetadata(folder);
  const storedFiles = await Promise.all(
    filenames.map(filename => loadFile(folder, filename, bucket, dryRun)),
  );
  return { metadata, files: storedFiles };
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

const loadFolders = async ({ folders, dryRun = false }) => {
  let mongoConfig;
  try {
    // mongo config file, can be json or js code
    mongoConfig = require('../../configs/mongo');
  } catch (_) {
    console.error("couldn't find mongo config file");
    return;
  }
  let client;
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
    for (const [index, folder] of folders.entries()) {
      try {
        console.log(`processing folder ${index + 1} out of ${folders.length}`);
        console.log(`== starting load of '${folder}'`);
        const projects = db.collection('projects');
        const document = {
          pdbInfo: await loadPdbInfo(
            (folder.match(/\/(\w{4})[^\/]+\/?$/i) || [])[1],
          ),
          ...(await loadFolder(folder, bucket, dryRun)),
          // do this last, in case something fails before doesn't trigger the
          // counter increment (side-effect)
          _id: await getNextId(db.collection('counters'), dryRun),
        };
        if (!dryRun) await projects.insertOne(document);
        console.log(`== finished loading '${folder}'`);
      } catch (error) {
        console.error(error);
        console.error(`failed to load '${folder}'`);
      }
    }
  } catch (error) {
    console.error('mongodb connection error');
    console.error(error);
  } finally {
    if (client && 'close' in client) client.close();
  }
};

module.exports = loadFolders;
