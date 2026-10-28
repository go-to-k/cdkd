import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateProjectCommand, CreateProjectCommand } from '@aws-sdk/client-codebuild';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-codebuild', async () => {
  const actual = await vi.importActual('@aws-sdk/client-codebuild');
  return {
    ...actual,
    CodeBuildClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';

const PROJECT = 'my-project';
const TYPE = 'AWS::CodeBuild::Project';

/** The minimum a CodeBuild project template needs to map cleanly. */
const BASE = {
  ServiceRole: 'arn:aws:iam::0:role/build',
  Artifacts: { Type: 'NO_ARTIFACTS' },
  Environment: {
    Type: 'LINUX_CONTAINER',
    ComputeType: 'BUILD_GENERAL1_SMALL',
    Image: 'aws/codebuild/standard:7.0',
  },
  Source: { Type: 'NO_SOURCE', BuildSpec: 'version: 0.2' },
};


/**
 * The single UpdateProject input of the update.
 *
 * Asserts exactly ONE was sent: a `.find` would silently hide a second
 * UpdateProject, and returning `undefined` when none was sent would make
 * every `toBeUndefined()` assertion below — including the CFn-parity
 * retention pins — pass vacuously against an implementation that stops
 * issuing the call at all.
 */
function updateProjectInput(): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateProjectCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as Record<string, unknown>;
}

describe('CodeBuildProvider EncryptionKey / Tags / SourceVersion removal (go-to-k/cdkd#1160)', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ project: { name: PROJECT, arn: `arn:aws:codebuild:::${PROJECT}` } });
    provider = new CodeBuildProvider();
  });

  const KEY = 'arn:aws:kms:us-east-1:0:key/abc';
  const TAGS = [{ Key: 'team', Value: 'build' }];

  // CFn A/B: CloudFormation reset a removed EncryptionKey to the AWS managed
  // S3 key; `alias/aws/s3` is the shape that reads back identically.
  it('removed: dropping EncryptionKey sends the AWS managed key alias', async () => {
    await provider.update('P', PROJECT, TYPE, { ...BASE }, { ...BASE, EncryptionKey: KEY });

    expect(updateProjectInput()['encryptionKey']).toBe('alias/aws/s3');
  });

  // CFn A/B: CloudFormation removed every user tag; `tags: []` is the clear.
  it('removed: dropping Tags sends an empty tag list', async () => {
    await provider.update('P', PROJECT, TYPE, { ...BASE }, { ...BASE, Tags: TAGS });

    expect(updateProjectInput()['tags']).toEqual([]);
  });

  it('never-present: neither field on either side sends neither member', async () => {
    await provider.update('P', PROJECT, TYPE, { ...BASE }, { ...BASE });

    const input = updateProjectInput();
    expect(input['encryptionKey']).toBeUndefined();
    expect(input['tags']).toBeUndefined();
  });

  it('kept: declared values pass through unchanged', async () => {
    const desired = { ...BASE, EncryptionKey: KEY, Tags: [{ Key: 'team', Value: 'ops' }] };

    await provider.update('P', PROJECT, TYPE, desired, { ...BASE, EncryptionKey: KEY, Tags: TAGS });

    const input = updateProjectInput();
    expect(input['encryptionKey']).toBe(KEY);
    expect(input['tags']).toEqual([{ key: 'team', value: 'ops' }]);
  });

  it('an empty-string EncryptionKey is the readback placeholder, not a declared key', async () => {
    // Previous `''`: nothing was declared, so nothing is reset (and `''`
    // itself never reaches the wire, which UpdateProject refuses).
    await provider.update('P', PROJECT, TYPE, { ...BASE }, { ...BASE, EncryptionKey: '' });
    expect(updateProjectInput()['encryptionKey']).toBeUndefined();

    // Desired `''` after a declared key: the same reset as an absent key.
    mockSend.mockClear();
    await provider.update('P', PROJECT, TYPE, { ...BASE, EncryptionKey: '' }, { ...BASE, EncryptionKey: KEY });
    expect(updateProjectInput()['encryptionKey']).toBe('alias/aws/s3');
  });

  it('rollback replay: reverting to a state without the fields clears them', async () => {
    const historical = { ...BASE };
    const attempted = { ...BASE, EncryptionKey: KEY, Tags: TAGS };

    await provider.update('P', PROJECT, TYPE, historical, attempted, { replayingState: true });

    const input = updateProjectInput();
    expect(input['encryptionKey']).toBe('alias/aws/s3');
    expect(input['tags']).toEqual([]);
  });

  it('create: an absent EncryptionKey / Tags stays absent (the reset is update-only)', async () => {
    await provider.create('P', TYPE, { ...BASE });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateProjectCommand);
    const input = call?.[0].input as Record<string, unknown> | undefined;
    expect(input).toBeDefined();
    expect(input?.['encryptionKey']).toBeUndefined();
    expect(input?.['tags']).toBeUndefined();
  });

  // CFn A/B: CloudFormation omitted sourceVersion from its UpdateProject and
  // the live value stayed, so the merge pass-through is parity.
  it('parity: removing SourceVersion sends no sourceVersion (CFn keeps it)', async () => {
    await provider.update('P', PROJECT, TYPE, { ...BASE }, { ...BASE, SourceVersion: 'refs/heads/main' });

    expect(updateProjectInput()['sourceVersion']).toBeUndefined();
  });

  it('positive polarity: a declared SourceVersion maps through', async () => {
    await provider.update('P', PROJECT, TYPE, { ...BASE, SourceVersion: 'refs/heads/dev' }, { ...BASE });

    expect(updateProjectInput()['sourceVersion']).toBe('refs/heads/dev');
  });
});
