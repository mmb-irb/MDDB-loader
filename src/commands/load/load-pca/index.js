const mathjs = require('mathjs');

const getSpinner = require('../../../utils/get-spinner');
const readFilePerLine = require('../../../utils/read-file-per-line');
const statFileLinesToDataLines = require('../../../utils/stat-file-lines-to-data-lines');

const loadPCA = async (folder, pcaFiles, spinnerRef) => {
  spinnerRef.current = getSpinner().start('Loading PCA analysis');

  const output = {
    step: 0,
    y: [],
  };

  const eigenvaluesFile = pcaFiles.find(filename =>
    filename.includes('eigenval'),
  );
  const eigenvalueGenerator = statFileLinesToDataLines(
    readFilePerLine(folder + eigenvaluesFile),
  );
  let maxIndex = 0;
  for await (const [index, eigenvalue] of eigenvalueGenerator) {
    output.y.push({ eigenvalue });
    maxIndex = index;
  }

  const projectionFile = pcaFiles.find(filename => filename.includes('proj'));
  const projectionGenerator = statFileLinesToDataLines(
    readFilePerLine(folder + projectionFile),
    { emitCommentSymbol: true },
  );
  let currentComponent = 0;
  let maxComponent = 0;
  let startedProcessing = true;
  let currentData;
  for await (const yielded of projectionGenerator) {
    if (yielded === statFileLinesToDataLines.COMMENT_SYMBOL) {
      if (startedProcessing) {
        currentComponent++;
        startedProcessing = false;
        spinnerRef.current.text = `Loading PCA analysis (projection ${currentComponent} out of ${maxIndex} possible)`;
      }
      continue;
    }
    const [index, value] = yielded;
    if (!startedProcessing) {
      startedProcessing = true;
      currentData = output.y[currentComponent - 1].data = [];
      maxComponent = currentComponent;
    }
    if (!output.step) output.step = index;
    currentData.push(value);
  }

  for (const component of output.y) {
    if (component.data) {
      component.min = mathjs.min(component.data);
      component.max = mathjs.max(component.data);
    }
  }

  spinnerRef.current.succeed(
    `Loaded PCA analysis, ${maxIndex} components, ${maxComponent} projections`,
  );

  return output;
};

module.exports = loadPCA;
