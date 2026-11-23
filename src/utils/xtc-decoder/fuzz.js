// Compressed xtc frames made at random, to test the decoder where files written by GROMACS do not reach
// The same seed gives the same frames. They are not what GROMACS writes: their headers have every size and limit
// the decoder handles (and some it must refuse), and their data follows the layout of the format with any numbers in it,
// sometimes damaged. What the reader of GROMACS gets from them is in fixtures/fuzz.json: see generate-fuzz.js
const crypto = require('crypto');
const { frameBytes, decodeFrame, XtcError } = require('.');
const { random } = require('./generate-fixtures');

// Frames in every batch of fixtures/fuzz.json, which has a hash per batch
const FRAMES_PER_BATCH = 500;

// Writes bits one after the other, the most significant first, as GROMACS does (sendbits)
class BitWriter {
    constructor() {
        this.bytes = [];
        // Bits that do not make a byte yet, and how many they are
        this.pending = 0;
        this.count = 0;
    }
    // Write the "count" lowest bits of a number (up to 32)
    put(value, count) {
        this.pending = this.pending * 2 ** count + ((value >>> 0) % 2 ** count);
        this.count += count;
        while (this.count >= 8) {
            this.count -= 8;
            const byte = Math.floor(this.pending / 2 ** this.count);
            this.bytes.push(byte);
            this.pending -= byte * 2 ** this.count;
        }
    }
    // Write "count" random bits as GROMACS writes ints packed together (sendints): byte by byte and then the bits left
    // For random bits the order of the bytes makes no difference, but the pieces must be these
    putPacked(rng, count) {
        for (; count > 8; count -= 8) this.put(rng() * 256, 8);
        this.put(rng() * 256, count);
    }
    finish() {
        if (this.count) this.bytes.push(this.pending * 2 ** (8 - this.count));
        return Uint8Array.from(this.bytes);
    }
}

const pick = (rng, options) => options[Math.floor(rng() * options.length)];
const integer = (rng, low, high) => low + Math.floor(rng() * (high - low + 1));
// A number with exactly this many bits
const withBits = (rng, bits) => (bits <= 0 ? 0 : 2 ** (bits - 1) + Math.floor(rng() * 2 ** (bits - 1)));

// sizeofint of GROMACS: bits to store an int32 smaller than size, with its oddities (0 if negative, 32 from 2^30)
const sizeOfInt = size => {
    let num = 1;
    let bits = 0;
    for (; size >= num && bits < 32; num <<= 1) bits++;
    return bits;
};

const INT_LIMITS = [0, 1, -1, 2147483647, -2147483648, 16777216, -16777216, 1073741824, -1073741824];
const SIZE_LIMITS = [1, 2, 255, 256, 65535, 65536, 0xfffffe, 0xffffff, 0x1000000, 0x1000001];
const PRECISIONS = [1, 10, 100, 1000, 1000, 1000, 10000, 100000, 1e6, 1e7, 1e8, 3, 500, 1234, 100007];
const BAD_PRECISIONS = [0, -1000, NaN, Infinity, -Infinity, 1e-45, 1e-39, 3e38];
// Packed bits and small sizes around the limits of the decoder: the pieces of 24 bits, the fast decoder, the end of the table
const PACKED_BITS = [1, 8, 9, 16, 17, 23, 24, 25, 32, 33, 47, 48, 49, 51, 52, 53, 54, 55, 64, 71, 72];
const SMALLIDX = [9, 9, 10, 16, 17, 24, 25, 32, 33, 47, 48, 49, 50, 64, 65, 66, 70, 71, 72, 73];
const BAD_SMALLIDX = [-1, 0, 5, 8, 74, 100];

// The 3 sizes of a frame, that is the ranges of its ints in x, y and z
const makeSizes = rng => {
    const kind = rng();
    // Usual sizes: a box of a few nm
    if (kind < 0.25) return [0, 0, 0].map(() => integer(rng, 1, 5000));
    // Sizes whose product has about some number of bits, any from 1 to 72
    if (kind < 0.65) {
        const total = rng() < 0.6 ? pick(rng, PACKED_BITS) : integer(rng, 1, 72);
        const bits = [0, 0, 0];
        for (let left = total; left > 0; left--) {
            const candidates = [0, 1, 2].filter(i => bits[i] < 24);
            bits[pick(rng, candidates)]++;
        }
        return bits.map(count => Math.max(1, withBits(rng, count)));
    }
    // Sizes at the limit between ints packed together and ints stored one by one
    if (kind < 0.8) return [0, 0, 0].map(() => pick(rng, SIZE_LIMITS));
    // Ints stored one by one: a size of 25 to 32 bits, or more than one
    if (kind < 0.95) {
        const sizes = [0, 0, 0].map(() => withBits(rng, integer(rng, 1, 32)));
        sizes[integer(rng, 0, 2)] = pick(rng, [withBits(rng, integer(rng, 25, 32)), 0x1000000, 2 ** 29, 2 ** 30 - 1, 2 ** 30, 2 ** 31 - 1]);
        return sizes;
    }
    // Sizes no frame should have: 0, or a maximum under the minimum
    return [0, 0, 0].map(() => pick(rng, [0, 0, 1, 300, -5, 2 ** 31, 2 ** 32 - 1]));
};

