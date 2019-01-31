const promisify = require('util').promisify;
const fs = require('fs');
const fetch = require('node-fetch');
const devNull = require('dev-null');

// Promisify All the things
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);

const mongodb = require('mongodb');
const _ = require('lodash');
const mathjs = require('mathjs');

const readFilePerLine = require('../utils/read-file-per-line');

const loadTrajectory = require('./load-trajectory');

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

const processFunctionCreator = (...keys) => async dataAsyncGenerator => {
  const output = {
    step: 0,
    y: new Map(keys.map(y => [y, { average: 0, stddev: 0, data: [] }])),
  };
  for await (const data of dataAsyncGenerator) {
    if (!output.step) output.step = data[0];
    for (const [index, value] of Array.from(output.y.keys()).entries()) {
      output.y.get(value).data.push(data[index + 1]);
    }
  }
  for (const key of output.y.keys()) {
    const y = output.y.get(key);
    y.average = mathjs.mean(y.data);
    y.stddev = mathjs.std(y.data);
  }
  output.y = _.fromPairs(Array.from(output.y.entries()));
  return output;
};

const analyses = [
  {
    name: 'rgyr',
    pattern: /rgyr/,
    process: processFunctionCreator('rgyr', 'rgyrx', 'rgyry', 'rgyrz'),
  },
  {
    name: 'rmsd',
    pattern: /rmsd/,
    process: processFunctionCreator('rmsd'),
  },
  {
    name: 'fluctuation',
    pattern: /rmsf/,
    process: processFunctionCreator('rmsf'),
  },
];

const WHITE_SPACE = /\s+/;
const statFileLinesToDataLines = async function*(lines) {
  for await (const line of lines) {
    let processsedLine = line.trim();
    if (!processsedLine) continue;
    if (processsedLine.startsWith('#')) continue;
    if (processsedLine.startsWith('@')) continue;
    yield processsedLine.split(WHITE_SPACE).map(cell => +cell);
  }
};

const loadAnalysis = async (folder, analysisFile) => {
  const { name, process } =
    analyses.find(({ pattern }) => pattern.test(analysisFile)) || {};
  if (!name) return;
  return [
    name,
    await process(
      statFileLinesToDataLines(readFilePerLine(folder + analysisFile)),
    ),
  ];
};

// const filePatternToLoad = /\.(xtc|dcd|pdb)$/i;
const rawFilePatternToLoad = /\.(dcd|pdb)$/i;
const analysisFilePatternToLoad = /\.xvg$/i;
const trajectoryFilePatternToLoad = /\.trj$/i;

const loadFolder = async (folder, bucket, dryRun) => {
  const allFiles = await readdir(folder);
  const rawFiles = allFiles.filter(filename =>
    rawFilePatternToLoad.test(filename),
  );
  const trajectoryFile = allFiles.find(filename =>
    trajectoryFilePatternToLoad.test(filename),
  );
  const analysisFiles = allFiles.filter(filename =>
    analysisFilePatternToLoad.test(filename),
  );
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
