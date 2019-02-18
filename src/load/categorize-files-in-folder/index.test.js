const categorizeFilesInFolder = require(__dirname);

describe('categorizeFilesInFolder', () => {
  test('basic', async () => {
    const files = await categorizeFilesInFolder(`${__dirname}/__fixtures`);
    expect(files).toEqual({
      allFiles: [
        'md.dcd',
        'md.imaged.rot.xtc',
        'md.pdb',
        'md.xvg',
        'some-file',
      ],
      rawFiles: ['md.pdb'],
      trajectoryFile: 'md.imaged.rot.xtc',
      analysisFiles: ['md.xvg'],
    });
  });
});
