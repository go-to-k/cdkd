import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockS3Send, mockStsSend, mockEcrSend, mockQuestion, stateBackendMocks } = vi.hoisted(
  () => ({
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    mockEcrSend: vi.fn(),
    mockQuestion: vi.fn(),
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
    },
  })
);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return { send: mockS3Send, destroy: vi.fn() };
    },
    get sts() {
      return { send: mockStsSend, destroy: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => stateBackendMocks),
}));

// Keep the real command classes (DescribeImagesCommand etc.) so
// constructor-name assertions work; only the client is replaced.
vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({ send: mockEcrSend, destroy: vi.fn() })),
  };
});

// Let action errors propagate to parseAsync instead of process.exit-ing, so
// the refusal paths are assertable. Every other export stays real (CdkdError,
// normalizeAwsError are consumed by the code under test).
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

// The interactive y/N prompt (only reached without --yes on a TTY stdin).
vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
  },
}));

import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DescribeImagesCommand, BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import {
  createGcCommand,
  parseOlderThan,
  collectAssetReferences,
  type AssetReferences,
} from '../../../src/cli/commands/gc.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { derivePartitionAndUrlSuffix, PARTITION_TABLE } from '../../../src/utils/aws-partition.js';
import type { BootstrapMarker } from '../../../src/assets/asset-storage.js';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const MARKER_KEY = `cdkd-bootstrap/${REGION}.json`;
// Deliberately NOT the `cdkd-assets-{acct}-{region}` naming convention: gc
// must take names from the marker, never recompute them (#1011 custom-name
// compatibility).
const ASSET_BUCKET = 'my-custom-asset-bucket';
const CONTAINER_REPO = 'my-custom-container-repo';
const MARKER_BODY = JSON.stringify({
  assetBucket: ASSET_BUCKET,
  containerRepo: CONTAINER_REPO,
  assetSupportVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const STATE_KEY = `cdkd/MyStack/${REGION}/state.json`;
const PREFIXED_STATE_KEY = `custom-prefix/PrefixedStack/${REGION}/state.json`;

const REF_DIGEST = `sha256:${'a'.repeat(64)}`;
const GARBAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'c'.repeat(64)}`;
const TAG_ONLY_DIGEST = `sha256:${'d'.repeat(64)}`;
const MULTI_TAG_DIGEST = `sha256:${'e'.repeat(64)}`;
const COMBO_DIGEST = `sha256:${'f'.repeat(64)}`;

// Content-addressed keys for the comma-joined-URI belt-and-braces pass:
// two s3:// URIs joined by a comma yield ONE over-long URL capture, so
// only the name-independent `<sha256>.<ext>` pass protects them.
const HASH_KEY_A = `${'1'.repeat(64)}.zip`;
const HASH_KEY_B = `${'2'.repeat(64)}.zip`;

// Fn::Base64-resolved UserData carrying an s3:// reference — collected via
// the one-level base64 decode pass.
const USERDATA_B64 = Buffer.from(
  `#!/bin/bash\naws s3 cp s3://my-custom-asset-bucket/ref-userdata.sh /tmp/boot.sh\n`,
  'utf8'
).toString('base64');

// Older than the 30d default cutoff vs. brand new.
const OLD = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
const NEW = new Date();

/**
 * Default main-stack state: every reference SHAPE the extractor must
 * understand, spread across properties / observedProperties / attributes /
 * outputs.
 */
