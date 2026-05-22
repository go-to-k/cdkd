import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateRaw } from 'node:zlib';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  LayerMaterializationError,
  materializeLayerFromArn,
  type AwsCredentials,
  type LambdaSendClient,
  type StsSendClient,
} from '../../../src/local/layer-arn-materializer.js';
import type { ResolvedArnLambdaLayer } from '../../../src/local/lambda-resolver.js';

/**
 * Build a minimal ZIP buffer containing the listed `{name, data}`
 * entries. The format follows the documented PKZIP central directory
 * shape with DEFLATE-compressed payloads — exactly what AWS Lambda
 * publishes as a layer ZIP.
 *
 * Hand-rolling the ZIP in test code keeps the test fully synchronous
 * against the production `unzipBufferToDirectory` helper without
 * pulling in a heavyweight test-only dep. The helper supports both
 * STORE (method 0) and DEFLATE (method 8); we always emit DEFLATE
 * here because real layer ZIPs use it.
 */
async function buildZip(entries: { name: string; data: Buffer | string }[]): Promise<Uint8Array> {
  const central: Buffer[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf-8');
    const compressed = await new Promise<Buffer>((resolve, reject) => {
      deflateRaw(dataBuf, (err, out) => (err ? reject(err) : resolve(out)));
    });
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    // crc32 stub: we use 0 because the production decoder does not
    // verify the CRC (we only compare uncompressed length).
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // gen flags
    localHeader.writeUInt16LE(8, 8); // compression: DEFLATE
    localHeader.writeUInt16LE(0, 10); // mtime
    localHeader.writeUInt16LE(0, 12); // mdate
    localHeader.writeUInt32LE(0, 14); // crc32 (unverified)
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len
    localParts.push(localHeader, nameBuf, compressed);

    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4); // version made by
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(0, 8); // gen flags
    cdEntry.writeUInt16LE(8, 10); // compression
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(0, 16);
    cdEntry.writeUInt32LE(compressed.length, 20);
    cdEntry.writeUInt32LE(dataBuf.length, 24);
    cdEntry.writeUInt16LE(nameBuf.length, 28);
    cdEntry.writeUInt16LE(0, 30); // extra
    cdEntry.writeUInt16LE(0, 32); // comment
    cdEntry.writeUInt16LE(0, 34); // disk no
    cdEntry.writeUInt16LE(0, 36); // internal
    cdEntry.writeUInt32LE(0, 38); // external (regular file)
    cdEntry.writeUInt32LE(offset, 42);
    central.push(cdEntry, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([Buffer.concat(localParts), cdBuf, eocd]));
}

function makeLayer(overrides: Partial<ResolvedArnLambdaLayer> = {}): ResolvedArnLambdaLayer {
  return {
    kind: 'arn',
    logicalId: 'arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:3',
    arn: 'arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:3',
    region: 'us-east-1',
    accountId: '111122223333',
    name: 'MyLayer',
    version: '3',
    ...overrides,
  };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; some tests already removed the dir.
    }
  }
});

