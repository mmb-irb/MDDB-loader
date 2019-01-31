const loadMetadata = require(__dirname);

describe('loadMetadata', () => {
  test('basic', async () => {
    expect(await loadMetadata(`${__dirname}/__fixtures`)).toMatchSnapshot();
  });
});
