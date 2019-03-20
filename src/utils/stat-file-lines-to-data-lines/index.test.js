const statFileToDataLines = require(__dirname);

describe('statFileToDataLines', () => {
  test('basic', async () => {
    const fileLines = [
      '# Gromacs Runs One Microsecond At Cannonball Speeds',
      '@    title "Radius of gyration (total and around axes)"',
      '',
      '         0      2.6359      2.2906     2.10045     2.05846',
      '        10     2.66498     2.31907     2.11922      2.0821',
    ];
    const expected = [
      [0, 2.6359, 2.2906, 2.10045, 2.05846],
      [10, 2.66498, 2.31907, 2.11922, 2.0821],
    ];
    const asyncGenerator = statFileToDataLines(fileLines);
    let line = await asyncGenerator.next();
    expect(line.value).toEqual(expected[0]);
    line = await asyncGenerator.next();
    expect(line.value).toEqual(expected[1]);
    line = await asyncGenerator.next();
    expect(line.value).toBeUndefined();
    expect(line.done).toBe(true);
  });

  test('edge cases where no data', async () => {
    const edgeCases = [undefined, null, [], [''], ['    '], ['@ comment']];
    for (const edgeCase of edgeCases) {
      const asyncGenerator = statFileToDataLines(edgeCase);
      const end = await asyncGenerator.next();
      expect(end.value).toBeUndefined();
      expect(end.done).toBe(true);
    }
  });
});
