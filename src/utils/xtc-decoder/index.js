// Reads GROMACS .xtc trajectory files (compressed coordinates) without running GROMACS
//
// This is a port of the GROMACS reader: xdr3dfcoord, receivebits, receiveints, sizeofint and sizeofints
// in src/gromacs/fileio/libxdrf.cpp, and read_first_xtc / read_next_xtc in src/gromacs/fileio/xtcio.cpp.
// Every frame has the same float32 values GROMACS gives, bit for bit: values stay in nm and nothing is rounded here.
// The tests compare it with "gmx dump -bin" of GROMACS itself (see generate-fixtures.js).
//
// An xtc file is a list of frames. All numbers are big endian:
//   int32    magic           1995, or 2023 for systems over 298 million atoms
//   int32    natoms
//   int32    step
//   float32  time
//   float32  box[9]
//   int32    natoms          again
// With 9 atoms or less, the coordinates follow as 3 float32 per atom. Otherwise they are compressed:
//   float32  precision       coordinates were multiplied by it and rounded to integers
//   int32    minint[3]       minimum of the integers, in x, y and z
//   int32    maxint[3]       maximum
//   int32    smallidx        index in MAGICINTS of the size of the first small differences
//   int32    bytes           size of the compressed data (int64 with magic 2023)
//   bytes    data            padded to a multiple of 4 bytes
// The data is a stream of bits. An atom is stored as its 3 integers minus minint, packed in one big number.
// Then a bit tells if the run length changes, with 5 more bits if it does. A run is up to 8 atoms that follow,
// every one stored as the small difference with the atom before, to save space (waters, bonded atoms).
const fs = require('fs');

const XTC_MAGIC = 1995;
// Same format, with the size of the compressed data as an int64
const XTC_NEW_MAGIC = 2023;
// GROMACS refuses more atoms than this in a frame of the 1995 format
const XTC_1995_MAX_NATOMS = 298261617;
// Sizes for the small differences between consecutive atoms: 2^(index / 3), mostly
const MAGICINTS = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 10, 12, 16, 20, 25, 32, 40, 50, 64,
    80, 101, 128, 161, 203, 256, 322, 406, 512, 645, 812, 1024, 1290,
    1625, 2048, 2580, 3250, 4096, 5060, 6501, 8192, 10321, 13003,
    16384, 20642, 26007, 32768, 41285, 52015, 65536, 82570, 104031,
    131072, 165140, 208063, 262144, 330280, 416127, 524287, 660561,
    832255, 1048576, 1321122, 1664510, 2097152, 2642245, 3329021,
    4194304, 5284491, 6658042, 8388607, 10568983, 13316085, 16777216,
];
const FIRSTIDX = 9;
const LASTIDX = MAGICINTS.length;
// GROMACS writes smallidx = LASTIDX, one past its table, when consecutive atoms are very far apart
// What it reads there is not defined, so that size counts as 0 here: a run cannot use it
const magicInt = index => (index < LASTIDX ? MAGICINTS[index] : 0);

// magic, natoms, step and time
const HEADER_BYTES = 16;
// Then the box and natoms again
const COORDINATES_OFFSET = HEADER_BYTES + 9 * 4 + 4;
// precision, minint, maxint and smallidx
const COMPRESSION_HEADER_BYTES = 8 * 4;
// Atoms up to which coordinates are not compressed
const MAX_UNCOMPRESSED_ATOMS = 9;
// Numbers of several bytes are handled in pieces of 3 bytes, so they are exact as JavaScript numbers
const LIMB = 0x1000000;
// The bit reader reads 4 bytes at a time, so it may read up to 3 bytes after the last one it uses
const SLACK_BYTES = 4;
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;

// An xtc file that cannot be read: it is damaged, or it is not an xtc file
class XtcError extends Error {}

// sizeofint: number of bits needed to store an int smaller than size
// The size is a signed int32 there, so sizes of 2^30 or more give 32 and negative sizes give 0
const sizeOfInt = size => {
    let num = 1;
    let bits = 0;
    while (size >= num && bits < 32) {
        bits++;
        num <<= 1;
    }
    return bits;
};

