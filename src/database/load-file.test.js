// Tests for loading a file into GridFS and registering it in its project
// getDatabase() connects to a fake Mongo Memory Server in 'test' context
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { Database } = require('mddb-database');
const getDatabase = require('./index');
const Project = require('./project');
// Trajectories are decoded in a worker thread. The tests give the frames instead
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

    // Stopping the Mongo Memory Server after the big test files can take a while
    afterAll(async () => {
        const client = database && database.client;
        if (client && 'close' in client) await client.close();
        if (client && client._mongod) await client._mongod.stop();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }, 60000);

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

    // Record the size of every write of the next upload stream and the most chunk inserts in flight at once
    // With "failInsert", that chunk insert (1 for the first) fails
    const watchNextUpload = ({ failInsert } = {}) => {
        let inserts = 0;
        const writes = [];
        const inFlight = { now: 0, most: 0 };
        let chunksCollection;
        const original = database.bucket.openUploadStream.bind(database.bucket);
        const openUploadStream = jest.spyOn(database.bucket, 'openUploadStream').mockImplementationOnce((...args) => {
            const stream = original(...args);
            chunksCollection = stream.chunks;
            const write = stream.write.bind(stream);
            stream.write = (chunk, ...rest) => {
                writes.push(chunk.length);
                return write(chunk, ...rest);
            };
            const insertOne = stream.chunks.insertOne.bind(stream.chunks);
            stream.chunks.insertOne = async (...insertArgs) => {
                inFlight.now += 1;
                inFlight.most = Math.max(inFlight.most, inFlight.now);
                inserts += 1;
                try {
                    if (inserts === failInsert) throw new Error('insert failed');
                    return await insertOne(...insertArgs);
                } finally {
                    inFlight.now -= 1;
                }
            };
            return stream;
        });
        return { writes, inFlight, restore: () => {
            openUploadStream.mockRestore();
            // The wrapped insertOne is set on the collection object, shared by the next uploads
            if (chunksCollection) delete chunksCollection.insertOne;
        } };
    };

    it('writes a big file 4 chunks at a time, with its chunks in order', async () => {
        // 37 MiB: 9 full chunks of 4 MiB and one of 1 MiB
        const content = crypto.randomBytes(37 * 1024 * 1024);
        const filepath = makeFile('big.bin', content);
        const watch = watchNextUpload();
        let fileDocument;
        try {
            fileDocument = await database.loadFile(filepath, 'big.bin', {});
        } finally {
            watch.restore();
        }
        expect(watch.inFlight.most).toBe(4);
        const chunks = await database.db.collection('fs.chunks')
            .find({ files_id: fileDocument._id }, { projection: { n: 1 } }).sort({ n: 1 }).toArray();
        expect(chunks.map(chunk => chunk.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        // The file reads back as it was
        const downloaded = [];
        for await (const piece of database.bucket.openDownloadStream(fileDocument._id)) downloaded.push(piece);
        expect(Buffer.concat(downloaded).equals(content)).toBe(true);
    });

    it('loads an empty file and files of exactly 4 and 16 MiB', async () => {
        // An empty file gives no data to read, so the upload must end on the end of the file
        const empty = await database.loadFile(makeFile('empty.txt', ''), 'empty.txt', {});
        expect(empty.length).toBe(0);
        for (const mebibytes of [4, 16]) {
            const name = `exact-${mebibytes}.bin`;
            const fileDocument = await database.loadFile(makeFile(name, Buffer.alloc(mebibytes * 1024 * 1024, 1)), name, {});
            expect(fileDocument.length).toBe(mebibytes * 1024 * 1024);
            const chunks = await database.db.collection('fs.chunks').countDocuments({ files_id: fileDocument._id });
            expect(chunks).toBe(mebibytes / 4);
        }
    });

    it('deletes the chunks of an upload which fails in the middle', async () => {
        // 13 MiB: one write of 4 chunks, whose second insert fails while the others land
        const filepath = makeFile('failing-chunk.bin', crypto.randomBytes(13 * 1024 * 1024));
        const watch = watchNextUpload({ failInsert: 2 });
        try {
            await expect(database.loadFile(filepath, 'failing-chunk.bin', {})).rejects.toThrow('insert failed');
        } finally {
            watch.restore();
        }
        const id = database.currentUploadId;
        expect(await database.db.collection('fs.chunks').countDocuments({ files_id: id })).toBe(0);
        expect(await database.files.countDocuments({ _id: id })).toBe(0);
    });

    it('writes a trajectory 4 chunks at a time, gathering its small pieces', async () => {
        const project = await makeProject();
        // 1707 frames of 1024 atoms, 12 KiB each, as the trajectory reader gives them: about 20 MiB
        const frameBytes = 1024 * 3 * 4;
        readAndParseTrajectory.mockImplementationOnce(async function* (filepath, gromacsCommand, addOneFrame) {
            for (let frame = 0; frame < 1707; frame++) {
                addOneFrame();
                yield Buffer.alloc(frameBytes, frame % 256);
            }
        });
        const watch = watchNextUpload();
        try {
            await project.loadTrajectoryFile('trajectory.bin', 0, '/fake/trajectory.xtc', 'gmx', null);
        } finally {
            watch.restore();
        }
        // Every write but the last one has at least 4 chunks
        expect(watch.writes.slice(0, -1).every(size => size >= 16 * 1024 * 1024)).toBe(true);
        expect(watch.writes.reduce((sum, size) => sum + size, 0)).toBe(1707 * frameBytes);
        const stored = await database.files.findOne({ filename: 'trajectory.bin', 'metadata.project': project.id });
        expect(stored.metadata).toMatchObject({ frames: 1707, atoms: 1024 });
        // 20,975,616 bytes: 5 full chunks and a small one
        expect(await database.db.collection('fs.chunks').countDocuments({ files_id: stored._id })).toBe(6);
    });

    it('rejects a trajectory with no frames, without registering its deleted file', async () => {
        const project = await makeProject();
        // The trajectory reader gives no frame
        readAndParseTrajectory.mockImplementationOnce(async function* () {});
        await expect(project.loadTrajectoryFile('trajectory.bin', 0, '/fake/trajectory.xtc', 'gmx', null))
            .rejects.toThrow(/Failed to load any frame/);
        expect(await database.files.countDocuments({ filename: 'trajectory.bin', 'metadata.project': project.id })).toBe(0);
        expect(project.data.mds[0].files).toEqual([]);
    });

    it('rejects a trajectory which cannot be read to the end, deleting the chunks already written', async () => {
        const project = await makeProject();
        // 3 frames of 8 MiB, enough to write 4 chunks, and then the file turns out to be damaged
        readAndParseTrajectory.mockImplementationOnce(async function* (filepath, gromacsCommand, addOneFrame) {
            for (let frame = 0; frame < 3; frame++) {
                addOneFrame();
                yield Buffer.alloc(8 * 1024 * 1024, frame);
            }
            throw new Error('Wrong magic number in xtc file');
        });
        const watch = watchNextUpload();
        try {
            await expect(project.loadTrajectoryFile('trajectory.bin', 0, '/fake/trajectory.xtc', 'gmx', null))
                .rejects.toThrow('Wrong magic number in xtc file');
        } finally {
            watch.restore();
        }
        // Chunks were written before the failure and none is left
        expect(watch.writes.length).toBeGreaterThan(0);
        const id = database.currentUploadId;
        expect(await database.db.collection('fs.chunks').countDocuments({ files_id: id })).toBe(0);
        expect(await database.files.countDocuments({ _id: id })).toBe(0);
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
