// Connect to the actual database (MongoDB)
const connectToMongo = require('../utils/connect-to-mongo/index');
// Files system
const fs = require('fs');
// Add colors in console
const chalk = require('chalk');
// This tool converts miliseconds (ms) to a more human friendly string (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// This utility displays in console a dynamic loading status
const getSpinner = require('../utils/get-spinner');
// Function to call constantly to a function with a timer
const throttle = require('lodash.throttle');
// Function to execute command and retrieve output line by line
const readAndParseTrajectory = require('../utils/read-and-parse-trajectory');
// Load auxiliar functions
const {
    userConfirm,
    userConfirmDataLoad,
    getBasename,
    getMimeTypeFromFilename
} = require('../utils/auxiliar-functions');
// Get metadata handlers
const { merge_metadata } = require('./metadata-handlers');

// Constants
const N_COORDINATES = 3; // x, y, z
// Time it takes to the trajectory uploading logs to refresh
const THROTTLE_TIME = 1000; // 1 second
// Time it takes to the trajectory uploading logs to complain if there is no progress
const TIMEOUT_WARNING = 30000; // 30 seconds

// Use regexp to check if 'append' is an accession or an object ID
const accessionFormat = new RegExp('^' + process.env.ACCESSION_PREFIX + '\\d{5}$');

// Set the project class
class Database {
    constructor (client, db, bucket) {
        if (!client) throw new Error('No client');
        if (!db) throw new Error('No database');
        if (!bucket) throw new Error('No bucket');
        // Get database handlers
        this.client = client; // Client is not used by the database, but it is read from the database by others
        this.db = db;
        this.bucket = bucket;
        // Set some collections and list them all together
        this.collections = [];
        for (const [ collectionKey, collectionName ] of Object.entries(this.COLLECTION_NAMES)) {
            this[collectionKey] = db.collection(collectionName);
            this.collections.push(this[collectionKey]);
        }
        // The spinner displays in console a dynamic loading status so it is useful for logs
        // This object saves the access (both read and write) to the spinner methods and variables
        // Since this object is sealed, attributes can be written but not added or deteled
        this.spinnerRef = Object.seal({ current: null });
        // Keep the project ID in case we need to roll back
        // This object is sent empty to the load index.js, which saves a new mongo document on it
        this.project_id = null;
        // Store the current project data once it has been downloaded
        this.project_data = null;
        // Save also the original project data the first time we download it
        this.project_data_backup = null;
        // Keep track of the newly inserted data
        // This way, in case anything goes wrong, we can revert changes
        this.inserted_data = [];
        // Keep track of the currently inserting file
        // This way, in case anything goes wrong, we can delete orphan chunks
        this.currentUploadId = null;
    };

    // ----- Constants -----

    // Set the collection names
    COLLECTION_NAMES = {
        projects: 'projects',
        references: 'references',
        topologies: 'topologies',
        files: 'fs.files',
        chunks: 'fs.chunks',
        analyses: 'analyses',
        chains: 'chains',
        counters: 'counters'
    }

    // ----------------------


    // Set some functions to easily handle the spinner logs
    startLog = message => this.spinnerRef.current = getSpinner().start(message);
    updateLog = message => this.spinnerRef.current.text = message;
    successLog = message => this.spinnerRef.current.succeed(message);
    failLog = message => {
        this.spinnerRef.current.fail(message);
        throw new Error(message);
    }
    get logText () {
        return this.spinnerRef.current.text;
    }
    get logTime () {
        return this.spinnerRef.current.time;
    }
    get isLogRunning () {
        return this.spinnerRef.current && this.spinnerRef.current.running;
    }

    // Get the generic name of a document by the collection it belongs to
    // This is used for displaying only
    nameCollectionDocument = collection => {
        if (collection === this.projects) return 'project';
        if (collection === this.references) return 'reference';
        if (collection === this.topologies) return 'topology';
        if (collection === this.files) return 'file';
        if (collection === this.analyses) return 'analysis';
        if (collection === this.chains) return 'chain';
        if (collection === this.chunks) return 'chunk';
        throw new Error('Not supported collection');
    }

