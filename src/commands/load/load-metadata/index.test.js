const loadMetadata = require(__dirname);

describe('loadMetadata', () => {
  const spinnerRef = { current: null };
  test('basic', async () => {
    expect(
      await loadMetadata(`${__dirname}/__fixtures`, spinnerRef),
    ).toMatchSnapshot();
  });
});