const STATE_BODY = JSON.stringify({
  version: 8,
  stackName: 'MyStack',
  region: REGION,
  resources: {
    Fn: {
      physicalId: 'fn',
      resourceType: 'AWS::Lambda::Function',
      properties: {
        Code: { S3Bucket: ASSET_BUCKET, S3Key: 'ref-pair.zip' },
        Environment: {
          Variables: {
            ASSET_URI: `s3://${ASSET_BUCKET}/ref-s3uri.zip`,
            SIGNED_URL: `https://${ASSET_BUCKET}.s3.${REGION}.amazonaws.com/ref-query.zip?X-Amz-Signature=abc`,
          },
        },
      },
      observedProperties: {
        PathStyle: `https://s3.${REGION}.amazonaws.com/${ASSET_BUCKET}/ref-path.zip`,
      },
      attributes: {},
      dependencies: [],
    },
    Container: {
      physicalId: 'container-fn',
      resourceType: 'AWS::Lambda::Function',
      properties: {
        Code: {
          ImageUri: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONTAINER_REPO}:ref-tag`,
        },
      },
      attributes: {
        ResolvedImageUri: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONTAINER_REPO}@${REF_DIGEST}`,
      },
      dependencies: [],
    },
    Api: {
      physicalId: 'rest-api',
      resourceType: 'AWS::ApiGateway::RestApi',
      properties: {
        // `{Bucket, Key}` location shape (SpecRestApi / ApiDefinition.fromAsset,
        // SFN DefinitionS3Location) — the generalized any-value-matches-bucket
        // pair collection must protect this (review blocker on PR #1022).
        BodyS3Location: { Bucket: ASSET_BUCKET, Key: 'ref-bucketkey.json' },
      },
      attributes: {},
      dependencies: [],
    },
    Instance: {
      physicalId: 'i-userdata',
      resourceType: 'AWS::EC2::Instance',
      properties: {
        // Fn::Base64-resolved UserData — reference inside the encoded text.
        UserData: USERDATA_B64,
        // Comma-joined URIs: the URL capture over-runs the comma, so only
        // the content-hash pass protects the two real keys.
        BootAssets: `s3://${ASSET_BUCKET}/${HASH_KEY_A},s3://${ASSET_BUCKET}/${HASH_KEY_B}`,
      },
      attributes: {},
      dependencies: [],
    },
    MultiTagImage: {
      physicalId: 'multi-tag-fn',
      resourceType: 'AWS::Lambda::Function',
      properties: {
        // Only ONE of the image's tags is referenced — the image must be
        // kept (tags.some semantics).
        Code: {
          ImageUri: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONTAINER_REPO}:ref-tag-multi`,
        },
      },
      attributes: {
        // Combined `:tag@sha256:digest` URI — both captures collected.
        ComboUri: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONTAINER_REPO}:combo-tag@${COMBO_DIGEST}`,
      },
      dependencies: [],
    },
  },
  outputs: {
    TemplateUrl: `https://${ASSET_BUCKET}.s3.${REGION}.amazonaws.com/ref-output.json`,
  },
  lastModified: Date.now(),
});

/** State deployed under a custom --state-prefix — must still protect refs. */
const PREFIXED_STATE_BODY = JSON.stringify({
  version: 8,
  stackName: 'PrefixedStack',
  region: REGION,
  resources: {
    Fn: {
      physicalId: 'fn2',
      resourceType: 'AWS::Lambda::Function',
      properties: { Code: { S3Bucket: ASSET_BUCKET, S3Key: 'ref-prefixed.zip' } },
      attributes: {},
      dependencies: [],
    },
  },
  outputs: {},
  lastModified: Date.now(),
});

/** Every key the default STATE fixtures reference — all OLD in the bucket. */
const REFERENCED_KEYS = [
  'ref-pair.zip',
  'ref-s3uri.zip',
  'ref-query.zip',
  'ref-path.zip',
  'ref-output.json',
  'ref-prefixed.zip',
  'ref-bucketkey.json',
  'ref-userdata.sh',
  HASH_KEY_A,
  HASH_KEY_B,
];

async function runGc(extraArgs: string[] = []): Promise<void> {
  await runGcInRegion(REGION, extraArgs);
}

async function runGcInRegion(region: string, extraArgs: string[] = []): Promise<void> {
  const cmd = createGcCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['--region', region, ...extraArgs], { from: 'user' });
}

function s3CommandNames(): string[] {
  return mockS3Send.mock.calls.map((c) => (c[0] as object).constructor.name);
}

function s3Inputs(commandName: string): Record<string, unknown>[] {
  return mockS3Send.mock.calls
    .filter((c) => (c[0] as object).constructor.name === commandName)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

function ecrInputs(commandName: string): Record<string, unknown>[] {
  return mockEcrSend.mock.calls
    .filter((c) => (c[0] as object).constructor.name === commandName)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

function deletedS3Keys(): string[] {
  return s3Inputs(DeleteObjectsCommand.name).flatMap((input) =>
    ((input['Delete'] as { Objects: { Key: string }[] }).Objects ?? []).map((o) => o.Key)
  );
}

function deletedDigests(): string[] {
  return ecrInputs(BatchDeleteImageCommand.name).flatMap((input) =>
    (input['imageIds'] as { imageDigest: string }[]).map((i) => i.imageDigest)
  );
}

function expectNothingDeleted(): void {
  expect(s3CommandNames()).not.toContain(DeleteObjectsCommand.name);
  expect(ecrInputs(BatchDeleteImageCommand.name)).toHaveLength(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });

  // Default scripting: marker present, two state files (default + custom
  // prefix), no locks; asset bucket holds every referenced key (all OLD)
  // plus one old garbage object and one new garbage object; the repo holds
  // referenced images (by tag and by digest), one old garbage image, and
  // one new garbage image.
  stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
    if (key === MARKER_KEY) return MARKER_BODY;
    if (key === STATE_KEY) return STATE_BODY;
    if (key === PREFIXED_STATE_KEY) return PREFIXED_STATE_BODY;
    return null;
  });
  stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
    if (prefix === '') return [MARKER_KEY, STATE_KEY, PREFIXED_STATE_KEY];
    return [];
  });
  mockS3Send.mockImplementation(async (command: object) => {
    if (command instanceof ListObjectsV2Command) {
      return {
        Contents: [
          ...REFERENCED_KEYS.map((key) => ({ Key: key, Size: 100, LastModified: OLD })),
          { Key: 'garbage-old.zip', Size: 2048, LastModified: OLD },
          { Key: 'garbage-new.zip', Size: 512, LastModified: NEW },
        ],
        IsTruncated: false,
      };
    }
    return {};
  });
  mockEcrSend.mockImplementation(async (command: object) => {
    if (command instanceof DescribeImagesCommand) {
      return {
        imageDetails: [
          {
            imageDigest: TAG_ONLY_DIGEST,
            imageTags: ['ref-tag'],
            imageSizeInBytes: 1000,
            imagePushedAt: OLD,
          },
          { imageDigest: REF_DIGEST, imageSizeInBytes: 1000, imagePushedAt: OLD },
          {
            // Only 'ref-tag-multi' is referenced; 'unref-tag' is not — the
            // image must be KEPT (tags.some, not tags.every).
            imageDigest: MULTI_TAG_DIGEST,
            imageTags: ['ref-tag-multi', 'unref-tag'],
            imageSizeInBytes: 1000,
            imagePushedAt: OLD,
          },
          {
            // Referenced via the combined `:combo-tag@sha256:...` URI.
            imageDigest: COMBO_DIGEST,
            imageTags: ['combo-tag'],
            imageSizeInBytes: 1000,
            imagePushedAt: OLD,
          },
          {
            imageDigest: GARBAGE_DIGEST,
            imageTags: ['garbage-tag'],
            imageSizeInBytes: 4096,
            imagePushedAt: OLD,
          },
          { imageDigest: NEW_DIGEST, imageTags: ['new-tag'], imageSizeInBytes: 1, imagePushedAt: NEW },
        ],
      };
    }
    return {};
  });
});

