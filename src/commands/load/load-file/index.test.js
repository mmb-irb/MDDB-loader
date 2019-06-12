const loadFile = require(__dirname);

describe('loadFile', () => {
  test('success', async () => {
    expect(
      loadFile(`${__dirname}/__fixtures/`, 'test-file.dat', undefined, true),
    ).resolves.toBeUndefined();
  });

  test.skip('error', async () => {
    expect(
      loadFile(`${__dirname}/__fixtures/`, 'not-a-file', undefined, true),
    ).rejects.toBeUndefined();
    expect(
      loadFile(`${__dirname}/`, '__fixtures', undefined, true),
    ).rejects.toBeUndefined();
    expect(
      loadFile(undefined, undefined, undefined, true),
    ).rejects.toBeInstanceOf(Error);
  });
});
