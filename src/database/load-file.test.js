// Tests for loading a file into GridFS and registering it in its project
// getDatabase() connects to a fake Mongo Memory Server in 'test' context
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { Database } = require('mddb-database');
const getDatabase = require('./index');
const Project = require('./project');
// Trajectories are read with Gromacs. The tests give the frames instead
jest.mock('../utils/read-and-parse-trajectory', () => jest.fn());
const readAndParseTrajectory = require('../utils/read-and-parse-trajectory');

describe('loading a file', () => {
    let database;
    let directory;

    beforeAll(async () => {
        // Hide the console output emitted by the fake Mongo Memory Server setup
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            database = await getDatabase();
        } finally {
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-load-file-'));
    }, 60000);

    afterAll(async () => {
        const client = database && database.client;
        if (client && 'close' in client) await client.close();
        if (client && client._mongod) await client._mongod.stop();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    });

    // A project with one MD, in the database and as a handler
    let projects = 0;
    const makeProject = async () => {
        projects += 1;
        const data = {
            _id: new Database.ObjectId(),
            accession: `TESTLF${projects}`,
            published: false,
            metadata: {},
            mds: [{ name: 'replica 1', files: [], analyses: [] }],
            mdref: 0,
            files: [],
            analyses: [],
        };
        await database.projects.insertOne(data);
        return new Project(data, database);
    };

    const makeFile = (name, content) => {
        const filepath = path.join(directory, name);
        fs.writeFileSync(filepath, content);
        return filepath;
    };

    it('registers the file without reading its file document back', async () => {
        const project = await makeProject();
        const filepath = makeFile('small.txt', 'small file content');
        // Every read is one more round trip to MongoDB
        const findOne = jest.spyOn(database.files, 'findOne');
        try {
            await project.loadFile('small.txt', 0, filepath);
            expect(findOne).not.toHaveBeenCalled();
        } finally {
            findOne.mockRestore();
        }
        // The file is in GridFS and registered in the project in MongoDB
        const stored = await database.files.findOne({ filename: 'small.txt', 'metadata.project': project.id });
        expect(stored.length).toBe(18);
        const remote = await database.projects.findOne({ _id: project.id });
        expect(remote.mds[0].files).toEqual([{ name: 'small.txt', id: stored._id }]);
    });

    it('resolves with the acknowledged file document', async () => {
        const filepath = makeFile('document.txt', 'some content');
        const fileDocument = await database.loadFile(filepath, 'document.txt', { md: 0 });
        expect(fileDocument).toMatchObject({ _id: database.currentUploadId, filename: 'document.txt', length: 12, metadata: { md: 0 } });
    });

    it('waits for the file document if the upload did not return it', async () => {
        const project = await makeProject();
        const filepath = makeFile('fallback.txt', 'fallback content');
        const original = database.loadFile;
        const loadFile = jest.spyOn(database, 'loadFile').mockImplementationOnce(async (...args) => {
            await original(...args);
            return undefined;
        });
        const findOne = jest.spyOn(database.files, 'findOne');
        try {
            await project.loadFile('fallback.txt', 0, filepath);
            expect(findOne).toHaveBeenCalledTimes(1);
        } finally {
            loadFile.mockRestore();
            findOne.mockRestore();
        }
        expect(project.data.mds[0].files.map(file => file.name)).toEqual(['fallback.txt']);
    });

    it('rejects if the upload fails, instead of crashing the loader', async () => {
        const filepath = makeFile('failing.txt', 'content which MongoDB rejects');
        // An upload stream whose chunk insert fails
        const openUploadStream = jest.spyOn(database.bucket, 'openUploadStream').mockImplementationOnce(() => {
            const stream = new Writable({ write: (chunk, encoding, callback) => callback(new Error('insert failed')) });
            stream.id = new Database.ObjectId();
            return stream;
        });
        try {
            await expect(database.loadFile(filepath, 'failing.txt', {})).rejects.toThrow('insert failed');
        } finally {
            openUploadStream.mockRestore();
        }
    });

    it('rejects a trajectory with no frames, without registering its deleted file', async () => {
        const project = await makeProject();
        // Gromacs gives no frame
        readAndParseTrajectory.mockImplementationOnce(async function* () {});
        await expect(project.loadTrajectoryFile('trajectory.bin', 0, '/fake/trajectory.xtc', 'gmx', null))
            .rejects.toThrow(/Failed to load any frame/);
        expect(await database.files.countDocuments({ filename: 'trajectory.bin', 'metadata.project': project.id })).toBe(0);
        expect(project.data.mds[0].files).toEqual([]);
    });

    it('loads a trajectory and stores its frames and atoms', async () => {
        const project = await makeProject();
        // Two frames of 3 atoms, of 3 coordinates of 4 bytes each
        readAndParseTrajectory.mockImplementationOnce(async function* (filepath, gromacsCommand, addOneFrame) {
            for (let frame = 0; frame < 2; frame++) {
                addOneFrame();
                yield Buffer.alloc(3 * 3 * 4);
            }
        });
        await project.loadTrajectoryFile('trajectory.bin', 0, '/fake/trajectory.xtc', 'gmx', null);
        const stored = await database.files.findOne({ filename: 'trajectory.bin', 'metadata.project': project.id });
        expect(stored.metadata).toMatchObject({ frames: 2, atoms: 3 });
        expect(project.data.mds[0].files.map(file => file.name)).toEqual(['trajectory.bin']);
    });
});
