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
