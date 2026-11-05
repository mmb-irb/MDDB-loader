// Tests for the delete CLI command
// These run against the fake Mongo Memory Server seeded by mddb-database, which
// includes the project with accession 'A0001' (see fake-mongo/project_2.json)
const { Database } = require('mddb-database');
const getDatabase = require('../../database');
const deleteFunction = require('./index');

// Mock the logger: it uses ora, which (in a TTY) starts a setInterval to animate
// the spinner. A spinner that is still mid-animation when the run finishes keeps
// the event loop alive and makes Jest warn "did not exit one second after...".
// The spinner is console-only decoration, so we stub it out. failLog must keep
// throwing, since the code relies on that to abort on failures.
jest.mock('../../utils/logger', () => ({
    startLog: jest.fn(),
    updateLog: jest.fn(),
    successLog: jest.fn(),
    warnLog: jest.fn(),
    failLog: jest.fn(message => {
        throw new Error(message);
    }),
    logText: jest.fn(),
    logTime: jest.fn(),
    isLogRunning: jest.fn(() => false),
}));

describe('delete command', () => {
    let database;

    beforeAll(async () => {
        // Silence the noisy fake Mongo Memory Server setup logs while connecting
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            database = await getDatabase();
        } finally {
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
        // The fake mongo does not seed the accession counter, and the shared setup()
        // cannot create it here. deleteProject() reads it (getLastAccession), so we
        // seed it manually with a value that does NOT map back to 'A0001', so the
        // deletion does not try to reuse the accession by decrementing the counter.
        await database.counters.insertOne({
            accessions: true,
            last: parseInt('A0001', database.ALPHANUMERIC) + 5,
        });
    }, 60000);

    afterAll(async () => {
        const client = database && database.client;
        if (client && 'close' in client) await client.close();
        if (client && client._mongod) await client._mongod.stop();
    });

    it('does nothing when the accession does not exist', async () => {
        const before = await database.projects.countDocuments();
        // A missing accession is reported but must not throw nor delete anything
        await expect(
            deleteFunction({ id: 'ZZZZZ', confirm: true }, database),
        ).resolves.toBeUndefined();
        expect(await database.projects.countDocuments()).toBe(before);
    });

    it('refuses to delete the last available MD of a project', async () => {
        // 'A0001' has a single MD, so deleting 'A0001.1' must be rejected and
        // the project must remain untouched
        await expect(
            deleteFunction({ id: 'A0001.1', confirm: true }, database),
        ).rejects.toThrow('last available MD');
        expect(await database.findProject('A0001')).not.toBeNull();
    });

    it('does not delete the project when the deletion is not confirmed', async () => {
        const before = await database.projects.countDocuments();
        // A non-confirming answer ('n') makes the command abort after the summary,
        // without prompting the user and without deleting anything
        await expect(
            deleteFunction({ id: 'A0001', confirm: 'n' }, database),
        ).resolves.toBeUndefined();
        expect(await database.findProject('A0001')).not.toBeNull();
        expect(await database.projects.countDocuments()).toBe(before);
    });

    it('deletes a single file and recomputes the project totals', async () => {
        // Build a self-contained fixture: a project with one MD that owns a single
        // GridFS file. Use Database.ObjectId / the bucket from the same mongodb
        // instance the database code uses, so id class checks hold.
        const projectId = new Database.ObjectId();
        const filename = 'deletable_file.txt';
        // Upload a fake file to GridFS, tagged with its parent project and MD index
        const fileId = await new Promise((resolve, reject) => {
            const uploadStream = database.bucket.openUploadStream(filename, {
                metadata: { project: projectId, md: 0 },
            });
            uploadStream.on('error', reject);
            uploadStream.on('finish', () => resolve(uploadStream.id));
            uploadStream.end(Buffer.from('fake file content'));
        });
        // Insert the project that references the uploaded file
        // FRAMESTEP + md.frames let updateTotalTime() actually compute a time
        await database.projects.insertOne({
            _id: projectId,
            accession: 'TESTF',
            published: false,
            metadata: { FRAMESTEP: 0.001 },
            mds: [{ name: 'replica 1', frames: 10, files: [{ name: filename, id: fileId }], analyses: [] }],
            mdref: 0,
            files: [],
            analyses: [],
        });

        // Compute the project size while the file is present: it must be non-zero
        const project = await database.syncProject(projectId);
        await project.updateTotalSize();
        const sizeWithFile = (await database.findProject(projectId)).totalSize;
        expect(sizeWithFile).toBeGreaterThan(0);

        // Delete just the file (by its mongo id, as the coerced CLI would pass it)
        await deleteFunction({ id: fileId, confirm: true }, database);

        // The GridFS file document is gone
        expect(await database.files.findOne({ _id: fileId })).toBeNull();
        // The file reference was removed from the MD
        const updated = await database.findProject(projectId);
        expect(updated.mds[0].files).toHaveLength(0);
        // We reached the end of the command: project totals were recomputed
        // updateTotalSize -> back to 0 bytes (no files left); updateTotalTime -> frames kept
        expect(updated.totalSize).toBe(0);
        expect(updated.totalFrames).toBe(10);
        expect(updated.totalTime).toBeCloseTo(0.01);
    });

    it('removes a project file entry whose GridFS file is already gone', async () => {
        // An interrupted deletion may leave the project pointing to a file which no longer exists
        // Deleting that entry must clean the project instead of failing on every following load
        const projectId = new Database.ObjectId();
        const missingFileId = new Database.ObjectId();
        const filename = 'trajectory.bin';
        await database.projects.insertOne({
            _id: projectId,
            accession: 'TESTM',
            published: false,
            metadata: {},
            mds: [{ name: 'replica 1', files: [{ name: filename, id: missingFileId }], analyses: [] }],
            mdref: 0,
            files: [],
            analyses: [],
        });
        const project = await database.syncProject(projectId);
        await project.deleteFile(filename, 0);
        const updated = await database.findProject(projectId);
        expect(updated.mds[0].files).toHaveLength(0);
        expect(updated.pending_deletions).toBeUndefined();
    });

    it('keeps a record of a file deletion which is interrupted', async () => {
        const projectId = new Database.ObjectId();
        const filename = 'interrupted.bin';
        const fileId = await new Promise((resolve, reject) => {
            const uploadStream = database.bucket.openUploadStream(filename, { metadata: { project: projectId, md: 0 } });
            uploadStream.on('error', reject);
            uploadStream.on('finish', () => resolve(uploadStream.id));
            uploadStream.end(Buffer.from('fake file content'));
        });
        await database.projects.insertOne({
            _id: projectId,
            accession: 'TESTI',
            published: false,
            metadata: {},
            mds: [{ name: 'replica 1', files: [{ name: filename, id: fileId }], analyses: [] }],
            mdref: 0,
            files: [],
            analyses: [],
        });
        const project = await database.syncProject(projectId);
        // Simulate an interruption while the file is being deleted
        const deleteSpy = jest.spyOn(database.bucket, 'delete').mockRejectedValueOnce(new Error('Interrupted'));
        try {
            await expect(project.deleteFile(filename, 0)).rejects.toThrow('Interrupted');
        } finally {
            deleteSpy.mockRestore();
        }
        // The project no longer points to the file, but the deletion is recorded
        const interrupted = await database.findProject(projectId);
        expect(interrupted.mds[0].files).toHaveLength(0);
        expect(interrupted.pending_deletions).toHaveLength(1);
        expect(interrupted.pending_deletions[0]).toMatchObject({ type: 'file', name: filename, id: fileId, md: 0 });
        expect(await database.files.findOne({ _id: fileId })).not.toBeNull();
    });

    it('resumes pending deletions of files and analyses', async () => {
        const projectId = new Database.ObjectId();
        const filename = 'pending.bin';
        const fileId = await new Promise((resolve, reject) => {
            const uploadStream = database.bucket.openUploadStream(filename, { metadata: { project: projectId, md: 0 } });
            uploadStream.on('error', reject);
            uploadStream.on('finish', () => resolve(uploadStream.id));
            uploadStream.end(Buffer.from('fake file content'));
        });
        const { insertedId: analysisId } = await database.analyses.insertOne({ name: 'rmsd', project: projectId, md: 0, value: {} });
        const date = new Date();
        await database.projects.insertOne({
            _id: projectId,
            accession: 'TESTR',
            published: false,
            metadata: {},
            mds: [{ name: 'replica 1', files: [], analyses: [] }],
            mdref: 0,
            files: [],
            analyses: [],
            pending_deletions: [
                { type: 'file', name: filename, id: fileId, md: 0, date },
                { type: 'analysis', name: 'rmsd', id: analysisId, md: 0, date },
                // This one was already deleted when the previous run was interrupted
                { type: 'file', name: 'gone.bin', id: new Database.ObjectId(), md: 0, date },
            ],
        });
        const project = await database.syncProject(projectId);
        await project.resumePendingDeletions();
        expect(await database.files.findOne({ _id: fileId })).toBeNull();
        expect(await database.analyses.findOne({ _id: analysisId })).toBeNull();
        expect((await database.findProject(projectId)).pending_deletions).toBeUndefined();
    });

    // This test is destructive: it removes the 'A0001' project, so it runs last
    it('deletes a whole project by its accession', async () => {
        // The fake project stores its file/analysis ids as plain strings instead of
        // ObjectIds, which makes GridFS deletion throw. Clear those references so the
        // test focuses on the project-level deletion (resolve accession -> confirm ->
        // remove the project document and its unused references).
        await database.projects.updateOne(
            { accession: 'A0001' },
            { $set: { files: [], analyses: [], 'mds.$[].files': [], 'mds.$[].analyses': [] } },
        );
        const before = await database.projects.countDocuments();
        expect(await database.findProject('A0001')).not.toBeNull();
        // Delete the project, confirming so no user prompt is awaited
        await deleteFunction({ id: 'A0001', confirm: true }, database);
        // The project document must be gone
        expect(await database.findProject('A0001')).toBeNull();
        expect(await database.projects.countDocuments()).toBe(before - 1);
    });
});
