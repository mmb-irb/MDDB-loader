// Load auxiliar functions
const { userConfirm, userConfirmDataLoad, mdNameToDirectory } = require('../utils/auxiliar-functions');
// Add colors in console
const chalk = require('chalk');

// Set the project class
class Database {
    constructor (db, bucket) {
        // Get database handlers
        this.db = db;
        this.bucket = bucket;
        // The spinner displays in console a dynamic loading status (see getSpinner)
        // This object saves the access (both read and write) to the spinner methods and variables
        // Since this object is sealed, attributes can be written but not added or deteled
        this.spinnerRef = Object.seal({ current: null });
        // Keep the project ID in case we need to roll back
        // This object is sent empty to the load index.js, which saves a new mongo document on it
        this.project_id = null;
        // Store the MD names once they have been found
        this.md_directory_names = null;
        // Store the current project data once it has been downloaded
        this._project_data = null;
        
    };

    // Set some collection getters
    get projects () {
        return this.db.collection('projects');
    }
    get references () {
        return this.db.collection('references');
    }
    get topologies () {
        return this.db.collection('topologies');
    }
    get files () {
        return this.db.collection('fs.files');
    }

    // Get the database project data
    get project_data () {
        // Set an async wrapper
        return (async () => {
            // Return the stored value if we already have it
            if (this._project_data !== null) return this._project_data;
            // Otherwise it has to be requested
            this._project_data = await this.projects.findOne({ _id: this.project_id });
            if (!this._project_data) this._project_data = {};
            return this._project_data;
        })();
    }

    // Set the database project
    // If a mongo id or accession is passed then we check the project exists
    setupProject = async (idOrAccession, mdDirectories) => {
        if (idOrAccession) {
            // Use regexp to check if 'append' is an accession or an object ID
            const accessionFormat = new RegExp('^' + process.env.ACCESSION_PREFIX + '\\d{5}$');
            // If it is an accession we have to query in a specific format
            // If it is an object id we can directly query with it
            const query = accessionFormat.test(idOrAccession) ? { accession: idOrAccession } : idOrAccession;
            // Find the already existing project in mongo
            this._project_data = await this.projects.findOne(query);
            if (!this._project_data) throw new Error(`No project found for ID/Accession '${idOrAccession}'`);
            this.project_id = selectedProject._id;
            // Display the project id. It may be useful if the load is abruptly interrupted to clean
            console.log(chalk.cyan(`== new data will be added to project '${this.project_id}'`));
            // Set MD directory names from project data
            this.md_directory_names = {}
            this._project_data.mds.forEach(md => {
                const name = md.name;
                const directory = mdNameToDirectory(name);
                if (mdDirectories.includes(directory))
                    this.md_directory_names[directory] = name;
            });
        }
        else {
            // Create a new document in mongo
            // 'insertedId' is a standarized name inside the returned object. Do not change it.
            this._project_data = { accession: null, published: false };
            // Load the new project
            const result = await this.projects.insertOne(this._project_data);
            // If the operation failed
            if (result.acknowledged === false) throw new Error(`Failed to insert new project`);
            // Update the project id
            this.project_id = result.insertedId;
            // Display the project id. It may be useful if the load is abruptly interrupted to clean
            console.log(chalk.cyan(`== new project will be stored with the id '${this.project_id}'`));
        }
        // Set MD directory names from the available MD directories
        this.md_directory_names = {}
        mdDirectories.forEach(directory => {
            const name = directory.replace('_', ' ');
            this.md_directory_names[directory] = name;
        });
        // Check the number of MD names and MD directories match
        // This could mean MD names are so similar that they lead to identical directory name or vice versa
        if (mdDirectories.length !== Object.keys(this.md_directory_names))
            throw new Error('Number of MD names and MD directories must match');
    }

    // Set a function to easily update current project
    updateProject = async updater => {
        const result = this.projects.findOneAndUpdate({ _id: this.project_id }, updater);
        if (result.acknowledged === false) throw new Error('Failed to update current project')
    };

    // Add a new reference in the references collection in case it does not exist yet
    loadReference = async reference => {
        console.log('Loading reference ' + reference.uniprot);
        // Check if the reference is already in the database and, if so, skip it
        const current = await this.references.findOne({ uniprot: reference.uniprot });
        if (current) return console.log(chalk.grey(`  Reference ${reference.uniprot} is already in the database`));
        // Load the new reference
        const result = await this.references.insertOne(reference);
        // If the operation failed
        if (result.acknowledged === false) throw new Error(`Failed to insert new reference`);
        console.log(chalk.green(`  Loaded new reference ${reference.uniprot} -> ${result.insertedId}`));
    };

