// Minimal tests for the load CLI command
// These exercise the input-validation guards at the top of load(), which throw
// before any real I/O happens. The database is a lightweight stub: the guards
// only need setup() to resolve, so there is no need for a (fake) mongo here.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Importing the load command transitively imports mddb-database, which (under
// NODE_ENV=test) opens a fake Mongo Memory Server connection at import time.
// We grab that connection here so we can close it in afterAll and let Jest exit.
const { databaseConnection } = require('mddb-database');
const load = require('./index');

describe('load command input validation', () => {
    let projectDir;
    // A stub database whose setup() resolves; we also track that load() calls it
    let database;

    beforeAll(() => {
        // Create an empty, accessible project directory so directoryCoerce() succeeds
        // and findMdDirectories() simply returns no MD directories
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-test-'));
    });

    afterAll(async () => {
        fs.rmSync(projectDir, { recursive: true, force: true });
        // Close the fake mongo connection opened when mddb-database was imported
        const client = await databaseConnection;
        if (client && 'close' in client) await client.close();
        if (client && client._mongod) await client._mongod.stop();
    });

    beforeEach(() => {
        database = { setup: jest.fn().mockResolvedValue(undefined) };
    });

    // Build the command arguments, skipping trajectories so Gromacs is not required
    const args = extra => ({ pdir: projectDir, skipTrajectories: true, ...extra });

    it('runs the database setup before validating', async () => {
        // include: [] makes it throw, but only after setup() has been called
        await expect(load(args({ include: [] }), database)).rejects.toThrow();
        expect(database.setup).toHaveBeenCalledTimes(1);
    });

    it('throws when the include option is passed empty', async () => {
        await expect(load(args({ include: [] }), database)).rejects.toThrow(
            "The 'include' option is empty",
        );
    });

    it('throws when the exclude option is passed empty', async () => {
        await expect(load(args({ exclude: [] }), database)).rejects.toThrow(
            "The 'exclude' option is empty",
        );
    });

    it('throws when include and exclude are used together', async () => {
        await expect(
            load(args({ include: ['*.json'], exclude: ['*.xtc'] }), database),
        ).rejects.toThrow("not compatible");
    });

    it('throws when no files match the include option', async () => {
        // The empty directory contains nothing matching the pattern
        await expect(load(args({ include: ['*.json'] }), database)).rejects.toThrow(
            'No files were found among included',
        );
    });
});
