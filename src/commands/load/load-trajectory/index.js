// It is used to interrupt stream flows
const devNull = require('dev-null');
const throttle = require('lodash.throttle');
// This tool converts miliseconds (ms) to a more human friendly string (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');
const executeCommandPerLine = require('../../../utils/execute-command-per-line');

// Constants
const UNIT_CONVERSION_SCALE = 10;
const N_COORDINATES = 3;
// example matches:
// '      x[    0]={ 6.40500e+00,  7.53800e+00,  9.81800e+00}'
// '      x[35999]={-8.50000e-02,  1.82000e+00,  7.23700e+00}'
const COORDINATES_REGEXP = /^\s*x\[\s*\d*]={\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2}),\s*(-?\d+\.\d+e[+-]\d{2})\s*}\s*$/;
const FRAME_REGEXP = / frame \d+:$/;
const THROTTLE_TIME = 1000; // 1 second
const TIMEOUT_WARNING = 30000; // 30 seconds

// This function converts the trajectory data through Gromacs by streaming
// The converted data is uploaded into mongo also by streaming
// When the streaming has finished, some extra metadata is added to mongo
// Keep track of the process and display in console the current frame at any moment
const loadTrajectory = (
  folder,
  filename,
  bucket,
  files,
  projectID,
  gromacsCommand, // It is the gromacs-path ('gmx')
  dryRun,
  spinnerRef,
  abort, // Load aborting function
) => {
  // Display the start of this process in console
  spinnerRef.current = getSpinner().start(
    `Loading trajectory file '${filename}'`,
  );
  // Track the current frame
  let frameCount = 0;
  let timeoutID;
  // This throttle calls the specified function every "THROTTLE_TIME" seconds (1 second)
  const updateSpinner = throttle(() => {
    // Update the spiner periodically to show the user the time taken for the running process
    spinnerRef.current.text = `Loading trajectory file [${filename} -> ${
      process.env.currentUploadId
    }]\n(frame ${frameCount} in ${prettyMs(
      Date.now() - spinnerRef.current.time,
    )})`;
    // Warn user if the process is stuck
    // "setTimeout" and "clearTimeout" are node built-in functions
    // "clearTimeout" cancels the timeout (only if is is already set, in this case)
    if (timeoutID) clearTimeout(timeoutID);
    // "setTimeout" executes a function after a specific amount of time
    // First argument is the function to be executed and the second argument is the time
    // In this case, a warning message is added to the spinner after 30 seconds
    timeoutID = setTimeout(() => {
      spinnerRef.current.text = `${spinnerRef.current.text} ${chalk.yellow(
        ' ⚠️  Timeout warning: nothing happened in the last 30 seconds. ' +
          'Load will be resumed by force in 15 seconds.',
      )}`;
    }, TIMEOUT_WARNING);
  }, THROTTLE_TIME);

  return new Promise(async (resolve, reject) => {
    // keep a buffer handy for reuse for every atoms in every frame
    // Allocate a new buffer of the provided size
    // Float32Array.BYTES_PER_ELEMENT corresponds to 4
    const coordinatesBuffer = Buffer.alloc(
      Float32Array.BYTES_PER_ELEMENT * N_COORDINATES,
    );
    // This function is equivalent to openning a new terinal and typing this:
    // gmx dump -f path/to/trajectory
    // This assembly runs Gromacs as a paralel process which returns an output in string chunks
    // These strings are converted in standarized "lines"
    const asyncLineGenerator = executeCommandPerLine(gromacsCommand, [
      // Arguments sent to Gromacs
      'dump', // Gromacs command: Make binary files human readable
      '-f', // "dump" option which stands for specific input files: xtc trr cpt gro g96 pdb tng
      folder + filename, // Path to file
    ]);
    // Set the name for the new file stored in mongo
    let dbFilename = 'trajectory.bin';
    const pcaMatch = filename.match(/\.(pca-\d+)\./i);
    if (pcaMatch) dbFilename = `trajectory.${pcaMatch[1]}.bin`;
    // Manage the dryRun option
    const uploadStream = dryRun
      ? // If dryRun is true then interrupt the stream flow
        devNull()
      : // Else, open an upload stream to mongo
        // All data uploaded to mongo by this way is stored in fs.chunks
        // fs.chunks is a default collection of mongo which is managed internally
        bucket.openUploadStream(dbFilename, {
          contentType: 'application/octet-stream',
          chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
    // The resulting id of the current upload stream is saved as an environment variable
    // In case of abort, this id is used by the automatic cleanup to find orphan chunks
    process.env.currentUploadId = uploadStream.id;
    // error
    uploadStream.on('error', error => {
      // Display the end of this process as failure in console
      spinnerRef.current.fail(error);
      reject();
    });

    let timeout;
    // Track the last time we checked if the load was aborted
    let lastCheck = Date.now();
    // for each atom coordinates in the data
    for await (const line of asyncLineGenerator) {
      // Check once per second if the process has been aborted
      const now = Date.now();
      if (now > lastCheck + 1000) {
        if (await abort()) return resolve('abort');
        lastCheck = now;
      }

      // Save matches with a long RegExp pattern defined above
      const match = line.match(COORDINATES_REGEXP);
      if (!match) {
        // try to check if it's a "frame number" line
        if (FRAME_REGEXP.test(line)) {
          frameCount++;
          updateSpinner(); // Update the current frame in the spinner
        }
        continue; // Next line
      }

      // convert units
      coordinatesBuffer.writeFloatLE(+match[1] * UNIT_CONVERSION_SCALE, 0); // x
      coordinatesBuffer.writeFloatLE(+match[2] * UNIT_CONVERSION_SCALE, 4); // y
      coordinatesBuffer.writeFloatLE(+match[3] * UNIT_CONVERSION_SCALE, 8); // z

      // In case of overload stop writing streams and wait until the drain is resolved
      const keepGoing = uploadStream.write(coordinatesBuffer);
      if (!keepGoing) {
        // dataSent is resolved when one of these 2 promises is resolved:
        const dataSent = Promise.race([
          // First promise (canonical): We receive the callback from uploadStream.write
          new Promise(next => uploadStream.once('drain', next)),
          // Second promise (something happend), there is no callback after a wide time
          // Force the loop to be resumed
          // It will stop in the next iteration if there is really a connection problem
          new Promise(
            next =>
              (timeout = setTimeout(() => {
                next();
              }, 45000)),
          ),
        ]);
        // Stop the loop here until one of the previous promises is resolved
        await dataSent;
        // Once passed, we remove the timeout
        if (timeout) clearTimeout(timeout);
      }
    }
    // Warn the user we have to wait here
    updateSpinner.cancel();
    if (timeoutID) clearTimeout(timeoutID);
    spinnerRef.current.text = `All trajectory frames loaded (${frameCount}). Waiting for Mongo...`;
    // Try to end the end the uploadStream with the canoncial end() function
    // If it fails, create the fs.files' document manually and go on (necessary fudge)
    // Closing the stream may fail sometimes (e.g. as long as the upload resuming was forced)
    const streamFinished = Promise.race([
      // First promise (canonical): We receive the callback from uploadStream.end
      new Promise(resolve => uploadStream.end(resolve)),
      // Second promise (something happend), there is no callback after a wide time
      // Create the manual fs.files' document
      // DANI: Since I ignore how the md5 is set, the manual md5 is just the internal id
      new Promise(
        next =>
          (timeout = setTimeout(async () => {
            await files.insertOne({
              _id: uploadStream.id,
              length: uploadStream.length,
              chunkSize: uploadStream.chunkSizeBytes,
              uploadDate: new Date(),
              filename: uploadStream.filename,
              md5: uploadStream.id.toString(),
              contentType: 'application/octet-stream',
            });
            next();
          }, 45000)),
      ),
    ]);

    // Wait until one of the endings has ended and stop any reamining timeout
    await streamFinished;
    if (timeout) clearTimeout(timeout);

    // Display the end of this process as success in console
    spinnerRef.current.succeed(
      `Loaded trajectory file [${filename} -> ${process.env.currentUploadId}]\n(${frameCount} frames)`,
    );
    // Find the new uploaded document and add a few metadata (frames, atoms and project id)
    // findOneAndUpdate() is a mongo function
    // This function finds a document and applies an update to this document
    const trajectoryFileDescriptor = (await files.findOneAndUpdate(
      // The object id of the document to find
      { _id: uploadStream.id },
      // The update to be applied after the document has been found
      {
        $set: {
          metadata: {
            frames: frameCount,
            // The number of atoms is calculated
            atoms:
              uploadStream.length /
              frameCount /
              Float32Array.BYTES_PER_ELEMENT /
              N_COORDINATES,
            project: projectID,
          },
        },
      },
      // By default findOneAndUpdate() returns the original doc (i.e. before the update)
      { returnOriginal: false }, // This makes findOneAndUpdate() return the updated doc
    )).value;
    // Save this id as a reference for cleanup
    if (process.env.uploaded)
      process.env.uploaded.push(process.env.currentUploadId);
    // Remove this id from the current upload id
    process.env.currentUploadId = '';
    // resolve with number of frames
    resolve(trajectoryFileDescriptor);
  });
};

module.exports = loadTrajectory;
