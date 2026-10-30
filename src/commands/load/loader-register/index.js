// File system
const fs = require('fs');
// Utilities for working with file and directory paths
const nodePath = require('node:path');
// Allows to call a unix command
const { spawnSync } = require('child_process');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// Import auxiliar functions
const { idOrAccessionCoerce, canWrite } = require('../../../utils/auxiliar-functions');

const REGISTER_FILENAME = '.loader_register.json';
// Old trace file which only contained the project id
// It is still read so already loaded directories keep pointing to their projects
const LEGACY_TRACE_FILENAME = '.project_id';

// Root of the loader repository, used to find out the loader version
const LOADER_DIRECTORY = nodePath.resolve(__dirname, '../../../..');

// Run a git command in the loader repository and return its output
const runGit = args => {
    const result = spawnSync('git', ['-C', LOADER_DIRECTORY, ...args], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`Failed to get the loader version: 'git ${args.join(' ')}' failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
};

// Get the loader version from git
// It tells the last release, how far we are from it and if there are uncommited changes
// e.g. v0.0.7-4-gbec5b4b-dirty -> 4 commits after v0.0.7 (commit bec5b4b) with local changes
const getLoaderVersion = () => runGit(['describe', '--tags', '--long', '--dirty']);

// Get the exact command line used to call the loader
// Arguments with spaces or special characters are quoted so the command can be copied and run again
const getCommandLine = () => process.argv.map(arg => {
    if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(arg)) return arg;
    return `'${arg.replaceAll("'", "'\\''")}'`;
}).join(' ');

// Read the register, which is a list with one entry per load
const readRegister = registerPath => {
    const register = JSON.parse(fs.readFileSync(registerPath, { encoding: 'utf8', flag: 'r' }));
    if (!Array.isArray(register)) throw new Error(`Register ${registerPath} is not a list`);
    return register;
};

// Add an entry to a hidden file with the project id and some details of the load
// This allows the loader to know the project id in further loads
const leaveRegister = (directory, project) => {
    // If we do not have write permissiones here then do not try to leave a register
    if (!canWrite(directory)) {
        console.log(chalk.yellow(`WARNING: No write permissions in ${directory}. No register will be left.`));
        return
    };
    const registerFilepath = directory + REGISTER_FILENAME;
    if (fs.existsSync(registerFilepath) && !canWrite(registerFilepath)) {
        console.log(chalk.yellow(`WARNING: No permission to overwrite ${registerFilepath}. Previous register will remain.`));
        return
    };
    const register = fs.existsSync(registerFilepath) ? readRegister(registerFilepath) : [];
    register.push({
        date: new Date().toISOString(),
        version: getLoaderVersion(),
        command: getCommandLine(),
        projectId: project.id.toString(),
        accession: project.data.accession,
    });
    fs.writeFileSync(registerFilepath, JSON.stringify(register, null, 4) + '\n');
    // Once the new register is written the legacy trace is not needed anymore
    const legacyTracePath = directory + LEGACY_TRACE_FILENAME;
    if (fs.existsSync(legacyTracePath)) fs.rmSync(legacyTracePath);
}

// Find the register, if exists, and return the project id of its last entry
// If there is no register then fall back to the legacy trace
const findRegisteredId = directory => {
    const registerPath = directory + REGISTER_FILENAME;
    if (fs.existsSync(registerPath)) {
        const register = readRegister(registerPath);
        const lastEntry = register.at(-1);
        if (!lastEntry || !lastEntry.projectId) throw new Error(`Missing project id in the last entry of ${registerPath}`);
        return idOrAccessionCoerce(lastEntry.projectId);
    }
    const legacyTracePath = directory + LEGACY_TRACE_FILENAME;
    if (!fs.existsSync(legacyTracePath)) return null;
    const id = fs.readFileSync(legacyTracePath, { encoding: 'utf8', flag: 'r' });
    return idOrAccessionCoerce(id);
}

// Remove the register and the legacy trace
const removeRegister = directory => {
    for (const filename of [REGISTER_FILENAME, LEGACY_TRACE_FILENAME]) {
        const filepath = directory + filename;
        if (fs.existsSync(filepath)) fs.rmSync(filepath);
    }
}

module.exports = {
    leaveRegister,
    findRegisteredId,
    removeRegister
}
