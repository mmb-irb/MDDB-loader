// Tests for the discovery of files to be loaded
const fs = require('fs');
const os = require('os');
const path = require('path');

const findAllFiles = require('./index');
const { findMdDirectories } = require('../handle-directories');

describe('findAllFiles', () => {
    let projectDir;

    beforeAll(() => {
        // Build a project with one MD directory and several incomplete directories left by the workflow
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-files-test-')) + '/';
        const touch = file => {
            fs.mkdirSync(path.dirname(projectDir + file), { recursive: true });
            fs.writeFileSync(projectDir + file, '');
        };
        touch('metadata.json');
        touch('extra/mda.project.json');
        touch('incomplete_extra/mda.partial.json');
        touch('replica_1/.register.json');
        touch('replica_1/mda.rmsd.json');
        touch('replica_1/sub/mda.pca.json');
        touch('replica_1/incomplete_rgyr/mda.rgyr.json');
        touch('incomplete_replica_2/.register.json');
        touch('incomplete_replica_2/mda.rmsd.json');
    });

    afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }));

    // Hide the warnings about skipped directories
    beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    it('does not take incomplete directories as MD directories', () => {
        expect(findMdDirectories(projectDir)).toEqual([path.normalize(projectDir + 'replica_1')]);
    });

    it('skips files inside incomplete directories', () => {
        const mdirs = findMdDirectories(projectDir);
        const [projectFiles, mdFiles] = findAllFiles(projectDir, mdirs);
        expect(projectFiles).toContain('extra/mda.project.json');
        expect(projectFiles).not.toContain('incomplete_extra/mda.partial.json');
        expect(projectFiles).not.toContain('incomplete_replica_2/mda.rmsd.json');
        const replicaFiles = mdFiles[mdirs[0]];
        expect(replicaFiles).toContain('mda.rmsd.json');
        expect(replicaFiles).toContain('sub/mda.pca.json');
        expect(replicaFiles).not.toContain('incomplete_rgyr/mda.rgyr.json');
    });

    it('warns about every skipped directory', () => {
        findAllFiles(projectDir, findMdDirectories(projectDir));
        const warnings = console.log.mock.calls.map(call => call[0]).join('\n');
        expect(warnings).toContain('incomplete_extra');
        expect(warnings).toContain('incomplete_replica_2');
        expect(warnings).toContain('incomplete_rgyr');
    });
});