    // Anticipate chains update
    forestallChainsUpdate = async (conserve = false, overwrite = false) => {
        // Find the current chains value
        const currentChains = await this.project_data.chains;
        // If there is no current value then there is no problem
        if (!currentChains) return true;
        // In case it is 'conserve', skip this part
        // This is equal to always choosing the 'C' option
        if (conserve) return false;
        // Ask the user in case the overwrite flag was not passed
        const confirm = overwrite ? true : await userConfirmDataLoad('Chains');
        // If there was no confirmation then abort the process
        if (!confirm) {
            console.log(chalk.yellow('New data will be discarded'));
            return false;
        }
        // If we had confirmation then proceed to delete current data
        console.log(chalk.yellow('Current data will be overwritten'));
        // Set chains as an empty list
        const updateResult = this.projects.findOneAndUpdate(
            // Find current project by its id
            { _id: this.project_id },
            // The '$set' command in mongo will override the previous value
            { $set: { chains: [] } });
        // If the operation failed
        if (updateResult.acknowledged === false) throw new Error(`Failed to update project data`);
        // Delete previous chains
        const deleteResults = db.collection('chains').deleteMany({ project: this.project_id });
        console.log(deleteResults);
        if (!deleteResults) throw new Error(`Failed to delete previous data in chains collection`);
        return true;
    };

    // Given a current and a new metadata objects, add missing new fields to the current metadata
    // Handle also conflicts when the new value already exists and it has a different value
    _merge_metadata = async (currentMetadata, newMetadata, conserve = false, overwrite = false) => {
        // Check the status of each new metadata key in the current metadata
        for (const [key, newValue] of Object.entries(newMetadata)) {
            const currentValue = currentMetadata[key];
            // Missing keys are added from current metadata
            if (currentValue === undefined) currentMetadata[key] = newValue;
            // Keys with the same value are ignored since there is nothing to change
            else if (currentValue === newValue) continue;
            // Keys with different values are conflictive and we must ask the user for each one
            else {
                // Arrays and objects are not considered 'equal' even when they store identical values
                // We have to check this is not the case
                // NEVER FORGET: Both objects and arrays return 'object' when checked with 'typeof'
                if (
                    typeof currentValue === 'object' &&
                    typeof newValue === 'object'
                ) {
                    if (JSON.stringify(currentValue) === JSON.stringify(newValue))
                    continue;
                }
                // When this is a real conflict...
                // If the 'conserve' option is passed
                if (conserve) continue;
                // Else, if the 'overwrite' option is passed
                else if (overwrite) currentMetadata[key] = newValue;
                // Else, ask the user
                else {
                    const confirm = await userConfirm(
                        `Metadata '${key}' field already exists and its value does not match new metadata.
                        Current value: ${JSON.stringify(currentValue, null, 4)}
                        New value: ${JSON.stringify(newValue, null, 4)}
                        Confirm data loading:
                        C - Conserve current value and discard new value
                        * - Overwrite current value with the new value`,
                    );
                    // If 'C' do nothing
                    if (confirm === 'C') {
                        console.log(chalk.yellow('New value will be discarded'));
                        continue;
                    }
                    // Otherwise, overwrite
                    else {
                        console.log(chalk.yellow('Current value will be overwritten'));
                        currentMetadata[key] = newValue;
                    }
                }
            }
        }
        return currentMetadata;
    }

    // Set a handler to update metadata
    // If no MD directory is passed then update project metadata
    updateProjectMetadata = async (newMetadata, conserve, overwrite) => {
        console.log('Loading project metadata');
        // Get current metadata
        // Note that project metadata is in a field called 'metadata'
        const currentMetadata = await this.project_data.metadata;
        // If there is no metadata then simply add it
        if (!currentMetadata) return await this.updateProject({ $set: { metadata: newMetadata } });
        // If there is an already existing metadata then we modify it and send it back to mongo
        // WARNING: Note that values in current metadata which are missing in new metadata will remain
        // This is makes sense since we are 'appending' new data
        await this._merge_metadata(currentMetadata, newMetadata, conserve, overwrite);
        // Finally, load the modified current metadata object into mongo
        await this.updateProject({ $set: { metadata: currentMetadata }});
    };


