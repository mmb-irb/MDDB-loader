// Load auxiliar functions
const {
    userConfirm,
    userConfirmDataLoad,
    mdNameToDirectory,
    getBasename
} = require('../utils/auxiliar-functions');
// Add colors in console
const chalk = require('chalk');
// This utility displays in console a dynamic loading status
const getSpinner = require('../utils/get-spinner');

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
        this.project_data = null;
        // Save also the original project data the first time we download it
        this.project_data_backup = null;
        // Keep track of the newly inserted data
        // This way, in case anything goes wrong, we can revert changes
        this.inserted_data = []
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
    get analyses () {
        return this.db.collection('analyses');
    }
    get chains () {
        return this.db.collection('chains');
    }

    // Set the database project
    // If a mongo id or accession is passed then we check the project exists
    setupProject = async (idOrAccession, mdDirectories = []) => {
        // Parse the full md
        const mdDirectoryBasenames = mdDirectories.map(directory => getBasename(directory));
        // If an ID was passed (i.e. the project already exists in the database)
        if (idOrAccession) {
            // Use regexp to check if 'append' is an accession or an object ID
            const accessionFormat = new RegExp('^' + process.env.ACCESSION_PREFIX + '\\d{5}$');
            // If it is an accession we have to query in a specific format
            // If it is an object id we can directly query with it
            const query = accessionFormat.test(idOrAccession) ? { accession: idOrAccession } : idOrAccession;
            // Find the already existing project in mongo
            this.project_data = await this.projects.findOne(query);
            if (!this.project_data) throw new Error(`No project found for ID/Accession '${idOrAccession}'`);
            this.project_id = this.project_data._id;
            // Display the project id. It may be useful if the load is abruptly interrupted to clean
            console.log(chalk.cyan(`== new data will be added to project '${this.project_id}'`));
        }
        // If no ID was passed (i.e. the project is not yet in the database)
        else {
            // Set MD names from the available MD directories
            const mds = mdDirectoryBasenames.map(directory => {
                const mdName = directory.replaceAll('_', ' ');
                return { name: mdName, files: [], analyses: [] }
            })
            // Create a new project
            // 'insertedId' is a standarized name inside the returned object. Do not change it.
            // DANI: El mdref está fuertemente hardcodeado, hay que pensarlo
            this.project_data = { accession: null, published: false, mds: mds, mdref: 0, files: [] };
            // Load the new project
            const result = await this.projects.insertOne(this.project_data);
            // If the operation failed
            if (result.acknowledged === false) throw new Error(`Failed to insert new project`);
            // Update the project id
            this.project_data._id = result.insertedId;
            this.project_id = result.insertedId;
            // Update the inserted data in case we need to revert the change
            this.inserted_data.push({
                name: 'new project',
                collection: this.projects,
                id: this.project_id
            });
            // Display the project id. It may be useful if the load is abruptly interrupted to clean
            console.log(chalk.cyan(`== new project will be stored with the id '${this.project_id}'`));
        }
        // Set MD directory names and indices from project data
        this.md_directory_names = {};
        this.md_directory_indices = {};
        this.project_data.mds.forEach((md, index) => {
            const name = md.name;
            const directory = mdNameToDirectory(name);
            if (mdDirectoryBasenames.includes(directory)) {
                this.md_directory_names[directory] = name;
                this.md_directory_indices[directory] = index;
            }
        });
        // Check the number of MD names and MD directories match
        // This could mean MD names are so similar that they lead to identical directory name or vice versa
        if (mdDirectories.length !== Object.keys(this.md_directory_names).length)
            throw new Error('Number of MD names and MD directories must match');
    }

    // Update remote project by overwritting it al with current project data
    updateProject = async () => {
        const result = await this.projects.replaceOne({ _id: this.project_id }, this.project_data);
        if (result.acknowledged === false) throw new Error('Failed to update current project');
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
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new reference',
            collection: this.references,
            id: result.insertedId
        });
    };

    // Anticipate chains update
    // Note that chains are updated (i.e. deleted and loaded) all together
    forestallChainsUpdate = async (conserve = false, overwrite = false) => {
        // Find the current chains value
        const currentChains = this.project_data.chains;
        // If there is no current value then there is no problem
        if (!currentChains) return true;
        // In case it is 'conserve', skip this part
        // This is equal to always choosing the 'C' option
        if (conserve) return false;
        // Ask the user in case the overwrite flag was not passed
        const confirm = overwrite ? true : await userConfirmDataLoad('Chains');
        // If there was no confirmation then abort the process
        if (!confirm) return false;
        // If we had confirmation then proceed to delete current data
        // Set chains as an empty list
        const updateResult = this.projects.findOneAndUpdate(
            // Find current project by its id
            { _id: this.project_id },
            // The '$set' command in mongo will override the previous value
            { $set: { chains: [] } });
        // If the operation failed
        if (updateResult.acknowledged === false) throw new Error(`Failed to update project data`);
        // Delete previous chains
        const deleteResults = this.chains.deleteMany({ project: this.project_id });
        console.log(deleteResults);
        if (!deleteResults) throw new Error(`Failed to delete previous data in chains collection`);
        return true;
    };

    // Load a new chain
    // WARNING: Note that this function will not check for previously existing chains with identical letter
    // WARNING: This is done previously by the forestallChainsUpdate function
    loadChain = async chainContent => {
        // Upload the new topology
        const result = await this.chains.insertOne(chainContent);
        if (result.acknowledged === false) throw new Error(`Failed to insert new chain`);
        //console.log(chalk.green(`  Loaded new chain -> ${result.insertedId}`));
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new chain',
            collection: this.chains,
            id: result.insertedId
        });
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
        const currentMetadata = this.project_data.metadata;
        // If there is no metadata then simply add it
        if (!currentMetadata) {
            this.project_data.metadata = newMetadata;
            await this.updateProject();
            return console.log(chalk.green('   Done'));
        }
        // If there is an already existing metadata then we modify it and send it back to mongo
        // WARNING: Note that values in current metadata which are missing in new metadata will remain
        // This is makes sense since we are 'appending' new data
        await this._merge_metadata(currentMetadata, newMetadata, conserve, overwrite);
        this.project_data.metadata = currentMetadata;
        // Finally, load the modified current metadata object into mongo
        await this.updateProject();
        console.log(chalk.green('   Done'));
    };


    // Set a handler to update metadata
    // If no MD directory is passed then update project metadata
    updateMdMetadata = async (newMetadata, mdIndex, conserve, overwrite) => {
        console.log('Loading MD metadata');
        // Get current metadata
        // Note that MD metadata is in every MD object
        const mdData = this.project_data.mds[mdIndex];
        // At this point metadata should exist
        if (!mdData) throw new Error(`MD with index ${mdIndex} does not exist`);
        // Update the MD object with the MD metadata
        await this._merge_metadata(mdData, newMetadata, conserve, overwrite);
        this.project_data.mds[mdIndex] = mdData;
        // Finally, load the new mds object into mongo
        await this.updateProject();
        console.log(chalk.green('   Done'));
    };

    // Check if there is a previous document already saved
    // If so, check if we must delete it or conserve it
    forestallTopologyLoad = async (newTopology, conserve, overwrite) => {
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
        // If the user has asked to conserve current data then abort the process
        if (!confirm) return false;
        // We must delete the current document in mongo
        const result = await db.collection(collection).deleteOne({ project: projectIdRef.current });
        console.log(result);
        if (!result) throw new Error(`Failed to remove previous topology`);
        return true;
    };

    // Set handler to update the topologies collection, which is not coordinated with 'projects'
    // Check if there is already a loaded value different from the the new value to warn the user
    loadTopology = async (newTopology, conserve, overwrite) => {
        // Anticipate the load and delete previous topology if necessary
        const userConsent = await this.forestallTopologyLoad(newTopology, conserve, overwrite);
        if (!userConsent) return;
        // Upload the new topology
        const result = await this.topologies.insertOne(newTopology);
        if (result.acknowledged === false) throw new Error(`Failed to insert new topology`);
        console.log(`Loaded new topology -> ${result.insertedId}`);
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new topology',
            collection: this.topologies,
            id: result.insertedId
        });
    };

    // Get the MD index corresponding list of available files
    getAvailableFiles = mdIndex => mdIndex === undefined
        ? this.project_data.files
        : this.project_data.mds[mdIndex].files;

    // Check if there is a previous file with the same name
    // If so, check if we must delete it or conserve it
    forestallFileLoad = async (filename, mdIndex, conserve, overwrite) => {
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        const alreadyExistingFile = availableFiles.find(file => file.name === filename);
        // If the new file is not among the current files then there is no problem
        if (!alreadyExistingFile) return true;
        // In case it exists and the 'conserve' flag has been passed we end here
        if (conserve) return false;
        // Note that here we do not check if files are identical since they may be huge
        // Ask the user in case the 'overwrite' flag has not been passed
        const confirm = overwrite ? true : await userConfirmDataLoad(filename + ' file');
        // If the user has asked to conserve current data then abort the process
        if (!confirm) return false;
        // Delete the current file from the database
        await this.deleteFile(filename, mdIndex);
        return true;
    };

    // Delete a file both from fs.files / fs.chunks and from the project data
    deleteFile = async (filename, mdIndex) => {
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Find the file summary
        const currentFile = availableFiles.find(file => file.name === filename);
        if (!currentFile) throw new Error(`File ${filename} is not in the available files list`);
        console.log(`Deleting file ${filename} from MD with index ${mdIndex} <- ${currentFile.id}`);
        // Delete the file from fs.files and its chunks from fs.chunks using the file id
        // GridFSBucket.delete has no callback but when it fails (i.e. file not found) it kills the process
        // https://mongodb.github.io/node-mongodb-native/6.3/classes/GridFSBucket.html#delete
        await this.bucket.delete(currentFile.id);
        // Remove the current file entry from the files list and update the project
        const fileIndex = availableFiles.indexOf(currentFile);
        availableFiles.splice(fileIndex, 1);
        await this.updateProject();
    }

    // Update the project to register that a file has been loaded
    // WARNING: Note that this function will not check for previously existing file with identical name
    // WARNING: This is done previously by the forestallFileLoad function
    setLoadedFile = async (filename, mdIndex, id) => {
        console.log(`Updating project with the load of ${filename} file`);
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Add the new file to the list and update the remote project
        availableFiles.push({ name: filename, id: id });
        await this.updateProject();
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: filename + ' file',
            collection: this.files,
            id: id
        });
    };

    // Get the MD index corresponding list of available analyses
    getAvailableAnalyses = mdIndex => mdIndex === undefined
        ? this.project_data.analyses
        : this.project_data.mds[mdIndex].analyses;

    // Check if there is a previous analysis with the same name
    // If so, check if we must delete it or conserve it
    // DANI: En teoría no existen los análisis de proyecto, pero le doy soporte porque me los pedirán pronto (imagino)
    forestallAnalysisLoad = async (name, mdIndex, conserve, overwrite) => {
        // Check the current available analyses
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        const alreadyExistingAnalysis = availableAnalyses.find(analysis => analysis.name === name);
        // If the new analysis is not among the current analyses then there is no problem
        if (!alreadyExistingAnalysis) return true;
        // In case it exists and the 'conserve' flag has been passed we end here
        if (conserve) return false;
        // Note that here we do not check if analyses are identical since they may be huge
        // Ask the user in case the 'overwrite' flag has not been passed
        const confirm = overwrite ? true : await userConfirmDataLoad(name + ' analysis');
        // If the user has asked to conserve current data then abort the process
        if (!confirm) return false;
        // Delete the current analysis from the database
        this.deleteAnalysis(analysis.name, mdIndex);
        return true;
    };

    // Delete an analysis both from its collection and from the project data
    deleteAnalysis = async (name, mdIndex) => {
        console.log(`Deleting file ${name} from MD with index ${mdIndex}`);
        // Delete the current analysis from the database
        const result = await this.analyses.deleteOne({
            name: name,
            project: this.project_id,
            md: mdIndex
        });
        if (!result) throw new Error(`Failed to remove previous analysis`);
        // Remove the current analysis entry from the analyses list and update the project
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        const currentAnalysis = availableAnalyses.find(analysis => analysis.name === name);
        const analysisIndex = availableAnalyses.indexOf(currentAnalysis);
        availableAnalyses.splice(analysisIndex, 1);
        await this.updateProject();
    }

    // Load a new analysis
    // The analysis object contains a name and a value (the actual content)
    // In this function we also asign the project and the md index
    // WARNING: Note that this function will not check for previously existing analysis with identical name
    // WARNING: This is done previously by the forestallAnalysisLoad function
    loadAnalysis = async (analysis, mdIndex) => {
        this.spinnerRef.current = getSpinner().start(`Loading analysis ${analysis.name}`);
        analysis.project = this.project_id;
        analysis.md = mdIndex;
        // Insert a new document in the analysis collection
        const result = await this.analyses.insertOne(analysis);
        if (result.acknowledged === false) throw new Error('Failed to load analysis');
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        // Update the project to register that an analysis has been loaded
        availableAnalyses.push({ name: analysis.name, id: result.insertedId });
        await this.updateProject();
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: analysis.name + ' analysis',
            collection: this.analyses,
            id: id
        });
        this.spinnerRef.current.succeed(`Loaded analysis ${analysis.name} -> ${result.insertedId}`);
    }

    // Unload things loaded in the database during the last run
    revertLoad = async () => {
        // Ask the user if already loaded data is to be conserved or cleaned up
        const confirm = await userConfirm(
            `There was some problem and load has been aborted. Confirm further instructions:
            C - Conserve already loaded data
            * - Delete already loaded data`);
        // If data is to be conserved there is nothing to do here
        if (confirm === 'C') return;
        // Delete inserted data one by one
        for (const data of this.inserted_data) {
            console.log(`Deleting ${data.name} <- ${data.id}`);
            const result = await data.collection.deleteOne({ _id: data.id });
            if (result.acknowledged === false) throw new Error(`Failed to delete ${data.name}`);
        }
    };

}

module.exports = Database