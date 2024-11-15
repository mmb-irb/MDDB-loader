#!/usr/bin/env node

// Allow reading to the current working directory
const process = require('process');
// These 2 lines alone allow all scripts to access the env file through process.env
const dotenvLoad = require('dotenv').config({ path: __dirname + '/.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

// "yargs" is a library used to manage script calls from unix console
const yargs = require('yargs');

// Import auxiliar functions
const { idOrAccessionCoerce } = require('./src/utils/auxiliar-functions');
// Hanlde the setup before any command is run
const commonHandler = require('./src/commands');

// -----------------------------------------------------------------------------------------

// Execute different functions and scripts according to the input commands and options
// Display help info when this script is called with no commands or with a "--help" commands
// yargs API: https://github.com/yargs/yargs/blob/HEAD/docs/api.md
yargs
    // load
    .command({
        command: 'load <pdir>', // Command name and positional arguments. Useful for the help
        desc: 'load data from specified file or folder', // Command description. Useful for the help
        builder: yargs => yargs
            // All values from options and positionals are saved at the "argv" object (explained below)
            // project directory
            .positional('pdir', {
                alias: 'project-directory',
                describe: 'Project directory containing all files to be loaded',
                type: 'string'
            })
            // --accession
            .option('a', {
                alias: 'accession',
                description: 'Set the accession.\n' +
                    'Use this to append new data to an already existing project.\n' +
                    'Also use this to create a new project with a specific accession.',
                type: 'string',
                default: null,
                coerce: idOrAccessionCoerce,
            })
            // --conserve
            .option('c', {
                alias: 'conserve',
                description: 'Restrict the data append so the user is never asked and new data is loaded only when there is no conflict',
                type: 'boolean',
                default: false,
            })
            // --overwrite
            .option('o', {
                alias: 'overwrite',
                description: 'Priorize the data append so the user is never asked and current data is overwritten when there is any conflict',
                type: 'boolean',
                default: false,
            })
            // --md-directories
            .option('mdirs', {
                alias: 'md-directories',
                description: 'Set which MD directories are to be loaded',
                type: 'array'
            })
            // --include
            .option('i', {
                alias: 'include',
                description: 'Load only the specified files',
                type: 'array',
            })
            // --exclude
            .option('e', {
                alias: 'exclude',
                description: 'Load all but the specified files',
                type: 'array',
            })
            // --skip-trajectories
            .option('st', {
                alias: 'skip-trajectories',
                description: 'Skip the load of any trajectory file (xtc) in the binary format (bin)',
                type: 'boolean',
                default: false,
            })
            // --skip-files
            .option('sf', {
                alias: 'skip-files',
                description: 'Skip the load of any file (pdb, xtc, ...)',
                type: 'boolean',
                default: false,
            })
            // --skip-analyses
            .option('sa', {
                alias: 'skip-analyses',
                description: 'Skip the load of any analyses (md.whatever.json files)',
                type: 'boolean',
                default: false,
            })
            // --gromacs-path
            .option('gro', {
                alias: 'gromacs-path', // Option name. Useful for the help
                description: 'path to gromacs command-line tool', // Option description. Useful for the help
                type: 'string',
                default: null,
                coerce: idOrAccessionCoerce,
            }),
        handler: commonHandler('load'), // Call the command script with the command name as argument
    })
    // publish
    .command({
        command: 'publish <id|accession>',
        desc: 'publish and assign an accession (if not already existing) to the specified id(s)',
        builder: yargs => yargs
            // id
            .positional('id', {
                describe: 'ID to process',
                type: 'string',
                coerce: idOrAccessionCoerce,
            }),
        handler: commonHandler('publish'),
    })
    // unpublish
    .command({
        command: 'unpublish <id|accession>',
        desc: 'publish and assign an accession to the specified id, or re-publish an existing accession',
        builder: yargs => yargs
            // id
            .positional('id', {
                describe: 'ID or accession to unpublish',
                type: 'string',
                coerce: idOrAccessionCoerce,
            }),
        handler: commonHandler('unpublish'),
    })
    // list
    // DANI: Nunca lo uso
    .command({
        command: 'list',
        desc: 'list all projects and their status',
        handler: commonHandler('list'),
    })
    // delete
    .command({
        command: 'delete [id]',
        aliases: ['drop', 'erase', 'remove'],
        desc: 'Delete any document by its ID. To clean up a published project, you must first unpublish it',
        builder: yargs => yargs
            // --confirm
            .option('y', {
                alias: 'confirm',
                description: 'Confirm already, so the user is never asked for confirmation before deletion',
                type: 'boolean',
                default: false,
            })
            // id
            .positional('id', {
                describe: 'ID of document to delete',
                type: 'string',
                coerce: idOrAccessionCoerce,
            }),
            handler: commonHandler('delete'),
    })
    // cleanup
    // NOTE: ask user to unpublish before cleaning up, to make them think twice
    // NOTE: about what they're about to do since there is no going back from that
    .command({
        command: 'cleanup',
        aliases: ['clean', 'clear'],
        desc: 'Remove orphan data',
        builder: yargs => yargs
            // --confirm
            .option('y', {
                alias: 'confirm',
                description: 'Confirm already, so the user is never asked for confirmation before deletion',
                type: 'boolean',
                default: false,
            }),
        handler: commonHandler('cleanup'),
    })
    // setup
    .command({
        command: 'setup',
        aliases: ['install'],
        desc: 'Setup the database collections and configure their indexation',
        builder: yargs => yargs,
        handler: commonHandler('setup'),
    })
    .demandCommand() // Demand a minimmum of 1 command
    .strict()
    // Display all descriptions when the command --help is asked or there is no command
    .help().argv; // "argv" is a normal object passed from yargs library
// This object contains the input values of options and positionals from the command
// e.g. in load command, argv contains the values of {folder, gromacs-path}

// in case an exception manages to escape us
process.on('unhandledRejection', error => {
    console.error('Unhandled rejection');
    console.error(error);
});