    // Set a handler to update metadata
    // If no MD directory is passed then update project metadata
    updateMdMetadata = async (newMetadata, mdDirectory, conserve, overwrite) => {
        console.log('Loading MD metadata');
        // Get current metadata
        // Note that MD metadata is in every MD object
        const mds = await this.project_data.mds;
        const currentMetadata = mds.find(md => mdNameToDirectory(md['name']) === mdDirectory);
        // At this point metadata should exist
        if (!currentMetadata) throw new Error('MD directory ' + mdDirectory + ' does not exist');
        // Update the MD object with the MD metadata
        await this._merge_metadata(currentMetadata, newMetadata, conserve, overwrite);
        // Finally, load the new mds object into mongo
        await this.updateProject({ $set: { mds: mds } });
    };

    // Check if there is a previous document already saved
    // If so, check if we must delete it or conserve it
    forestallTopologiesUpdate = async (newTopology, conserve, overwrite) => {
        // Check if current project already has a topology in the database
        const exist = await this.topologies.findOne({ project: this.project_id });
        // In case it does not exist we are done
        if (!exist) return true;
        // In case it exists and the 'conserve' flag has been passed we end here
        if (conserve) return false;
        // Check if both documents are identical
        // In this case we stop here since it makes not sense uploading the same
        if (JSON.stringify(exist) === JSON.stringify(newTopology)) return false;
        // Ask the user in case the 'overwrite' flag has not been passed
        const confirm = overwrite ? true : await userConfirmDataLoad('Topology');
        // If the user has asked to converve current data then abort the process
        if (!confirm) {
            console.log(chalk.yellow('New data will be discarded'));
            return false;
        }
        console.log(chalk.yellow('Current data will be overwritten'));
        // We must delete the current document in mongo
        const result = await db.collection(collection).deleteOne({ project: projectIdRef.current });
        console.log(result);
        if (!result) throw new Error(`Failed to remove previous topology`);
        return true;
    };

    // Set handler to update the topologies collection, which is not coordinated with 'projects'
    // Check if there is already a loaded value different from the the new value to warn the user
    // The 'updater' argument stands for the object data to be uploaded to mongo
    updateTopologies = async (newTopology, conserve, overwrite) => {
        // Anticipate the load and delete previous topology if necessary
        const userConsent = await this.forestallTopologiesUpdate(newTopology, conserve, overwrite);
        if (!userConsent) return;
        // Upload the new topology
        const result = await this.topologies.insertOne(newTopology);
        if (result.acknowledged === false) throw new Error(`Failed to insert new topology`);
    };

    // Check if there is a previous file with the same name
    // If so, check if we must delete it or conserve it
    forestallFileLoad = async (filename, mdDirectory, conserve, overwrite) => {
        // Check the current available files
        const projectData = await this.project_data;
        const mdName = mdDirectory && this.md_directory_names[mdDirectory];
        const mdData = mdName && projectData.mds.find(md => md.name === mdName);
        const currentFiles = mdDirectory ? mdData.files : projectData.files;
        const alreadyExistingFile = currentFiles.find(file => file.filename === filename);
        // If the new file is not among the current files then there is no problem
        if (!alreadyExistingFile) return true;
        // In case it exists and the 'conserve' flag has been passed we end here
        if (conserve) return false;
        // Note that here we do not check if files are identical since they may be huge
        // Ask the user in case the 'overwrite' flag has not been passed
        const confirm = overwrite ? true : await userConfirmDataLoad(filename);
        // If the user has asked to conserve current data then abort the process
        if (!confirm) {
            console.log(chalk.yellow('New data will be discarded'));
            return false;
        }
        console.log(chalk.yellow('Current data will be overwritten'));
        // Delete the current file from the database
        const result = await this.files.deleteOne({ project: this.project_id });
        console.log(result);
        if (!result) throw new Error(`Failed to remove previous file`);
        // Remove the current file entry from the files list and update the project
        // In case it is a directory file
        if (mdDirectory) {
            // Update the whole mds, which is easier than pulling from such specific array
            currentFiles.remove(alreadyExistingFile);
            await this.updateProject({ $set: { mds: projectData.mds } });
        }
        // In case it is a project file
        else {
            await this.updateProject({ $pull: { files: { filename: filename } } });
        }
        return true;
    };