    // Create a new project in the database
    // Set the handler project data accordingly
    createProject = async () => {
        // Create a new project
        // DANI: El mdref está fuertemente hardcodeado, hay que pensarlo
        this.project_data = { accession: null, published: false, mds: [], mdref: 0, files: [] };
        this.startLog(`📝 Adding new database project`);
        // Load the new project
        const result = await this.projects.insertOne(this.project_data);
        // If the operation failed
        if (result.acknowledged === false) return this.failLog(`📝 Failed to add new database project`);
        this.successLog(`📝 Added new database project -> ${result.insertedId}`);
        // Update the project id
        this.project_data._id = result.insertedId;
        this.project_id = result.insertedId;
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new project',
            collection: this.projects,
            id: this.project_id
        });
    }

    // Find an already existing project in the database and set its data as the handler project data
    syncProject = async idOrAccession => {
        // If it is an accession we have to query in a specific format
        // If it is an object id we can directly query with it
        const query = accessionFormat.test(idOrAccession) ? { accession: idOrAccession } : idOrAccession;
        // Find the already existing project in mongo
        this.project_data = await this.projects.findOne(query);
        if (!this.project_data) throw new Error(`No project found for ID/Accession '${idOrAccession}'`);
        this.project_id = this.project_data._id;
    }

    // Update remote project by overwritting it al with current project data
    updateProject = async () => {
        this.startLog(`📝 Updating database project data`);
        // Replace remote project data by local project data
        const result = await this.projects.replaceOne({ _id: this.project_id }, this.project_data);
        if (result.acknowledged === false) return this.failLog('📝 Failed to update database project data');
        this.successLog('📝 Updated database project data');
    };

    // Get a summary of the project contents
    logProjectSummary = async () => {
        console.log(`Project ${this.project_id} summary:`);
        // Show if there is a topology
        const topology = await this.getTopology();
        if (topology) console.log('- Topology');
        // Show the number of chains
        const chains = this.project_data.chains;
        const chainCount = (chains && chains.length) || 0;
        if (chainCount > 0) console.log(`- Chains: ${chainCount}`);
        // Show the number of project files and analyses
        const projectFiles = this.project_data.files;
        const projectFilesCount = (projectFiles && projectFiles.length) || 0;
        if (projectFilesCount > 0) console.log(`- Project files: ${projectFilesCount}`);
        const projectAnalyses = this.project_data.analyses;
        const projectAnalysesCount = (projectAnalyses && projectAnalyses.length) || 0;
        if (projectAnalysesCount > 0) console.log(`- Project analyses: ${projectAnalysesCount}`);
        // Show the number of MDs
        // Get MDs not flagged as removed
        const mds = this.project_data.mds.filter(md => !md.removed);
        const mdCount = (mds && mds.length) || 0;
        if (mdCount > 0) console.log(`- MDs: ${mdCount}`);
        // Show the number of MD files and analyses
        let mdFilesCount = 0;
        let mdAnalysesCount = 0;
        for (const md of mds) {
            const mdFiles = md.files;
            mdFilesCount += (mdFiles && mdFiles.length) || 0;
            const mdAnalyses = md.analyses;
            mdAnalysesCount += (mdAnalyses && mdAnalyses.length) || 0;
        }
        if (mdFilesCount > 0) console.log(`- MD Files: ${mdFilesCount}`);
        if (mdAnalysesCount > 0) console.log(`- MD Analyses: ${mdAnalysesCount}`);
        // In case we produced no output say explicitly that the project is empty
        if (!topology && chainCount === 0 && projectFilesCount === 0 && projectAnalysesCount === 0 &&
            mdCount === 0 && mdFilesCount === 0 && mdAnalysesCount === 0) console.log('  Project is empty');
    }

    // Delete a project
    deleteProject = async () => {
        // Delete all project contents before deleteing the project itself to avoid having orphans in case of interruption
        // Delete the topology
        const topology = await this.getTopology();
        if (topology) await this.deleteTopology();
        // Delete chains
        const chains = this.project_data.chains || [];
        if (chains.length > 0) await this.deleteChains();
        // Delete project files
        const projectFiles = this.project_data.files || [];
        // WARNING: The project files list is truncated as files are deleted and thus we can not iterate over it
        // To avoid this problem we create a new list with project filenames
        const projectFilenames = projectFiles.map(file => file.name);
        for await (const filename of projectFilenames) {
            await this.deleteFile(filename, undefined);
        }
        // Delete project analyses
        const projectAnalyses = this.project_data.analyses || [];
        // WARNING: The project analyses list is truncated as analyses are deleted and thus we can not iterate over it
        // To avoid this problem we create a new list with project analysis names
        const projectAnalysisNames = projectAnalyses.map(analysis => analysis.name);
        for await (const analysisName of projectAnalysisNames) {
            await this.deleteAnalysis(analysisName, undefined);
        }
        // Delete every MD
        for await (const [mdIndex, md] of Object.entries(this.project_data.mds)) {
            // If the MD is flagged as removed then we skip it
            if (md.removed) continue;
            await this.removeMDirectory(mdIndex);
        }
        // Delete the remote project document
        this.startLog(`🗑️ Deleting project ${this.project_id}`);
        const result = await this.projects.deleteOne({ _id: this.project_id });
        if (!result) return this.failLog(`🗑️ Failed to delete project ${this.project_id}`);
        this.successLog(`🗑️ Deleted project ${this.project_id}`);
        // Remove references if they are not used by other projects
        for await (const uniprot of this.project_data.metadata.REFERENCES || []) {
            const used = await this.isReferenceUsed(uniprot);
            if (used === false) await this.deleteReference(uniprot);
        }
    }

    // Add a new MD directory to the current project
    addMDirectory = async name => {
        // Create the new MD object and add it to project data
        const md = { name: name, files: [], analyses: [] };
        this.project_data.mds.push(md);
        // Update the remote
        await this.updateProject();
    }

    // Remove an existing MD directory
    // Note that MDs are handled thorugh indices so we can not simply remove an MD object from the project MDs list
    // Instead we remove its content and add a tag to mark it as removed
    removeMDirectory = async mdIndex => {
        // Delete all MD contents before deleteing the project itself to avoid having orphans in case of interruption
        const md = this.project_data.mds[mdIndex];
        // Delete MD files
        const mdFiles = md.files || [];
        // WARNING: The MD files list is truncated as files are deleted and thus we can not iterate over it
        // To avoid this problem we create a new list with MD filenames
        const mdFilenames = mdFiles.map(file => file.name);
        for await (const filename of mdFilenames) {
            await this.deleteFile(filename, mdIndex);
        }
        // Delete MD analyses
        const mdAnalyses = md.analyses || [];
        // WARNING: The MD analyses list is truncated as analyses are deleted and thus we can not iterate over it
        // To avoid this problem we create a new list with MD analysis names
        const mdAnalysisNames = mdAnalyses.map(analysis => analysis.name);
        for await (const analysisName of mdAnalysisNames) {
            await this.deleteAnalysis(analysisName, mdIndex);
        }
        // Replace the current MD object with a new object which conserves the name and is flagged as 'removed'
        console.log(`MD ${md.name} will be flagged as removed`);
        const residualMD = { name: md.name, removed: true };
        this.project_data.mds[mdIndex] = residualMD
        // Update the remote
        await this.updateProject();
    }

    // Add a new reference in the references collection in case it does not exist yet
    loadReference = async reference => {
        // Check if the reference is already in the database and, if so, skip the load
        const current = await this.references.findOne({ uniprot: reference.uniprot });
        if (current) return console.log(chalk.grey(`Reference ${reference.uniprot} is already in the database`));
        this.startLog(`💽 Loading reference ${reference.uniprot}`);
        // Load the new reference
        const result = await this.references.insertOne(reference);
        // If the operation failed
        if (result.acknowledged === false) return this.failLog(`💽 Failed to load reference ${reference.uniprot}`);
        this.successLog(`💽 Loaded reference ${reference.uniprot}`);
        console.log(chalk.green(`  Loaded new reference ${reference.uniprot} -> ${result.insertedId}`));
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new reference',
            collection: this.references,
            id: result.insertedId
        });
    };

    // Check if a reference is still under usage
    // i.e. there is at least one project using it
    isReferenceUsed = async uniprot => {
        const projects = await this.projects.count({ 'metadata.REFERENCES': uniprot });
        if (projects === 0) return false;
        return true;
    }

    // Delete a reference
    deleteReference = async uniprot => {
        this.startLog(`🗑️ Deleting referece ${uniprot}`);
        const result = await this.references.deleteOne({ uniprot: uniprot });
        if (!result) return this.failLog(`🗑️ Failed to delete referece ${uniprot}`);
        this.successLog(`🗑️ Deleted referece ${uniprot}`);
    }

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
        await this.deleteChains();
        return true;
    };

    // Load a new chain
    // WARNING: Note that this function will not check for previously existing chains with identical letter
    // WARNING: This is done previously by the forestallChainsUpdate function
    loadChain = async chainContent => {
        // Upload the new topology
        this.startLog(`💽 Loading chain ${chainContent.name}`);
        const result = await this.chains.insertOne(chainContent);
        if (result.acknowledged === false) return this.failLog(`💽 Failed to load chain ${chainContent.name}`);
        this.successLog(`💽 Loaded chain ${chainContent.name}`);
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new chain',
            collection: this.chains,
            id: result.insertedId
        });
    };

    // Delete all current project chains
    deleteChains = async () => {
        this.startLog(`🗑️ Deleting chains`);
        // Delete previous chains
        const result = await this.chains.deleteMany({ project: this.project_id });
        if (result.acknowledged === false) return this.failLog(`🗑️ Failed to delete chains`);
        this.successLog(`🗑️ Deleted chains`);
        // Set project data chains as an empty list
        this.project_data.chains = [];
        await this.updateProject();
    };

    // Set a handler to update metadata
    // If no MD directory is passed then update project metadata
    updateProjectMetadata = async (newMetadata, conserve, overwrite) => {
        // Get current metadata
        // Note that project metadata is in a field called 'metadata'
        const previousMetadata = this.project_data.metadata;
        // If there is no metadata then simply add it
        if (!previousMetadata) {
            this.project_data.metadata = newMetadata;
            await this.updateProject();
            return;
        }
        // If there is an already existing metadata then we modify it and send it back to mongo
        // WARNING: Note that values in current metadata which are missing in new metadata will remain
        // This makes sense since we are 'appending' new data
        const changed = await merge_metadata(previousMetadata, newMetadata, conserve, overwrite);
        // If there were no changes in metadata then there is no need to update remote project data
        if (!changed) return console.log(chalk.grey(`Project metadata is already up to date`));
        // Finally, load the modified current metadata object into mongo
        await this.updateProject();
    };


    // Set a handler to update metadata
    // If no MD directory is passed then update project metadata
    updateMdMetadata = async (newMetadata, mdIndex, conserve, overwrite) => {
        // Get current metadata
        // Note that MD metadata is in every MD object
        const mdData = this.project_data.mds[mdIndex];
        // At this point metadata should exist
        if (!mdData) throw new Error(`MD with index ${mdIndex} does not exist`);
        // Update the MD object with the MD metadata
        const changed = await merge_metadata(mdData, newMetadata, conserve, overwrite);
        // If there were no changes in metadata then there is no need to update remote project data
        if (!changed) return console.log(chalk.grey(`MD metadata is already up to date`));
        // Finally, load the new mds object into mongo
        await this.updateProject();
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
        await this.deleteTopology();
        return true;
    };

    // Set handler to update the topologies collection, which is not coordinated with 'projects'
    // Check if there is already a loaded value different from the the new value to warn the user
    loadTopology = async (newTopology, conserve, overwrite) => {
        // Anticipate the load and delete previous topology if necessary
        const userConsent = await this.forestallTopologyLoad(newTopology, conserve, overwrite);
        if (!userConsent) return;
        this.startLog(`💽 Loading topology data`);
        // Upload the new topology
        const result = await this.topologies.insertOne(newTopology);
        if (result.acknowledged === false) return this.failLog(`💽 Failed to load new topology data`);
        this.successLog(`💽 Loaded new topology data -> ${result.insertedId}`);
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: 'new topology',
            collection: this.topologies,
            id: result.insertedId
        });
    };

    // Get the current project topology
    getTopology = async () => {
        return await this.topologies.findOne({ project: this.project_id });
    }

    // Delete the current project topology
    deleteTopology = async () => {
        this.startLog(`🗑️ Deleting topology data`);
        const result = await this.topologies.deleteOne({ project: this.project_id });
        if (!result) return this.failLog(`🗑️ Failed to delete topology data`);
        this.successLog(`🗑️ Deleted topology data`);
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

    // Load a file using the mongo gridfs bucket
    loadFile = async (filename, mdIndex, sourceFilepath, abort) => {
        // Wrap all this function inside a promise which is resolved by the stream
        await new Promise((resolve, reject) => {
            // Start the logs
            this.startLog(`💽 Loading new file: ${filename}`);
            // Create variables to track the ammount of data to be passed and already passed
            const totalData = fs.statSync(sourceFilepath).size;
            let currentData = 0;
            // Start reading the file by streaming
            const readStream = fs.createReadStream(sourceFilepath);
            // Open the mongo writable stream with a few customized options
            // All data uploaded to mongo by this way is stored in fs.chunks
            // fs.chunks is a default collection of mongo which is managed internally
            const uploadStream = this.bucket.openUploadStream(filename, {
                // Check that the file format is accepted. If not, change it to "octet-stream"
                contentType: getMimeTypeFromFilename(filename),
                metadata: { project: this.project_id, md: mdIndex },
                chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
            });
            // The resulting id of the current upload stream is saved as an environment variable
            // In case of abort, this id is used by the automatic cleanup to find orphan chunks
            this.currentUploadId = uploadStream.id;
            // Promise is not resolved if the readable stream returns error
            readStream.on('error', () => {
                const progress = Math.round((currentData / totalData) * 10000) / 100;
                this.failLog(`💽 Failed to load file ${databaseFilename} -> ${uploadStream.id} at ${progress} %`);
                reject();
            });
            // Output the percentaje of data already loaded to the logs
            readStream.on('data', async data => {
                // Sum the new data chunk number of bytes
                currentData += data.length;
                // Calculate the progress rounded to 2 decimals
                const progress = Math.round((currentData / totalData) * 10000) / 100;
                // Calculate the amount of time we have been loading the file
                const time = prettyMs(Date.now() - this.logTime);
                // Update the logs
                this.updateLog(`💽 Loading file ${filename} -> ${uploadStream.id}\n  at ${progress} % (in ${time})`);
                // Pause and wait for the callback to resume
                readStream.pause();
                // Check that local buffer is sending data out before continue to prevent memory leaks
                uploadStream.write(data, 'utf8', async () => {
                    await abort();
                    readStream.resume();
                });
                // At the end
                if (currentData / totalData === 1) {
                    uploadStream.end(() => {
                        // Display it through the logs
                        this.successLog(`💽 Loaded file [${filename} -> ${uploadStream.id}] (100 %)`);
                        resolve();
                    });
                }
            });
        });
        // Check the new file has been added
        const result = await this.files.findOne({ _id: this.currentUploadId });
        if (result === null) throw new Error(`File not found`);
        // Update project data as the new file has been loaded
        await this._addProjectFile(filename, mdIndex, this.currentUploadId);
        // Remove this id from the current upload id
        this.currentUploadId = null;
    }

    // Load a file using the mongo gridfs bucket
    loadTrajectoryFile = async (filename, mdIndex, sourceFilepath, gromacsCommand, abort) => {
        // Get the filename alone, without the whole path, for displaying
        const basename = getBasename(sourceFilepath);
        // Display the start of this process in console
        this.startLog(`💽 Loading trajectory file '${basename}' as '${filename}'`);
        // Track the current frame
        let frameCount = 0;
        let timeoutID;
        // This throttle wrap makes the function not to be called more than once in a time range (1 second)
        const updateLogs = throttle(() => {
            // Update logs periodically to show the user the time taken for the running process
            const timeTaken = prettyMs(Date.now() - this.logTime);
            this.updateLog(`💽 Loading trajectory file '${basename}' as '${filename}' [${
                this.currentUploadId}]\n (frame ${frameCount} in ${timeTaken})`);
            // Warn user if the process is stuck
            // "setTimeout" and "clearTimeout" are node built-in functions
            // "clearTimeout" cancels the timeout (only if is is already set, in this case)
            if (timeoutID) clearTimeout(timeoutID);
            // "setTimeout" executes a function after a specific amount of time
            // First argument is the function to be executed and the second argument is the time
            // In this case, a warning message is added to the logs after 30 seconds
            timeoutID = setTimeout(() => {
                const message = ' ⚠️  Timeout warning: nothing happened in the last 30 seconds.';
                this.updateLog(`${this.logText} ${chalk.yellow(message)}`);
            }, TIMEOUT_WARNING);
        }, THROTTLE_TIME);
        // Set a function which adds one to to the frame counter
        // This function is then passed to the trajectory reader/parser
        const addOneFrame = () => {
            frameCount += 1
            updateLogs();
        };
        await new Promise(async (resolve, reject) => {
            // Set initial metadata for the file document
            const metadata = { project: this.project_id, md: mdIndex };
            // Open an upload stream to mongo
            // All data uploaded to mongo by this way is stored in fs.chunks
            // fs.chunks is a default collection of mongo which is managed internally
            const uploadStream = this.bucket.openUploadStream(filename, {
                contentType: 'application/octet-stream',
                metadata: metadata,
                chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
            });
            // The resulting id of the current upload stream is saved as an environment variable
            // In case of abort, this id is used by the automatic cleanup to find orphan chunks
            this.currentUploadId = uploadStream.id;
            // If there is an error then display the end of this process as failure in console
            uploadStream.on('error', error => {
                this.failLog(error);
                reject();
            });
            // This function is equivalent to openning a new terinal and typing this:
            // gmx dump -f path/to/trajectory
            // This assembly runs Gromacs as a paralel process which returns an output in string chunks
            // These strings are converted in standarized "lines"
            const trajectoryCoordinates = readAndParseTrajectory(sourceFilepath, gromacsCommand, addOneFrame, abort);
            // Set a timeout
            let timeout;
            // Iterate over buffers of binary coordinates
            for await (const coordinates of trajectoryCoordinates) {
                // In case of overload stop writing streams and wait until the drain is resolved
                const keepGoing = uploadStream.write(coordinates);
                if (!keepGoing) {
                    // Stop the loop here until the drain signal is sent
                    await new Promise(next => uploadStream.once('drain', next));
                    // Once passed, we remove the timeout
                    if (timeout) clearTimeout(timeout);
                }
            }
            // Update the logs
            updateLogs.cancel();
            if (timeoutID) clearTimeout(timeoutID);
            this.updateLog(`💽 All trajectory frames loaded (${frameCount}). Waiting for Mongo...`);
            // Wait until one of the endings has ended and stop any reamining timeout
            uploadStream.end(async () => {
                // Remove the timeout
                if (timeout) clearTimeout(timeout);
                // Display the end of this process as success in console
                this.successLog(
                    `💽 Loaded trajectory file '${basename}' as '${filename}' [${uploadStream.id}]\n(${frameCount} frames)`);
                // Add the number of frames to the matadata object
                metadata.frames = frameCount;
                // Calculate the number of atoms in the loaded trajectory and add it to the metadata object
                metadata.atoms = uploadStream.length / frameCount / Float32Array.BYTES_PER_ELEMENT / N_COORDINATES;
                // Updated the recently created file document with additional metadata
                const result = await this.files.findOneAndUpdate({ _id: uploadStream.id }, { $set: { metadata: metadata } });
                // If the operation failed then warn the user
                if (result.acknowledged === false) throw new Error(`Failed to update file data`);
                if (result.value === null) throw new Error(`File not found`);
                resolve();
            });
        });
        // Update project data as the new file has been loaded
        await this._addProjectFile(filename, mdIndex, this.currentUploadId);
        // Remove this id from the current upload id
        this.currentUploadId = null;
    }

    // Update the project to register that a file has been loaded
    // WARNING: Note that this function will not check for previously existing file with identical name
    // WARNING: This should be done by the forestallFileLoad function previously
    _addProjectFile = async (filename, mdIndex, id) => {
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

    // Delete a file both from fs.files / fs.chunks and from the project data
    deleteFile = async (filename, mdIndex) => {
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Find the file summary
        const currentFile = availableFiles.find(file => file.name === filename);
        if (!currentFile) throw new Error(`File ${filename} is not in the available files list (MD index ${mdIndex})`);
        this.startLog(`🗑️  Deleting file ${filename} <- ${currentFile.id}`);
        // Delete the file from fs.files and its chunks from fs.chunks using the file id
        // GridFSBucket.delete has no callback but when it fails (i.e. file not found) it kills the process
        // https://mongodb.github.io/node-mongodb-native/6.3/classes/GridFSBucket.html#delete
        await this.bucket.delete(currentFile.id);
        this.successLog(`🗑️  Deleted file ${filename} <- ${currentFile.id}`);
        // Remove the current file entry from the files list and update the project
        const fileIndex = availableFiles.indexOf(currentFile);
        availableFiles.splice(fileIndex, 1);
        await this.updateProject();
    }

    // Rename a file, both in the files collection and in project data
    renameFile = async (filename, mdIndex, newFilename) => {
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Find the file summary
        const currentFile = availableFiles.find(file => file.name === filename);
        if (!currentFile) throw new Error(`File ${filename} is not in the available files list (MD index ${mdIndex})`);
        this.startLog(`📝 Renaming file ${filename} from MD with index ${mdIndex} (${currentFile.id}) as ${newFilename}`);
        // Update filename in the files collection document
        const result = await this.files.findOneAndUpdate({ _id: currentFile.id }, { $set: { filename: newFilename }});
        if (result.acknowledged === false) return this.failLog(`📝 Failed to renamed file ${filename} from MD with index ${mdIndex} (${currentFile.id}) as ${newFilename}`);
        this.successLog(`📝 Renamed file ${filename} from MD with index ${mdIndex} (${currentFile.id}) as ${newFilename}`);
        // Rename the file object name and update the project
        currentFile.name = newFilename;
        await this.updateProject();
    }

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
        await this.deleteAnalysis(name, mdIndex);
        return true;
    };

    // Load a new analysis
    // The analysis object contains a name and a value (the actual content)
    // In this function we also asign the project and the md index
    // WARNING: Note that this function will not check for previously existing analysis with identical name
    // WARNING: This is done previously by the forestallAnalysisLoad function
    loadAnalysis = async (analysis, mdIndex) => {
        analysis.project = this.project_id;
        analysis.md = mdIndex;
        this.startLog(`💽 Loading analysis ${analysis.name}`);
        // Insert a new document in the analysis collection
        const result = await this.analyses.insertOne(analysis);
        if (result.acknowledged === false) return this.failLog(`💽 Failed to load analysis ${analysis.name}`);
        this.successLog(`💽 Loaded analysis ${analysis.name} -> ${result.insertedId}`);
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        // Update the project to register that an analysis has been loaded
        availableAnalyses.push({ name: analysis.name, id: result.insertedId });
        await this.updateProject();
        // Update the inserted data in case we need to revert the change
        this.inserted_data.push({
            name: analysis.name + ' analysis',
            collection: this.analyses,
            id: result.insertedId
        });
    }

    // Delete an analysis both from its collection and from the project data
    deleteAnalysis = async (name, mdIndex) => {
        // Get the current analysis entry analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        const currentAnalysis = availableAnalyses.find(analysis => analysis.name === name);
        if (!currentAnalysis) throw new Error(`Analysis ${name} is not in the available analyses list (MD index ${mdIndex})`);
        this.startLog(`🗑️ Deleting analysis ${name} (MD index ${mdIndex})`);
        // Delete the current analysis from the database
        const result = await this.analyses.deleteOne({
            name: name,
            project: this.project_id,
            md: mdIndex
        });
        if (!result) this.failLog(`🗑️ Failed to delete analysis ${name} (MD index ${mdIndex})`);
        this.successLog(`🗑️ Deleted analysis ${name} from MD with index ${mdIndex} <- ${currentAnalysis.id}`);
        // Remove the current analysis entry from the analyses list and update the project
        const analysisIndex = availableAnalyses.indexOf(currentAnalysis);
        availableAnalyses.splice(analysisIndex, 1);
        await this.updateProject();
    }

    // Unload things loaded in the database during the last run
    revertLoad = async (confirmed = false) => {
        // Check if any data was loaded
        // If not, there is no point in asking the user
        if (this.inserted_data.length === 0) return;
        // Stop the logs if it they are still alive
        if (this.isLogRunning) this.failLog(`Interrupted while doing: ${this.logText}`);
        // Ask the user if already loaded data is to be conserved or cleaned up
        const confirm = confirmed || await userConfirm(
            `There was some problem and load has been aborted. Confirm further instructions:
            C - Conserve already loaded data
            * - Delete already loaded data`);
        // If data is to be conserved there is nothing to do here
        if (confirm === 'C') return;
        // Delete inserted data one by one
        for (const data of this.inserted_data) {
            const collection = data.collection;
            if (collection === this.files) {
                console.log('allright its a file');
                await this.bucket.delete(currentFile.id);
            } 
            else {
                const result = await data.collection.deleteOne({ _id: data.id });
                if (result.acknowledged === false) throw new Error(`Failed to delete ${data.name}`);
            }
            console.log(`🗑️ Deleted ${data.name} <- ${data.id}`);
        }
    };

    // Cleanup functions -------------------------

    // Given an id, find the document and the collection it belongs to
    findId = async id => {
        // Iterate over all collections until we find the id
        for await (const collection of this.collections) {
            const document = await collection.findOne({ _id: id });
            if (document) return { document, collection };
        }
        // If there was no result then null is returned
        return null;
    }

}

// Connect to the database
// Then construct and return the database handler
const getDatabase = async () => {
    const { client, db, bucket } = await connectToMongo();
    return new Database(client, db, bucket);
};

module.exports = getDatabase