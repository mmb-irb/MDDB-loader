// Function to ask the user for confirmation
const { userConfirm } = require('../../../utils/auxiliar-functions');
// Add colors in console
const chalk = require('chalk');

// Given a previous and a new metadata objects, add missing new fields to the previous metadata
// Handle also conflicts when the new value already exists and it has a different value
// If something was added or changed then return true and otherwise return false
merge_metadata = async (previousMetadata, newMetadata, conserve = false, overwrite = false) => {
    let changed = false;
    // Check the status of each new metadata key in the current metadata
    for (const [key, newValue] of Object.entries(newMetadata)) {
        const previousValue = previousMetadata[key];
        // Missing keys are added from current metadata
        if (previousValue === undefined) {
            previousMetadata[key] = newValue;
            changed = true;
            continue;
        }
        // Keys with the same value are ignored since there is nothing to change
        if (previousValue === newValue) {
            continue;
        }
        // Arrays and objects are not considered 'equal' even when they store identical values
        // We have to check this is not the case
        // NEVER FORGET: Both objects and arrays return 'object' when checked with 'typeof'
        if (typeof previousValue === 'object' && typeof newValue === 'object') {
            if (JSON.stringify(previousValue) === JSON.stringify(newValue)) continue;
        }
        // Keys with different values are conflictive and we must ask the user for each one
        // If the 'conserve' option is passed then we always keep the original value
        if (conserve) continue;
        // If the 'overwrite' option is passed then we always keep the new value
        if (overwrite) {
            previousMetadata[key] = newValue;
            changed = true;
            continue;
        }
        // If we have no force instruction then we must ask the user
        const confirm = await userConfirm(
            `Metadata '${key}' field already exists and its value does not match new metadata.
            Previous value: ${JSON.stringify(previousValue, null, 4)}
            New value: ${JSON.stringify(newValue, null, 4)}
            Confirm data loading:
            Y - Overwrite previous value with the new value
            * - Conserve previous value and discard new value`,
        );
        // If 'Y' then overwrite
        if (confirm === 'Y') {
            console.log(chalk.yellow('Previous value will be overwritten by the new value'));
            previousMetadata[key] = newValue;
            changed = true;
            continue;
        }
        // Otherwise, do nothing
        console.log(chalk.yellow('Previous value is conserved'));
    }
    return changed;
}

module.exports = {
    merge_metadata
}