// sizeofints: number of bits needed to store 3 ints packed together, which is the bits of size0 * size1 * size2
// The product may have 72 bits, so it is calculated byte by byte, as GROMACS does
const sizeOfInts = (size0, size1, size2) => {
    const sizes = [size0, size1, size2];
    const bytes = [1];
    let nbytes = 1;
    for (let i = 0; i < 3; i++) {
        let carry = 0;
        let count = 0;
        for (; count < nbytes; count++) {
            carry += bytes[count] * sizes[i];
            bytes[count] = carry % 256;
            carry = Math.floor(carry / 256);
        }
        while (carry !== 0) {
            bytes[count++] = carry % 256;
            carry = Math.floor(carry / 256);
        }
        nbytes = count;
    }
    let num = 1;
    let bits = 0;
    while (bytes[nbytes - 1] >= num) {
        bits++;
        num *= 2;
    }
    return bits + (nbytes - 1) * 8;
};

// ----- Bit reader -----
// Its state is here and not in an object because this is the hot path. Decoding is synchronous, so frames never mix
let data = null; // Bytes of the file
let position = 0; // Index of the byte with the next bit
let bit = 0; // Index of the next bit in that byte, 0 being the most significant

// receivebits: read up to 24 bits, the most significant first
const readBits = count => {
    const window =
        (data[position] << 24) | (data[position + 1] << 16) | (data[position + 2] << 8) | data[position + 3];
    const value = (window << bit) >>> (32 - count);
    bit += count;
    position += bit >>> 3;
    bit &= 7;
    return value;
};

// receivebits for ints stored alone, which may have up to 32 bits
// GROMACS masks the value with (1 << count) - 1, which is 0 for 32 bits: it reads those ints as 0. So does this
const readBitsUpTo32 = count => {
    if (count === 0) return 0;
    if (count <= 24) return readBits(count);
    const high = readBits(count - 16);
    return ((high << 16) | readBits(16)) & ((1 << count) - 1);
};

// Read up to 24 bits written as bytes with the least significant byte first, the last byte having the bits left
const readLimb = count => {
    const value = readBits(count);
    if (count <= 8) return value;
    if (count <= 16) {
        const last = count - 8;
        return (value >>> last) | ((value & ((1 << last) - 1)) << 8);
    }
    const last = count - 16;
    return (value >>> (8 + last)) | (((value >>> last) & 0xff) << 8) | ((value & ((1 << last) - 1)) << 16);
};

// receiveints: read 3 ints packed in "bits" bits as the number (int0 * size1 + int1) * size2 + int2
// They are left in these variables, to return them without creating an array for every atom
let int0 = 0;
let int1 = 0;
let int2 = 0;
const readInts = (bits, size1, size2) => {
    if (bits > 48) return readHugeInts(bits, size1, size2);
    // Up to 48 bits the number and its divisions are exact
    let packed = readLimb(bits < 24 ? bits : 24);
    if (bits > 24) packed += readLimb(bits - 24) * LIMB;
    const rest = Math.floor(packed / size2);
    int2 = packed - rest * size2;
    int0 = Math.floor(rest / size1);
    int1 = rest - int0 * size1;
    int0 |= 0;
};
// The same with more bits, up to 72: long division, 3 bytes at a time
// It is apart from readInts to keep that one small, which makes it faster
const readHugeInts = (bits, size1, size2) => {
    const limb0 = readLimb(24);
    const limb1 = readLimb(24);
    const limb2 = readLimb(bits - 48);
    const high2 = Math.floor(limb2 / size2);
    let rest = (limb2 - high2 * size2) * LIMB + limb1;
    const mid2 = Math.floor(rest / size2);
    rest = (rest - mid2 * size2) * LIMB + limb0;
    const low2 = Math.floor(rest / size2);
    int2 = rest - low2 * size2;
    rest = (high2 % size1) * LIMB + mid2;
    const mid1 = Math.floor(rest / size1);
    rest = (rest - mid1 * size1) * LIMB + low2;
    const low1 = Math.floor(rest / size1);
    int1 = rest - low1 * size1;
    // GROMACS keeps the 32 lowest bits
    int0 = (mid1 * LIMB + low1) | 0;
};