    // Update the project to register that file has been loaded
    // WARNING: Note that this function will not check for previously existing file with identical name
    // WARNING: This is done previously by the forestallFileLoad function
    setLoadedFile = async (filename, mdDirectory, id) => {
        console.log('Updating project with the load of ' + filename);
        const fileObject = { name: filename, id: id };
        if (mdDirectory) {
            // Modifiy the whole MDs object and reset it in the project
            const mdName = mdDirectory && this.md_directory_names[mdDirectory];
            const mdData = mdName && projectData.mds.find(md => md.name === mdName);
            mdData.files.push(fileObject);
            await this.updateProject({ $set: { mds: projectData.mds } });
        }
        else {
            await this.updateProject({ $push: { files: fileObject } });
        }


        // Check if the reference is already in the database and, if so, skip it
        const current = await this.references.findOne({ uniprot: reference.uniprot });
        if (current) return console.log(chalk.grey(`  Reference ${reference.uniprot} is already in the database`));
        // Load the new reference
        const result = await this.references.insertOne(reference);
        // If the operation failed
        if (result.acknowledged === false) throw new Error(`Failed to insert new reference`);
        console.log(chalk.green(`  Loaded new reference ${reference.uniprot} -> ${result.insertedId}`));
    };

    // // Set a general handler to update 'analyses' and 'chains' collections
    // // Previously, update the 'projects' collection through the updateProject function
    // // The 'collection' argument stands for the mongo collection to be selected
    // // The 'collection' argument expects 'analyses' or 'chains' as string
    // // The 'updater' argument stands for the data to be uploaded to mongo
    // // The 'updater' argument expects an object (e.g. { name, value, projectId })
    // // Some key of the updater must be named 'name'
    // updateCollection = async (collection, updater) => {
    //     const previous = await updateProject('push', { [collection]: updater.name });
    //     // If it was aborted
    //     if (previous === 'abort') return;
    //     // Mongo upload must be done in 'await Promise' format. Otherwise, it is prone to fail
    //     return new Promise((resolve, reject) => {
    //     db.collection(collection).insertOne(
    //         updater,
    //         // Callback function
    //             (error, result) => {
    //             // In case the load fails
    //             if (error) {
    //                 console.error(error);
    //                 reject();
    //             }
    //             // In case the load is successfull
    //             else {
    //                 if (append) appended.push(result.insertedId);
    //                 resolve();
    //             }
    //         },
    //     );
    //     });
    // };

    // updateAnticipation('set', { chains: [] })
    // updateAnticipation('push', { files: { filename: dbFilename } })
    // updateAnticipation('push', { files: { filename: filename } })
    // updateAnticipation('push', { analyses: name })

