// The xtc decoder against the reader of GROMACS on frames made at random, which reach every size and limit of the format
// The frames come from fuzz.js and are always the same. What GROMACS reads from them is in fixtures/fuzz.json, as a hash
// for every batch of 500 frames, so this test needs no GROMACS. generate-fuzz.js makes that file with the code of GROMACS
const { makeFrames, readFrame, hashBatch } = require('./fuzz');
const expected = require('./fixtures/fuzz.json');

describe(`xtc decoder with frames made at random (GROMACS ${expected.gromacs})`, () => {
    // The frames of every batch, made once for all tests
    let batches;
    beforeAll(() => (batches = expected.batches.map(({ seed }) => makeFrames(seed))));

    // If a batch differs, generate-fuzz.js tells which of its frames does and what is wrong with it
    it.each([[true, 'the fast decoder for the usual frames'], [false, 'the general decoder alone']])(
        'reads what GROMACS reads and refuses what GROMACS cannot read (fast decoder: %s)',
        fast => {
            const results = batches.map((frames, i) => {
                const coordinates = frames.map(frame => readFrame(frame, fast));
                return { seed: expected.batches[i].seed, read: coordinates.filter(Boolean).length, hash: hashBatch(coordinates) };
            });
            expect(results).toEqual(expected.batches);
        },
    );

    it('has enough frames of both kinds', () => {
        const read = expected.batches.reduce((sum, batch) => sum + batch.read, 0);
        expect(batches.flat().length).toBe(60000);
        // About two thirds are read. The rest are refused, as GROMACS would read out of bounds with them
        expect(read).toBe(40642);
    });
});
