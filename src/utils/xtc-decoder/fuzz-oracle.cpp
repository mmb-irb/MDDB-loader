// The reader of GROMACS itself, to tell what it gets from the frames of the fuzz tests of the xtc decoder
//
// This file has no code of GROMACS. generate-fuzz.js takes the pieces included below from the source of GROMACS
// (src/gromacs/fileio/libxdrf.cpp), as they are, and compiles this file with them. Here is only what joins them:
// the header of a frame is read from memory instead of from a file, and the three things GROMACS does not check are
// checked, since what it reads is not defined when they happen.
//
// It reads frames from the standard input, each as its size (uint32) and its bytes, and for each one it writes
// a byte (1 if what GROMACS reads is defined, 0 if not) and, if it is, the number of coordinates (uint32)
// and the coordinates (float32)
#include <algorithm>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

// What GROMACS reads from the frame is not defined
struct Undefined
{
};

// GROMACS ends the program when it finds sizes of 0. Here that ends the frame
#define exit(code) throw Undefined()

// The table of sizes of the small differences
namespace gromacs
{
#include "gromacs-table.inc"
} // namespace gromacs

// GROMACS reads the table without checking the index
// It reads one past the end when consecutive atoms are very far apart: frames written by GROMACS do it. That int was 0
// in the builds of GROMACS we looked at, and a run cannot use a size of 0, so it is taken as 0. Any other index outside is not defined
struct CheckedTable
{
    int operator[](int index) const
    {
        const int entries = sizeof(gromacs::magicints) / sizeof(*gromacs::magicints);
        if (index == entries)
        {
            return 0;
        }
        if (index < 0 || index > entries)
        {
            throw Undefined();
        }
        return gromacs::magicints[index];
    }
};
static const CheckedTable magicints;

// FIRSTIDX, struct DataBuffer, sizeofint, sizeofints, receivebits and receiveints
#include "gromacs-functions.inc"

// Numbers are big endian in the file
static int readInt(const unsigned char* bytes)
{
    return static_cast<int>((static_cast<unsigned>(bytes[0]) << 24) | (static_cast<unsigned>(bytes[1]) << 16)
                            | (static_cast<unsigned>(bytes[2]) << 8) | bytes[3]);
}

// Read the coordinates of a compressed frame as xdr3dfcoord does. Returns false if they are not defined
static bool readFrame(const unsigned char* frame, std::size_t frameBytes, std::vector<float>* coordinates)
{
    // The variables of xdr3dfcoord, with their types
#include "gromacs-declarations.inc"
    int*              ip = nullptr;
    struct DataBuffer buffer;

    const int magic = readInt(frame);
    lsize           = readInt(frame + 52);
    size3           = static_cast<std::size_t>(lsize) * 3;
    float       precisionValue;
    const int   precisionBits = readInt(frame + 56);
    std::memcpy(&precisionValue, &precisionBits, sizeof(float));
    float* precision = &precisionValue;
    for (int d = 0; d < 3; d++)
    {
        minint[d] = readInt(frame + 60 + 4 * d);
        maxint[d] = readInt(frame + 72 + 4 * d);
    }
    smallidx = readInt(frame + 84);
    // The size of the compressed data is an int64 with the magic number of 2023
    const bool        isNewFormat = (magic == 2023);
    const std::size_t dataOffset  = isNewFormat ? 96 : 92;
    const std::size_t dataBytes   = isNewFormat
                                            ? (static_cast<std::size_t>(static_cast<unsigned>(readInt(frame + 88))) << 32)
                                                      | static_cast<unsigned>(readInt(frame + 92))
                                            : static_cast<std::size_t>(readInt(frame + 88));
    // GROMACS would read after the end of the file
    if (dataBytes > frameBytes - dataOffset)
    {
        return false;
    }
    // Room for what GROMACS reads and writes after the end of its arrays when the frame is wrong
    const std::size_t          extra = size3 + 64;
    std::vector<float>         floats(size3 + extra);
    std::vector<int>           ints(size3 + extra);
    std::vector<unsigned char> data(dataBytes + extra * 5);
    std::memcpy(data.data(), frame + dataOffset, dataBytes);
    float* fp   = floats.data();
    ip          = ints.data();
    buffer.data = data.data();
    try
    {
#include "gromacs-start.inc"
#include "gromacs-sizes.inc"
#include "gromacs-small.inc"
        buffer.index    = 0;
        buffer.lastbits = 0;
        buffer.lastbyte = 0;
#include "gromacs-loop.inc"
        // GROMACS read after the end of the compressed data, or wrote after the end of the coordinates
        if (buffer.index > dataBytes || lfp - fp > static_cast<std::ptrdiff_t>(size3))
        {
            return false;
        }
    }
    catch (const Undefined&)
    {
        return false;
    }
    coordinates->assign(fp, fp + size3);
    return true;
}

int main()
{
    std::vector<unsigned char> frame;
    std::vector<float>         coordinates;
    std::uint32_t              frameBytes;
    while (std::fread(&frameBytes, sizeof(frameBytes), 1, stdin) == 1)
    {
        frame.resize(frameBytes);
        if (std::fread(frame.data(), 1, frameBytes, stdin) != frameBytes)
        {
            return 1;
        }
        const unsigned char isDefined = readFrame(frame.data(), frameBytes, &coordinates) ? 1 : 0;
        std::fwrite(&isDefined, 1, 1, stdout);
        if (isDefined)
        {
            const std::uint32_t count = coordinates.size();
            std::fwrite(&count, sizeof(count), 1, stdout);
            std::fwrite(coordinates.data(), sizeof(float), count, stdout);
        }
    }
    return 0;
}
