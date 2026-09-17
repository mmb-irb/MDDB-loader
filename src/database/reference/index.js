// Files system
const fs = require('fs');
// This utility displays in console a dynamic loading status
const logger = require('../../utils/logger');
// Load auxiliar functions
const { getBasename } = require('../../utils/auxiliar-functions');
// Import a version handler
const Version = require('../../utils/version');

// Set the reference class
class Reference {
    constructor (type, data, database) {
        // Store the current reference data
        this.type = type;
        this.data = data;
        // Store the database handler
        this.database = database;
        // Get some additional values from the database
        const config = this.database.REFERENCES[this.type];
        this.collection = this.database[config.collectionName];
        this.idField = config.idField;
        this.id = this.data[this.idField];
        this.projectIdsField = config.projectIdsField;
        this.label = `"${this.type}" reference "${this.id}"`;
        this.version = new Version(this.data.version);
        // Always use this query to find the reference in the database
        this.referenceQuery = { [this.idField]: this.id }
        // Note that the version is included in the query for safety reasons
        // Otherwise we could overwrite a newer reference while this is obsolete
        if (this.data.version) this.referenceQuery.version = this.version.toString();
    };

    // Update remote reference data by overwritting it all with current reference data
    // WARNING: Be sure you are updating this reference, and not a newer version
    updateRemote = async () => {
        logger.startLog(`📝 Updating database ${this.label} data`);
        // Replace remote reference data by local reference data
        // Include the version in the query for safety reasons
        // Otherwise we could overwrite a newer reference while this is obsolete
        const result = await this.collection.replaceOne(this.referenceQuery, this.data);
        if (result.acknowledged === false)
            return logger.failLog(`📝 Failed to update database ${this.label} data`);
        logger.successLog(`📝 Updated database ${this.label} data`);
    };

    // Iterate files associated to this reference
    // To do so, check its shallowest values and look for the 'file:' header
    iterateAssociatedFiles = function* () {
        for (const [field, value] of Object.entries(this.data)) {
            // Check if the following value is a reference to a file
            if (typeof value !== 'string') continue;
            if (!value.startsWith('file:')) continue;
            const filename = value.slice(5);
            yield [field, filename];
        }
    }

    // Delete a file and update the remote reference accordingly
    deleteFile = async (filename, field) => {
        // Set the query object
        const fileQuery = {
            filename: filename,
            'metadata.reftype': this.type,
            'metadata.refid': this.id,
            'metadata.field': field,
        };
        // Delete the file
        await this.database.deleteFile(fileQuery);
        // Update the reference metadata accordingly
        this.data[field] = null;
        await this.updateRemote();
    }

    // Add a new reference in the references collection in case it does not exist yet
    loadReference = async () => {
        // Check if the reference has any files to be uploaded with it
        // To do so, check its shallowest values and look for the 'file:' header
        for await (const [field, filePath] of this.iterateAssociatedFiles()) {
            // Make sure the file exists
            if (!fs.existsSync(filePath))
                throw new Error(`The ${this.label} has a missing associated file ` +
                    `(${field}: 'file:${filePath}') but the file in "${filePath}" is missing.`);
            // Get the file name
            const fileName = getBasename(filePath);
            // Now load the file including its metadata
            const fileMetadata = { reftype: this.type, refid: this.id, field: field };
            await this.database.loadFile(filePath, fileName, fileMetadata);
            // If the load was sucessful then make sure to leave only the filename in the reference data
            if (filePath !== fileName) this.data[field] = `file:${fileName}`;
        }
        // Otherwise load the new reference data as it is
        logger.startLog(`💽 Loading ${this.label}`);
        // Load the new reference
        const result = await this.collection.insertOne(this.data);
        // If the operation failed
        if (result.acknowledged === false) return logger.failLog(`💽 Failed to load ${this.label}`);
        logger.successLog(`💽 Loaded new ${this.label} -> ${result.insertedId}`);
        // Update the inserted data in case we need to revert the change
        this.database.inserted_data.push({
            name: `new ${this.label}`,
            collection: this.collection,
            id: result.insertedId
        });
    };

    // Delete the reference from the database
    deleteReference = async () => {
        // Delete all reference files
        for await (const [field, filename] of this.iterateAssociatedFiles()) {
            await this.deleteFile(filename, field);
        }
        // Delete the reference
        logger.startLog(`🗑️  Deleting ${this.label}`);
        const result = await this.collection.deleteOne(this.referenceQuery);
        if (!result)
            return logger.failLog(`🗑️  Failed to delete ${this.label}`);
        if (result.deleteCount === 0)
            return logger.failLog(`🗑️  No reference was found using query ${this.referenceQuery}`);
        logger.successLog(`🗑️  Deleted ${this.label}`);
    }
};

module.exports = Reference