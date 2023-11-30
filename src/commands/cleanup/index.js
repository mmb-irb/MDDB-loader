// Load auxiliar functions
const { userConfirm } = require('../../utils/auxiliar-functions');
// Get an objectId from the string id
const { ObjectId } = require('mongodb');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../utils/get-spinner');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// Return a word's plural when the numeric argument is bigger than 1
const plural = require('../../utils/plural');

// Find projects which load was incomplete. Uncompleted projects lack metadata
const findProjectsToDelete = async (db, spinnerRef) => {
  if (spinnerRef)
    spinnerRef.current = getSpinner().start('Looking for projects to delete');
  // DANI: It seems there is no need to add an 'await' here, but have a look
  const c = db.collection('projects');
  // Find all project which lack the metadata field
  const cursor = await c.find({ metadata: { $exists: false } });
  const result = (await cursor.toArray()).map(({ _id }) => _id);
  if (spinnerRef)
    spinnerRef.current.succeed(
      `Found ${plural('project', result.length, true)} to delete`,
    );
  return result;
};

// Find all documents in the specified 'collection' whose 'find' id matches the specified 'id'
// The 'id' is specified by the user and it is meant to belong to a project
// In case there is no 'id' specified, find all orphan documents
// (i.e. their 'find' id does not match any existing 'parent' id)
// 'collection', 'find' and 'parent' differ according to the collection to be searched:
// fs.files, fs.chunks, chains or analyses
// 'db' is always passed since it is needed
// if 'spinnerRef' is passed it is used to display in console the result of this search
const findDocumentsToDelete = async (
  id,
  collection,
  find,
  parent,
  db,
  spinnerRef,
) => {
  if (spinnerRef)
    spinnerRef.current = getSpinner().start(
      `Looking for ${id ? '' : 'orphan '}${collection} to delete`,
    );
  const c = db.collection(collection);
  let cursor;
  if (id) {
    // Now, find it
    cursor = await c.find({ [find]: id });
  } else {
    // do some kind of "join" where no corresponding document is found
    cursor = await c.aggregate([
      {
        $lookup: {
          from: `${parent}`,
          as: 'foreign',
          localField: `${find}`,
          foreignField: '_id',
        },
      },
      { $match: { foreign: { $size: 0 } } },
      // "$project" (from 'projection') is used to select specific fields (attributes)
      // In this case it is only requiered the "_id"
      { $project: { _id: 1 } },
    ]);
  }
  const result = (await cursor.toArray()).map(({ _id }) => _id);
  if (spinnerRef)
    spinnerRef.current.succeed(
      `Found ${result.length} ${id ? '' : 'orphan '}${collection} to delete`,
    );
  return result;
};
// This function does nothing to data, it just return counts and outputs info by the spinner
// If project 'id' is provided, estimate how many chunks belog to all files in this project
// If no project 'id' is provided, estimate how many orphan chunks must be:
// Calculate the difference between the number of chunks needed by the files...
// ...and the actual number of chunks
// CAUTION: Returns error if the passed id belongs to a project with 0 files
const estimateChunks = async (id, db, spinnerRef) => {
  if (spinnerRef)
    spinnerRef.current = getSpinner().start(
      `Estimating the number of chunks to delete`,
    );
  // Calculate the chunks needed by each file
  const fileChunks = (await db
    .collection('fs.files')
    .aggregate([
      {
        // If an 'id' is provided, select only the project related files
        // Else, select all
        $match: id ? { 'metadata.project': id } : {},
      },
      {
        $project: {
          _id: 1,
          // Estimate is made by dividing the file size between the chunk size and rounding up
          chunks: { $ceil: { $divide: ['$length', '$chunkSize'] } },
        },
      },
      {
        $group: {
          _id: {},
          // Then, count the needed chunks of all files together
          total: { $sum: '$chunks' },
        },
      },
    ])
    .toArray())[0].total;
  if (id) {
    if (spinnerRef)
      spinnerRef.current.succeed(
        'Expected ' + fileChunks + ' file associated chunks to delete',
      );
    return fileChunks;
  } else {
    // Retrieve the total number of chunks
    const totalChunks = (await db.collection('fs.chunks').stats()).count;
    // Display in console the expected number of orphan chunks
    if (spinnerRef)
      spinnerRef.current.succeed(
        'Expected ' + (totalChunks - fileChunks) + ' orphan chunks to delete',
      );
    return totalChunks - fileChunks;
  }
};

// Delete files from "fs.files" by id
// This function also deletes file chunks through the method bucket.delete
const deleteFiles = (ids, bucket) => ids.map(id => bucket.delete(id));

