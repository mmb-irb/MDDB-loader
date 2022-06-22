// Files system
const fs = require('fs');
// It is used to interrupt stream flows
const devNull = require('dev-null');
// Visual tool which allows to add colors in console
const chalk = require('chalk');
// This tool converts miliseconds (ms) to a more human friendly string (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');
// This utility displays in console a dynamic loading status
const getSpinner = require('../../../utils/get-spinner');

// This is just like an string array with the accepted formats
const mimeMap = new Map([['.pdb', 'chemical/x-pdb']]);

// Check if the provided filename has one of the accepted formats
// If it is, return the type. If not, return the "octet-stream" format.
const getMimeTypeFromFilename = filename => {
  for (const [extension, type] of mimeMap.entries()) {
    if (filename.toLowerCase().endsWith(extension)) return type;
  }
  // default
  return 'application/octet-stream';
};

const loadFile = (
  folder,
  filename,
  bucket,
  files,
  projectID,
  dryRun,
  appended,
  spinnerRef,
  index,
  rawFilesLength,
  abort, // Load aborting function
) =>
  new Promise((resolve, reject) => {
    // Check that there are folder and filename
    if (!(folder && filename)) {
      return reject(new Error('Need to pass a folder and a filename'));
    }
    try {
      // Start the spinner
      spinnerRef.current = getSpinner().start(`Loading new file: ${filename}`);
      // Create variables to track the ammoun of data to be passed and already passed
      const totalData = fs.statSync(folder + filename).size;
      let currentData = 0;
      // Create a variable to track the time since the last chunk, so we can force resume
      let timeout;
      // Start reading the file by streaming
      const readStream = fs.createReadStream(folder + filename);
      // In case the filename starts with 'fs.' set the database filename without the prefix
      let databaseFilename = filename;
      if (databaseFilename.slice(0, 3) === 'fs.')
        databaseFilename = databaseFilename.slice(3);
      // Check if the dryRun option is activated. If it is, do nothing.
      // If it is not, start writing the file into mongo by streaming
      const uploadStream = dryRun
        ? devNull()
        : // Open the mongo writable stream with a few customized options
          // All data uploaded to mongo by this way is stored in fs.chunks
          // fs.chunks is a default collection of mongo which is managed internally
          bucket.openUploadStream(databaseFilename, {
            // Check that the file format is accepted. If not, change it to "octet-stream"
            contentType: getMimeTypeFromFilename(filename),
            metadata: { project: projectID },
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
          });
      // The resulting id of the current upload stream is saved as an environment variable
      // In case of abort, this id is used by the automatic cleanup to find orphan chunks
      process.env.currentUploadId = uploadStream.id;
      // If we are appending, save the id into the append array
      if (appended) appended.push(uploadStream.id);
      // Promise is resolved when the upload stream is finished
      const finishUpload = async () => {
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
                //console.log('Forced stream end');
                await files.insertOne({
                  _id: uploadStream.id,
                  length: uploadStream.length,
                  chunkSize: uploadStream.chunkSizeBytes,
                  uploadDate: new Date(),
                  filename: uploadStream.filename,
                  md5: uploadStream.id.toString(),
                  contentType: 'application/octet-stream',
                  //contentType: uploadStream.contentType,
                });
                next();
              }, 45000)),
          ),
        ]);
        // Wait until one of the endings has ended and stop any reamining timeout
        await streamFinished;
        if (timeout) clearTimeout(timeout);
        // Display it through the spinner
        spinnerRef.current.succeed(
          `Loaded file [${filename} -> ${uploadStream.id}] (100 %)`,
        );
        // Save this id as a reference for cleanup
        if (process.env.uploaded) {
          process.env.uploaded.push(process.env.currentUploadId);
        }
        // Remove this id from the current upload id
        process.env.currentUploadId = '';
        const fileDescriptor = await files.findOne(uploadStream.id);
        // Finally, resolve the promise
        resolve(fileDescriptor);
      };
      // Promise is not resolved if the readable stream returns error
      readStream.on('error', reject);
      // Track the percentaje of data already loaded through the spinner
      readStream.on('data', async data => {
        // Sum the new data chunk number of bytes
        currentData += data.length;
        // Update the spinner
        spinnerRef.current.text = `Loading file ${index} out of ${rawFilesLength} [${filename} -> ${
          uploadStream.id
        }]\n  at ${
          // I multiply by extra 100 inside the math.round and divide by 100 out
          // This is because I want the round for 2 decimals
          Math.round((currentData / totalData) * 10000) / 100
        } % (in ${
          // The time which is taking to finish the process
          prettyMs(Date.now() - spinnerRef.current.time)
        })`;

        // Pause and wait for the callback to resume
        readStream.pause();

        // Set a timeout to resume the download in case that the callback does not return
        timeout = setTimeout(() => {
          console.log('Resumed by force');
          readStream.resume();
        }, 45000);

        // Check that local buffer is sending data out before continue to prevent memory leaks
        uploadStream.write(data, 'utf8', async () => {
          // Clear the previous iteration's timeout
          if (timeout) clearTimeout(timeout);
          if (await abort()) return resolve('abort');
          readStream.resume();
        });

        // At the end
        if (currentData / totalData === 1) finishUpload();
      });

      // Connect both reading and writing streams and start streaming
      //readStream.pipe(uploadStream);
    } catch (error) {
      console.error(chalk.bgRed(error));
      reject(error);
    }
  });

module.exports = loadFile;
