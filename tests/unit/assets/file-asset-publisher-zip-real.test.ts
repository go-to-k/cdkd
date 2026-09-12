/**
 * The REAL archiver, not a mock.
 *
 * `file-asset-publisher.test.ts` mocks `archiver`, so it asserts how the
 * publisher drives the archive object and nothing about the package's own
 * export shape — it stayed green across archiver v7 -> v8, which dropped the
 * callable `archiver(format, options)` factory entirely (native ESM, one class
 * per format). A mocked suite cannot see that break: it supplies whichever
 * export the source happens to import.
 *
 * So this file mocks ONLY S3 and lets the real `archiver` run against a real
 * temp directory, then reads the uploaded bytes back with adm-zip. A wrong
 * import shape throws here, and a zip that is not a zip fails the read-back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const mockS3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockS3Send,
    destroy: vi.fn(),
  })),
  HeadObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'HeadObject' })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'PutObject' })),
}));

const { FileAssetPublisher } = await import('../../../src/assets/file-asset-publisher.js');

describe('FileAssetPublisher.uploadZip against the real archiver package', () => {
  let cdkOutputDir: string;

  beforeEach(() => {
    mockS3Send.mockReset();
    cdkOutputDir = mkdtempSync(join(tmpdir(), 'cdkd-zip-real-'));
  });

  afterEach(() => {
    rmSync(cdkOutputDir, { recursive: true, force: true });
  });

  /** Drive `publish()` with a zip-packaged asset and return the PutObject body. */
  async function publishAndCaptureBody(assetDir: string): Promise<Buffer> {
    // HeadObject -> NotFound (asset absent), PutObject -> success.
    mockS3Send.mockImplementation((command: { _type?: string }) => {
      if (command._type === 'HeadObject') {
        const err = new Error('not found') as Error & { name: string };
        err.name = 'NotFound';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const publisher = new FileAssetPublisher();
    await publisher.publish(
      'asset-hash',
      {
        displayName: 'RealArchiverAsset',
        source: { path: assetDir, packaging: 'zip' },
        destinations: {
          'current_account-current_region': {
            bucketName: 'cdkd-assets',
            objectKey: 'asset-hash.zip',
          },
        },
      },
      cdkOutputDir,
      '123456789012',
      'us-east-1'
    );

    const put = mockS3Send.mock.calls
      .map((call) => call[0] as { _type?: string; Body?: unknown })
      .find((command) => command._type === 'PutObject');
    expect(put).toBeDefined();
    expect(Buffer.isBuffer(put!.Body)).toBe(true);
    return put!.Body as Buffer;
  }

  it('zips a directory asset into bytes S3 receives as a readable ZIP', async () => {
    const assetDir = 'my-lambda';
    const abs = join(cdkOutputDir, assetDir);
    mkdirSync(join(abs, 'nested'), { recursive: true });
    writeFileSync(join(abs, 'index.js'), 'export const handler = () => {};');
    writeFileSync(join(abs, 'nested', 'helper.js'), 'export const helper = 1;');

    const body = await publishAndCaptureBody(assetDir);

    // ZIP local-file-header magic. A factory/class import mistake would have
    // thrown before reaching this point; a non-zip buffer fails right here.
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const entries = new AdmZip(body)
      .getEntries()
      .map((e) => e.entryName)
      .sort();
    // `archive.directory(dirPath, false)` flattens the asset dir itself away
    // and keeps the paths BELOW it. Subdirectories get their own entry —
    // that is cdkd's shape, NOT parity with the CDK's own asset zipper,
    // which globs `onlyFiles: true` and emits no directory entries.
    expect(entries).toEqual(['index.js', 'nested/', 'nested/helper.js']);

    const unzipped = new AdmZip(body).readAsText('index.js');
    expect(unzipped).toBe('export const handler = () => {};');
  });

  it('keeps the executable bit a provided.* runtime bootstrap needs', async () => {
    const assetDir = 'custom-runtime';
    const abs = join(cdkOutputDir, assetDir);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, 'bootstrap'), '#!/bin/sh\nexec ./handler\n');
    writeFileSync(join(abs, 'config.json'), '{}');
    // `chmod`, not `writeFileSync`'s `mode`, which the process umask MASKS.
    // Measured: umask 027 yields 0750/0640 and umask 077 yields 0700/0600,
    // both failing the assertions below — green on CI (umask 022) and red on
    // a hardened workstation. `chmod(2)` ignores the umask.
    chmodSync(join(abs, 'bootstrap'), 0o755);
    chmodSync(join(abs, 'config.json'), 0o644);

    const body = await publishAndCaptureBody(assetDir);

    // A `provided.al2` Lambda whose `bootstrap` arrives without 0755 fails at
    // INVOKE time, long after a green deploy — and `zip-stream` went 6 -> 7 in
    // this bump, so the mode path is not assumed to be untouched.
    const modes = Object.fromEntries(
      new AdmZip(body).getEntries().map((e) => [e.entryName, (e.header.attr >>> 16) & 0o7777])
    );
    expect(modes['bootstrap']).toBe(0o755);
    expect(modes['config.json']).toBe(0o644);
  });

  it('compresses at the requested zlib level rather than the archiver default', async () => {
    const assetDir = 'compressible';
    const abs = join(cdkOutputDir, assetDir);
    mkdirSync(abs, { recursive: true });
    // Highly compressible, and large enough that level 9 vs level 0 cannot
    // come out equal by luck.
    writeFileSync(join(abs, 'bundle.js'), 'export const x = 1;\n'.repeat(20_000));

    const body = await publishAndCaptureBody(assetDir);

    // The publisher's ONLY constructor option is `zlib: { level: 9 }`, so
    // dropping it is silent: every other assertion in this file still passes
    // while uploads inflate under an already-minted content hash. The
    // comparand is therefore a DEFAULT-options build of the same input, not
    // an uncompressed one — measured on this fixture, level 9 is 1143 B and
    // the default 2504 B, while level 0 is 400132 B, so a level-0 comparand
    // would clear any ratio the default also clears and the case would not
    // discriminate the actual mistake. Comparing builds rather than pinning
    // a byte count keeps the case independent of the zlib version.
    const { ZipArchive } = await import('archiver');
    const atDefaultLevel = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const archive = new ZipArchive({});
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
      archive.directory(abs, false);
      archive.finalize().catch(reject);
    });

    expect(body.length).toBeLessThan(atDefaultLevel.length);
  });

  it('rejects through the archive error listener when a file cannot be read', async (ctx) => {
    // As root every open succeeds, so the case would fail for the wrong
    // reason. `ctx.skip()` rather than a bare `return`, which vitest reports
    // as a PASS — the vacuous green this repo's own rules ban.
    if (process.getuid?.() === 0) ctx.skip();

    const assetDir = 'unreadable';
    const abs = join(cdkOutputDir, assetDir);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, 'secret.js'), 'export const x = 1;', { mode: 0o000 });

    // This pins `archive.on('error', reject)`: without that listener the
    // stream emits an unhandled 'error' and the publish promise never
    // settles. It does NOT reach `finalize()`'s promise — measured, an
    // entry-read EACCES goes through `_moduleAppend`'s callback to
    // `emit('error')` only, and the finalize promise stays PENDING forever.
    // The `.catch(reject)` on it is pinned in the mocked sibling instead,
    // which is the only place the two can be separated.
    await expect(publishAndCaptureBody(assetDir)).rejects.toThrow(/EACCES|permission denied/i);
  });

  it('zips a single-file asset under its basename', async () => {
    const assetFile = 'handler.js';
    writeFileSync(join(cdkOutputDir, assetFile), 'module.exports = {};');

    const body = await publishAndCaptureBody(assetFile);

    const entries = new AdmZip(body).getEntries().map((e) => e.entryName);
    expect(entries).toEqual(['handler.js']);
    expect(new AdmZip(body).readAsText('handler.js')).toBe('module.exports = {};');
  });
});
