// Small functions used along the whole loader

// Import some logic

// Allows asking user for confirmation
const prompts = require('prompts');
// Add colors in console
const chalk = require('chalk');
// ObjectId return
const { ObjectId } = require('mongodb');
// Files system from node
const fs = require('fs');
// Allows to call a unix command or run another script
// The execution of this code keeps running
const { spawnSync } = require('child_process');
// Used to read the current working directory through cwd
const process = require('process');

// YAML parser
const YAML = require('yaml')

// Find some values
const workingDirectory = process.cwd();
// RegExp formula to check if a string is a mongoid
const mongoidFormat = new RegExp('^[0-9a-f]{24}$');

// Set some constants

// Set problematic signs for directory/folder names
FORBIDEN_DIRECTORY_CHARACTERS = ['.', ',', ';', ':'];
// RegExp formula to find multiple slashes
const MULTIPLE_SLASHES = /\/+/g;

// Throw a question for the user trough the console
// Await for the user to confirm
const userConfirm = async question => {
    const response = await prompts({
        type: 'text',
        name: 'confirm',
        message: question,
    });
    if (response.confirm) return response.confirm;
    return null;
};

// Usual question
const userConfirmDataLoad = async fieldname => {
    const confirm = await userConfirm(
        `'${fieldname}' already exists in the project. Confirm data loading:
        Y - Overwrite previous data with new data
        * - Conserve previous data and discard new data`
    ) === 'Y';
    // Warn the user about the consequences of its decision
    const message = confirm
        ? 'Previous data will be overwritten by the new data'
        : 'Previous data is conserved and the new data will be discarded';
    console.log(chalk.yellow(message));
    return confirm;
};

// Check if gromacs excutable is in path
// If a command is passed then use it
// Otherwiese, guess the gromacs command by try and fail
// Return the working command
const USUAL_GROMACS_COMMANDS = ['gmx', 'gmx_mpi']
const getGromacsCommand = command => {
    // Set the commands to try before we give up
    const commandsToTry = command ? [ command ] : USUAL_GROMACS_COMMANDS;
    for (const cmd of commandsToTry) {
        // Check if a command is installed in the system
        // WARNING: "error" is not used, but it must be declared in order to obtain the output
        const process = spawnSync(cmd, ['/?'], {encoding: 'utf8'});
        if (process.output !== null) return cmd;
    }
    // In case no grommacs command was found in the path we warn the user and stop here
    throw new Error('Gromacs is not installed or its source is not in $PATH');
};

// Translate a MD name to a MD directory
const mdNameToDirectory = name => {
    // Make all letters lower and replace white spaces by underscores
    let directory = name.toLowerCase().replace(' ', '_');
    // Remove problematic characters
    for (const character of FORBIDEN_DIRECTORY_CHARACTERS) {
        directory = directory.replace(character, '');
    }
    return directory;
}

// Convert the input local path into a valid global path
const resolvePath = (path, isDirectory) => {
    const basepath = path.startsWith('/') ? '' : `${workingDirectory}/`;
    const fullpath = `${basepath}${path}${isDirectory ? '/' : ''}`;
    return fullpath.replace(MULTIPLE_SLASHES, '/');
};

// Convert a local directory path into a global path and check it is accessible
const directoryCoerce = directory => {
    // Path conversion
    const fullPath = resolvePath(directory, isDirectory = true);
    try {
        // Check if directory is accessible and executable
        // "X_OK" means directory must be executable and yes, directories were always executables
        fs.accessSync(fullPath, fs.constants.X_OK);
    } catch (_) {
        throw new Error(`Unable to use directory '${directory}'`);
    }
    return fullPath;
};

// Given a path with any number of steps, return the last step
const getBasename = path => {
    const steps = path.split('/');
    const last = steps[steps.length -1]; // For when the path ends with no '/' (usually files)
    if (last) return last;
    return steps[steps.length -2]; // For when the path ends in '/' (usually directories)
}

// Save the object from mongo which is associated to the provided id
// WARNING: If the argument passed to this function is null a new ObjectId is generated
const idCoerce = id => new ObjectId(id);

// Convert the input accession string into a valid accession format
const accessionCoerce = accession => accession.trim();

// Try to coerce the input argument as a mongo id
// If fails, try it as an accession
const idOrAccessionCoerce = idOrAccession => {
    if (!idOrAccession) return null;
    if (mongoidFormat.test(idOrAccession)) return idCoerce(idOrAccession);
    return accessionCoerce(idOrAccession);
};

// This is just like an string array with the accepted formats
const mimeMap = new Map([['.pdb', 'chemical/x-pdb']]);

// Check if the provided filename has one of the accepted formats
// If it is, return the type. If not, return the "octet-stream" format.
const getMimeTypeFromFilename = filename => {
    for (const [extension, type] of mimeMap.entries()) {
        if (filename.toLowerCase().endsWith(extension)) return type;
    }
    // default
    return 'application/octet-stream';
};

// Read and parse a JSON file
const loadJSON = filepath => {
    try {
        const fileContent = fs.readFileSync(filepath, 'utf8');
        const output = JSON.parse(fileContent);
        return output;
    } catch (error) {
        console.error(error);
        return null;
    }
};

// Read and parse a YAML file
const loadYAML = filepath => {
    try {
        const fileContent = fs.readFileSync(filepath, 'utf8');
        const output = YAML.parse(fileContent);
        return output;
    } catch (error) {
        console.error(error);
        return null;
    }
};

// Read a file which may be a YAML or a JSON
const loadYAMLorJSON = filepath => {
    const splits = filepath.split('.');
    const extension = splits[splits.length-1];
    if (extension.length === filepath.length) throw new Error(`File ${filepath} has no extension`);
    if (extension === 'yaml' || extension === 'yml') return loadYAML(filepath);
    if (extension === 'json') return loadJSON(filepath);
    throw new Error(`File ${filepath} has a non supported extension`);
}

module.exports = {
    mongoidFormat,
    userConfirm,
    userConfirmDataLoad,
    getGromacsCommand,
    mdNameToDirectory,
    directoryCoerce,
    getBasename,
    idOrAccessionCoerce,
    getMimeTypeFromFilename,
    loadJSON,
    loadYAML,
    loadYAMLorJSON,
};