describe('materializeLayerFromArn', () => {
  it('calls GetLayerVersion in the layer ARN region (not the dev profile region) and unzips Content.Location into a tmpdir', async () => {
    const calls: { region: string; command: unknown }[] = [];
    const zip = await buildZip([
      { name: 'nodejs/', data: '' },
      { name: 'nodejs/index.js', data: 'module.exports = 42;' },
    ]);

    const lambdaFactory = (region: string): LambdaSendClient => ({
      send: async (command: { input?: unknown }) => {
        calls.push({ region, command: command.input ?? command });
        return { Content: { Location: 'https://presigned.example/zip' } };
      },
    });

    const fetchedUrls: string[] = [];
    const dir = await materializeLayerFromArn(makeLayer({ region: 'eu-west-1' }), {
      lambdaClientFactory: lambdaFactory,
      fetchZip: async (url) => {
        fetchedUrls.push(url);
        return zip;
      },
    });
    cleanupDirs.push(dir);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.region).toBe('eu-west-1');
    expect(fetchedUrls).toEqual(['https://presigned.example/zip']);
    expect(existsSync(join(dir, 'nodejs', 'index.js'))).toBe(true);
    expect(readFileSync(join(dir, 'nodejs', 'index.js'), 'utf-8')).toBe('module.exports = 42;');
  });

  it('routes through sts:AssumeRole when roleArn is set and forwards the temp creds to the Lambda client', async () => {
    const stsCalls: { region: string }[] = [];
    const lambdaCalls: { credentials?: AwsCredentials }[] = [];
    const stsFactory = (region: string): StsSendClient => ({
      send: async () => {
        stsCalls.push({ region });
        return {
          Credentials: {
            AccessKeyId: 'AKIAFAKE',
            SecretAccessKey: 'secret/fake',
            SessionToken: 'session-token-fake',
          },
        };
      },
    });
    const lambdaFactory = (_region: string, credentials?: AwsCredentials): LambdaSendClient => ({
      send: async () => {
        lambdaCalls.push({ ...(credentials !== undefined && { credentials }) });
        return { Content: { Location: 'https://presigned.example/zip' } };
      },
    });
    const zip = await buildZip([{ name: 'python/handler.py', data: 'print(1)' }]);

    const dir = await materializeLayerFromArn(makeLayer({ region: 'us-west-2' }), {
      roleArn: 'arn:aws:iam::999988887777:role/CrossAccountReadLayer',
      stsClientFactory: stsFactory,
      lambdaClientFactory: lambdaFactory,
      fetchZip: async () => zip,
    });
    cleanupDirs.push(dir);

    expect(stsCalls).toEqual([{ region: 'us-west-2' }]);
    expect(lambdaCalls).toHaveLength(1);
    expect(lambdaCalls[0]!.credentials).toEqual({
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'secret/fake',
      sessionToken: 'session-token-fake',
    });
  });

  it('surfaces an actionable error on GetLayerVersion AccessDenied', async () => {
    const lambdaFactory = (): LambdaSendClient => ({
      send: async () => {
        const err = new Error(
          'User: arn:aws:iam::111122223333:user/dev is not authorized to perform: lambda:GetLayerVersion'
        );
        (err as { name?: string }).name = 'AccessDeniedException';
        throw err;
      },
    });
    await expect(
      materializeLayerFromArn(makeLayer(), {
        lambdaClientFactory: lambdaFactory,
        fetchZip: async () => new Uint8Array(),
      })
    ).rejects.toThrow(LayerMaterializationError);
    await expect(
      materializeLayerFromArn(makeLayer(), {
        lambdaClientFactory: lambdaFactory,
        fetchZip: async () => new Uint8Array(),
      })
    ).rejects.toThrow(/GetLayerVersion access denied.*--layer-role-arn/);
  });

  it('reports STS failure separately from GetLayerVersion failure (different hint)', async () => {
    const stsFactory = (): StsSendClient => ({
      send: async () => {
        throw new Error('Not authorized to perform: sts:AssumeRole');
      },
    });
    await expect(
      materializeLayerFromArn(makeLayer(), {
        roleArn: 'arn:aws:iam::999988887777:role/BadRole',
        stsClientFactory: stsFactory,
        fetchZip: async () => new Uint8Array(),
      })
    ).rejects.toThrow(/STS AssumeRole.*BadRole.*role trust policy/);
  });

  it('rejects ZIP entries that try to escape the destination directory (Zip Slip)', async () => {
    const zip = await buildZip([{ name: '../escaped.txt', data: 'evil' }]);
    const lambdaFactory = (): LambdaSendClient => ({
      send: async () => ({ Content: { Location: 'https://presigned.example/zip' } }),
    });
    await expect(
      materializeLayerFromArn(makeLayer(), {
        lambdaClientFactory: lambdaFactory,
        fetchZip: async () => zip,
      })
    ).rejects.toThrow(/escapes the destination directory/);
  });

  it('rmSyncs the just-created tmpdir on unzip failure (no orphan dir leak)', async () => {
    // Review-fix M1 from PR #491: `materializeLayerFromArn` creates a
    // fresh tmpdir via `mkdtemp(...)` BEFORE calling
    // `unzipBufferToDirectory`. The unzip step can throw (Zip Slip /
    // symlink / corrupt ZIP / unsupported compression) and the caller
    // never receives the directory path on the error path — so the
    // outer cleanup loops in `local-invoke.ts` (`ImagePlan.layerArnTmpDirs`)
    // and `local-start-api.ts` (`layerTmpDirs: Set<string>`) never learn
    // about it. Without the in-materializer `rmSync` the OS would keep
    // the dir until reboot. This test pins the fix.
    //
    // Detection strategy: snapshot the set of `cdkd-local-arn-layer-*`
    // dirs under `os.tmpdir()` before the failing call, then after the
    // reject assert no NEW dir matching the layer's `<name>-<version>`
    // prefix survived.
    const layer = makeLayer({ name: 'CleanupLayer', version: '99' });
    const prefix = `cdkd-local-arn-layer-${layer.name}-${layer.version}-`;
    const snapshot = new Set(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix))
    );

    const zip = await buildZip([{ name: '../escaped.txt', data: 'evil' }]);
    const lambdaFactory = (): LambdaSendClient => ({
      send: async () => ({ Content: { Location: 'https://presigned.example/zip' } }),
    });
    await expect(
      materializeLayerFromArn(layer, {
        lambdaClientFactory: lambdaFactory,
        fetchZip: async () => zip,
      })
    ).rejects.toThrow(LayerMaterializationError);

    const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix));
    const newDirs = after.filter((entry) => !snapshot.has(entry));
    expect(newDirs).toEqual([]);
    // Defense-in-depth: also assert none of those potential dirs exist
    // (covers a race where the OS hands out the same random suffix).
    for (const entry of newDirs) {
      expect(existsSync(join(tmpdir(), entry))).toBe(false);
    }
  });

  it('rejects HTTP failures on the presigned URL with a clear message', async () => {
    const lambdaFactory = (): LambdaSendClient => ({
      send: async () => ({ Content: { Location: 'https://presigned.example/zip' } }),
    });
    await expect(
      materializeLayerFromArn(makeLayer(), {
        lambdaClientFactory: lambdaFactory,
        fetchZip: async () => {
          throw new Error('HTTP 403 Forbidden from layer Content.Location URL');
        },
      })
    ).rejects.toThrow(/failed to download layer ZIP/);
  });

  it('rejects an empty Content.Location response (missing presigned URL)', async () => {
    const lambdaFactory = (): LambdaSendClient => ({
      send: async () => ({ Content: {} }),
    });
    await expect(
      materializeLayerFromArn(makeLayer(), {
        lambdaClientFactory: lambdaFactory,
        fetchZip: async () => new Uint8Array(),
      })
    ).rejects.toThrow(/GetLayerVersion response did not include Content\.Location/);
  });
});
