import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import * as zlib from 'node:zlib';
import { type FunctionCode, type S3ObjectStorageMode } from '@aws-sdk/client-lambda';
import { inlineCodeFileNameForRuntime } from './shared.js';

/**
 * Build Lambda Code parameter from CDK properties
 */
export function buildCode(
  this: LambdaFunctionProvider,
  code: Record<string, unknown>,
  runtime: string | undefined
): FunctionCode {
  const result: FunctionCode = {};

  if (code['S3Bucket']) {
    result.S3Bucket = code['S3Bucket'] as string;
  }
  if (code['S3Key']) {
    result.S3Key = code['S3Key'] as string;
  }
  if (code['S3ObjectVersion']) {
    result.S3ObjectVersion = code['S3ObjectVersion'] as string;
  }
  // Both were never forwarded (issue #5300): a template's `REFERENCE`
  // deployed as the Lambda default `COPY`, and a customer managed key for
  // the deployment package fell back to the AWS owned key.
  if (code['S3ObjectStorageMode']) {
    result.S3ObjectStorageMode = code['S3ObjectStorageMode'] as S3ObjectStorageMode;
  }
  if (code['SourceKMSKeyArn']) {
    result.SourceKMSKeyArn = code['SourceKMSKeyArn'] as string;
  }
  if (code['ZipFile']) {
    // Lambda SDK expects a zip binary, not raw text.
    // CloudFormation's ZipFile property auto-zips inline code, but SDK does not.
    // Create a minimal zip with the code as index.* file.
    result.ZipFile = this.createZipFromInlineCode(code['ZipFile'] as string, runtime);
  }
  if (code['ImageUri']) {
    result.ImageUri = code['ImageUri'] as string;
  }

  return result;
}

/**
 * Create a zip file from inline code text.
 *
 * CloudFormation's ZipFile property automatically wraps inline code in a zip,
 * but the Lambda SDK expects actual zip binary. This creates a minimal zip
 * containing the code as index.* (extension derived from runtime — nodejs
 * runtimes use index.js, python runtimes use index.py; see CFn ZipFile docs).
 */
export function createZipFromInlineCode(
  this: LambdaFunctionProvider,
  code: string,
  runtime: string | undefined
): Uint8Array {
  const fileData = Buffer.from(code, 'utf-8');
  const crc32 = this.crc32(fileData);
  const compressedData = zlib.deflateRawSync(fileData);

  const fileName = Buffer.from(inlineCodeFileNameForRuntime(runtime));
  const now = new Date();
  const modTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const modDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  // Local file header
  const localHeader = Buffer.alloc(30 + fileName.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(8, 8); // compression: deflate
  localHeader.writeUInt16LE(modTime, 10);
  localHeader.writeUInt16LE(modDate, 12);
  localHeader.writeUInt32LE(crc32, 14);
  localHeader.writeUInt32LE(compressedData.length, 18);
  localHeader.writeUInt32LE(fileData.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra field length
  fileName.copy(localHeader, 30);

  // Central directory
  const centralDir = Buffer.alloc(46 + fileName.length);
  centralDir.writeUInt32LE(0x02014b50, 0);
  centralDir.writeUInt16LE(20, 4);
  centralDir.writeUInt16LE(20, 6);
  centralDir.writeUInt16LE(0, 8);
  centralDir.writeUInt16LE(8, 10);
  centralDir.writeUInt16LE(modTime, 12);
  centralDir.writeUInt16LE(modDate, 14);
  centralDir.writeUInt32LE(crc32, 16);
  centralDir.writeUInt32LE(compressedData.length, 20);
  centralDir.writeUInt32LE(fileData.length, 24);
  centralDir.writeUInt16LE(fileName.length, 28);
  centralDir.writeUInt32LE(0, 42); // offset to local header
  fileName.copy(centralDir, 46);

  // End of central directory
  const endRecord = Buffer.alloc(22);
  const cdOffset = localHeader.length + compressedData.length;
  const cdSize = centralDir.length;
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8); // entries on disk
  endRecord.writeUInt16LE(1, 10); // total entries
  endRecord.writeUInt32LE(cdSize, 12);
  endRecord.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localHeader, compressedData, centralDir, endRecord]);
}

export function crc32(this: LambdaFunctionProvider, data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
