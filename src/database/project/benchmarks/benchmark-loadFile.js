/**
 * Benchmark to measure loadFile upload speed
 * This tests the full file upload pipeline including fs.createReadStream
 * and GridFS upload with the pause/resume backpressure mechanism.
 * 
 * Run with: node src/database/project/benchmark-loadFile.js
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
// Load env from the project root
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
// Use the project's connection function
const connectToMongo = require('../../../utils/connect-to-mongo');

// Test file sizes to benchmark
const TEST_SIZES = [
    { name: '10 MB', size: 10 * 1024 * 1024 },
    { name: '100 MB', size: 100 * 1024 * 1024 },
    { name: '500 MB', size: 500 * 1024 * 1024 },
];

// Create a temporary test file with random data
async function createTestFile(size) {
    const tmpDir = os.tmpdir();
    const filepath = path.join(tmpDir, `benchmark-loadfile-${Date.now()}.bin`);
    
    // Write in chunks to avoid memory issues with large files
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB chunks
    const writeStream = fs.createWriteStream(filepath);
    
    let written = 0;
    while (written < size) {
        const chunkSize = Math.min(CHUNK_SIZE, size - written);
        const chunk = crypto.randomBytes(chunkSize);
        await new Promise((resolve, reject) => {
            writeStream.write(chunk, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        written += chunkSize;
    }
    
    await new Promise(resolve => writeStream.end(resolve));
    return filepath;
}

// Implementation of loadFile from project/index.js (simplified for benchmarking)
async function loadFile(bucket, filename, sourceFilepath) {
    const startTime = Date.now();
    const totalData = fs.statSync(sourceFilepath).size;
    let currentData = 0;
    
    const fileId = await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(sourceFilepath);
        const uploadStream = bucket.openUploadStream(filename, {
            contentType: 'application/octet-stream',
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
        
        readStream.on('error', reject);
        uploadStream.on('error', reject);
        
        readStream.on('data', async data => {
            currentData += data.length;
            readStream.pause();
            // This is the backpressure mechanism from the original loadFile
            uploadStream.write(data, 'utf8', () => {
                readStream.resume();
            });
            if (currentData >= totalData) {
                uploadStream.end(() => {
                    resolve(uploadStream.id);
                });
            }
        });
    });
    
    const elapsed = (Date.now() - startTime) / 1000;
    return { fileId, elapsed, totalData };
}

// Alternative: loadFile without pause/resume (using pipe)
async function loadFilePipe(bucket, filename, sourceFilepath) {
    const startTime = Date.now();
    const totalData = fs.statSync(sourceFilepath).size;
    
    const fileId = await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(sourceFilepath);
        const uploadStream = bucket.openUploadStream(filename, {
            contentType: 'application/octet-stream',
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
        
        readStream.on('error', reject);
        uploadStream.on('error', reject);
        uploadStream.on('finish', () => resolve(uploadStream.id));
        
        readStream.pipe(uploadStream);
    });
    
    const elapsed = (Date.now() - startTime) / 1000;
    return { fileId, elapsed, totalData };
}

// Alternative: loadFile with larger read chunks
async function loadFileLargeChunks(bucket, filename, sourceFilepath) {
    const startTime = Date.now();
    const totalData = fs.statSync(sourceFilepath).size;
    let currentData = 0;
    
    const fileId = await new Promise((resolve, reject) => {
        // Use larger highWaterMark for read stream (1MB instead of default 64KB)
        const readStream = fs.createReadStream(sourceFilepath, {
            highWaterMark: 1024 * 1024 // 1 MB
        });
        const uploadStream = bucket.openUploadStream(filename, {
            contentType: 'application/octet-stream',
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
        
        readStream.on('error', reject);
        uploadStream.on('error', reject);
        
        readStream.on('data', async data => {
            currentData += data.length;
            readStream.pause();
            uploadStream.write(data, 'utf8', () => {
                readStream.resume();
            });
            if (currentData >= totalData) {
                uploadStream.end(() => {
                    resolve(uploadStream.id);
                });
            }
        });
    });
    
    const elapsed = (Date.now() - startTime) / 1000;
    return { fileId, elapsed, totalData };
}

// Alternative: loadFile using write() return value for backpressure
async function loadFileWriteBackpressure(bucket, filename, sourceFilepath) {
    const startTime = Date.now();
    const totalData = fs.statSync(sourceFilepath).size;
    let currentData = 0;
    
    const fileId = await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(sourceFilepath, {
            highWaterMark: 256 * 1024 // 256 KB
        });
        const uploadStream = bucket.openUploadStream(filename, {
            contentType: 'application/octet-stream',
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
        
        readStream.on('error', reject);
        uploadStream.on('error', reject);
        
        readStream.on('data', async data => {
            currentData += data.length;
            const keepGoing = uploadStream.write(data);
            
            if (!keepGoing) {
                readStream.pause();
                uploadStream.once('drain', () => readStream.resume());
            }
            
            if (currentData >= totalData) {
                uploadStream.end(() => {
                    resolve(uploadStream.id);
                });
            }
        });
    });
    
    const elapsed = (Date.now() - startTime) / 1000;
    return { fileId, elapsed, totalData };
}

// Alternative: Large chunks + write() backpressure (best of both)
async function loadFileLargeChunksWriteBackpressure(bucket, filename, sourceFilepath) {
    const startTime = Date.now();
    const totalData = fs.statSync(sourceFilepath).size;
    let currentData = 0;
    
    const fileId = await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(sourceFilepath, {
            highWaterMark: 1024 * 1024 // 1 MB
        });
        const uploadStream = bucket.openUploadStream(filename, {
            contentType: 'application/octet-stream',
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
        
        readStream.on('error', reject);
        uploadStream.on('error', reject);
        
        readStream.on('data', async data => {
            currentData += data.length;
            const keepGoing = uploadStream.write(data);
            
            if (!keepGoing) {
                readStream.pause();
                uploadStream.once('drain', () => readStream.resume());
            }
            
            if (currentData >= totalData) {
                uploadStream.end(() => {
                    resolve(uploadStream.id);
                });
            }
        });
    });
    
    const elapsed = (Date.now() - startTime) / 1000;
    return { fileId, elapsed, totalData };
}

// Alternative: 4MB chunks (matching GridFS chunk size)
async function loadFile4MBChunks(bucket, filename, sourceFilepath) {
    const startTime = Date.now();
    const totalData = fs.statSync(sourceFilepath).size;
    let currentData = 0;
    
    const fileId = await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(sourceFilepath, {
            highWaterMark: 4 * 1024 * 1024 // 4 MB - matching GridFS chunk size
        });
        const uploadStream = bucket.openUploadStream(filename, {
            contentType: 'application/octet-stream',
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
        
        readStream.on('error', reject);
        uploadStream.on('error', reject);
        
        readStream.on('data', async data => {
            currentData += data.length;
            const keepGoing = uploadStream.write(data);
            
            if (!keepGoing) {
                readStream.pause();
                uploadStream.once('drain', () => readStream.resume());
            }
            
            if (currentData >= totalData) {
                uploadStream.end(() => {
                    resolve(uploadStream.id);
                });
            }
        });
    });
    
    const elapsed = (Date.now() - startTime) / 1000;
    return { fileId, elapsed, totalData };
}

// Configurable chunk size test
async function loadFileConfigurable(bucket, filename, sourceFilepath, chunkSize) {
    const startTime = Date.now();
    const totalData = fs.statSync(sourceFilepath).size;
    let currentData = 0;
    
    const fileId = await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(sourceFilepath, {
            highWaterMark: chunkSize
        });
        const uploadStream = bucket.openUploadStream(filename, {
            contentType: 'application/octet-stream',
            chunkSizeBytes: 4 * 1024 * 1024, // 4 MiB
        });
        
        readStream.on('error', reject);
        uploadStream.on('error', reject);
        
        readStream.on('data', async data => {
            currentData += data.length;
            const keepGoing = uploadStream.write(data);
            
            if (!keepGoing) {
                readStream.pause();
                uploadStream.once('drain', () => readStream.resume());
            }
            
            if (currentData >= totalData) {
                uploadStream.end(() => {
                    resolve(uploadStream.id);
                });
            }
        });
    });
    
    const elapsed = (Date.now() - startTime) / 1000;
    return { fileId, elapsed, totalData };
}

async function benchmarkLoadFile() {
    console.log('===========================================');
    console.log('  loadFile Upload Speed Benchmark          ');
    console.log('===========================================\n');
    
    // Connect to MongoDB
    const { client, db, bucket } = await connectToMongo();
    console.log(`Connected to: ${process.env.DB_NAME}\n`);
    
    // Select which test size to use (use smaller for quick tests)
    const testConfig = TEST_SIZES[1]; // 100 MB
    console.log(`Test file size: ${testConfig.name}\n`);
    
    // Create test file
    console.log('Creating test file...');
    const testFilepath = await createTestFile(testConfig.size);
    console.log(`Test file created: ${testFilepath}\n`);
    
    const results = [];
    
    try {
        // Test 1: Original loadFile implementation (pause/resume on every write callback)
        console.log('--- Test 1: Original loadFile (pause/resume every write) ---');
        {
            const { fileId, elapsed, totalData } = await loadFile(
                bucket, 
                'benchmark-loadfile-original', 
                testFilepath
            );
            const throughput = (totalData / 1024 / 1024 / elapsed).toFixed(2);
            console.log(`Time: ${elapsed.toFixed(2)}s`);
            console.log(`Throughput: ${throughput} MB/sec\n`);
            results.push({ test: 'Original (pause/resume)', throughput: parseFloat(throughput) });
            await bucket.delete(fileId);
        }
        
        // Test 2: Using pipe (Node.js handles backpressure automatically)
        console.log('--- Test 2: Using pipe() (automatic backpressure) ---');
        {
            const { fileId, elapsed, totalData } = await loadFilePipe(
                bucket,
                'benchmark-loadfile-pipe',
                testFilepath
            );
            const throughput = (totalData / 1024 / 1024 / elapsed).toFixed(2);
            console.log(`Time: ${elapsed.toFixed(2)}s`);
            console.log(`Throughput: ${throughput} MB/sec\n`);
            results.push({ test: 'Pipe (automatic)', throughput: parseFloat(throughput) });
            await bucket.delete(fileId);
        }
        
        // Test 3: Larger read chunks (1MB highWaterMark)
        console.log('--- Test 3: Larger read chunks (1MB highWaterMark) ---');
        {
            const { fileId, elapsed, totalData } = await loadFileLargeChunks(
                bucket,
                'benchmark-loadfile-largechunks',
                testFilepath
            );
            const throughput = (totalData / 1024 / 1024 / elapsed).toFixed(2);
            console.log(`Time: ${elapsed.toFixed(2)}s`);
            console.log(`Throughput: ${throughput} MB/sec\n`);
            results.push({ test: 'Large chunks (1MB)', throughput: parseFloat(throughput) });
            await bucket.delete(fileId);
        }
        
        // Test 4: Using write() return value for backpressure
        console.log('--- Test 4: write() return value backpressure ---');
        {
            const { fileId, elapsed, totalData } = await loadFileWriteBackpressure(
                bucket,
                'benchmark-loadfile-writebackpressure',
                testFilepath
            );
            const throughput = (totalData / 1024 / 1024 / elapsed).toFixed(2);
            console.log(`Time: ${elapsed.toFixed(2)}s`);
            console.log(`Throughput: ${throughput} MB/sec\n`);
            results.push({ test: 'Write backpressure (256KB)', throughput: parseFloat(throughput) });
            await bucket.delete(fileId);
        }
        
        // Test 5: Large chunks + write backpressure (best of both)
        console.log('--- Test 5: 1MB chunks + write() backpressure ---');
        {
            const { fileId, elapsed, totalData } = await loadFileLargeChunksWriteBackpressure(
                bucket,
                'benchmark-loadfile-1mb-writebackpressure',
                testFilepath
            );
            const throughput = (totalData / 1024 / 1024 / elapsed).toFixed(2);
            console.log(`Time: ${elapsed.toFixed(2)}s`);
            console.log(`Throughput: ${throughput} MB/sec\n`);
            results.push({ test: '1MB + write backpressure', throughput: parseFloat(throughput) });
            await bucket.delete(fileId);
        }
        
        // Test 6: 4MB chunks (matching GridFS chunk size)
        console.log('--- Test 6: 4MB chunks (matching GridFS) ---');
        {
            const { fileId, elapsed, totalData } = await loadFile4MBChunks(
                bucket,
                'benchmark-loadfile-4mb',
                testFilepath
            );
            const throughput = (totalData / 1024 / 1024 / elapsed).toFixed(2);
            console.log(`Time: ${elapsed.toFixed(2)}s`);
            console.log(`Throughput: ${throughput} MB/sec\n`);
            results.push({ test: '4MB chunks', throughput: parseFloat(throughput) });
            await bucket.delete(fileId);
        }
        
        // Test 7-10: Find optimal chunk size
        console.log('--- Chunk Size Sweep ---');
        const chunkSizes = [
            { name: '64KB (default)', size: 64 * 1024 },
            { name: '128KB', size: 128 * 1024 },
            { name: '512KB', size: 512 * 1024 },
        ];
        for (const { name, size } of chunkSizes) {
            console.log(`Testing ${name}...`);
            const { fileId, elapsed, totalData } = await loadFileConfigurable(
                bucket,
                `benchmark-loadfile-${name}`,
                testFilepath,
                size
            );
            const throughput = (totalData / 1024 / 1024 / elapsed).toFixed(2);
            console.log(`  Time: ${elapsed.toFixed(2)}s | Throughput: ${throughput} MB/sec`);
            results.push({ test: name, throughput: parseFloat(throughput) });
            await bucket.delete(fileId);
        }
        console.log('');
        
        // Summary
        console.log('===========================================');
        console.log('  Summary                                  ');
        console.log('===========================================');
        results.sort((a, b) => b.throughput - a.throughput);
        for (const r of results) {
            console.log(`  ${r.test.padEnd(25)} ${r.throughput.toFixed(2)} MB/sec`);
        }
        
    } finally {
        // Cleanup
        console.log('\nCleaning up...');
        fs.unlinkSync(testFilepath);
        await client.close();
        console.log('Done.');
    }
}

benchmarkLoadFile().catch(console.error);

/*
===========================================
  loadFile Upload Speed Benchmark          
===========================================

Connected to: mdposit

Test file size: 100 MB

--- Test 1: Original loadFile (pause/resume every write) ---
Time: 7.12s
Throughput: 14.05 MB/sec

--- Test 2: Using pipe() (automatic backpressure) ---
Time: 4.96s
Throughput: 20.17 MB/sec

--- Test 3: Larger read chunks (1MB highWaterMark) ---
Time: 3.55s
Throughput: 28.14 MB/sec

--- Test 4: write() return value backpressure ---
Time: 7.95s
Throughput: 12.58 MB/sec

--- Test 5: 1MB chunks + write() backpressure ---
Time: 8.80s
Throughput: 11.37 MB/sec

--- Test 6: 4MB chunks (matching GridFS) ---
Time: 6.19s
Throughput: 16.16 MB/sec

--- Chunk Size Sweep ---
Testing 64KB (default)...
  Time: 20.49s | Throughput: 4.88 MB/sec
Testing 128KB...
  Time: 11.75s | Throughput: 8.51 MB/sec
Testing 512KB...
  Time: 4.94s | Throughput: 20.23 MB/sec

===========================================
  Summary                                  
===========================================
  Large chunks (1MB)        28.14 MB/sec   <-- WINNER
  512KB                     20.23 MB/sec
  Pipe (automatic)          20.17 MB/sec
  4MB chunks                16.16 MB/sec
  Original (pause/resume)   14.05 MB/sec
  Write backpressure (256KB) 12.58 MB/sec
  1MB + write backpressure  11.37 MB/sec
  128KB                     8.51 MB/sec
  64KB (default)            4.88 MB/sec

CONCLUSION:
- The original pause/resume backpressure pattern is fine
- The problem is the default 64KB highWaterMark for fs.createReadStream
- Fix: Add { highWaterMark: 1024 * 1024 } to createReadStream options
- This gives ~2x speedup (14 -> 28 MB/sec)
*/
