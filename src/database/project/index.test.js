// Tests for the project handler
// Importing it transitively imports mddb-database, which (under NODE_ENV=test) opens a
// fake Mongo Memory Server connection at import time, so we close it at the end
const { ObjectId } = require('bson');
const { databaseConnection } = require('mddb-database');
const Project = require('./index');
const { MAX_DOCUMENT_SIZE } = require('../../utils/constants');

describe('Project.checkAnalysisSize', () => {
    const project = new Project({ _id: new ObjectId(), accession: 'TEST00001' }, {});

    afterAll(async () => {
        const client = await databaseConnection;
        if (client && 'close' in client) await client.close();
        if (client && client._mongod) await client._mongod.stop();
    });

    it('accepts an analysis which fits in a MongoDB document', () => {
        const analysis = { name: 'rmsd', value: { data: [1, 2, 3] } };
        expect(() => project.checkAnalysisSize(analysis, 0, '/some/mda.rmsd.json')).not.toThrow();
    });

    it('rejects an analysis which does not fit in a MongoDB document', () => {
        const analysis = { name: 'pca', value: { data: 'x'.repeat(MAX_DOCUMENT_SIZE) } };
        expect(() => project.checkAnalysisSize(analysis, 2, '/some/mda.pca.json')).toThrow(
            /Analysis 'pca' \(MD index 2\) from \/some\/mda\.pca\.json is too large .* 16\.00 MiB/,
        );
    });

    it('does not modify the analysis object', () => {
        const analysis = { name: 'rmsd', value: {} };
        project.checkAnalysisSize(analysis, 0, '/some/mda.rmsd.json');
        expect(analysis).toEqual({ name: 'rmsd', value: {} });
    });
});
