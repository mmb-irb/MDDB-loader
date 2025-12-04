/**
 * Benchmark to isolate MongoDB GridFS upload speed
 * This tests raw upload speed without any parsing
 * and shows the upper limits of what we can achieve.
 * with the loader.
 * 
 * Run with: node src/utils/read-and-parse-trajectory/benchmark-gridfs.js
 */

const { GridFSBucket } = require('mongodb');
const crypto = require('crypto');
// Load env from the project root
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
// Use the project's connection function
const connectToMongo = require('../connect-to-mongo');

const DATA_SIZE = 100 * 1024 * 1024; // 100 MB test

async function benchmarkGridFS() {
    console.log('===========================================');
    console.log('  GridFS Upload Speed Benchmark            ');
    console.log('===========================================\n');
    
    // Connect to MongoDB using the project's connection
    const { client, db, bucket } = await connectToMongo();
    
    console.log(`Connected to: ${process.env.DB_NAME}`);
    console.log(`Test data size: ${DATA_SIZE / 1024 / 1024} MB\n`);
    
    // Generate random test data
    console.log('Generating random test data...');
    const testData = crypto.randomBytes(DATA_SIZE);
    console.log('Test data generated.\n');
    
    // Test 1: Single large write
    console.log('--- Test 1: Single large write ---');
    {
        const uploadStream = bucket.openUploadStream('benchmark-single-write', {
            chunkSizeBytes: 4 * 1024 * 1024,
        });
        
        const startTime = Date.now();
        await new Promise((resolve, reject) => {
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
            uploadStream.end(testData);
        });
        
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`Time: ${elapsed.toFixed(2)}s`);
        console.log(`Throughput: ${(DATA_SIZE / 1024 / 1024 / elapsed).toFixed(2)} MB/sec\n`);
        
        // Cleanup
        await bucket.delete(uploadStream.id);
    }
    
    // Test 2: Multiple 256KB writes (like our buffered approach)
    console.log('--- Test 2: Multiple 256KB writes ---');
    {
        const uploadStream = bucket.openUploadStream('benchmark-256kb-writes', {
            chunkSizeBytes: 4 * 1024 * 1024,
        });
        
        const CHUNK_SIZE = 256 * 1024;
        const startTime = Date.now();
        let written = 0;
        let drainWaits = 0;
        
        await new Promise(async (resolve, reject) => {
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
            
            while (written < DATA_SIZE) {
                const chunk = testData.subarray(written, Math.min(written + CHUNK_SIZE, DATA_SIZE));
                const keepGoing = uploadStream.write(chunk);
                written += chunk.length;
                
                if (!keepGoing) {
                    drainWaits++;
                    await new Promise(next => uploadStream.once('drain', next));
                }
            }
            uploadStream.end();
        });
        
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`Time: ${elapsed.toFixed(2)}s`);
        console.log(`Drain waits: ${drainWaits}`);
        console.log(`Throughput: ${(DATA_SIZE / 1024 / 1024 / elapsed).toFixed(2)} MB/sec\n`);
        
        await bucket.delete(uploadStream.id);
    }
    
    // Test 3: Multiple 1.2KB writes (like original BATCH_SIZE=100)
    console.log('--- Test 3: Multiple 1.2KB writes (original approach) ---');
    {
        const uploadStream = bucket.openUploadStream('benchmark-1kb-writes', {
            chunkSizeBytes: 4 * 1024 * 1024,
        });
        
        const CHUNK_SIZE = 1200; // ~100 atoms * 12 bytes
        const startTime = Date.now();
        let written = 0;
        let drainWaits = 0;
        let writeCount = 0;
        
        await new Promise(async (resolve, reject) => {
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
            
            while (written < DATA_SIZE) {
                const chunk = testData.subarray(written, Math.min(written + CHUNK_SIZE, DATA_SIZE));
                const keepGoing = uploadStream.write(chunk);
                written += chunk.length;
                writeCount++;
                
                if (!keepGoing) {
                    drainWaits++;
                    await new Promise(next => uploadStream.once('drain', next));
                }
            }
            uploadStream.end();
        });
        
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`Time: ${elapsed.toFixed(2)}s`);
        console.log(`Write calls: ${writeCount}`);
        console.log(`Drain waits: ${drainWaits}`);
        console.log(`Throughput: ${(DATA_SIZE / 1024 / 1024 / elapsed).toFixed(2)} MB/sec\n`);
        
        await bucket.delete(uploadStream.id);
    }
    
    // Test 4: Higher highWaterMark
    console.log('--- Test 4: 256KB writes with higher highWaterMark ---');
    {
        const uploadStream = bucket.openUploadStream('benchmark-high-watermark', {
            chunkSizeBytes: 4 * 1024 * 1024,
        });
        
        // Increase the writable stream's highWaterMark
        uploadStream.writableHighWaterMark; // Check default
        
        const CHUNK_SIZE = 256 * 1024;
        const startTime = Date.now();
        let written = 0;
        let drainWaits = 0;
        
        await new Promise(async (resolve, reject) => {
            uploadStream.on('finish', resolve);
            uploadStream.on('error', reject);
            
            while (written < DATA_SIZE) {
                const chunk = testData.subarray(written, Math.min(written + CHUNK_SIZE, DATA_SIZE));
                const keepGoing = uploadStream.write(chunk);
                written += chunk.length;
                
                if (!keepGoing) {
                    drainWaits++;
                    await new Promise(next => uploadStream.once('drain', next));
                }
            }
            uploadStream.end();
        });
        
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`Default highWaterMark: ${uploadStream.writableHighWaterMark}`);
        console.log(`Time: ${elapsed.toFixed(2)}s`);
        console.log(`Drain waits: ${drainWaits}`);
        console.log(`Throughput: ${(DATA_SIZE / 1024 / 1024 / elapsed).toFixed(2)} MB/sec\n`);
        
        await bucket.delete(uploadStream.id);
    }
    
    await client.close();
}

benchmarkGridFS().catch(console.error);

/*
===========================================
  GridFS Upload Speed Benchmark            
===========================================

Connected to: mdposit
Test data size: 100 MB

Generating random test data...
Test data generated.

--- Test 1: Single large write ---
Time: 1.73s
Throughput: 57.90 MB/sec

--- Test 2: Multiple 256KB writes ---
Time: 3.23s
Drain waits: 25
Throughput: 31.00 MB/sec

--- Test 3: Multiple 1.2KB writes (original approach) ---
Time: 3.22s
Write calls: 87382
Drain waits: 25
Throughput: 31.07 MB/sec

--- Test 4: 256KB writes with higher highWaterMark ---
Default highWaterMark: 16384
Time: 3.11s
Drain waits: 25
Throughput: 32.11 MB/sec
*/