// The compressed data of a frame: for every atom its 3 ints, the bit and the 5 bits that change the run length,
// and the small differences of the atoms of the run. All with random numbers, which is what compressed data looks like
const makeData = (rng, natoms, sizes, smallidx) => {
    const writer = new BitWriter();
    const packed = sizes.every(size => size >= 1 && size <= 0xffffff);
    const packedBits = packed ? (BigInt(sizes[0]) * BigInt(sizes[1]) * BigInt(sizes[2])).toString(2).length : 0;
    const bits = sizes.map(size => sizeOfInt(size | 0));
    // Some frames keep to what GROMACS would write, others do anything
    const tidy = rng() < 0.8;
    let run = 0;
    for (let atoms = 0; atoms < natoms; ) {
        if (packed) writer.putPacked(rng, packedBits);
        else for (const count of bits) writer.put(rng() * 2 ** 32, count);
        atoms++;
        const left = natoms - atoms;
        // Change the run length now and then, and always if the atoms left are less than the run
        if (rng() < 0.35 || (tidy && run > left)) {
            run = integer(rng, 0, tidy ? Math.min(8, left) : 10);
            let isSmaller = integer(rng, -1, 1);
            if (tidy && (smallidx + isSmaller < 9 || smallidx + isSmaller > 72)) isSmaller = 0;
            writer.put(1, 1);
            writer.put(Math.min(31, run * 3 + isSmaller + 1), 5);
            for (let i = 0; i < run && smallidx > 0; i++) writer.putPacked(rng, smallidx);
            smallidx += isSmaller;
        } else {
            writer.put(0, 1);
            for (let i = 0; i < run && smallidx > 0; i++) writer.putPacked(rng, smallidx);
        }
        atoms += run;
    }
    return writer.finish();
};

// One frame, as the bytes it has in a file
const makeFrame = rng => {
    const natoms = rng() < 0.85 ? integer(rng, 10, 40) : integer(rng, 10, 300);
    const sizes = makeSizes(rng);
    const minimum = [0, 0, 0].map(() => (rng() < 0.3 ? pick(rng, INT_LIMITS) : integer(rng, -100000, 100000)));
    const smallidx = rng() < 0.04 ? pick(rng, BAD_SMALLIDX) : rng() < 0.6 ? pick(rng, SMALLIDX) : integer(rng, 9, 72);
    let data;
    // A few frames have just random bytes
    if (rng() < 0.04) data = Uint8Array.from({ length: integer(rng, natoms, natoms * 8) }, () => rng() * 256);
    else data = makeData(rng, natoms, sizes, smallidx);
    // Damage some frames: changed bits, missing bytes, bytes that are not used
    const damage = rng();
    if (damage < 0.08) for (let i = integer(rng, 1, 3); i > 0; i--) data[integer(rng, 0, data.length - 1)] ^= 1 << integer(rng, 0, 7);
    else if (damage < 0.14) data = data.subarray(0, Math.max(1, data.length - integer(rng, 1, 8)));
    else if (damage < 0.2) data = Uint8Array.from({ length: data.length + integer(rng, 1, 60) }, (unused, i) => (i < data.length ? data[i] : rng() * 256));
    // The magic number of 2023 has the size of the data as an int64
    const magic = rng() < 0.1 ? 2023 : 1995;
    const dataOffset = magic === 2023 ? 96 : 92;
    const bytes = new Uint8Array(dataOffset + Math.ceil(data.length / 4) * 4);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, magic);
    view.setInt32(4, natoms);
    view.setInt32(8, integer(rng, -2147483648, 2147483647));
    view.setFloat32(12, rng() * 1000);
    for (let i = 0; i < 9; i++) view.setFloat32(16 + i * 4, rng() * 10);
    view.setInt32(52, natoms);
    view.setFloat32(56, rng() < 0.03 ? pick(rng, BAD_PRECISIONS) : pick(rng, PRECISIONS));
    for (let i = 0; i < 3; i++) {
        view.setInt32(60 + i * 4, minimum[i]);
        // Int32 arithmetic, as where GROMACS gets the sizes back
        view.setInt32(72 + i * 4, (minimum[i] + sizes[i] - 1) | 0);
    }
    view.setInt32(84, smallidx);
    view.setUint32(dataOffset - 4, data.length);
    bytes.set(data, dataOffset);
    return bytes;
};

// The frames of a batch, which are always the same for the same seed
const makeFrames = seed => {
    const rng = random(seed);
    return Array.from({ length: FRAMES_PER_BATCH }, () => makeFrame(rng));
};

// Read a frame with the decoder. Returns the bytes of its coordinates (float32, in nm), or null if the decoder refuses the frame
const readFrame = (frame, fast) => {
    // The decoder may read up to 3 bytes after the frame, and the reader of files gives it room for that
    const bytes = new Uint8Array(frame.length + 4);
    bytes.set(frame);
    const view = new DataView(bytes.buffer);
    try {
        if (frameBytes(view, 0, frame.length) !== frame.length) throw new Error('A frame of the fuzz tests is not complete');
        const { coordinates } = decodeFrame(bytes, view, 0, fast);
        return Buffer.from(coordinates.buffer);
    } catch (error) {
        if (error instanceof XtcError) return null;
        throw error;
    }
};

// A hash of what was read from the frames of a batch: the coordinates of every frame, or that the frame was refused
const hashBatch = coordinates => {
    const hash = crypto.createHash('sha256');
    for (const bytes of coordinates) {
        if (bytes) hash.update('read').update(bytes);
        else hash.update('refused');
    }
    return hash.digest('hex').slice(0, 16);
};

module.exports = { makeFrames, readFrame, hashBatch };