describe('cdkd gc', () => {
  it('deletes only unreferenced+old objects/images; referenced or recent ones are kept', async () => {
    await runGc(['--yes']);

    // S3: only the old, unreferenced object goes. Every reference shape
    // (S3Bucket/S3Key pair, s3:// URI, https virtual-hosted URL with query
    // string stripped, https path-style URL, outputs URL, custom
    // --state-prefix state file) protected its key.
    expect(deletedS3Keys()).toEqual(['garbage-old.zip']);

    // ECR: only the old, unreferenced image goes — tag-referenced and
    // digest-referenced images stay, as does the too-new one.
    expect(deletedDigests()).toEqual([GARBAGE_DIGEST]);
  });

  it('reads bucket/repo names from the marker, never the naming convention', async () => {
    await runGc(['--yes']);

    for (const input of [...s3Inputs(ListObjectsV2Command.name), ...s3Inputs(DeleteObjectsCommand.name)]) {
      expect(input['Bucket']).toBe(ASSET_BUCKET);
    }
    for (const input of [
      ...ecrInputs(DescribeImagesCommand.name),
      ...ecrInputs(BatchDeleteImageCommand.name),
    ]) {
      expect(input['repositoryName']).toBe(CONTAINER_REPO);
    }
  });

  it('passes ExpectedBucketOwner on every S3 call against the asset bucket', async () => {
    await runGc(['--yes']);

    for (const name of [ListObjectsV2Command.name, DeleteObjectsCommand.name]) {
      const inputs = s3Inputs(name);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input['ExpectedBucketOwner']).toBe(ACCOUNT);
      }
    }
  });

  it('is a friendly no-op when the region has no bootstrap marker', async () => {
    stateBackendMocks.getRawObject.mockResolvedValue(null);

    // No --yes on purpose: the early return must fire before any prompt.
    await runGc();

    expect(s3CommandNames()).not.toContain(ListObjectsV2Command.name);
    expect(mockEcrSend).not.toHaveBeenCalled();
    expect(mockQuestion).not.toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('is a friendly no-op when the state bucket itself does not exist', async () => {
    stateBackendMocks.getRawObject.mockRejectedValue(
      Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' })
    );

    await runGc();

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEcrSend).not.toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('aborts when any stack holds a lock, naming the locked stack', async () => {
    stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
      if (prefix === '')
        return [MARKER_KEY, STATE_KEY, `cdkd/LockedStack/${REGION}/lock.json`];
      return [];
    });

    await expect(runGc(['--yes'])).rejects.toThrow(/LockedStack \(us-east-1\)/);
    await expect(runGc(['--yes'])).rejects.toThrow(/force-unlock/);
    expect(s3CommandNames()).not.toContain(ListObjectsV2Command.name);
    expectNothingDeleted();
  });

  it('aborts the whole run when a state file fails to JSON-parse', async () => {
    stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
      if (key === MARKER_KEY) return MARKER_BODY;
      if (key === STATE_KEY) return 'this is { not json';
      return PREFIXED_STATE_BODY;
    });

    await expect(runGc(['--yes'])).rejects.toThrow(/not valid JSON/);
    expect(s3CommandNames()).not.toContain(ListObjectsV2Command.name);
    expectNothingDeleted();
  });

  it('--dry-run prints the plan and performs zero mutations without prompting', async () => {
    await runGc(['--dry-run']);

    expect(mockQuestion).not.toHaveBeenCalled();
    expectNothingDeleted();
    // The plan was still computed (listing happened).
    expect(s3CommandNames()).toContain(ListObjectsV2Command.name);
  });

  it('declined confirmation deletes nothing', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockQuestion.mockResolvedValue('n');
    try {
      await runGc();
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expect(mockQuestion).toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('empty answer at the prompt defaults to NO', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockQuestion.mockResolvedValue('');
    try {
      await runGc();
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expectNothingDeleted();
  });

  it('non-TTY stdin without --yes is a hard error, not a hang or silent delete', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await expect(runGc()).rejects.toThrow(CdkdError);
      await expect(runGc()).rejects.toThrow(/--yes/);
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expectNothingDeleted();
  });

  it('zero candidates is an info no-op with no prompt', async () => {
    mockS3Send.mockImplementation(async (command: object) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: REFERENCED_KEYS.map((key) => ({ Key: key, Size: 100, LastModified: OLD })),
          IsTruncated: false,
        };
      }
      return {};
    });
    mockEcrSend.mockImplementation(async (command: object) => {
      if (command instanceof DescribeImagesCommand) {
        return {
          imageDetails: [
            {
              imageDigest: REF_DIGEST,
              imageTags: ['ref-tag'],
              imageSizeInBytes: 1,
              imagePushedAt: OLD,
            },
          ],
        };
      }
      return {};
    });

    // No --yes on purpose: zero candidates must not prompt.
    await runGc();

    expect(mockQuestion).not.toHaveBeenCalled();
    expectNothingDeleted();
  });

  describe('--older-than age guard', () => {
    it('honors a shorter --older-than (a 2d-old object deleted with 1d, kept with default 30d)', async () => {
      const twoDaysOld = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: [{ Key: 'recent-garbage.zip', Size: 1, LastModified: twoDaysOld }],
            IsTruncated: false,
          };
        }
        return {};
      });
      mockEcrSend.mockImplementation(async () => ({ imageDetails: [] }));

      await runGc(['--yes']); // default 30d: kept
      expectNothingDeleted();

      vi.clearAllMocks();
      mockStsSend.mockResolvedValue({ Account: ACCOUNT });
      await runGc(['--yes', '--older-than', '1d']); // 1d: deleted
      expect(deletedS3Keys()).toEqual(['recent-garbage.zip']);
    });

    it('keeps objects/images with no timestamp (treated as new)', async () => {
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          return { Contents: [{ Key: 'no-timestamp.zip', Size: 1 }], IsTruncated: false };
        }
        return {};
      });
      mockEcrSend.mockImplementation(async (command: object) => {
        if (command instanceof DescribeImagesCommand) {
          return {
            imageDetails: [{ imageDigest: GARBAGE_DIGEST, imageTags: [], imageSizeInBytes: 1 }],
          };
        }
        return {};
      });

      await runGc(['--yes']);
      expectNothingDeleted();
    });

    it('rejects zero / negative / unitless / unknown-unit --older-than values', async () => {
      await expect(runGc(['--older-than', '0d'])).rejects.toThrow(/greater than zero/);
      await expect(runGc(['--older-than=-1d'])).rejects.toThrow(/Invalid --older-than/);
      await expect(runGc(['--older-than', '30'])).rejects.toThrow(/Invalid --older-than/);
      await expect(runGc(['--older-than', '12x'])).rejects.toThrow(/Invalid --older-than/);
      expectNothingDeleted();
    });

    it('parseOlderThan converts days and hours to milliseconds', () => {
      expect(parseOlderThan('30d')).toBe(30 * 24 * 60 * 60 * 1000);
      expect(parseOlderThan('12h')).toBe(12 * 60 * 60 * 1000);
      expect(parseOlderThan('1.5d')).toBe(1.5 * 24 * 60 * 60 * 1000);
      expect(() => parseOlderThan('5m')).toThrow(/Invalid --older-than/);
    });
  });

  describe('pagination', () => {
    it('threads ContinuationToken across ListObjectsV2 pages', async () => {
      let listCall = 0;
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          listCall += 1;
          if (listCall === 1) {
            return {
              Contents: [{ Key: 'page1-garbage.zip', Size: 1, LastModified: OLD }],
              IsTruncated: true,
              NextContinuationToken: 'tok-1',
            };
          }
          return {
            Contents: [{ Key: 'page2-garbage.zip', Size: 1, LastModified: OLD }],
            IsTruncated: false,
          };
        }
        return {};
      });
      mockEcrSend.mockImplementation(async () => ({ imageDetails: [] }));

      await runGc(['--yes']);

      const listInputs = s3Inputs(ListObjectsV2Command.name);
      expect(listInputs).toHaveLength(2);
      expect(listInputs[0]).not.toHaveProperty('ContinuationToken');
      expect(listInputs[1]).toMatchObject({ ContinuationToken: 'tok-1' });
      expect(deletedS3Keys()).toEqual(['page1-garbage.zip', 'page2-garbage.zip']);
    });

    it('threads nextToken across DescribeImages pages', async () => {
      const digest2 = `sha256:${'e'.repeat(64)}`;
      let describeCall = 0;
      mockEcrSend.mockImplementation(async (command: object) => {
        if (command instanceof DescribeImagesCommand) {
          describeCall += 1;
          if (describeCall === 1) {
            return {
              imageDetails: [
                { imageDigest: GARBAGE_DIGEST, imageSizeInBytes: 1, imagePushedAt: OLD },
              ],
              nextToken: 'tok-ecr',
            };
          }
          return {
            imageDetails: [{ imageDigest: digest2, imageSizeInBytes: 1, imagePushedAt: OLD }],
          };
        }
        return {};
      });
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: false };
        return {};
      });

      await runGc(['--yes']);

      const describeInputs = ecrInputs(DescribeImagesCommand.name);
      expect(describeInputs).toHaveLength(2);
      expect(describeInputs[0]).not.toHaveProperty('nextToken');
      expect(describeInputs[1]).toMatchObject({ nextToken: 'tok-ecr' });
      expect(deletedDigests()).toEqual([GARBAGE_DIGEST, digest2]);
    });
  });

  describe('chunked deletion', () => {
    it('chunks S3 deletes to 1,000 keys and ECR deletes to 100 image ids per call', async () => {
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: Array.from({ length: 1500 }, (_, i) => ({
              Key: `garbage-${i}.zip`,
              Size: 1,
              LastModified: OLD,
            })),
            IsTruncated: false,
          };
        }
        return {};
      });
      mockEcrSend.mockImplementation(async (command: object) => {
        if (command instanceof DescribeImagesCommand) {
          return {
            imageDetails: Array.from({ length: 150 }, (_, i) => ({
              imageDigest: `sha256:${String(i).padStart(64, '0')}`,
              imageSizeInBytes: 1,
              imagePushedAt: OLD,
            })),
          };
        }
        return {};
      });

      await runGc(['--yes']);

      const deleteInputs = s3Inputs(DeleteObjectsCommand.name);
      expect(deleteInputs).toHaveLength(2);
      expect((deleteInputs[0]!['Delete'] as { Objects: unknown[] }).Objects).toHaveLength(1000);
      expect((deleteInputs[1]!['Delete'] as { Objects: unknown[] }).Objects).toHaveLength(500);

      const batchInputs = ecrInputs(BatchDeleteImageCommand.name);
      expect(batchInputs).toHaveLength(2);
      expect(batchInputs[0]!['imageIds']).toHaveLength(100);
      expect(batchInputs[1]!['imageIds']).toHaveLength(50);
    });
  });

  describe('deletion failures', () => {
    it('surfaces per-key DeleteObjects Errors as a hard error', async () => {
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: [{ Key: 'garbage-old.zip', Size: 1, LastModified: OLD }],
            IsTruncated: false,
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          return { Errors: [{ Key: 'garbage-old.zip', Code: 'AccessDenied', Message: 'denied' }] };
        }
        return {};
      });
      mockEcrSend.mockImplementation(async () => ({ imageDetails: [] }));

      await expect(runGc(['--yes'])).rejects.toThrow(/Failed to delete 1 object/);
    });

    it('surfaces BatchDeleteImage failures as a hard error', async () => {
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: false };
        return {};
      });
      mockEcrSend.mockImplementation(async (command: object) => {
        if (command instanceof DescribeImagesCommand) {
          return {
            imageDetails: [
              { imageDigest: GARBAGE_DIGEST, imageSizeInBytes: 1, imagePushedAt: OLD },
            ],
          };
        }
        if (command instanceof BatchDeleteImageCommand) {
          return {
            failures: [
              {
                imageId: { imageDigest: GARBAGE_DIGEST },
                failureCode: 'ImageReferencedByManifestList',
                failureReason: 'referenced',
              },
            ],
          };
        }
        return {};
      });

      await expect(runGc(['--yes'])).rejects.toThrow(/Failed to delete 1 image/);
    });
  });

  describe('asset-storage edge cases', () => {
    it('refuses a foreign asset bucket (ListObjectsV2 403)', async () => {
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          throw Object.assign(new Error('Forbidden'), {
            name: 'Forbidden',
            $metadata: { httpStatusCode: 403 },
          });
        }
        return {};
      });

      await expect(runGc(['--yes'])).rejects.toThrow(/not owned by account/);
      expectNothingDeleted();
    });

    it('skips a missing asset bucket / repo idempotently', async () => {
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          throw Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' });
        }
        return {};
      });
      mockEcrSend.mockImplementation(async () => {
        throw Object.assign(new Error('RepositoryNotFoundException'), {
          name: 'RepositoryNotFoundException',
        });
      });

      // Nothing to gc → info no-op, no prompt, no error.
      await runGc();

      expect(mockQuestion).not.toHaveBeenCalled();
      expectNothingDeleted();
    });
  });

  // Issue #1781: all three asset-reference matchers used to hardcode the
  // commercial `amazonaws.com` suffix, so outside that partition NOTHING
  // matched, every live asset read as UNREFERENCED, and gc DELETED it.
  // Every non-commercial assertion below is paired with a commercial
  // counter-case asserting the unchanged collection (the #1758 convention).
  describe('partition URL suffixes (issue #1781)', () => {
    const MARKER: BootstrapMarker = {
      assetBucket: ASSET_BUCKET,
      containerRepo: CONTAINER_REPO,
      assetSupportVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    /** Collect references out of ONE string, as a state document would carry it. */
    function collect(value: string): AssetReferences {
      const refs: AssetReferences = {
        s3Keys: new Set(),
        imageTags: new Set(),
        imageDigests: new Set(),
      };
      collectAssetReferences({ SomeProperty: value }, MARKER, refs);
      return refs;
    }

    // ONE region per row of the EXPORTED partition table, synthesized from the
    // row's own prefix rather than hand-written (issue #1785).
    //
    // This is the half the previous hand-written list could not do: a new arm
    // added to `PARTITION_TABLE` now arrives here on its own, so a suffix gc
    // does not match reds INSTEAD of silently deleting that partition's live
    // assets. `derivePartitionAndUrlSuffix` is still the thing under test for
    // the suffix each region resolves to — the row is only the source of the
    // region to probe, and that a probe reaches its OWN row (rather than an
    // earlier row swallowing it) is pinned by `reaches every row through the
    // public function` in `tests/unit/utils/aws-partition.test.ts`.
    const DERIVE_TABLE_PROBES = PARTITION_TABLE.map((row) => `${row.prefix}probe-1`);

    // A hand-written FLOOR of the suffixes cdkd has already written into state
    // files, asserted independently of the table.
    //
    // Deriving gc's list from `PARTITION_TABLE` propagates ADDITIONS, but it
    // also means a row edited or removed there would silently stop gc matching
    // state already written with the old suffix — the irreversible direction.
    // This literal is what makes such a removal red: the suffix has to be
    // carried over into `GC_EXTRA_URL_SUFFIXES` deliberately.
    const RECORDED_SUFFIX_FLOOR = [
      'amazonaws.com', // aws, aws-us-gov
      'amazonaws.com.cn', // aws-cn
      'amazonaws.eu', // aws-eusc
      'c2s.ic.gov', // aws-iso
      'sc2s.sgov.gov', // aws-iso-b
      'cloud.adc-e.uk', // aws-iso-e
      'csp.hci.ic.gov', // aws-iso-f
    ];

    it('collects a virtual-hosted S3 reference for every arm of the exported partition table', () => {
      // The count floor proves the loop SAW its input: an accidentally empty
      // (or filtered-to-nothing) table would otherwise pass vacuously.
      expect(DERIVE_TABLE_PROBES.length).toBeGreaterThanOrEqual(7);

      for (const region of DERIVE_TABLE_PROBES) {
        const { urlSuffix } = derivePartitionAndUrlSuffix(region);
        const refs = collect(`https://${ASSET_BUCKET}.s3.${region}.${urlSuffix}/live-asset.zip`);
        expect([...refs.s3Keys], `region ${region} (${urlSuffix})`).toEqual(['live-asset.zip']);
      }
    });

    it('still collects every suffix already recorded in state, table row or not', () => {
      for (const urlSuffix of RECORDED_SUFFIX_FLOOR) {
        const refs = collect(`https://${ASSET_BUCKET}.s3.some-region-1.${urlSuffix}/live-asset.zip`);
        expect([...refs.s3Keys], `suffix ${urlSuffix}`).toEqual(['live-asset.zip']);
      }
    });


    it('collects a path-style S3 reference outside commercial; commercial unchanged', () => {
      expect([
        ...collect(`https://s3.cn-north-1.amazonaws.com.cn/${ASSET_BUCKET}/cn-path.zip`).s3Keys,
      ]).toEqual(['cn-path.zip']);
      expect([
        ...collect(`https://s3.us-iso-east-1.c2s.ic.gov/${ASSET_BUCKET}/iso-path.zip`).s3Keys,
      ]).toEqual(['iso-path.zip']);

      // Commercial counter-case: byte-identical input still collects the key.
      expect([
        ...collect(`https://s3.${REGION}.amazonaws.com/${ASSET_BUCKET}/com-path.zip`).s3Keys,
      ]).toEqual(['com-path.zip']);
    });

    it('collects the dualstack / no-region virtual-hosted variants outside commercial', () => {
      expect([
        ...collect(`https://${ASSET_BUCKET}.s3.dualstack.cn-north-1.amazonaws.com.cn/dual.zip`)
          .s3Keys,
      ]).toEqual(['dual.zip']);
      expect([...collect(`https://${ASSET_BUCKET}.s3.amazonaws.com.cn/no-region.zip`).s3Keys]).toEqual(
        ['no-region.zip']
      );

      // Commercial counter-case.
      expect([
        ...collect(`https://${ASSET_BUCKET}.s3.dualstack.${REGION}.amazonaws.com/dual.zip`).s3Keys,
      ]).toEqual(['dual.zip']);
    });

    it('strips a query string from a non-commercial pre-signed URL; commercial unchanged', () => {
      expect([
        ...collect(
          `https://${ASSET_BUCKET}.s3.cn-north-1.amazonaws.com.cn/signed.zip?X-Amz-Signature=abc`
        ).s3Keys,
      ]).toEqual(['signed.zip']);
      expect([
        ...collect(
          `https://${ASSET_BUCKET}.s3.${REGION}.amazonaws.com/signed.zip?X-Amz-Signature=abc`
        ).s3Keys,
      ]).toEqual(['signed.zip']);
    });

    it('collects an ECR tag + digest outside commercial; commercial unchanged', () => {
      const digest = `sha256:${'9'.repeat(64)}`;

      const cn = collect(
        `${ACCOUNT}.dkr.ecr.cn-north-1.amazonaws.com.cn/${CONTAINER_REPO}:cn-tag@${digest}`
      );
      expect([...cn.imageTags]).toEqual(['cn-tag']);
      expect([...cn.imageDigests]).toEqual([digest]);

      const iso = collect(
        `${ACCOUNT}.dkr.ecr.us-isob-east-1.sc2s.sgov.gov/${CONTAINER_REPO}:iso-tag`
      );
      expect([...iso.imageTags]).toEqual(['iso-tag']);

      // Commercial counter-case: byte-identical input still collects both.
      const com = collect(
        `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONTAINER_REPO}:com-tag@${digest}`
      );
      expect([...com.imageTags]).toEqual(['com-tag']);
      expect([...com.imageDigests]).toEqual([digest]);
    });

    it('collects the ECR FIPS + short-form hosts outside commercial; commercial unchanged', () => {
      const digest = `sha256:${'8'.repeat(64)}`;

      // FIPS host (`dkr.ecr-fips.<region>.<urlSuffix>`) — the `us-gov-*`
      // partition's suffix is the commercial one, so the FIPS infix is the
      // ONLY thing distinguishing it and a plain `\.ecr\.` matcher misses it.
      const gov = collect(
        `${ACCOUNT}.dkr.ecr-fips.us-gov-west-1.amazonaws.com/${CONTAINER_REPO}:gov-tag`
      );
      expect([...gov.imageTags]).toEqual(['gov-tag']);

      const cnFips = collect(
        `${ACCOUNT}.dkr.ecr-fips.cn-north-1.amazonaws.com.cn/${CONTAINER_REPO}:cn-fips-tag@${digest}`
      );
      expect([...cnFips.imageTags]).toEqual(['cn-fips-tag']);
      expect([...cnFips.imageDigests]).toEqual([digest]);

      // Short-form alias (`dkr-ecr.<region>.on.aws`). Deliberately NOT routed
      // through the shared S3 suffix set — see ECR_REGISTRY_HOST.
      const short = collect(
        `${ACCOUNT}.dkr-ecr.${REGION}.on.aws/${CONTAINER_REPO}:short-tag@${digest}`
      );
      expect([...short.imageTags]).toEqual(['short-tag']);
      expect([...short.imageDigests]).toEqual([digest]);

      // Commercial counter-case on the plain host: byte-identical, unchanged.
      const com = collect(`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONTAINER_REPO}:com-tag`);
      expect([...com.imageTags]).toEqual(['com-tag']);
    });

    it('the ECR short-form suffix does NOT leak into the S3 matchers', () => {
      // `on.aws` is an ECR-only endpoint. If it were folded into the shared
      // AWS_URL_SUFFIXES set, both S3 shapes below would start matching.
      expect([...collect(`https://${ASSET_BUCKET}.s3.${REGION}.on.aws/leak.zip`).s3Keys]).toEqual(
        []
      );
      expect([
        ...collect(`https://s3.${REGION}.on.aws/${ASSET_BUCKET}/leak.zip`).s3Keys,
      ]).toEqual([]);
    });

    it('does NOT treat a look-alike host as a cdkd asset reference', () => {
      // A foreign suffix, and a host that merely EMBEDS a real suffix without
      // ending in one. Over-matching here would only ever over-protect, but it
      // would let any string naming the bucket pin an object forever.
      const lookAlikes = [
        `https://${ASSET_BUCKET}.s3.${REGION}.example.com/lookalike.zip`,
        `https://${ASSET_BUCKET}.s3.${REGION}.amazonaws.com.evil.com/lookalike.zip`,
        `https://s3.${REGION}.example.com/${ASSET_BUCKET}/lookalike.zip`,
      ];
      for (const value of lookAlikes) {
        expect([...collect(value).s3Keys], value).toEqual([]);
      }

      // BOTH ECR outputs are asserted: a digest-only look-alike carries no
      // `:tag`, so checking `imageTags` alone would pass it unexamined.
      const digest = `sha256:${'7'.repeat(64)}`;
      const ecrLookAlikes = [
        `${ACCOUNT}.dkr.ecr.${REGION}.example.com/${CONTAINER_REPO}:lookalike-tag@${digest}`,
        `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com.evil.com/${CONTAINER_REPO}:lookalike-tag`,
        `${ACCOUNT}.dkr.ecr.${REGION}.example.com/${CONTAINER_REPO}@${digest}`,
        `${ACCOUNT}.dkr.ecr-fips.${REGION}.example.com/${CONTAINER_REPO}:lookalike-tag`,
        `${ACCOUNT}.dkr-ecr.${REGION}.on.aws.evil.com/${CONTAINER_REPO}:lookalike-tag`,
      ];
      for (const value of ecrLookAlikes) {
        const refs = collect(value);
        expect([...refs.imageTags], value).toEqual([]);
        expect([...refs.imageDigests], value).toEqual([]);
      }
    });

    it('keeps the live assets of a cn-north-1 stack instead of deleting them', async () => {
      // The assertion that actually protects the user: end-to-end, a state
      // file recording `amazonaws.com.cn` hosts must make gc treat those
      // objects / images as REFERENCED. Before the fix every one of them was
      // selected for deletion.
      const CN_REGION = 'cn-north-1';
      const CN_MARKER_KEY = `cdkd-bootstrap/${CN_REGION}.json`;
      const CN_STATE_KEY = `cdkd/CnStack/${CN_REGION}/state.json`;
      const CN_TAGGED_DIGEST = `sha256:${'1'.repeat(63)}a`;
      const CN_REF_DIGEST = `sha256:${'2'.repeat(63)}b`;
      const CN_GARBAGE_DIGEST = `sha256:${'3'.repeat(63)}c`;

      const CN_STATE_BODY = JSON.stringify({
        version: 8,
        stackName: 'CnStack',
        region: CN_REGION,
        resources: {
          Fn: {
            physicalId: 'fn',
            resourceType: 'AWS::Lambda::Function',
            properties: {
              Environment: {
                Variables: {
                  VIRTUAL_HOSTED: `https://${ASSET_BUCKET}.s3.${CN_REGION}.amazonaws.com.cn/cn-virtual.zip`,
                  PATH_STYLE: `https://s3.${CN_REGION}.amazonaws.com.cn/${ASSET_BUCKET}/cn-path.zip`,
                },
              },
            },
            attributes: {},
            dependencies: [],
          },
          Container: {
            physicalId: 'container-fn',
            resourceType: 'AWS::Lambda::Function',
            properties: {
              Code: {
                ImageUri: `${ACCOUNT}.dkr.ecr.${CN_REGION}.amazonaws.com.cn/${CONTAINER_REPO}:cn-tag`,
              },
            },
            attributes: {
              ResolvedImageUri: `${ACCOUNT}.dkr.ecr.${CN_REGION}.amazonaws.com.cn/${CONTAINER_REPO}@${CN_REF_DIGEST}`,
            },
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: Date.now(),
      });

      stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
        if (key === CN_MARKER_KEY) return MARKER_BODY;
        if (key === CN_STATE_KEY) return CN_STATE_BODY;
        return null;
      });
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
        if (prefix === '') return [CN_MARKER_KEY, CN_STATE_KEY];
        return [];
      });
      mockS3Send.mockImplementation(async (command: object) => {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: [
              { Key: 'cn-virtual.zip', Size: 100, LastModified: OLD },
              { Key: 'cn-path.zip', Size: 100, LastModified: OLD },
              { Key: 'cn-garbage.zip', Size: 100, LastModified: OLD },
            ],
            IsTruncated: false,
          };
        }
        return {};
      });
      mockEcrSend.mockImplementation(async (command: object) => {
        if (command instanceof DescribeImagesCommand) {
          return {
            imageDetails: [
              {
                imageDigest: CN_TAGGED_DIGEST,
                imageTags: ['cn-tag'],
                imageSizeInBytes: 1,
                imagePushedAt: OLD,
              },
              { imageDigest: CN_REF_DIGEST, imageSizeInBytes: 1, imagePushedAt: OLD },
              {
                imageDigest: CN_GARBAGE_DIGEST,
                imageTags: ['cn-garbage'],
                imageSizeInBytes: 1,
                imagePushedAt: OLD,
              },
            ],
          };
        }
        return {};
      });

      await runGcInRegion(CN_REGION, ['--yes']);

      // Only the genuinely unreferenced ones go; the referenced cn assets stay.
      expect(deletedS3Keys()).toEqual(['cn-garbage.zip']);
      expect(deletedDigests()).toEqual([CN_GARBAGE_DIGEST]);
    });
  });
});
