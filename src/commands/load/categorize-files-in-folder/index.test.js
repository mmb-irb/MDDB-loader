const categorizeFilesInFolder = require(__dirname);

describe('categorizeFilesInFolder', () => {
  test('basic', async () => {
    const files = await categorizeFilesInFolder(`${__dirname}/__fixtures`);
    expect(files).toEqual({
      allFiles: [
        'md.analysis.xvg',
        'md.dcd',
        'md.imaged.rot.xtc',
        'md.pca.eigenval.xvg',
        'md.pdb',
        'metadata.json',
        'some-file',
      ],
      metadataFile: 'metadata.json',
      pcaFiles: ['md.pca.eigenval.xvg'],
      rawFiles: ['md.imaged.rot.xtc', 'md.pdb'],
      trajectoryFiles: ['md.imaged.rot.xtc'],
      analysisFiles: ['md.analysis.xvg'],
    });
  });
});
