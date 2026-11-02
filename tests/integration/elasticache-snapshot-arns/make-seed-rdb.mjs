#!/usr/bin/env node
// Writes a minimal Redis RDB file holding ONE string key, for the
// elasticache-snapshot-arns fixture to seed a cluster from S3 (issue #5635).
//
// usage: node make-seed-rdb.mjs <out-path> <key> <value>
//
// Layout (RDB version 9, loadable by Redis 5 and later): the "REDIS0009"
// header, SELECTDB 0, one RDB_TYPE_STRING entry, EOF, then the CRC-64/Jones
// checksum (little-endian) of every byte before it. A real checksum rather
// than the "disabled" zero, so a loader that insists on one still accepts it.
import { writeFileSync } from 'node:fs';

const [out, key, value] = process.argv.slice(2);
if (!out || !key || value === undefined) {
  console.error('usage: node make-seed-rdb.mjs <out-path> <key> <value>');
  process.exit(2);
}

/** RDB length encoding: 6-bit for < 64, 14-bit for < 16384 (all this needs). */
function len(n) {
  if (n < 64) return Buffer.from([n]);
  if (n < 16384) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  throw new Error(`length ${n} is out of range for this writer`);
}

const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([len(b.length), b]);
};

// CRC-64/Jones as Redis computes it: reflected, polynomial 0xad93d23594c935a9
// (reversed 0x95ac9329ac4bc9b5), init 0, no final xor.
const POLY = 0x95ac9329ac4bc9b5n;
const MASK = 0xffffffffffffffffn;
export function crc64(buf) {
  let crc = 0n;
  for (const byte of buf) {
    crc ^= BigInt(byte);
    for (let i = 0; i < 8; i++) crc = crc & 1n ? (crc >> 1n) ^ POLY : crc >> 1n;
  }
  return crc & MASK;
}
if (crc64(Buffer.from('123456789')) !== 0xe9c6d914c4b8d9can) {
  throw new Error('crc64 self-check failed');
}

const body = Buffer.concat([
  Buffer.from('REDIS0009', 'ascii'),
  Buffer.from([0xfe, 0x00]), // SELECTDB 0
  Buffer.from([0x00]), // RDB_TYPE_STRING
  str(key),
  str(value),
  Buffer.from([0xff]), // EOF
]);
const sum = Buffer.alloc(8);
sum.writeBigUInt64LE(crc64(body));
writeFileSync(out, Buffer.concat([body, sum]));
