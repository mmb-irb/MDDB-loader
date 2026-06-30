// Tests for the loader database handler factory
// getDatabase() connects to mongo (a fake Mongo Memory Server in 'test' context) and
// returns a Database4Loader instance ready to operate on the database
const { Database } = require('mddb-database');
const getDatabase = require('./index');

describe('database getDatabase', () => {
    let database;

    // Connecting spins up a Mongo Memory Server, which can be slow
    // (it may need to download the mongod binary on the first run)
    beforeAll(async () => {
        // By default, Jest sets process.env.NODE_ENV = 'test'
        // Hide the console output emitted by the fake Mongo Memory Server setup
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            database = await getDatabase();
        } finally {
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
    }, 60000);

    afterAll(async () => {
        const client = database && database.client;
        if (client && 'close' in client) await client.close();
        if (client && client._mongod) await client._mongod.stop();
    });

    it('resolves to a connected loader database handler', () => {
        expect(database).toBeDefined();
        // It is a Database subclass set up as a local (non-global) node
        expect(database).toBeInstanceOf(Database);
        expect(database.isGlobal).toBe(false);
        // It starts with no inserted data nor issued accession to revert
        expect(database.inserted_data).toEqual([]);
        expect(database.new_accession_issued).toBe(false);
    });

    it('exposes the seeded collections', async () => {
        // The references collection is exposed under the 'uniprot_refs' key
        expect(await database.projects.countDocuments()).toBe(2);
        expect(await database.uniprot_refs.countDocuments()).toBe(2);
    });

    it('finds a seeded project by its accession', async () => {
        const found = await database.findProject('A0001');
        expect(found).not.toBeNull();
        expect(found.accession).toBe('A0001');
    });

    it('throws when finding a project with no id or accession', async () => {
        await expect(database.findProject()).rejects.toThrow('Missing ID or Accession');
    });

    it('returns null when syncing a non-existing project', async () => {
        expect(await database.syncProject('NONEXISTENT')).toBeNull();
    });

    it('returns a project handler when syncing an existing project', async () => {
        const project = await database.syncProject('A0001');
        expect(project).not.toBeNull();
        expect(project.data.accession).toBe('A0001');
    });
});
