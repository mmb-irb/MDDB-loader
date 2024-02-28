// Files system
const fs = require('fs');
// This utility displays in console a dynamic loading status
const logger = require('../../utils/logger');
// Add colors in console
const chalk = require('chalk');
// This tool converts miliseconds (ms) to a more human friendly string (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// Function to call constantly to a function with a timer
const throttle = require('lodash.throttle');
// Function to execute command and retrieve output line by line
const readAndParseTrajectory = require('../../utils/read-and-parse-trajectory');
// Load auxiliar functions
const {
    userConfirmDataLoad,
    getBasename,
    getMimeTypeFromFilename
} = require('../../utils/auxiliar-functions');
// Get metadata handlers
const { merge_metadata } = require('./metadata-handlers');

// Constants
const N_COORDINATES = 3; // x, y, z
// Time it takes to the trajectory uploading logs to refresh
const THROTTLE_TIME = 1000; // 1 second
// Time it takes to the trajectory uploading logs to complain if there is no progress
const TIMEOUT_WARNING = 30000; // 30 seconds

// Set the project class
class Project {
    constructor (data, database) {
        // Store the current project data
        this.data = data;
        this.id = this.data._id;
        // Store the database handler
        this.database = database;
        // Keep track of the currently inserting file
        // This way, in case anything goes wrong, we can delete orphan chunks
        this.currentUploadId = null;
    };

    // Update remote project data by overwritting it all with current project data
    updateRemote = async () => {
        logger.startLog(`📝 Updating database project data`);
        // Replace remote project data by local project data
        const result = await this.database.projects.replaceOne({ _id: this.id }, this.data);
        if (result.acknowledged === false) return logger.failLog('📝 Failed to update database project data');
        logger.successLog('📝 Updated database project data');
    };

    // Get a summary of the project contents
    logProjectSummary = async () => {
        console.log(`Project ${this.id} summary:`);
        // Show if there is a topology
        const topology = await this.getTopology();
        if (topology) console.log('- Topology');
        // Show the number of chains
        const chains = this.data.chains;
        const chainCount = (chains && chains.length) || 0;
        if (chainCount > 0) console.log(`- Chains: ${chainCount}`);
        // Show the number of project files and analyses
        const projectFiles = this.data.files;
        const projectFilesCount = (projectFiles && projectFiles.length) || 0;
        if (projectFilesCount > 0) console.log(`- Project files: ${projectFilesCount}`);
        const projectAnalyses = this.data.analyses;
        const projectAnalysesCount = (projectAnalyses && projectAnalyses.length) || 0;
        if (projectAnalysesCount > 0) console.log(`- Project analyses: ${projectAnalysesCount}`);
        // Show the number of MDs
        // Get MDs not flagged as removed
        const mds = this.data.mds.filter(md => !md.removed);
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
        const chains = this.data.chains || [];
        if (chains.length > 0) await this.deleteChains();
        // Delete project files
        const projectFiles = this.data.files || [];
        // WARNING: The project files list is truncated as files are deleted and thus we can not iterate over it
        // To avoid this problem we create a new list with project filenames
        const projectFilenames = projectFiles.map(file => file.name);
        for await (const filename of projectFilenames) {
            await this.deleteFile(filename, undefined);
        }
        // Delete project analyses
        const projectAnalyses = this.data.analyses || [];
        // WARNING: The project analyses list is truncated as analyses are deleted and thus we can not iterate over it
        // To avoid this problem we create a new list with project analysis names
        const projectAnalysisNames = projectAnalyses.map(analysis => analysis.name);
        for await (const analysisName of projectAnalysisNames) {
            await this.deleteAnalysis(analysisName, undefined);
        }
        // Delete every MD
        for await (const [mdIndex, md] of Object.entries(this.data.mds)) {
            // If the MD is flagged as removed then we skip it
            if (md.removed) continue;
            await this.removeMDirectory(mdIndex);
        }
        // Delete the remote project document
        logger.startLog(`🗑️  Deleting project ${this.id}`);
        const result = await this.database.projects.deleteOne({ _id: this.id });
        if (!result) return logger.failLog(`🗑️  Failed to delete project ${this.id}`);
        logger.successLog(`🗑️  Deleted project ${this.id}`);
        // Remove references if they are not used by other projects
        const metadata = this.data.metadata;
        if (!metadata) return;
        for await (const uniprot of metadata.REFERENCES || []) {
            const used = await this.database.isReferenceUsed(uniprot);
            if (used === false) await this.database.deleteReference(uniprot);
        }
    }

