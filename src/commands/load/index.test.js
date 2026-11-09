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

describe('load command frames check for new MDs', () => {
    let projectDir;

    // Write a project with one MD directory whose metadata is the given one
    const writeProject = mdMetadata => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-frames-test-'));
        fs.writeFileSync(path.join(projectDir, 'metadata.json'), JSON.stringify({}));
        fs.writeFileSync(path.join(projectDir, 'topology.json'), JSON.stringify({}));
        const mdDir = path.join(projectDir, 'replica_1');
        fs.mkdirSync(mdDir);
        fs.writeFileSync(path.join(mdDir, 'metadata.json'), JSON.stringify(mdMetadata));
        fs.writeFileSync(path.join(mdDir, 'structure.pdb'), '');
        fs.writeFileSync(path.join(mdDir, 'trajectory.xtc'), '');
    };

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    // A project stub whose first write fails with a sentinel error
    // Reaching it means the frames check passed
    const projectStub = mdNames => ({
        data: { accession: 'TEST', mds: mdNames.map(name => ({ name })) },
        findMDIndexByName: name => {
            const index = mdNames.indexOf(name);
            return index === -1 ? null : index;
        },
        resumePendingDeletions: jest.fn().mockRejectedValue(new Error('passed the check')),
    });

    const makeDatabase = existingProject => ({
        setup: jest.fn().mockResolvedValue(undefined),
        syncProject: jest.fn().mockResolvedValue(existingProject),
        createProject: jest.fn().mockRejectedValue(new Error('passed the check')),
    });

    const args = () => ({ pdir: projectDir, mdirs: ['replica_1'], accession: 'TEST', skipTrajectories: true });

    it('stops before creating a new project when an MD has no frames', async () => {
        writeProject({ name: 'replica 1' });
        const database = makeDatabase(null);
        await expect(load(args(), database)).rejects.toThrow("Missing 'frames'");
        expect(database.createProject).not.toHaveBeenCalled();
    });

    it('creates a new project when all MDs have frames', async () => {
        writeProject({ name: 'replica 1', frames: 10 });
        const database = makeDatabase(null);
        await expect(load(args(), database)).rejects.toThrow('passed the check');
        expect(database.createProject).toHaveBeenCalledTimes(1);
    });

    it('stops before writing when a new MD in an existing project has no frames', async () => {
        writeProject({ name: 'replica 2' });
        const project = projectStub(['replica 1']);
        await expect(load(args(), makeDatabase(project))).rejects.toThrow("Missing 'frames'");
        expect(project.resumePendingDeletions).not.toHaveBeenCalled();
    });

    it('does not require frames for MDs already in the project', async () => {
        writeProject({ name: 'replica 1' });
        const project = projectStub(['replica 1']);
        await expect(load(args(), makeDatabase(project))).rejects.toThrow('passed the check');
    });
});
