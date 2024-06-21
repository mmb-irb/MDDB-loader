// File system
const fs = require('fs');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// Import auxiliar functions
const { idOrAccessionCoerce, canWrite } = require('../../../utils/auxiliar-functions');

const TRACE_FILENAME = '.project_id';

// Leave a hidden file with the project id when the load starts
// This allows the loader to know the project id in further loads
const leaveTrace = (directory, id) => {
    // If we do not have write permissiones here then do not try to leave a trace
    if (!canWrite(directory)) {
        console.log(chalk.yellow(`WARNING: No write permissions here. No trace will be left.`));
        return
    };
    fs.writeFileSync(directory + TRACE_FILENAME, id.toString());
}

// Find the project id trace, if exists, and return the project id
const findTrace = directory => {
    const tracePath = directory + TRACE_FILENAME;
    if (!fs.existsSync(tracePath)) return null;
    const id = fs.readFileSync(tracePath, { encoding: 'utf8', flag: 'r' });
    return idOrAccessionCoerce(id);
}

// Remove a trace
const removeTrace = directory => {
    const tracePath = directory + TRACE_FILENAME;
    if (fs.existsSync(tracePath)) fs.rmSync(tracePath);
}

module.exports = {
    leaveTrace,
    findTrace,
    removeTrace
}