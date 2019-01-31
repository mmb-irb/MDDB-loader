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
    const firstLine = await asyncGenerator.next();
    expect(firstLine.value).toEqual(expected[0]);
    const secondLine = await asyncGenerator.next();
    expect(secondLine.value).toEqual(expected[1]);
    const end = await asyncGenerator.next();
    expect(end.value).toBeUndefined();
    expect(end.done).toBe(true);
  });
});
