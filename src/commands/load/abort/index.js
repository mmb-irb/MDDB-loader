// Load auxiliar functions
const { userConfirm } = require('../../../utils/auxiliar-functions');

// Set a function setup the aborting function
const getAbortingFunction = database => {
    // Check if load has been aborted
    // If so, exit the load function and ask the user permission to clean the already loaded data
    return async () => {
        // Return here if there is no abort
        if (!process.env.abort) return false;
        const confirm = await userConfirm(
            `Load has been interrupted. Confirm further instructions:
            C - Abort load and conserve already loaded data
            D - Abort load and delete already loaded data
            * - Resume load`,
        );
        if (confirm === 'C') {
            process.exit(0)
        } else if (confirm === 'D') {
            await database.revertLoad(confirmed = true);
            process.exit(0)
        } else {
            // Clean the 'abort' environmental variable
            process.env.abort = '';
            return;
        }
    };
}

module.exports = getAbortingFunction;