    // Add a new MD directory to the current project
    addMDirectory = async name => {
        // Create the new MD object and add it to project data
        const md = { name: name, files: [], analyses: [] };
        this.data.mds.push(md);
        // Update the remote
        await this.updateRemote();
    }

    // Remove an existing MD directory
    // Note that MDs are handled thorugh indices so we can not simply remove an MD object from the project MDs list
    // Instead we remove its content and add a tag to mark it as removed
    removeMDirectory = async mdIndex => {
        // Delete all MD contents before deleteing the project itself to avoid having orphans in case of interruption
        const md = this.data.mds[mdIndex];
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
        this.data.mds[mdIndex] = residualMD
        // Update the remote
        await this.updateRemote();
    }

    // Anticipate chains update
    // Note that chains are updated (i.e. deleted and loaded) all together
    forestallChainsUpdate = async (conserve = false, overwrite = false) => {
        // Find the current chains value
        const currentChains = this.data.chains;
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
        // Add the project id to the chain content
        chainContent.project = this.id;
        // Upload the new topology
        logger.startLog(`💽 Loading chain ${chainContent.name}`);
        const result = await this.database.chains.insertOne(chainContent);
        if (result.acknowledged === false) return logger.failLog(`💽 Failed to load chain ${chainContent.name}`);
        logger.successLog(`💽 Loaded chain ${chainContent.name} -> ${result.insertedId}`);
        // Update project data
        if (!this.data.chains) this.data.chains = [];
        this.data.chains.push(chainContent.name);
        await this.updateRemote();
        // Update the inserted data in case we need to revert the change
        this.database.inserted_data.push({
            name: 'new chain',
            collection: this.database.chains,
            id: result.insertedId
        });
    };

    // Delete all current project chains
    deleteChains = async () => {
        logger.startLog(`🗑️  Deleting chains`);
        // Delete previous chains
        const result = await this.database.chains.deleteMany({ project: this.id });
        if (result.acknowledged === false) return logger.failLog(`🗑️ Failed to delete chains`);
        logger.successLog(`🗑️  Deleted chains`);
        // Set project data chains as an empty list
        this.data.chains = [];
        await this.updateRemote();
    };

    // Set a handler to update metadata
    // If no MD directory is passed then update project metadata
    updateProjectMetadata = async (newMetadata, conserve, overwrite) => {
        // Get current metadata
        // Note that project metadata is in a field called 'metadata'
        const previousMetadata = this.data.metadata;
        // If there is no metadata then simply add it
        if (!previousMetadata) {
            this.data.metadata = newMetadata;
            await this.updateRemote();
            return;
        }
        // If there is an already existing metadata then we modify it and send it back to mongo
        // WARNING: Note that values in current metadata which are missing in new metadata will remain
        // This makes sense since we are 'appending' new data
        const changed = await merge_metadata(previousMetadata, newMetadata, conserve, overwrite);
        // If there were no changes in metadata then there is no need to update remote project data
        if (!changed) return console.log(chalk.grey(`Project metadata is already up to date`));
        // Finally, load the modified current metadata object into mongo
        await this.updateRemote();
    };


    // Set a handler to update metadata
    // If no MD directory is passed then update project metadata
    updateMdMetadata = async (newMetadata, mdIndex, conserve, overwrite) => {
        // Get current metadata
        // Note that MD metadata is in every MD object
        const mdData = this.data.mds[mdIndex];
        // At this point metadata should exist
        if (!mdData) throw new Error(`MD with index ${mdIndex} does not exist`);
        // Update the MD object with the MD metadata
        const changed = await merge_metadata(mdData, newMetadata, conserve, overwrite);
        // If there were no changes in metadata then there is no need to update remote project data
        if (!changed) return console.log(chalk.grey(`MD metadata is already up to date`));
        // Finally, load the new mds object into mongo
        await this.updateRemote();
    };

    // Check if there is a previous document already saved
    // If so, check if we must delete it or conserve it
    forestallTopologyLoad = async (newTopology, conserve, overwrite) => {
        // Check if current project already has a topology in the database
        const exist = await this.database.topologies.findOne({ project: this.id });
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
        logger.startLog(`💽 Loading topology data`);
        // Upload the new topology
        const result = await this.database.topologies.insertOne(newTopology);
        if (result.acknowledged === false) return logger.failLog(`💽 Failed to load new topology data`);
        logger.successLog(`💽 Loaded new topology data -> ${result.insertedId}`);
        // Update the inserted data in case we need to revert the change
        this.database.inserted_data.push({
            name: 'new topology',
            collection: this.database.topologies,
            id: result.insertedId
        });
    };