// Delete documents from chains, analyses or fs.chunks
const deleteDocuments = (ids, db, collection) =>
  ids.map(id => db.collection(collection).deleteOne({ _id: id }));


// This function finds data by project or file ids or by orphanhood and removes it from mongo
const cleanup = async (
  { id, deleteAllOrphans, force },
  { db, bucket, spinnerRef },
) => {
  let target;
  let type = undefined;

  // Identify what does the id belong to
  if (id) {
    await new Promise(async resolve => {
      target = await db.collection('projects').findOne(id);
      if (target) {
        type = 'project';
        return resolve();
      }
      target = await db.collection('fs.files').findOne(id);
      if (target) {
        type = 'file';
        return resolve();
      }
      target = await db.collection('fs.chunks').findOne(id);
      if (target) {
        type = 'chunk';
        return resolve();
      }
      target = await db.collection('fs.chunks').findOne({ files_id: id });
      if (target) {
        type = 'orphans';
        return resolve();
      }
      target = await db.collection('analyses').findOne(id);
      if (target) {
        type = 'analysis';
        return resolve();
      }
      target = await db.collection('chains').findOne(id);
      if (target) {
        type = 'chain';
        return resolve();
      }
      target = await db.collection('topologies').findOne(id);
      if (target) {
        type = 'topology';
        return resolve();
      }
      target = await db.collection('references').findOne(id);
      if (target) {
        type = 'reference';
        return resolve();
      }
      console.error(chalk.yellow(`Nothing found for ID '${id}'`));
      return resolve();
    });
    // If you found something give feedback and otherwise stop here
    if (target)
      console.log(chalk.cyan(`== running cleanup of ${type} with id ${id}`));
    else return;
  } else if (deleteAllOrphans) {
    console.log(chalk.cyan(`== running trash cleanup`));
    console.log(
      chalk.yellow(
        `CAUTION: Do not run this process while data is beeing loaded`,
      ),
    );
  }

  // Data to clean will be stored here
  const toBeDeleted = {};

  // If the cleanup is called with an id
  if (type && type === 'project') {
    // project published? => Bail! Need to unpublish first
    // This is on purpose, more steps to avoid deleting something important
    if (target.published) {
      return console.error(
        chalk.bgRed("This project cannot be removed because it's published"),
      );
    }
    toBeDeleted.files = await findDocumentsToDelete(
      id,
      'fs.files',
      'metadata.project',
      'projects',
      db,
      spinnerRef,
    );
    if (toBeDeleted.files.length > 0) await estimateChunks(id, db, spinnerRef);
    // If there is a "currentUploadId" in the environment variables, find related chunks
    // This only happens when an upload has been aborted and the automatic cleanup is called
    // The current upload stream may have left some orphan chunks and they must be deleted
    if (process.env.currentUploadId) {
      console.log(
        `One file load was cancelled abruptly [${process.env.currentUploadId}]`,
      );
      console.log(`Orphan chunks associated to this file will be found`);
      toBeDeleted.chunks = await findDocumentsToDelete(
        ObjectId(process.env.currentUploadId),
        'fs.chunks',
        'files_id',
        'fs.files',
        db,
        spinnerRef,
      );
    } else {
      toBeDeleted.chunks = [];
    }
    // Find also related analyses and chains
    toBeDeleted.analyses = await findDocumentsToDelete(
      id,
      'analyses',
      'project',
      'projects',
      db,
      spinnerRef,
    );
    toBeDeleted.chains = await findDocumentsToDelete(
      id,
      'chains',
      'project',
      'projects',
      db,
      spinnerRef,
    );
    toBeDeleted.topologies = await findDocumentsToDelete(
      id,
      'topologies',
      'project',
      'projects',
      db,
      spinnerRef,
    );
    toBeDeleted.projects = [id];
  }
  // Delete a specific file
  else if (type && type === 'file') {
    const relatedProject = target.metadata.project;
    // Ask user before delete
    const confirmation =
      force ||
      (await userConfirm(
        `Confirm deletion of file '${target.filename}' and its index in project ${relatedProject} [y/*]`,
      ));
    if (!confirmation) return console.log('Cancelled operation');
    spinnerRef.current = getSpinner().start('Deleting found data');
    // Delete the document in fs.files and all its related chunks in fs.chunks
    await Promise.resolve(deleteFiles([id], bucket));
    // Remove the index of this file in the related project
    await new Promise(resolve => {
      db.collection('projects').findOneAndUpdate(
        { _id: relatedProject },
        { $pull: { files: { filename: target.filename } } },
        err => {
          if (err)
            spinnerRef.current.fail('Error while deleting current data:' + err);
          resolve();
        },
      );
    });
    spinnerRef.current.succeed('Deleted found data');
    return;
  }
  // Delete a specific chain or analysis document
  else if (type && (type === 'analysis' || type === 'chain')) {
    const relatedProject = target.project;
    const collection = type === 'analysis' ? 'analyses' : 'chains';
    // Ask user before delete
    const confirmation =
      force ||
      (await userConfirm(
        `Confirm deletion of ${type} '${target.name}' and its index in project ${relatedProject} [y/*]`,
      ));
    if (!confirmation) return console.log('Cancelled operation');
    spinnerRef.current = getSpinner().start('Deleting found data');
    // Delete the document in fs.files and all its related chunks in fs.chunks
    await Promise.resolve(deleteDocuments([id], db, collection));
    // Remove the index of this file in the related project
    await new Promise(resolve => {
      db.collection('projects').findOneAndUpdate(
        { _id: relatedProject },
        { $pull: { [collection]: target.name } },
        err => {
          if (err)
            spinnerRef.current.fail('Error while deleting current data:' + err);
          resolve();
        },
      );
    });
    spinnerRef.current.succeed('Deleted found data');
    return;
  }
  // Delete a specific chain or analysis document
  else if (type && type === 'topology') {
    const relatedProject = target.project;
    // Ask user before delete
    const confirmation =
      force ||
      (await userConfirm(
        `Confirm deletion of topology from project ${relatedProject} [y/*]`,
      ));
    if (!confirmation) return console.log('Cancelled operation');
    spinnerRef.current = getSpinner().start('Deleting found data');
    // Delete the document in fs.files and all its related chunks in fs.chunks
    await Promise.resolve(deleteDocuments([id], db, 'topologies'));
    spinnerRef.current.succeed('Deleted found data');
    return;
  }
  // Delete a specific references
  else if (type && type === 'reference') {
    const uniprot = target.uniprot;
    // Ask user before delete
    const confirmation =
      force ||
      (await userConfirm(
        `Confirm deletion of reference with UniProt ID ${uniprot} [y/*]`,
      ));
    if (!confirmation) return console.log('Cancelled operation');
    spinnerRef.current = getSpinner().start('Deleting found data');
    // Delete the document in fs.files and all its related chunks in fs.chunks
    await Promise.resolve(deleteDocuments([id], db, 'references'));
    spinnerRef.current.succeed('Deleted found data');
    return;
  } else if (type && type === 'chunk') {
    // Ask user before delete
    const confirmation =
      force || (await userConfirm(`Confirm chunk deletion [y/*]`));
    if (!confirmation) return console.log('Cancelled operation');
    spinnerRef.current = getSpinner().start('Deleting found data');
    // Delete the document in fs.files and all its related chunks in fs.chunks
    await Promise.resolve(deleteDocuments([id], db, 'fs.chunks'));
    spinnerRef.current.succeed('Deleted found data');
    return;
  } else if (type && type === 'orphans') {
    // Ask user before delete
    toBeDeleted.chunks = await findDocumentsToDelete(
      target.files_id,
      'fs.chunks',
      'files_id',
      'fs.files',
      db,
      spinnerRef,
    );
    toBeDeleted.files = [];
    toBeDeleted.analyses = [];
    toBeDeleted.chains = [];
    toBeDeleted.projects = [];
    toBeDeleted.topologies = [];
  } else if (type) {
    console.error(
      chalk.bgRed(`Manual cleanup of specific ${type} is not yet supported`),
    );
    return;
  }
  // If it has been asked all orphans to be deleted, find all
  else if (deleteAllOrphans) {
    console.log(chalk.cyan(`[Finding orphan data]`));
    toBeDeleted.files = await findDocumentsToDelete(
      null,
      'fs.files',
      'metadata.project',
      'projects',
      db,
      spinnerRef,
    );
    // Output the expected number of chunks
    await estimateChunks(null, db, spinnerRef);
    toBeDeleted.chunks = await findDocumentsToDelete(
      null,
      'fs.chunks',
      'files_id',
      'fs.files',
      db,
      spinnerRef,
    );
    toBeDeleted.analyses = await findDocumentsToDelete(
      null,
      'analyses',
      'project',
      'projects',
      db,
      spinnerRef,
    );
    toBeDeleted.chains = await findDocumentsToDelete(
      null,
      'chains',
      'project',
      'projects',
      db,
      spinnerRef,
    );
    toBeDeleted.topologies = await findDocumentsToDelete(
      null,
      'topologies',
      'project',
      'projects',
      db,
      spinnerRef,
    );
    console.log(
      chalk.cyan(
        `[Finding projects with a failed load and their related data]`,
      ),
    );
    toBeDeleted.projects = await findProjectsToDelete(db, spinnerRef);
    // Find all data related to the projects to be deleted
    let chunksCount = 0;
    for (const p in toBeDeleted.projects) {
      console.log(
        chalk.cyan(
          `- Finding data related to project ${toBeDeleted.projects[p]}`,
        ),
      );
      const newFiles = await findDocumentsToDelete(
        toBeDeleted.projects[p],
        'fs.files',
        'metadata.project',
        'projects',
        db,
        spinnerRef,
      );
      toBeDeleted.files.push(...newFiles);
      if (newFiles.length > 0)
        chunksCount += await estimateChunks(
          toBeDeleted.projects[p],
          db,
          spinnerRef,
        );
      toBeDeleted.analyses.push(
        ...(await findDocumentsToDelete(
          toBeDeleted.projects[p],
          'analyses',
          'project',
          'projects',
          db,
          spinnerRef,
        )),
      );
      toBeDeleted.chains.push(
        ...(await findDocumentsToDelete(
          toBeDeleted.projects[p],
          'chains',
          'project',
          'projects',
          db,
          spinnerRef,
        )),
      );
      toBeDeleted.topologies.push(
        ...(await findDocumentsToDelete(
          toBeDeleted.projects[p],
          'topologies',
          'project',
          'projects',
          db,
          spinnerRef,
        )),
      );
    }
    // Final summary before data deletion confirmation
    console.log(chalk.cyan(`[Summary]`));
    console.log(chalk.cyan('· Projects -> ' + toBeDeleted.projects.length));
    console.log(chalk.cyan('· Files -> ' + toBeDeleted.files.length));
    console.log(chalk.cyan('· File related chunks -> ' + chunksCount));
    console.log(chalk.cyan('· Orphan chunks -> ' + toBeDeleted.chunks.length));
    console.log(chalk.cyan('· Analyses -> ' + toBeDeleted.analyses.length));
    console.log(chalk.cyan('· Chains -> ' + toBeDeleted.chains.length));
    console.log(chalk.cyan('· Topologies -> ' + toBeDeleted.topologies.length));
  }
  // Stop here if no id or "deleteAllOrphans" is provided
  else {
    console.log(
      'Nothing to do here, either provide an ID, or ask for all orphans to be deleted\n',
      'In orther to ask for all orphans to be deleted type the following command:\n',
      'node index.js cleanup --delete-all-orphans',
    );
    return;
  }

  // Stop here if there is nothing to delete
  if (
    !id &&
    toBeDeleted.files.length == 0 &&
    toBeDeleted.chunks.length == 0 &&
    toBeDeleted.analyses.length == 0 &&
    toBeDeleted.chains.length == 0 &&
    toBeDeleted.topologies.length == 0 &&
    toBeDeleted.projects.length == 0
  ) {
    return console.log('There is no data to delete');
  }

  // Ask user to confirm
  const confirmation1 =
    force ||
    (await userConfirm(
      'Confirm deletion of this data from the database [y/N]',
    ));
  if (!confirmation1) return console.log('Cancelled operation');
  if (deleteAllOrphans) {
    // user confirmation... again... because it might remove a lot of stuff
    const confirmation2 =
      force ||
      (await userConfirm(
        'There is no going back from that. Are you reaaaaaally sure? 🤔 [y/N]',
      ));
    if (!confirmation2) return console.log('Cancelled operation');
  }

  spinnerRef.current = getSpinner().start('Deleting found data');

  // Delete all selected data
  await Promise.all([
    // Delete files and their chunks
    ...deleteFiles(toBeDeleted.files, bucket),
    // This is only used to delete orphan chunks
    ...deleteDocuments(toBeDeleted.chunks, db, 'fs.chunks'),
    // Now delete the rest of documents and the project itself
    ...deleteDocuments(toBeDeleted.analyses, db, 'analyses'),
    ...deleteDocuments(toBeDeleted.chains, db, 'chains'),
    ...deleteDocuments(toBeDeleted.topologies, db, 'topologies'),
    ...deleteDocuments(toBeDeleted.projects, db, 'projects'),
  ]);

  spinnerRef.current.succeed('Deleted found data');
};

module.exports = cleanup;