    // Ask mongo to check if the specified data already exists
    // If it does then ask the user if data is to be conserved or overwritten
    // Remove data which is to be duplicated upon user confirmation
    //_forestallUpdate = async (command, updater) => {
    // _forestallUpdate = async (command, updater) => {
    //     // Get the name of the first (and only) key in the updater
    //     const updaterKey = Object.keys(updater)[0];
    //     // Set the name to refer this data when asking the user
    //     let name;
    //     // Set the a path object to find the updater fields
    //     let finder = {};
    //     // If the command is set it means the document must be directly in the project
    //     if (command === 'set') {
    //         name = updaterKey;
    //         finder[updaterKey] = { $exists: true };
    //     }
    //     // If the command is push it means the value or document must be part of an array
    //     else if (command === 'push') {
    //         // In case of 'analyses' and 'chains'
    //         if (typeof updater[updaterKey] === 'string') {
    //             name = updater[updaterKey];
    //             finder = updater;
    //         }
    //         // In case of 'files'
    //         // Here, the updater format is { files: { filename: name }}
    //         // In order to access the filename, we access the first key inside the first key
    //         else {
    //             name = updater[updaterKey].filename;
    //             finder = { [updaterKey]: { $elemMatch: updater[updaterKey] } };
    //         }
    //     } else throw new Error('wrong call');
    //     // Check if the path to the updater already exists in the database
    //     // *** WARNING: Do not use '...updater' instead of '...finder'
    //     // This would make the filter sensible to the whole document
    //     // (i.e. it would filter by each name and value of each field inside the document)
    //     // Thus, it would only ask the user when documents are identical, which is useless
    //     const exist = await db.collection('projects').findOne({ _id: projectIdRef.current, ...finder });
    //     // If does not exist then there is no problem
    //     if (!exist) return true;
    //     // In case it is 'conserve', skip this part
    //     // This is equal to always choosing the 'C' option
    //     if (conserve) return false;
    //     // Find out the collection where the data to delete is placed
    //     // i.e. 'fs.files', 'analyses' or 'chains'
    //     let collection = updaterKey;
    //     if (collection === 'files') collection = 'fs.files';
    //     // The 'set' command would overwrite the existing data
    //     // This is applied to chains
    //     if (command === 'set') {
    //         // Ask the user
    //         const confirm = overwrite
    //         ? '*'
    //         : await userConfirm(
    //             `'${name}' already exists in the project. Confirm data loading:
    //             C - Conserve current data and discard new data
    //             * - Overwrite current data with new data `
    //         );
    //         // Abort the process
    //         if (confirm === 'C') {
    //             console.log(chalk.yellow('New data will be discarded'));
    //             return false;
    //         } else {
    //             console.log(chalk.yellow('Current data will be overwritten'));
    //             spinnerRef.current = getSpinner().start('   Overwritting current data');
    //             // The '$set' command in mongo will override the previous value
    //             await new Promise(resolve => {
    //                 db.collection('projects').findOneAndUpdate(
    //                 { _id: projectIdRef.current },
    //                 { $set: updater },
    //                 err => {
    //                     if (err)
    //                     spinnerRef.current.fail(
    //                         '   Error while setting new data:' + err,
    //                     );
    //                     resolve();
    //                 },
    //                 );
    //             });
    //             // Delete documents related to the overwritten field
    //             await new Promise(resolve => {
    //                 // NEVER FORGET: Although all collections are supported this is only used for chains
    //                 db.collection(collection).deleteMany(
    //                 {
    //                     $or: [
    //                     // 'analyses' and 'chains'
    //                     { project: projectIdRef.current },
    //                     // 'fs.files'
    //                     {
    //                         metadata: { project: projectIdRef.current },
    //                     },
    //                     ],
    //                 },
    //                 // Callback function
    //                 err => {
    //                     if (err)
    //                     spinnerRef.current.fail(
    //                         '   Error while deleting current data:' + err,
    //                     );
    //                     else spinnerRef.current.succeed('   Deleted current data');
    //                     resolve();
    //                 },
    //                 );
    //             });
    //             return true;
    //         }
    //     }
    //     // The 'push' command would NOT override the existing data and just add new data
    //     // This is applied to files and analyses
    //     else if (command === 'push') {
    //         // Ask the user
    //         // In case it is 'overwrite', proceed to delete previous data and load the new one
    //         const confirm = overwrite
    //         ? '*'
    //         : await userConfirm(`'${name}' already exists in the project. Confirm data loading:
    //             C - Conserve current data and discard new data
    //             * - Overwrite current data (delete all duplicates) with new data`);
    //         // Abort the process
    //         if (confirm === 'C') {
    //         console.log(chalk.yellow('New data will be discarded'));
    //         return false;
    //         }
    //         // Continue the process but first delete current data
    //         else {
    //         console.log(chalk.yellow('Current data will be deleted'));
    //         spinnerRef.current = getSpinner().start('   Deleting current data');
    //         // Delete the 'projects' associated data
    //         await new Promise(resolve => {
    //             db.collection('projects').findOneAndUpdate(
    //             { _id: projectIdRef.current },
    //             { $pull: updater },
    //             err => {
    //                 if (err)
    //                 spinnerRef.current.fail(
    //                     '   Error while deleting current data:' + err,
    //                 );
    //                 resolve();
    //             },
    //             );
    //         });
    //         // Delete the current document
    //         await new Promise(resolve => {
    //             // NEVER FORGET: Although all collections are supported this is only used for files and analyses
    //             db.collection(collection).deleteMany(
    //             {
    //                 $or: [
    //                 // 'analyses' and 'chains'
    //                 { project: projectIdRef.current, name: name },
    //                 // 'fs.files'
    //                 {
    //                     'metadata.project': projectIdRef.current,
    //                     filename: name,
    //                 },
    //                 ],
    //             },
    //             // Callback function
    //             err => {
    //                 if (err)
    //                 spinnerRef.current.fail(
    //                     '   Error while deleting current data:' + err,
    //                 );
    //                 else spinnerRef.current.succeed('   Deleted current data');
    //                 resolve();
    //             },
    //             );
    //         });
    //         // Continue the loading process
    //         return true;
    //         }
    //     }
    // };

    // Set a general handler to update the 'projects' collection
    // The 'command' argument stands for the command to be executed by mongo
    // The 'command' argument expects 'set' or 'push' as string
    // The 'updater' argument stands for the changes to be performed in mongo
    // The 'updater' argument expects an object with a single key (e.g. { metadata })
    // _update = async (command, updater) => {
    //     // Mongo upload must be done in 'await Promise' format. Otherwise, it is prone to fail
    //     return new Promise((resolve, reject) => {
    //         db.collection('projects').findOneAndUpdate(
    //         { _id: projectIdRef.current },
    //         { ['$' + command]: updater },
    //         // Callback function
    //         err => {
    //             // In case the load fails
    //             if (err) {
    //             console.error(err);
    //             reject();
    //             }
    //             // In case the load is successfull
    //             else resolve();
    //         },
    //         );
    //     });
    // };

}

module.exports = Database