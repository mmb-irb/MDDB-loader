const categorizeFilesInFolder = require(__dirname);

describe('categorizeFilesInFolder', () => {
  test('basic', async () => {
    const files = await categorizeFilesInFolder(`${__dirname}/__fixtures`);
    expect(files).toEqual({
      allFiles: ['md.dcd', 'md.pdb', 'md.trj', 'md.xvg', 'some-file'],
      rawFiles: ['md.dcd', 'md.pdb'],
      trajectoryFile: 'md.trj',
      analysisFiles: ['md.xvg'],
    });
  });
});