// Decode the compressed coordinates of a frame into "coordinates"
// "offset" is where the compression header starts and "dataOffset" where the compressed data does
const decodeCoordinates = (bytes, view, offset, dataOffset, dataBytes, natoms, coordinates) => {
    const precision = view.getFloat32(offset);
    const min0 = view.getInt32(offset + 4);
    const min1 = view.getInt32(offset + 8);
    const min2 = view.getInt32(offset + 12);
    // Sizes are unsigned int32 in GROMACS
    const size0 = (view.getInt32(offset + 16) - min0 + 1) >>> 0;
    const size1 = (view.getInt32(offset + 20) - min1 + 1) >>> 0;
    const size2 = (view.getInt32(offset + 24) - min2 + 1) >>> 0;
    let smallidx = view.getInt32(offset + 28);
    if (smallidx < 0 || smallidx > LASTIDX) throw new XtcError(`Wrong smallidx in xtc frame (${smallidx})`);
    // The 3 ints of an atom are packed together unless a size is too big for that: then they are stored one by one
    // packedBits is 0 in that case, and also if a size is 0 in a damaged file
    let packedBits = 0;
    let bits0 = 0;
    let bits1 = 0;
    let bits2 = 0;
    if (((size0 | size1 | size2) >>> 0) > 0xffffff) {
        bits0 = sizeOfInt(size0 | 0);
        bits1 = sizeOfInt(size1 | 0);
        bits2 = sizeOfInt(size2 | 0);
    } else {
        packedBits = sizeOfInts(size0, size1, size2);
        if (packedBits !== 0 && (size1 === 0 || size2 === 0)) throw new XtcError('Wrong sizes in xtc frame');
    }
    // GROMACS calculates the inverse of the precision as a double and keeps it as a float
    const inversePrecision = Math.fround(1 / precision);
    // GROMACS never writes such a precision, and it would read coordinates that are infinite or not numbers
    if (!(precision > 0) || !(inversePrecision > 0) || inversePrecision === Infinity)
        throw new XtcError(`Wrong precision in xtc frame (${precision})`);
    let smaller = magicInt(Math.max(FIRSTIDX, smallidx - 1)) >> 1;
    let smallnum = magicInt(smallidx) >> 1;
    let sizesmall = magicInt(smallidx);
    data = bytes;
    position = dataOffset;
    bit = 0;
    const dataEnd = dataOffset + dataBytes;
    const ncoordinates = natoms * 3;
    let run = 0;
    let c = 0;
    while (c < ncoordinates) {
        let x, y, z;
        if (packedBits === 0) {
            x = readBitsUpTo32(bits0);
            y = readBitsUpTo32(bits1);
            z = readBitsUpTo32(bits2);
        } else {
            readInts(packedBits, size1, size2);
            x = int0;
            y = int1;
            z = int2;
        }
        // Int32 arithmetic, as in GROMACS
        x = (x + min0) | 0;
        y = (y + min1) | 0;
        z = (z + min2) | 0;
        // The run length stays the same unless this bit says otherwise
        // The 5 bits that follow have the new run length and whether the small differences get smaller or bigger
        let isSmaller = 0;
        if (readBits(1) === 1) {
            run = readBits(5);
            isSmaller = run % 3;
            run -= isSmaller;
            isSmaller--;
        }
        // GROMACS has no such checks: it would write after the end of its array, or divide by 0
        if (c + 3 + run > ncoordinates) throw new XtcError('Wrong run in xtc frame: it has more atoms than the frame');
        if (run > 0 && sizesmall === 0) throw new XtcError('Wrong run in xtc frame: it has no size');
        for (let k = 0; k < run; k += 3) {
            readInts(smallidx, sizesmall, sizesmall);
            const nextX = (int0 + x - smallnum) | 0;
            const nextY = (int1 + y - smallnum) | 0;
            const nextZ = (int2 + z - smallnum) | 0;
            if (k === 0) {
                // The first atom of a run is written after the second, to compress water molecules better
                coordinates[c++] = Math.fround(nextX) * inversePrecision;
                coordinates[c++] = Math.fround(nextY) * inversePrecision;
                coordinates[c++] = Math.fround(nextZ) * inversePrecision;
                coordinates[c++] = Math.fround(x) * inversePrecision;
                coordinates[c++] = Math.fround(y) * inversePrecision;
                coordinates[c++] = Math.fround(z) * inversePrecision;
            } else {
                coordinates[c++] = Math.fround(nextX) * inversePrecision;
                coordinates[c++] = Math.fround(nextY) * inversePrecision;
                coordinates[c++] = Math.fround(nextZ) * inversePrecision;
            }
            x = nextX;
            y = nextY;
            z = nextZ;
        }
        if (run === 0) {
            // The int is rounded to float32 and multiplied as float32, as in GROMACS
            coordinates[c++] = Math.fround(x) * inversePrecision;
            coordinates[c++] = Math.fround(y) * inversePrecision;
            coordinates[c++] = Math.fround(z) * inversePrecision;
        }
        if (isSmaller !== 0) {
            smallidx += isSmaller;
            if (smallidx < 0 || smallidx > LASTIDX) throw new XtcError(`Wrong smallidx in xtc frame (${smallidx})`);
            if (isSmaller < 0) {
                smallnum = smaller;
                smaller = smallidx > FIRSTIDX ? magicInt(smallidx - 1) >> 1 : 0;
            } else {
                smaller = smallnum;
                smallnum = magicInt(smallidx) >> 1;
            }
            sizesmall = magicInt(smallidx);
        }
        // GROMACS would go on reading memory it never wrote
        if (position > dataEnd || (position === dataEnd && bit > 0))
            throw new XtcError('Wrong xtc frame: its compressed data is too short');
    }
};

