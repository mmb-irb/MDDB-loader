const fs = require('fs');

const mongodb = require('mongodb');

const loadFolder = (folder, bucket) =>
  new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream('test.txt');
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.write(Buffer.from(folder));
    stream.end(Buffer.from('\n'));
  });

const loadFolders = async ({ folders }) => {
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
    const { server, port, db: _db, ...config } = mongoConfig;
    client = await mongodb.MongoClient.connect(
      `mongodb://${server}:${port}`,
      config,
    );
    const bucket = new mongodb.GridFSBucket(client.db(mongoConfig.db));
    for (const [index, folder] of folders.entries()) {
      try {
        console.log(`processing folder ${index + 1} out of ${folders.length}`);
        console.log(`== starting load of '${folder}'`);
        await loadFolder(folder, bucket);
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
