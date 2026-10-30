import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateProjectCommand } from '@aws-sdk/client-codebuild';

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
 * The single UpdateProject input of the update. Asserts exactly ONE was sent,
 * so the retention pins below cannot pass vacuously against an update that
 * stops issuing the call.
 */
function updateProjectInput(): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateProjectCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as Record<string, unknown>;
}

const REPO = 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/r';

/** The six fields with a declared value, and the SDK member each maps to. */
const SIX: Array<[cfn: string, value: unknown, sdk: string, mapped: unknown]> = [
  [
    'VpcConfig',
    { VpcId: 'vpc-1', Subnets: ['subnet-1'], SecurityGroupIds: ['sg-1'] },
    'vpcConfig',
    { vpcId: 'vpc-1', subnets: ['subnet-1'], securityGroupIds: ['sg-1'] },
  ],
  [
    'FileSystemLocations',
    [{ Type: 'EFS', Location: 'fs-1.efs.us-east-1.amazonaws.com:/', MountPoint: '/mnt/efs', Identifier: 'efs1' }],
    'fileSystemLocations',
    [
      {
        type: 'EFS',
        location: 'fs-1.efs.us-east-1.amazonaws.com:/',
        mountPoint: '/mnt/efs',
        identifier: 'efs1',
        mountOptions: undefined,
      },
    ],
  ],
  [
    'SecondarySources',
    [{ Type: 'CODECOMMIT', Location: REPO, SourceIdentifier: 'src2' }],
    'secondarySources',
    [expect.objectContaining({ type: 'CODECOMMIT', location: REPO, sourceIdentifier: 'src2' })],
  ],
  [
    'SecondaryArtifacts',
    [{ Type: 'S3', Location: 'bucket', ArtifactIdentifier: 'art2', Name: 'out' }],
    'secondaryArtifacts',
    [expect.objectContaining({ type: 'S3', location: 'bucket', artifactIdentifier: 'art2', name: 'out' })],
  ],
  [
    'SecondarySourceVersions',
    [{ SourceIdentifier: 'src2', SourceVersion: 'refs/heads/main' }],
    'secondarySourceVersions',
    [{ sourceIdentifier: 'src2', sourceVersion: 'refs/heads/main' }],
  ],
  ['BadgeEnabled', true, 'badgeEnabled', true],
];

describe('CodeBuildProvider removal of the six CFn-kept fields (go-to-k/cdkd#5492)', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ project: { name: PROJECT, arn: `arn:aws:codebuild:::${PROJECT}` } });
    provider = new CodeBuildProvider();
  });

  // CFn A/B (go-to-k/cdkd#5492): CloudFormation's UpdateProject omitted each
  // removed member and the live value stayed, so cdkd must send nothing.
  it.each(SIX)('parity: removing %s alone sends no member for it (CFn keeps it)', async (cfn, value, sdk) => {
    await provider.update('P', PROJECT, TYPE, { ...BASE }, { ...BASE, [cfn]: value });

    const input = updateProjectInput();
    expect(input[sdk]).toBeUndefined();
  });

  it.each(SIX)('parity: removing %s beside a Description change still sends no member for it', async (cfn, value, sdk) => {
    await provider.update(
      'P',
      PROJECT,
      TYPE,
      { ...BASE, Description: 'd2' },
      { ...BASE, Description: 'd1', [cfn]: value }
    );

    const input = updateProjectInput();
    expect(input[sdk]).toBeUndefined();
    expect(input['description']).toBe('d2');
  });

  it('parity: removing all six at once sends none of them', async () => {
    const all = Object.fromEntries(SIX.map(([cfn, value]) => [cfn, value]));
    await provider.update('P', PROJECT, TYPE, { ...BASE }, { ...BASE, ...all });

    const input = updateProjectInput();
    for (const [, , sdk] of SIX) expect(input[sdk]).toBeUndefined();
  });

  it.each(SIX)('positive polarity: a declared %s maps through on update', async (cfn, value, sdk, mapped) => {
    await provider.update('P', PROJECT, TYPE, { ...BASE, [cfn]: value }, { ...BASE, [cfn]: value });

    expect(updateProjectInput()[sdk]).toEqual(mapped);
  });

  // `BadgeEnabled: false` is a declared value, not a removal: it must reach
  // the wire so a template that turns the badge off still does.
  it('positive polarity: a declared BadgeEnabled false is sent', async () => {
    await provider.update('P', PROJECT, TYPE, { ...BASE, BadgeEnabled: false }, { ...BASE, BadgeEnabled: true });

    expect(updateProjectInput()['badgeEnabled']).toBe(false);
  });
});