// Size in bytes of the frame starting at "offset", of which "available" bytes are there
// If they are not enough to know it, the number of bytes needed to go on, which is more than the available ones
// The checks are the ones GROMACS does, in the same order, and a few it does not do
const frameBytes = (view, offset, available, expectedAtoms) => {
    if (available < HEADER_BYTES) return HEADER_BYTES;
    const magic = view.getInt32(offset);
    if (magic !== XTC_MAGIC && magic !== XTC_NEW_MAGIC)
        throw new XtcError(`Wrong magic number in xtc file (${magic} instead of ${XTC_MAGIC} or ${XTC_NEW_MAGIC})`);
    const natoms = view.getInt32(offset + 4);
    // GROMACS only fails if there are more atoms than in the first frame. With less atoms it keeps atoms of the frame before
    if (expectedAtoms !== undefined && natoms !== expectedAtoms)
        throw new XtcError(`Wrong number of atoms in xtc frame (${natoms} instead of ${expectedAtoms})`);
    if (natoms < 0) throw new XtcError(`Wrong number of atoms in xtc frame (${natoms})`);
    if (available < COORDINATES_OFFSET) return COORDINATES_OFFSET;
    // GROMACS only warns when this number is not the one in the header, and then it may write after the end of its array
    const repeatedAtoms = view.getInt32(offset + COORDINATES_OFFSET - 4);
    if (repeatedAtoms !== natoms)
        throw new XtcError(`Wrong number of atoms in xtc frame (${natoms} and ${repeatedAtoms})`);
    if (natoms > XTC_1995_MAX_NATOMS && magic !== XTC_NEW_MAGIC)
        throw new XtcError(`Wrong xtc frame: ${natoms} atoms need the magic number ${XTC_NEW_MAGIC}`);
    if (natoms <= MAX_UNCOMPRESSED_ATOMS) return COORDINATES_OFFSET + natoms * 12;
    const dataOffset = COORDINATES_OFFSET + COMPRESSION_HEADER_BYTES + (magic === XTC_NEW_MAGIC ? 8 : 4);
    if (available < dataOffset) return dataOffset;
    let dataBytes = view.getInt32(offset + dataOffset - 4);
    if (magic === XTC_NEW_MAGIC) dataBytes = view.getInt32(offset + dataOffset - 8) * 0x100000000 + (dataBytes >>> 0);
    // GROMACS reads the data into a buffer of this size without checking that it fits
    const maxDataBytes = natoms <= 16 ? 240 : Math.floor(natoms * 3 * 1.2) * 4;
    if (dataBytes < 0 || dataBytes > maxDataBytes)
        throw new XtcError(`Wrong size of the compressed data in xtc frame (${dataBytes} bytes for ${natoms} atoms)`);
    // An atom takes one bit at least. This avoids making room for a wrong, huge number of atoms
    if (natoms > dataBytes * 8) throw new XtcError('Wrong xtc frame: its compressed data is too short');
    return dataOffset + Math.ceil(dataBytes / 4) * 4;
};

