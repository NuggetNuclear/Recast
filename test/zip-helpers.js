import fs from 'node:fs';
import { ZipArchive } from 'archiver';

// Shared by the engine tests and the HTTP API tests.
export function createZip(filePath, entries) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const zip = new ZipArchive();
    output.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(output);
    for (const [name, content] of Object.entries(entries)) {
      zip.append(content, { name });
    }
    zip.finalize();
  });
}

export function makeCraftedZip(filename, content) {
  const nameBuf = Buffer.from(filename, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');

  const lfh = Buffer.alloc(30 + nameBuf.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(0, 8);
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(0, 14);
  lfh.writeUInt32LE(dataBuf.length, 18);
  lfh.writeUInt32LE(dataBuf.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  nameBuf.copy(lfh, 30);

  const lfhOffset = 0;

  const cdh = Buffer.alloc(46 + nameBuf.length);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt16LE(0, 12);
  cdh.writeUInt16LE(0, 14);
  cdh.writeUInt32LE(0, 16);
  cdh.writeUInt32LE(dataBuf.length, 20);
  cdh.writeUInt32LE(dataBuf.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30);
  cdh.writeUInt16LE(0, 32);
  cdh.writeUInt16LE(0, 34);
  cdh.writeUInt16LE(0, 36);
  cdh.writeUInt32LE(0, 38);
  cdh.writeUInt32LE(lfhOffset, 42);
  nameBuf.copy(cdh, 46);

  const cdOffset = lfh.length + dataBuf.length;
  const cdSize = cdh.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, dataBuf, cdh, eocd]);
}

/** A minimal POSIX tar holding one regular file and one symlink pointing at `target`. */
export function makeTarWithSymlink(linkName, target) {
  const header = (name, size, type, linkname = '') => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'latin1');
    h.write('0000000\0', 108, 8, 'latin1');
    h.write('0000000\0', 116, 8, 'latin1');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
    h.write('00000000000\0', 136, 12, 'latin1');
    h.write('        ', 148, 8, 'latin1');
    h.write(type, 156, 1, 'latin1');
    h.write(linkname, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'latin1');
    h.write('00', 263, 2, 'latin1');
    const sum = [...h].reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
    return h;
  };
  const body = Buffer.from('plain file');
  const padded = Buffer.concat([body, Buffer.alloc(512 - body.length)]);
  return Buffer.concat([header('note.txt', body.length, '0'), padded, header(linkName, 0, '2', target), Buffer.alloc(1024)]);
}
