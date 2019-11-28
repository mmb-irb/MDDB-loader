#!/usr/bin/env node
const fs = require('fs');
const process = require('process');

const dotenvLoad = require('dotenv').config();

if (dotenvLoad.error) throw dotenvLoad.error;

const yargs = require('yargs');
const { ObjectId } = require('mongodb');

const commonHandler = require('./src/commands');
const resolvePath = require('./src/utils/resolve-path');

const folderCoerce = folder => {
  const cleanedUpFolder = resolvePath(folder, true);
  try {
    fs.accessSync(cleanedUpFolder, fs.constants.X_OK);
  } catch (_) {
    throw new Error(`unable to use folder '${folder}'`);
  }
  return cleanedUpFolder;
};

const idCoerce = id => ObjectId(id);

const accessionFormat = /^MCNS\d{5}$/;
const accessionCoerce = accession => {
  const output = accession.trim().toUpperCase();
  if (!accessionFormat.test(output)) throw new Error('Not a valid accession');
  return output;
};

const idOrAccessionCoerce = idOrAccession => {
  let output;
  try {
    output = idCoerce(idOrAccession);
  } catch (_) {
    try {
      output = accessionCoerce(idOrAccession);
    } catch (_) {
      /**/
    }
  }

  if (output) return output;

  throw new Error('Invalid ID or accession');
};

yargs
  // load
  .command({
    command: 'load <folder>',
    desc: 'load data from specified folder(s)',
    builder: yargs =>
      yargs
        // --gromacs-path
        .option('g', {
          alias: 'gromacs-path',
          default: 'gmx',
          description: 'path to gromacs command-line tool',
          type: 'string',
        })
        // --dry-run
        .option('d', {
          alias: 'dry-run',
          default: false,
          description: "Doesn't write to database",
          type: 'boolean',
        })
        // folders
        .positional('folder', {
          describe: 'Folder containing a project to load',
          type: 'string',
          coerce: folderCoerce,
        }),
    handler: commonHandler('load'),
  })
  // publish
  .command({
    command: 'publish <id>',
    desc:
      'publish and assign an accession (if not already existing) to the specified id(s)',
    builder: yargs =>
      yargs
        // id
        .positional('id', {
          describe: 'ID to process',
          type: 'string',
          coerce: idCoerce,
        }),
    handler: commonHandler('publish'),
  })
  // unpublish
  .command({
    command: 'unpublish <id|accession>',
    desc:
      'publish and assign an accession to the specified id, or re-publish an existing accession',
    builder: yargs =>
      // id
      yargs.positional('id', {
        describe: 'ID or accession to unpublish',
        type: 'string',
        coerce: idOrAccessionCoerce,
      }),
    handler: commonHandler('unpublish'),
  })
  // list
  .command({
    command: 'list',
    desc: 'list all projects and their status',
    handler: commonHandler('list'),
  })
  // cleanup
  // NOTE: ask user to unpublish before cleaning up, to make them think twice
  // NOTE: about what they're about to do since there is no going back from that
  .command({
    command: 'cleanup [id]',
    aliases: ['clean', 'drop', 'clear', 'delete', 'remove'],
    desc:
      'clean-up project and related files and documents from database. To clean up a published project, you must first unpublish it',
    builder: yargs =>
      yargs
        // --dry-run
        .option('delete-all-orphans', {
          description: 'Delete all orphan documents and files',
          type: 'boolean',
        })
        // id
        .positional('id', {
          describe: 'ID to clean up',
          type: 'string',
          coerce: idCoerce,
        })
        .conflicts('id', 'delete-all-orphans'),
    handler: commonHandler('cleanup'),
  })
  .demandCommand()
  .help().argv;

// in case an exception manages to escape us
process.on('unhandledRejection', error => {
  console.error('Unhandled rejection');
  console.error(error);
});
