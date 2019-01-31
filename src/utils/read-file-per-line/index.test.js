const readFilePerLine = require(__dirname);

describe('readFilePerLine', () => {
  test('basic', async () => {
    {
      const asyncGenerator = readFilePerLine(
        `${__dirname}/__fixtures/test-file-2.txt`,
      );
      let line = await asyncGenerator.next();
      expect(line.value).toBe('some text');
      line = await asyncGenerator.next();
      expect(line.value).toBeUndefined();
      expect(line.done).toBe(true);
    }

    {
      const asyncGenerator = readFilePerLine(
        `${__dirname}/__fixtures/test-file-3.txt`,
      );
      let line = await asyncGenerator.next();
      expect(line.value).toBe('some text');
      line = await asyncGenerator.next();
      expect(line.value).toBe('');
      line = await asyncGenerator.next();
      expect(line.value).toBe('some more');
      line = await asyncGenerator.next();
      expect(line.value).toBeUndefined();
      expect(line.done).toBe(true);
    }
  });

  test('edge cases', async () => {
    const edgeCases = [
      `${__dirname}/__fixtures/test-file-1.txt`,
      undefined,
      null,
      '',
    ];
    for (const edgeCase of edgeCases) {
      const asyncGenerator = readFilePerLine(edgeCase);
      let line = await asyncGenerator.next();
      expect(line.value).toBeUndefined();
      expect(line.done).toBe(true);
    }
  });
});
