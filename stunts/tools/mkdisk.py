#!/usr/bin/env python3
"""Build a small MBR + FAT16 hard-disk image holding a directory, for the emulated DOS PC.

usage: mkdisk.py <source dir> <dos dir name> <out.img> [extra files as name=path ...]
Files land in C:\\<dos dir name>\\; extras land in C:\\ (e.g. a batch file).
"""
import os, struct, sys, time

SRC, DIRNAME, OUT = sys.argv[1], sys.argv[2].upper(), sys.argv[3]
EXTRA = dict(a.split('=', 1) for a in sys.argv[4:])

HEADS, SPT, CYLS = 16, 63, 40
TOTAL = HEADS * SPT * CYLS
PSTART = SPT                       # partition starts at track 1
PSECTORS = TOTAL - PSTART
SPC = 4                            # sectors per cluster (2 KiB)
RESERVED, NFATS, ROOTENT = 1, 2, 512
root_secs = ROOTENT * 32 // 512
clusters_est = PSECTORS // SPC
fat_secs = (clusters_est * 2 + 511) // 512 + 1
data_start = RESERVED + NFATS * fat_secs + root_secs
nclusters = (PSECTORS - data_start) // SPC
assert 4085 <= nclusters < 65525

img = bytearray(TOTAL * 512)

def chs(lba):
    c = lba // (HEADS * SPT); h = (lba // SPT) % HEADS; s = lba % SPT + 1
    return bytes([h, ((c >> 2) & 0xC0) | s, c & 0xFF])

# MBR with one FAT16 partition
mbr = bytearray(512)
mbr[446:462] = bytes([0x80]) + chs(PSTART) + bytes([0x06]) + chs(TOTAL - 1) + struct.pack('<II', PSTART, PSECTORS)
mbr[510:512] = b'\x55\xaa'
img[0:512] = mbr

base = PSTART * 512
bs = bytearray(512)
bs[0:3] = b'\xeb\x3c\x90'; bs[3:11] = b'MKDISK  '
struct.pack_into('<HBHBHHBHHHII', bs, 11, 512, SPC, RESERVED, NFATS, ROOTENT, 0, 0xF8, fat_secs, SPT, HEADS, PSTART, PSECTORS)
struct.pack_into('<BBBI11s8s', bs, 36, 0x80, 0, 0x29, 0x12345678, b'STUNTS     ', b'FAT16   ')
bs[510:512] = b'\x55\xaa'
img[base:base + 512] = bs

fat = [0xFFF8, 0xFFFF]
def alloc(data):
    n = max(1, (len(data) + SPC * 512 - 1) // (SPC * 512)) if data else 0
    if not n: return 0
    first = len(fat)
    for i in range(n):
        fat.append(first + i + 1 if i < n - 1 else 0xFFFF)
        off = base + (data_start + (first + i - 2) * SPC) * 512
        chunk = data[i * SPC * 512:(i + 1) * SPC * 512]
        img[off:off + len(chunk)] = chunk
    return first

def dosname(n):
    n = n.upper(); stem, _, ext = n.partition('.')
    return (stem[:8].ljust(8) + ext[:3].ljust(3)).encode('ascii')

t = time.localtime()
dtime = (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2)
ddate = ((t.tm_year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday
def dirent(name11, attr, cluster, size):
    e = bytearray(32); e[0:11] = name11; e[11] = attr
    struct.pack_into('<HHHI', e, 22, dtime, ddate, cluster, size)
    return e

# subdirectory with the game files
sub = bytearray()
files = sorted(f for f in os.listdir(SRC) if os.path.isfile(os.path.join(SRC, f)))
sub_entries = []
for f in files:
    data = open(os.path.join(SRC, f), 'rb').read()
    sub_entries.append(dirent(dosname(f), 0x20, alloc(data), len(data)))
sub_size = (len(sub_entries) + 2) * 32
sub_first = len(fat)
sub_clusters = (sub_size + SPC * 512 - 1) // (SPC * 512)
for i in range(sub_clusters): fat.append(sub_first + i + 1 if i < sub_clusters - 1 else 0xFFFF)
sub = dirent(b'.          ', 0x10, sub_first, 0) + dirent(b'..         ', 0x10, 0, 0) + b''.join(sub_entries)
for i in range(sub_clusters):
    off = base + (data_start + (sub_first + i - 2) * SPC) * 512
    chunk = sub[i * SPC * 512:(i + 1) * SPC * 512]
    img[off:off + len(chunk)] = chunk

root = [dirent(b'STUNTS     ', 0x08, 0, 0), dirent(dosname(DIRNAME), 0x10, sub_first, 0)]
for name, path in EXTRA.items():
    data = open(path, 'rb').read()
    root.append(dirent(dosname(name), 0x20, alloc(data), len(data)))
roff = base + (RESERVED + NFATS * fat_secs) * 512
for i, e in enumerate(root): img[roff + i * 32:roff + i * 32 + 32] = e

assert len(fat) - 2 <= nclusters, 'disk too small'
fatb = struct.pack('<%dH' % len(fat), *fat)
for k in range(NFATS):
    off = base + (RESERVED + k * fat_secs) * 512
    img[off:off + len(fatb)] = fatb

open(OUT, 'wb').write(img)
print('wrote', OUT, len(img) // 1024, 'KiB,', len(files), 'files in C:\\' + DIRNAME)
