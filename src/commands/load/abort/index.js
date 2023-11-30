// Load auxiliar functions
const { userConfirm } = require('../../../utils/auxiliar-functions');
// In case of load abort we need to clean up
const cleanup = require('../../cleanup');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');

// Set a function setup the aborting function
const getAbortingFunction = (project, append, appended) => {
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
            return true;
        } else if (confirm === 'D') {
            // Delete the current uploaded data
            if (append) {
                for await (const doc of appended) {
                    await cleanup(
                        { id: doc, deleteAllOrphans: false },
                        project,
                    );
                }
            }
            // If this is not an append, delete the current project
            else
                await cleanup(
                    { id: projectIdRef.current, deleteAllOrphans: false },
                    project,
                );
            return true;
        } else {
            // Reverse the 'abort' environmental variable and restart the spinner
            process.env.abort = '';
            spinnerRef.current = getSpinner().start();
            return false;
        }
    };
}

module.exports = getAbortingFunction;