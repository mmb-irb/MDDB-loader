const fs = require('fs');
// Import auxiliar functions
const { idOrAccessionCoerce } = require('../../../utils/auxiliar-functions');

const TRACE_FILENAME = '.project_id';

// Leave a hidden file with the project id when the load starts
// This allows the loader to know the project id in further loads
const leaveTrace = (directory, id) => {
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