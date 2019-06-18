const prompt = require('prompt');
const chalk = require('chalk');

const getSpinner = require('../../utils/get-spinner');
const plural = require('../../utils/plural');

const findFilesToDelete = async (id, db) => {
  const c = db.collection('fs.files');
  let cursor;
  if (id) {
    cursor = await c.find({ 'metadata.project': id });
  } else {
    // do some kind of "join" where no corresponding document is found
    cursor = await c.aggregate([
      {
        $lookup: {
          from: 'projects',
          as: 'foreign',
          localField: 'metadata.project',
          foreignField: '_id',
        },
      },
      { $match: { foreign: { $size: 0 } } },
    ]);
  }
  return (await cursor.toArray()).map(({ _id }) => _id);
};

const findChunksToDelete = async db => {
  const cursor = db.collection('fs.chunks').aggregate([
    {
      $lookup: {
        from: 'fs.files',
        as: 'foreign',
        localField: 'files_id',
        foreignField: '_id',
      },
    },
    { $match: { foreign: { $size: 0 } } },
    { $count: 'orphans' },
  ]);
  console.log(await cursor.toArray());
  // console.log(await cursor.count());
  // await cursor.forEach();
  return [];
  // return (await cursor.toArray()).map(({ _id }) => _id);
};

const findRelatedDocumentsToDelete = async (id, db, collection) => {
  const c = db.collection(collection);
  let cursor;
  if (id) {
    cursor = await c.find({ project: id });
  } else {
    cursor = await c.aggregate([
      {
        $lookup: {
          from: 'projects',
          as: 'foreign',
          localField: 'project',
          foreignField: '_id',
        },
      },
      { $match: { foreign: { $size: 0 } } },
    ]);
  }
  return (await cursor.toArray()).map(({ _id }) => _id);
};

const deleteFiles = (ids, bucket) => ids.map(id => bucket.delete(id));

const deleteDocuments = (ids, db, collection) =>
  ids.map(id => db.collection(collection).deleteOne({ _id: id }));

const userConfirm = description =>
  new Promise((resolve, reject) => {
    prompt.start();
    prompt.get(
      [
        {
          name: 'confirm',
          description: chalk.bgBlue.white(description),
          type: 'string',
        },
      ],
      (error, result) => {
        if (error) return reject(error);
        if (result.confirm.toLowerCase() === 'y') return resolve();
        return reject();
      },
    );
  });

const cleanup = async (
  { id, deleteAllOrphans },
  { db, bucket, spinnerRef },
) => {
  if (!(id || deleteAllOrphans)) {
    console.log(
      'Nothing to do here, either provide an ID, or ask for all orphans to be deleted',
    );
    return;
  }

  if (id) {
    // try to find the project to delete
    const result = await db.collection('projects').findOne(id);
    // nothing found? => Bail!
    if (!result || !result._id) {
      throw new Error(`No project found for ID '${id}'`);
    }
    // project published? => Bail! Need to unpublish first
    // This is on purpose, more steps to avoid deleting something important
    if (result.published) {
      throw new Error("This project cannot be removed because it's published");
    }
  }

  // find files and documents to delete
  spinnerRef.current = getSpinner().start('Finding data to delete');
  const toBeDeleted = {
    files: await findFilesToDelete(id, db),
    chunks: deleteAllOrphans ? await findChunksToDelete(db) : [],
    analyses: await findRelatedDocumentsToDelete(id, db, 'analyses'),
    chains: await findRelatedDocumentsToDelete(id, db, 'chains'),
  };
  spinnerRef.current.succeed(
    `Found all data to delete (${plural(
      'file',
      toBeDeleted.files.length,
      true,
    )}, ${plural(
      'related document',
      toBeDeleted.analyses.length + toBeDeleted.chains.length,
      true,
    )}${deleteAllOrphans ? '' : ', and 1 document'})`,
  );

  // user confirmation
  try {
    await userConfirm('Confirm deletion of this data from the database [y/N]');
    if (deleteAllOrphans) {
      // user confirmation... again... because it might remove a lot of stuff
      await userConfirm(
        'There is no going back from that. Are you reaaaaaally sure? 🤔 [y/N]',
      );
    }
  } catch (error) {
    return console.log(
      chalk.bgYellow('Canceled action by user, nothing was deleted'),
    );
  }

  spinnerRef.current = getSpinner().start(
    'Deleting project, and related documents and files',
  );

  await Promise.all([
    ...deleteFiles(toBeDeleted.files, bucket),
    ...deleteDocuments(toBeDeleted.analyses, db, 'analyses'),
    ...deleteDocuments(toBeDeleted.chains, db, 'chains'),
    ...deleteDocuments([id], db, 'projects'),
  ]);

  spinnerRef.current.succeed();
};

module.exports = cleanup;
