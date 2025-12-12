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
    userConfirm,
    userConfirmDataLoad,
    getBasename,
    getMimeTypeFromFilename,
    getValueGetter,
    mdNameToDirectory,
    loadJSON,
    isNumber
} = require('../../utils/auxiliar-functions');
// Get metadata handlers
const { merge_metadata } = require('./metadata-handlers');
// Get constants
const { ANALYSIS_ASSOCIATED_FILES } = require('../../utils/constants');

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
        this.accession = this.data.accession;
        this.id = this.data._id;
        // Store the database handler
        this.database = database;
        // Keep track of the currently inserting file
        // This way, in case anything goes wrong, we can delete orphan chunks
        this.currentUploadId = null;
        // Fix data format issues
        // These may come from old project formats
        if (this.data.analyses === undefined) this.data.analyses = [];
        // Set an internal variable to store when the user confirms the load of a group of associated data
        // Thus there is no need to ask the user again for every file/analysis in the group
        this.confirmedAssociatedDataLoad = {};
    };

    // Update remote project data by overwritting it all with current project data
    updateRemote = async () => {
        logger.startLog(`📝 Updating database project data`);
        // Add last modification timestamp
        this.data.updateDate = new Date();
        // Replace remote project data by local project data
        const result = await this.database.projects.replaceOne({ _id: this.id }, this.data);
        if (result.acknowledged === false) return logger.failLog('📝 Failed to update database project data');
        logger.successLog('📝 Updated database project data');
    };

    // Get a summary of the project contents
    logProjectSummary = async () => {
        const accessionLabel = this.accession || 'with no accession';
        console.log(`Project ${accessionLabel} (${this.id}) summary:`);
        // Show if there is a topology
        const topology = await this.getTopology();
        if (topology) console.log('- Topology');
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
        if (!topology && projectFilesCount === 0 && projectAnalysesCount === 0 &&
            mdCount === 0 && mdFilesCount === 0 && mdAnalysesCount === 0) console.log('  Project is empty');
    }

    // Get a summary of some specific MD contents
    logMDSummary = async mdIndex => {
        const accessionLabel = this.accession || 'with no accession';
        const md = this.data.mds[mdIndex];
        console.log(`MD ${md.name} from project ${accessionLabel} (${this.id}) summary:`);
        // Show the number of MD files and analyses
        const mdFiles = md.files;
        const mdFilesCount = (mdFiles && mdFiles.length) || 0;
        const mdAnalyses = md.analyses;
        const mdAnalysesCount = (mdAnalyses && mdAnalyses.length) || 0;
        if (mdFilesCount > 0) console.log(`- MD Files: ${mdFilesCount}`);
        if (mdAnalysesCount > 0) console.log(`- MD Analyses: ${mdAnalysesCount}`);
        // In case we produced no output say explicitly that the MD is empty
        if (mdFilesCount === 0 && mdAnalysesCount === 0) console.log('  MD is empty');
    }

    // Delete a project
    deleteProject = async () => {
        // Delete all project contents before deleteing the project itself to avoid having orphans in case of interruption
        // Delete the topology
        const topology = await this.getTopology();
        if (topology) await this.deleteTopology();
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
            // Set the MD as removed and force it so we do not ask the user every time the reference MD is removed
            await this.removeMDirectory(+mdIndex, true);
        }
        // Delete the remote project document
        logger.startLog(`🗑️  Deleting project ${this.id}`);
        const result = await this.database.projects.deleteOne({ _id: this.id });
        if (!result) return logger.failLog(`🗑️  Failed to delete project ${this.id}`);
        logger.successLog(`🗑️  Deleted project ${this.id}`);
        // If this was the last issued project then reuse its accession for further projects
        const lastIssuedAccession = await this.database.getLastAccession();
        if (lastIssuedAccession === this.accession) await this.database.updateCounter(-1);
        // Remove references if they are not used by other projects
        const metadata = this.data.metadata;
        if (!metadata) return;
        // Iterate the different reference types
        // Iterate the different type of references (proteins, ligands)
        for await (const [ referenceName, refereceConfig ] of Object.entries(this.database.REFERENCES)) {
            const projectIdsField = refereceConfig.projectIdsField;
            const referenceIdsGetter = getValueGetter(projectIdsField);
            // Iterate the project reference ids
            const referenceIds = referenceIdsGetter(this.data);
            for await (const referenceId of referenceIds || []) {
                // Delete the reference if it is not used by other projects
                await this.database.deleteReferenceIfProper(referenceName, referenceId);
            }
        }
    }

    // Get the index of an already existing MD or null
    // To find the MD, guess its name using a directory
    findMDIndexByDirectory = directory => {
        // Get the last directory in the path
        const basename = getBasename(directory).toLowerCase();
        // For every MD, find out the directory it should have according to its name
        // Then check if it matches the requested directory
        // Otherwise return null and asume it is a new MD
        // Note that directories cannot be back-mapped to names since they may be missing forbidden characters
        for (const [mdIndex, md] of Object.entries(this.data.mds)) {
            const mdDirectory = mdNameToDirectory(md.name);
            // Make sure the MD index is numeric or silent errors will happen
            if (mdDirectory === basename) return +mdIndex;
        }
        return null;
    }

    // Get the index of an already existing MD or null
    // To find the MD, use its name
    findMDIndexByName = name => {
        // For every MD, find out the directory it should have according to its name
        // Then check if it matches the requested directory
        // Otherwise return null and asume it is a new MD
        // Note that directories cannot be back-mapped to names since they may be missing forbidden characters
        for (const [mdIndex, md] of Object.entries(this.data.mds)) {
            // Make sure the MD index is numeric or silent errors will happen
            if (md.name === name) return +mdIndex;
        }
        return null;
    }

    // Add a new MD directory to the current project
    addMDirectory = async metadata => {
        // Set the index of the new MD
        const mdIndex = this.data.mds.length;
        // Create the new MD object and add it to project data
        const md = { name: undefined, files: [], analyses: [] };
        this.data.mds.push(md);
        // Update the remote
        this.data.mdcount = this.countAvailableMDs();
        await this.updateMdMetadata(metadata, mdIndex, false, false);
    }

    // Remove an existing MD directory
    // Note that MDs are handled thorugh indices so we can not simply remove an MD object from the project MDs list
    // Instead we remove its content and add a tag to mark it as removed
    removeMDirectory = async (mdIndex, forced = false) => {
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
        // If this was the reference MD then we must change the reference MD
        // WARNING: This is to be done after the MD has been marked as removed
        // Otherwise the MD would still be 'available' as reference MD
        if (this.data.mdref === mdIndex) {
            // If this is forced then we automatically assign a new reference MD
            if (forced) this.data.mdref = this.findAvailableMDIndex();
            // Otherwise we ask the user which is to be the next reference MD
            else this.data.mdref = await this.setNewReferenceMD();
        }
        this.data.mdcount = this.countAvailableMDs();
        // Update the remote
        await this.updateRemote();
    }

    // Find the first available (i.e. not removed) MD index
    // Return null if all MDs are removed
    findAvailableMDIndex = () => {
        for (const [mdIndex, md] of Object.entries(this.data.mds)) {
            if (md.removed) continue;
            return +mdIndex;
        }
        return null;
    }

    // Find all available (i.e. not removed) MD indices
    findAvailableMDIndices = () => {
        const availableMDIndices = [];
        for (const [mdIndex, md] of Object.entries(this.data.mds)) {
            if (md.removed) continue;
            availableMDIndices.push(+mdIndex);
        }
        return availableMDIndices;
    }

    // Count the number of available (i.e. not removed) MDs
    countAvailableMDs = () => {
        let count = 0;
        for (const md of this.data.mds) {
            if (!md.removed) count++;
        }
        return count;
    }

    // Return a new referece MD index after asking the user
    // Return null if all MDs are removed
    setNewReferenceMD = async () => {
        // Get available MDs to offer to the user as possible reference MDs
        const availableMDIndices = this.findAvailableMDIndices();
        // If there are no available MDs then return null
        if (availableMDIndices.length === 0) {
            console.log('There are no more available MDs left. Reference MD will become null');
            return null;
        }
        // If there is just one available MDs then return it
        if (availableMDIndices.length === 1) {
            const newReferenceMDIndex = availableMDIndices[0];
            const newReferenceMD = this.data.mds[newReferenceMDIndex];
            console.log(`There is only one available MD left: ${newReferenceMD.name}. This will become the new reference MD`);
            return newReferenceMD;
        }
        // List all available (i.e. not removed) MDs
        const availableMDTitles = [];
        for (const mdIndex of availableMDIndices) {
            const md = this.data.mds[mdIndex];
            availableMDTitles.push(`  ${mdIndex} - ${md.name}`);
        }
        // Ask for user confirm until we get an acceptable answer
        while (true) {
            // Ask the user
            const userAnswer = await userConfirm(
                `The MD we are deleting is the reference MD. A new reference MD is to be assigned:\n${
                    availableMDTitles.join('\n')
                }`
            );
            // Make sure the user response is a number (an MD index)
            const userRequestedMdIndex = +userAnswer;
            if (Number.isNaN(userRequestedMdIndex)) {
                console.log('The answer is expected to be a number.')
                continue;
            }
            // Make sure the user requested MD index is among the available MDs
            if (!availableMDIndices.includes(userRequestedMdIndex)) {
                console.log(`The requested MD index (${userRequestedMdIndex}) is not available.`);
                continue;
            }
            // Return the requested MD index
            return userRequestedMdIndex;
        }
    }

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
        const message = 'There is already a topology in this project.';
        const confirm = overwrite ? true : await userConfirmDataLoad(message);
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
    getAvailableFiles = mdIndex => isNumber(mdIndex)
        ? this.data.mds[mdIndex].files
        : this.data.files;

    // Check if there is a previous file with the same name
    // If so, check if we must delete it or conserve it
    forestallFileLoad = async (filename, mdIndex, conserve, overwrite) => {
        // Find the file summary
        const alreadyExistingFile = this.findFile(filename, mdIndex);
        // If the new file is not among the current files then there is no problem
        if (!alreadyExistingFile) return true;
        // Check if the load was previously confirmed for the associated data group
        const associatedDataLabel = this.findFileAssociatedDataLabel(filename);
        const previousConfirm = this.confirmedAssociatedDataLoad[associatedDataLabel];
        // In case it exists and the 'conserve' flag has been passed we end here
        if (conserve || previousConfirm === false) return false;
        // Note that here we do not check if files are identical since they may be huge
        // Ask the user in case the 'overwrite' flag has not been passed
        let confirm = overwrite || previousConfirm === true;
        if (!confirm) {
            // Find if there is data associated to this file
            let message = `There is already a file named "${filename}" in this project.`;
            const associatedData = associatedDataLabel &&
                await this.findAssociatedData(associatedDataLabel, mdIndex);
            if (associatedData && associatedData.count > 1) {
                const analysisCount = associatedData.analyses.length;
                const fileCount = associatedData.files.length;
                message += (` This file is part of a group of associated data. ` +
                    `The group includes ${analysisCount} analyses and ${fileCount} files. ` +
                    `These analyses and files will be overwritten or conserved together.`);
            }
            // Ask the user
            confirm = await userConfirmDataLoad(message);
            // Save the result for the whole group of associated data
            this.confirmedAssociatedDataLoad[associatedDataLabel] = confirm;
        } 
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
            // If there is a metadata file associated to this file then load it
            let additionalMetadata = {};
            const metadataFilepath = sourceFilepath + '.meta.json';
            const metadataExists = fs.existsSync(metadataFilepath)
            if (metadataExists) additionalMetadata = loadJSON(metadataFilepath);
            // Set metadata to be written in the file entry
            const metadata = { project: this.id, md: mdIndex, ...additionalMetadata };
            // Start the logs
            const label = `${filename}${metadataExists ? ' (+ meta)' : ''}`; 
            logger.startLog(`💽 Loading new file: ${label}`);
            // Create variables to track the ammount of data to be passed and already passed
            const totalData = fs.statSync(sourceFilepath).size;
            let currentData = 0;
            const startTime = Date.now();
            // Start reading the file by streaming
            const readStream = fs.createReadStream(sourceFilepath);
            // Open the mongo writable stream with a few customized options
            // All data uploaded to mongo by this way is stored in fs.chunks
            // fs.chunks is a default collection of mongo which is managed internally
            const uploadStream = this.database.bucket.openUploadStream(filename, {
                // Check that the file format is accepted. If not, change it to "octet-stream"
                contentType: getMimeTypeFromFilename(filename),
                metadata: metadata,
                chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
            });
            // The resulting id of the current upload stream is saved as an environment variable
            // In case of abort, this id is used by the automatic cleanup to find orphan chunks
            this.currentUploadId = uploadStream.id;
            // Promise is not resolved if the readable stream returns error
            readStream.on('error', () => {
                const progress = Math.round((currentData / totalData) * 10000) / 100;
                logger.failLog(`💽 Failed to load file ${label} -> ${uploadStream.id} at ${progress} %`);
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
                // Calculate upload speed
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                const speedMBps = (currentData / elapsedSeconds / (1000 * 1000)).toFixed(2);
                // Update the logs
                logger.updateLog(`💽 Loading file ${label} -> ${uploadStream.id}\n  at ${progress} % (in ${time}) [${speedMBps} MB/s]`);
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
                        // Calculate final average speed
                        const totalSeconds = (Date.now() - startTime) / 1000;
                        const avgSpeedMBps = (totalData / totalSeconds / (1000 * 1000)).toFixed(2);
                        // Display it through the logs
                        logger.successLog(`💽 Loaded file ${label} -> ${uploadStream.id} (100 %) [avg: ${avgSpeedMBps} MB/s]`);
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
        const startTime = Date.now();
        let bytesWritten = 0;
        // This throttle wrap makes the function not to be called more than once in a time range (1 second)
        const updateLogs = throttle(() => {
            // Update logs periodically to show the user the time taken for the running process
            const timeTaken = prettyMs(Date.now() - logger.logTime());
            // Calculate upload speed
            const elapsedSeconds = (Date.now() - startTime) / 1000;
            const speedMBps = elapsedSeconds > 0 ? (bytesWritten / elapsedSeconds / (1000 * 1000)).toFixed(2) : '0.00';
            logger.updateLog(`💽 Loading trajectory file '${basename}' as '${filename}' [${
                this.currentUploadId}]\n (frame ${frameCount} in ${timeTaken}) [${speedMBps} MB/s]`);
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
                filename: filename,
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
                // Track bytes written
                bytesWritten += coordinates.length;
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
                // Check we actually loaded any frame
                if (frameCount === 0) {
                    // Delete the wrong trajectory entry
                    // WARNING: If not deleted here, it would create a duplicate entry
                    await this.database.bucket.delete(uploadStream.id);
                    logger.failLog(`💽 Failed to load any frame in trajectory file '${basename}' as '${filename}' [${uploadStream.id}] -> Check Gromacs is working fine`);
                    reject();
                }
                // Display the end of this process as success in console
                const totalSeconds = (Date.now() - startTime) / 1000;
                const avgSpeedMBps = (bytesWritten / totalSeconds / (1000 * 1000)).toFixed(2);
                logger.successLog(
                    `💽 Loaded trajectory file '${basename}' as '${filename}' [${uploadStream.id}]\n(${frameCount} frames) [avg: ${avgSpeedMBps} MB/s]`);
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

    // Find a file in this project
    findFile = (filename, mdIndex) => {
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Find the file summary
        return availableFiles.find(file => file.name === filename);
    }

    // Delete a file both from fs.files / fs.chunks and from the project data
    deleteFile = async (filename, mdIndex, handleAssociatedData = true) => {
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Find the file summary
        const currentFile = availableFiles.find(file => file.name === filename);
        // Find the file summary
        if (!currentFile) throw new Error(`File ${filename} is not in the available files list (MD index ${mdIndex})`);
        // If there is data associated to this analysis then delete the whole group of data instead
        if (handleAssociatedData) {
            const associatedDataLabel = this.findFileAssociatedDataLabel(filename);
            const associatedData = associatedDataLabel &&
                await this.findAssociatedData(associatedDataLabel, mdIndex);
            if (associatedData && associatedData.count > 1)
                return await this.deleteAssociatedData(associatedData);
        }
        logger.startLog(`🗑️  Deleting file ${filename} <- ${currentFile.id}`);
        const fileCursor = await this.database.bucket.find(currentFile.id);
        const targetFile = await fileCursor.next();
        // The file should always exist at this point, but make sure it does
        if (targetFile) {
            // Delete the file from fs.files and its chunks from fs.chunks using the file id
            // GridFSBucket.delete has no callback but when it fails (i.e. file not found) it kills the process
            // https://mongodb.github.io/node-mongodb-native/6.3/classes/GridFSBucket.html#delete
            await this.database.bucket.delete(currentFile.id);
            logger.successLog(`🗑️  Deleted file ${filename} <- ${currentFile.id}`);
        }
        // However a desynchronization between projects and fs.files may happen if the loader is abuptly interrupted
        else {
            logger.warnLog(`🗑️  File ${filename} does not exist already <- ${currentFile.id}`);
        }
        // Remove the current file entry from the files list and update the project
        const fileIndex = availableFiles.indexOf(currentFile);
        availableFiles.splice(fileIndex, 1);
        await this.updateRemote();
    }

    // Rename a file, both in the files collection and in project data
    renameFile = async (filename, mdIndex, newFilename) => {
        // Find the file summary
        const currentFile = this.findFile(filename, mdIndex);
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
    getAvailableAnalyses = mdIndex => isNumber(mdIndex)
        ? this.data.mds[mdIndex].analyses
        : this.data.analyses;

    // Check if there is a previous analysis with the same name
    // If so, check if we must delete it or conserve it
    // DANI: En teoría no existen los análisis de proyecto, pero le doy soporte porque me los pedirán pronto (imagino)
    forestallAnalysisLoad = async (name, mdIndex, conserve, overwrite) => {
        // Find the already existing analysis, if any
        const alreadyExistingAnalysis = this.findAnalysis(name, mdIndex);
        // If the new analysis is not among the current analyses then there is no problem
        if (!alreadyExistingAnalysis) return true;
        // Check if the load was previously confirmed for the associated data group
        const associatedDataLabel = this.findAnalysisAssociatedDataLabel(name);
        const previousConfirm = this.confirmedAssociatedDataLoad[associatedDataLabel];
        // In case it exists and the 'conserve' flag has been passed we end here
        if (conserve || previousConfirm === false) return false;
        // Note that here we do not check if analyses are identical since they may be huge
        // Ask the user in case the 'overwrite' flag has not been passed
        let confirm = overwrite || previousConfirm === true;
        if (!confirm) {
            // Find if there is data associated to this analysis
            let message = `There is already an analysis named "${name}" in this project.`;
            const associatedData = await this.findAssociatedData(associatedDataLabel, mdIndex);
            if (associatedData.count > 1) {
                const analysisCount = associatedData.analyses.length;
                const fileCount = associatedData.files.length;
                message += (` This analysis is part of a group of associated data.` +
                    ` The group includes ${analysisCount} analyses and ${fileCount} files.` +
                    ` These analyses and files will be overwritten or conserved together.`);
            }
            // Ask the suer
            confirm = await userConfirmDataLoad(message);
            // Save the result for the whole group of associated data
            this.confirmedAssociatedDataLoad[associatedDataLabel] = confirm;
        }
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
        if (mdIndex !== undefined) analysis.md = mdIndex;
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

    // Find an analysis in this project
    findAnalysis = (name, mdIndex) => {
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        // Find the analysis summary
        return availableAnalyses.find(analysis => analysis.name === name);
    }

    // Delete an analysis both from its collection and from the project data
    deleteAnalysis = async (name, mdIndex, handleAssociatedData = true) => {
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        // Get the current analysis
        const currentAnalysis = availableAnalyses.find(analysis => analysis.name === name);
        if (!currentAnalysis)
            throw new Error(`Analysis ${name} is not in the available analyses list (MD index ${mdIndex})`);
        // If there is data associated to this analysis then delete the whole group of data instead
        if (handleAssociatedData) {
            const associatedDataLabel = this.findAnalysisAssociatedDataLabel(name)
            const associatedData = await this.findAssociatedData(associatedDataLabel, mdIndex);
            if (associatedData.count > 1) return await this.deleteAssociatedData(associatedData);
        }
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

    // Rename an analysis, both in the analyses collection and in project data
    renameAnalysis = async (oldName, mdIndex, newName) => {
        // Find the analysis document
        const currentAnalysis = this.findAnalysis(oldName, mdIndex);
        if (!currentAnalysis) throw new Error(`Analysis ${oldName} is not in the available analyses list (MD index ${mdIndex})`);
        logger.startLog(`📝 Renaming analysis ${oldName} from MD with index ${mdIndex} (${currentAnalysis.id}) as ${newName}`);
        // Update analysis name in the analyses collection document
        const result = await this.database.analyses.findOneAndUpdate({ _id: currentAnalysis.id }, { $set: { name: newName }});
        if (result.acknowledged === false) return logger.failLog(`📝 Failed to renamed analysis ${oldName} from MD with index ${mdIndex} (${currentAnalysis.id}) as ${newName}`);
        logger.successLog(`📝 Renamed analysis ${oldName} from MD with index ${mdIndex} (${currentAnalysis.id}) as ${newName}`);
        // Rename the analysis object name and update the project
        currentAnalysis.name = newName;
        await this.updateRemote();
    }

    // Given a file, find if there is any analysis it is related to
    findFileAssociatedDataLabel = filename => {
        // Iterate analysis associated files until we find this file
        for (const [analysisName, associatedFiles] of Object.entries(ANALYSIS_ASSOCIATED_FILES)) {
            for (const associatedFile of associatedFiles) {
                if (filename.match(associatedFile)) return analysisName;
            }
        }
        // If no analysis was found to be associated then return null
        return null;
    }

    // Get the analysis core name
    // e.g. if the name is 'clusters-01' then get the 'clusters'
    findAnalysisAssociatedDataLabel = analysisName => {
        return analysisName.replace(/-[0-9]*$/i, '');
    }

    // Delete a group of related analyses and files
    // The data label is the name of the index analysis
    // e.g. 'pca', 'clusters', etc.
    findAssociatedData = async (dataLabel, mdIndex) => {
        // Get a list of available analyses
        const availableAnalyses = this.getAvailableAnalyses(mdIndex);
        // Filter the analysis related to the core name
        const analysesRegExp = new RegExp(`${dataLabel}(-[0-9]*)?`);
        const associatedAnalyses = availableAnalyses.filter(
            analysis => analysis.name.match(analysesRegExp));
        // Get a list of available files
        const availableFiles = this.getAvailableFiles(mdIndex);
        // Find out which files are related to the analysis
        const associtedFiles = [];
        const associatedFileRegExps = ANALYSIS_ASSOCIATED_FILES[dataLabel] || [];
        for (const fileRegExp of associatedFileRegExps) {
            for (const availableFile of availableFiles) {
                if (availableFile.name.match(fileRegExp))
                    associtedFiles.push(availableFile);
            }
        }
        // Count the amount of findings we had
        const count = associatedAnalyses.length + associtedFiles.length;
        // Return the findings
        return {
            analyses: associatedAnalyses,
            files: associtedFiles,
            count: count,
            mdIndex,
        };
    }

    // Delete a group of associated analyses and files
    deleteAssociatedData = async associatedData => {
        // Delete associated analyses
        for await(const analysis of associatedData.analyses) {
            await this.deleteAnalysis(analysis.name, associatedData.mdIndex, false);
        }
        // Delete associated files
        for await(const file of associatedData.files) {
            await this.deleteFile(file.name, associatedData.mdIndex, false);
        }
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