    // Get the current project topology
    getTopology = async () => {
        return await this.database.topologies.findOne({ project: this.id });
    }

    // Delete the current project topology
    deleteTopology = async () => {
        logger.startLog(`🗑️  Deleting topology data`);
        const result = await this.database.topologies.deleteOne({ project: this.id });
        if (!result) return logger.failLog(`🗑️  Failed to delete topology data`);
        logger.successLog(`🗑️  Deleted topology data`);
    };

    // Get the MD index corresponding list of available files
    getAvailableFiles = mdIndex => mdIndex === undefined
        ? this.data.files
        : this.data.mds[mdIndex].files;

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
            logger.startLog(`💽 Loading new file: ${filename}`);
            // Create variables to track the ammount of data to be passed and already passed
            const totalData = fs.statSync(sourceFilepath).size;
            let currentData = 0;
            // Start reading the file by streaming
            const readStream = fs.createReadStream(sourceFilepath);
            // Open the mongo writable stream with a few customized options
            // All data uploaded to mongo by this way is stored in fs.chunks
            // fs.chunks is a default collection of mongo which is managed internally
            const uploadStream = this.database.bucket.openUploadStream(filename, {
                // Check that the file format is accepted. If not, change it to "octet-stream"
                contentType: getMimeTypeFromFilename(filename),
                metadata: { project: this.id, md: mdIndex },
                chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
            });
            // The resulting id of the current upload stream is saved as an environment variable
            // In case of abort, this id is used by the automatic cleanup to find orphan chunks
            this.currentUploadId = uploadStream.id;
            // Promise is not resolved if the readable stream returns error
            readStream.on('error', () => {
                const progress = Math.round((currentData / totalData) * 10000) / 100;
                logger.failLog(`💽 Failed to load file ${databaseFilename} -> ${uploadStream.id} at ${progress} %`);
                reject();
            });
            // Output the percentaje of data already loaded to the logs
            readStream.on('data', async data => {
                // Sum the new data chunk number of bytes
                currentData += data.length;
                // Calculate the progress rounded to 2 decimals
                const progress = Math.round((currentData / totalData) * 10000) / 100;
                // Calculate the amount of time we have been loading the file
                const time = prettyMs(Date.now() - logger.logTime());
                // Update the logs
                logger.updateLog(`💽 Loading file ${filename} -> ${uploadStream.id}\n  at ${progress} % (in ${time})`);
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
                        logger.successLog(`💽 Loaded file [${filename} -> ${uploadStream.id}] (100 %)`);
                        resolve();
                    });
                }
            });
        });
        // Check the new file has been added
        const result = await this.database.files.findOne({ _id: this.currentUploadId });
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
        logger.startLog(`💽 Loading trajectory file '${basename}' as '${filename}'`);
        // Track the current frame
        let frameCount = 0;
        let timeoutID;
        // This throttle wrap makes the function not to be called more than once in a time range (1 second)
        const updateLogs = throttle(() => {
            // Update logs periodically to show the user the time taken for the running process
            const timeTaken = prettyMs(Date.now() - logger.logTime());
            logger.updateLog(`💽 Loading trajectory file '${basename}' as '${filename}' [${
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
                logger.updateLog(`${logger.logText()} ${chalk.yellow(message)}`);
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
            const metadata = { project: this.id, md: mdIndex };
            // Open an upload stream to mongo
            // All data uploaded to mongo by this way is stored in fs.chunks
            // fs.chunks is a default collection of mongo which is managed internally
            const uploadStream = this.database.bucket.openUploadStream(filename, {
                contentType: 'application/octet-stream',
                metadata: metadata,
                chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
            });
            // The resulting id of the current upload stream is saved as an environment variable
            // In case of abort, this id is used by the automatic cleanup to find orphan chunks
            this.currentUploadId = uploadStream.id;
            // If there is an error then display the end of this process as failure in console
            uploadStream.on('error', error => {
                logger.failLog(error);
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
            logger.updateLog(`💽 All trajectory frames loaded (${frameCount}). Waiting for Mongo...`);
            // Wait until one of the endings has ended and stop any reamining timeout
            uploadStream.end(async () => {
                // Remove the timeout
                if (timeout) clearTimeout(timeout);
                // Display the end of this process as success in console
                logger.successLog(
                    `💽 Loaded trajectory file '${basename}' as '${filename}' [${uploadStream.id}]\n(${frameCount} frames)`);
                // Add the number of frames to the matadata object
                metadata.frames = frameCount;
                // Calculate the number of atoms in the loaded trajectory and add it to the metadata object
                metadata.atoms = uploadStream.length / frameCount / Float32Array.BYTES_PER_ELEMENT / N_COORDINATES;
                // Updated the recently created file document with additional metadata
                const result = await this.database.files.findOneAndUpdate({ _id: uploadStream.id }, { $set: { metadata: metadata } });
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
        await this.updateRemote();
        // Update the inserted data in case we need to revert the change
        this.database.inserted_data.push({
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
        logger.startLog(`🗑️  Deleting file ${filename} <- ${currentFile.id}`);
        // Delete the file from fs.files and its chunks from fs.chunks using the file id
        // GridFSBucket.delete has no callback but when it fails (i.e. file not found) it kills the process
        // https://mongodb.github.io/node-mongodb-native/6.3/classes/GridFSBucket.html#delete
        await this.database.bucket.delete(currentFile.id);
        logger.successLog(`🗑️  Deleted file ${filename} <- ${currentFile.id}`);
        // Remove the current file entry from the files list and update the project
        const fileIndex = availableFiles.indexOf(currentFile);
        availableFiles.splice(fileIndex, 1);
        await this.updateRemote();
    }

    // Rename a file, both in the files collection and in project data
    renameFile = async (filename, mdIndex, newFilename) => {
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Find the file summary
        const currentFile = availableFiles.find(file => file.name === filename);
        if (!currentFile) throw new Error(`File ${filename} is not in the available files list (MD index ${mdIndex})`);
        logger.startLog(`📝 Renaming file ${filename} from MD with index ${mdIndex} (${currentFile.id}) as ${newFilename}`);
        // Update filename in the files collection document
        const result = await this.database.files.findOneAndUpdate({ _id: currentFile.id }, { $set: { filename: newFilename }});
        if (result.acknowledged === false) return logger.failLog(`📝 Failed to renamed file ${filename} from MD with index ${mdIndex} (${currentFile.id}) as ${newFilename}`);
        logger.successLog(`📝 Renamed file ${filename} from MD with index ${mdIndex} (${currentFile.id}) as ${newFilename}`);
        // Rename the file object name and update the project
        currentFile.name = newFilename;
        await this.updateRemote();
    }

    // Get the MD index corresponding list of available analyses
    getAvailableAnalyses = mdIndex => mdIndex === undefined
        ? this.data.analyses
        : this.data.mds[mdIndex].analyses;

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
        analysis.project = this.id;
        analysis.md = mdIndex;
        logger.startLog(`💽 Loading analysis ${analysis.name}`);
        // Insert a new document in the analysis collection
        const result = await this.database.analyses.insertOne(analysis);
        if (result.acknowledged === false) return logger.failLog(`💽 Failed to load analysis ${analysis.name}`);
        logger.successLog(`💽 Loaded analysis ${analysis.name} -> ${result.insertedId}`);
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        // Update the project to register that an analysis has been loaded
        availableAnalyses.push({ name: analysis.name, id: result.insertedId });
        await this.updateRemote();
        // Update the inserted data in case we need to revert the change
        this.database.inserted_data.push({
            name: analysis.name + ' analysis',
            collection: this.database.analyses,
            id: result.insertedId
        });
    }

    // Delete an analysis both from its collection and from the project data
    deleteAnalysis = async (name, mdIndex) => {
        // Get the current analysis entry analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        const currentAnalysis = availableAnalyses.find(analysis => analysis.name === name);
        if (!currentAnalysis) throw new Error(`Analysis ${name} is not in the available analyses list (MD index ${mdIndex})`);
        logger.startLog(`🗑️  Deleting analysis ${name} (MD index ${mdIndex})`);
        // Delete the current analysis from the database
        const result = await this.database.analyses.deleteOne({
            name: name,
            project: this.id,
            md: mdIndex
        });
        if (!result) logger.failLog(`🗑️  Failed to delete analysis ${name} (MD index ${mdIndex})`);
        logger.successLog(`🗑️  Deleted analysis ${name} from MD with index ${mdIndex} <- ${currentAnalysis.id}`);
        // Remove the current analysis entry from the analyses list and update the project
        const analysisIndex = availableAnalyses.indexOf(currentAnalysis);
        availableAnalyses.splice(analysisIndex, 1);
        await this.updateRemote();
    }

    // Set if the project is to be published
    setPublished = async published => {
        // If project is already in the desired status then do nothing
        if (this.data.published === published) return;
        // Update the project published status
        this.data.published = published;
        await this.updateRemote();
    };

}

module.exports = Project