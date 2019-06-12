const loadAnalysis = require(__dirname);

const analyses = [['rgyr', 'rgyr'], ['rmsd', 'rmsd'], ['rmsf', 'fluctuation']];

describe('loadAnalysis', () => {
  for (const [type, name] of analyses) {
    test(name, async () => {
      const analysis = await loadAnalysis(
        `${__dirname}/__fixtures/`,
        `md.${type}.xvg`,
      );
      expect(analysis.name).toBe(name);
      expect(analysis.value).toMatchSnapshot();
    });
  }
  test('unsupported analysis', () => {
    expect(
      loadAnalysis(`${__dirname}/__fixtures/`, 'md.unsupported.xvg'),
    ).resolves.toBeUndefined();
  });
});
