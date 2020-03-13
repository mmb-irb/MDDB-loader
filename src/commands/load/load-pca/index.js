const mathjs = require('mathjs');

const getSpinner = require('../../../utils/get-spinner');
// Read a file and returns its content line by line as a stream
const readFilePerLine = require('../../../utils/read-file-per-line');
// Process data
const statFileLinesToDataLines = require('../../../utils/stat-file-lines-to-data-lines');

// This function mines all pca files and returns data to load() in a standarized format
const loadPCA = async (folder, pcaFiles, spinnerRef) => {
  // Start the console output
  spinnerRef.current = getSpinner().start('Loading PCA analysis');
  // Set the output object, which will be returned at the end of this function
  const output = {
    step: 0,
    y: [],
  };
  // From the  array with all 'pca.' files, find the first which has 'eigenval' on its name
  const eigenvaluesFile = pcaFiles.find(filename =>
    filename.includes('eigenval'),
  );
  // Read the 'eigen' file and mine its data in lines of arrays
  // The 'false' argument stands for ignore commented lines
  // These arrays are meant to have 2 values: the index and the value
  // (e.g.) [ 1 , 45.4333 ] , [ 2 , 30.3418 ] , [ 3 , 11.011 ] ...
  const eigenvalueGenerator = statFileLinesToDataLines(
    readFilePerLine(folder + eigenvaluesFile),
    false,
  );

  // Save in a single array (output.y) all values and keep the last index number
  let maxIndex = 0;
  for await (const [index, eigenvalue] of eigenvalueGenerator) {
    output.y.push({ eigenvalue });
    maxIndex = index;
  }

  // From the array with all 'pca.' files, find all projection ('proj') files
  // Add the folder path to all of them
  const projectionFiles = pcaFiles
    .filter(filename => filename.match(/proj[a-z0-9]*.xvg/))
    .map(filename => folder + filename);

  // Read the projection files and mine their data in lines of arrays
  // The 'true' argument stands for return comment 'Symbol' class in case of commented line
  // These arrays are meant to have 2 fields: the index and the value
  // (e.g.) [ 0 , -7.1438 ] , [ 100 , -6.36336 ] , [ 200 , -6.53322 ] ...
  const projectionGenerator = statFileLinesToDataLines(
    readFilePerLine(projectionFiles),
    true,
  );
  // Add the new yielded data to the output in a specific standarized format
  let currentProjection = 0;
  let startedProcessing = true;
  let currentData;
  for await (const yielded of projectionGenerator) {
    // When a comment 'Symbol' class is yielded
    if (yielded === statFileLinesToDataLines.COMMENT_SYMBOL) {
      // Add +1 to 'currentProjection', which is a component counter
      // Switch the 'startedProcessing' to false so the counter does not increase
      // This switch is reverted to true when normal data is yielded
      // This way, many comments together counts as just 1
      if (startedProcessing) {
        currentProjection++;
        startedProcessing = false;
        // Update the console output with each counter increase
        spinnerRef.current.text = `Loading PCA analysis (projection ${currentProjection} out of ${maxIndex} possible)`;
      }
      continue;
    }
    // When normal data is yielded
    // Extract the index and value
    const [index, value] = yielded;
    // If this is the first time we receive data after receiving symbols
    if (!startedProcessing) {
      // Revert the switch back to true
      startedProcessing = true;
      // Set a new empty array (data) in the next element of the eigen data array (output.y)
      currentData = output.y[currentProjection - 1].data = [];
    }
    // If the output.step is still 0 set it as this index
    // This line will set the output.step to the first index of the array which is not 0
    if (!output.step) output.step = index;
    // Push the new yielded value to the previously created data array
    currentData.push(value);
  }
  // Find all indexes of output.y which contain a 'data' array and add 2 new fields on each:
  // The maximum and the minimum values from the 'data' array
  for (const component of output.y) {
    if (component.data) {
      component.min = mathjs.min(component.data);
      component.max = mathjs.max(component.data);
    }
  }
  // Send success console output
  spinnerRef.current.succeed(
    `Loaded PCA analysis, ${maxIndex} components, ${currentProjection} projections`,
  );
  // Return the results back to load()
  return { name: 'pca', value: output };
};

module.exports = loadPCA;