// Decode the frame starting at "offset", which must be complete: see frameBytes
// Returns { natoms, step, time, precision, box, coordinates }, with box and coordinates as Float32Array in nm
// The box has its 3 vectors one after the other. The precision is -1 if the coordinates were not compressed, as in GROMACS
const decodeFrame = (bytes, view, offset) => {
    const magic = view.getInt32(offset);
    const natoms = view.getInt32(offset + 4);
    const frame = {
        natoms,
        step: view.getInt32(offset + 8),
        time: view.getFloat32(offset + 12),
        precision: -1,
        box: new Float32Array(9),
        coordinates: new Float32Array(natoms * 3),
    };
    // Floats are copied as their 4 bytes, so they stay the same whatever they are
    const boxBits = new Uint32Array(frame.box.buffer);
    for (let i = 0; i < 9; i++) boxBits[i] = view.getUint32(offset + HEADER_BYTES + i * 4);
    if (natoms <= MAX_UNCOMPRESSED_ATOMS) {
        const coordinateBits = new Uint32Array(frame.coordinates.buffer);
        for (let i = 0; i < natoms * 3; i++) coordinateBits[i] = view.getUint32(offset + COORDINATES_OFFSET + i * 4);
        return frame;
    }
    frame.precision = view.getFloat32(offset + COORDINATES_OFFSET);
    const countBytes = magic === XTC_NEW_MAGIC ? 8 : 4;
    const dataOffset = offset + COORDINATES_OFFSET + COMPRESSION_HEADER_BYTES + countBytes;
    const dataBytes =
        (countBytes === 8 ? view.getInt32(dataOffset - 8) * 0x100000000 : 0) + view.getUint32(dataOffset - 4);
    try {
        decodeCoordinates(bytes, view, offset + COORDINATES_OFFSET, dataOffset, dataBytes, natoms, frame.coordinates);
    } finally {
        // Do not keep the bytes of the file after an error
        data = null;
    }
    return frame;
};

// Read an xtc file frame by frame: a generator of frames, as decodeFrame returns them
// It ends returning { frames, incomplete }. As in GROMACS, if the file ends in the middle of a frame
// the frames before are given and "incomplete" is true. Any other problem throws an XtcError
// options.bufferBytes: bytes read from the file at once. The buffer grows if a frame is bigger
const readXtcFrames = function*(filepath, options = {}) {
    const fd = fs.openSync(filepath, 'r');
    try {
        let fileBytes = fs.fstatSync(fd).size;
        let fileOffset = 0;
        let capacity = options.bufferBytes || DEFAULT_BUFFER_BYTES;
        let bytes = new Uint8Array(capacity + SLACK_BYTES);
        let view = new DataView(bytes.buffer);
        // The bytes of the file not decoded yet are bytes[start, end)
        let start = 0;
        let end = 0;
        let frames = 0;
        let natoms;
        while (true) {
            const available = end - start;
            const left = fileBytes - fileOffset;
            // The file ended right after a frame
            if (available === 0 && left === 0) return { frames, incomplete: false };
            const needed = available === 0 ? 1 : frameBytes(view, start, available, natoms);
            if (needed <= available) {
                const frame = decodeFrame(bytes, view, start);
                natoms = frame.natoms;
                start += needed;
                frames++;
                yield frame;
                continue;
            }
            // The file ends before the frame does
            if (needed > available + left) return { frames, incomplete: true };
            // Move the bytes left to the start of the buffer, or of a bigger one if the frame does not fit
            if (needed > capacity) {
                while (capacity < needed) capacity *= 2;
                const bigger = new Uint8Array(capacity + SLACK_BYTES);
                bigger.set(bytes.subarray(start, end));
                bytes = bigger;
                view = new DataView(bytes.buffer);
            } else bytes.copyWithin(0, start, end);
            end = available;
            start = 0;
            // Fill the buffer
            while (end < capacity && fileOffset < fileBytes) {
                const length = Math.min(capacity - end, fileBytes - fileOffset);
                const read = fs.readSync(fd, bytes, end, length, fileOffset);
                // The file got shorter while reading it
                if (read === 0) fileBytes = fileOffset;
                end += read;
                fileOffset += read;
            }
            bytes.fill(0, end, end + SLACK_BYTES);
        }
    } finally {
        fs.closeSync(fd);
    }
};

module.exports = { readXtcFrames, frameBytes, decodeFrame, XtcError };
