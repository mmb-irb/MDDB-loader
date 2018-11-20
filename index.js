#!/usr/bin/env node
const fs = require('fs');
const process = require('process');

const yargs = require('yargs');

const argv = yargs
  .command(
    'load <folders...>',
    'load data from specified folder(s)',
    yargs =>
      yargs.positional('folders', {
        describe: 'Folder(s) containing a project to load',
        type: 'string',
      }),
    require('./src/load'),
  )
  .demandCommand()
  .coerce('folders', folders => {
    const folderSet = new Set(folders);
    const erroredFolders = [];
    const cleanedUpFolders = [];
    const workingDirectory = process.cwd();
    for (const folder of folderSet) {
      const cleanedUpFolder = (folder.startsWith('/')
        ? `${folder}/`
        : `${workingDirectory}/${folder}/`
      ).replace(/\/+/g, '/');
      try {
        fs.accessSync(cleanedUpFolder, fs.constants.X_OK);
        cleanedUpFolders.push(cleanedUpFolder);
      } catch (_) {
        erroredFolders.push(folder);
      }
    }
    if (erroredFolders.length) {
      console.warn(`will skip: ${erroredFolders.join(', ')}.`);
    }
    if (cleanedUpFolders.length) return cleanedUpFolders;
  })
  .option('d', {
    alias: 'dry-run',
    default: false,
    description: "Doesn't write to database",
    type: 'boolean',
  })
  .help().argv;
