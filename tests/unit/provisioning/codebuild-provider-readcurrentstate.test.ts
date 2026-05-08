import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BatchGetProjectsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-codebuild';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-codebuild', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-codebuild')>(
    '@aws-sdk/client-codebuild'
  );
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

describe('CodeBuildProvider.readCurrentState', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodeBuildProvider();
  });

  it('returns CFn-shaped properties from BatchGetProjects (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      projects: [
        {
          name: 'myproj',
          description: 'mine',
          serviceRole: 'arn:aws:iam::1:role/r',
          timeoutInMinutes: 60,
          source: { type: 'GITHUB', location: 'https://x', buildspec: 'buildspec.yml' },
          artifacts: { type: 'S3', location: 'mybucket', name: 'art' },
          environment: {
            type: 'LINUX_CONTAINER',
            image: 'aws/codebuild/standard:7.0',
            computeType: 'BUILD_GENERAL1_SMALL',
            privilegedMode: false,
            environmentVariables: [{ name: 'FOO', value: 'BAR', type: 'PLAINTEXT' }],
          },
        },
      ],
    });

    const result = await provider.readCurrentState('myproj', 'L', 'AWS::CodeBuild::Project');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(BatchGetProjectsCommand);
    expect(result).toEqual({
      Name: 'myproj',
      Description: 'mine',
      ServiceRole: 'arn:aws:iam::1:role/r',
      TimeoutInMinutes: 60,
      EncryptionKey: '',
      BadgeEnabled: false,
      SourceVersion: '',
      Source: { Type: 'GITHUB', Location: 'https://x', BuildSpec: 'buildspec.yml' },
      Artifacts: { Type: 'S3', Location: 'mybucket', Name: 'art' },
      Environment: {
        Type: 'LINUX_CONTAINER',
        Image: 'aws/codebuild/standard:7.0',
        ComputeType: 'BUILD_GENERAL1_SMALL',
        PrivilegedMode: false,
        EnvironmentVariables: [{ Name: 'FOO', Value: 'BAR', Type: 'PLAINTEXT' }],
      },
      // Always-emit placeholders for LogsConfig / VpcConfig / Cache so
      // a console-side enable on a previously-default project surfaces
      // as drift on the v3 observedProperties baseline.
      LogsConfig: {
        CloudWatchLogs: { Status: 'ENABLED' },
        S3Logs: { Status: 'DISABLED' },
      },
      VpcConfig: {},
      Cache: { Type: 'NO_CACHE' },
      // Always-emit placeholders for the rarely-set surfaces too.
      SecondarySources: [],
      SecondaryArtifacts: [],
      SecondarySourceVersions: [],
      FileSystemLocations: [],
      BuildBatchConfig: {},
      ResourceAccessRole: '',
      Tags: [],
    });
  });

  it('surfaces SecondarySources / SecondaryArtifacts / FileSystemLocations / BuildBatchConfig / ResourceAccessRole when configured', async () => {
    mockSend.mockResolvedValueOnce({
      projects: [
        {
          name: 'myproj',
          secondarySources: [
            {
              type: 'GITHUB',
              location: 'https://example/repo2',
              sourceIdentifier: 'sec1',
            },
          ],
          secondaryArtifacts: [
            {
              type: 'S3',
              location: 'sec-bucket',
              artifactIdentifier: 'sec-art',
            },
          ],
          secondarySourceVersions: [
            { sourceIdentifier: 'sec1', sourceVersion: 'main' },
          ],
          fileSystemLocations: [
            {
              type: 'EFS',
              location: 'fs-1.efs.us-east-1.amazonaws.com:/',
              mountPoint: '/mnt/data',
              identifier: 'data',
              mountOptions: 'nfsvers=4.1',
            },
          ],
          buildBatchConfig: {
            serviceRole: 'arn:aws:iam::1:role/batch',
            timeoutInMins: 60,
            batchReportMode: 'REPORT_INDIVIDUAL_BUILDS',
            combineArtifacts: false,
            restrictions: { maximumBuildsAllowed: 5 },
          },
          resourceAccessRole: 'arn:aws:iam::1:role/access',
        },
      ],
    });

    const result = await provider.readCurrentState('myproj', 'L', 'AWS::CodeBuild::Project');

    expect(result?.SecondarySources).toEqual([
      { Type: 'GITHUB', Location: 'https://example/repo2', SourceIdentifier: 'sec1' },
    ]);
    expect(result?.SecondaryArtifacts).toEqual([
      { Type: 'S3', Location: 'sec-bucket', ArtifactIdentifier: 'sec-art' },
    ]);
    expect(result?.SecondarySourceVersions).toEqual([
      { SourceIdentifier: 'sec1', SourceVersion: 'main' },
    ]);
    expect(result?.FileSystemLocations).toEqual([
      {
        Type: 'EFS',
        Location: 'fs-1.efs.us-east-1.amazonaws.com:/',
        MountPoint: '/mnt/data',
        Identifier: 'data',
        MountOptions: 'nfsvers=4.1',
      },
    ]);
    expect(result?.BuildBatchConfig).toEqual({
      ServiceRole: 'arn:aws:iam::1:role/batch',
      TimeoutInMins: 60,
      BatchReportMode: 'REPORT_INDIVIDUAL_BUILDS',
      CombineArtifacts: false,
      Restrictions: { MaximumBuildsAllowed: 5 },
    });
    expect(result?.ResourceAccessRole).toBe('arn:aws:iam::1:role/access');
  });

  it('emits VpcConfig with VpcId/Subnets/SecurityGroupIds when AWS reports a VPC config', async () => {
    mockSend.mockResolvedValueOnce({
      projects: [
        {
          name: 'myproj',
          vpcConfig: {
            vpcId: 'vpc-abc',
            subnets: ['subnet-1', 'subnet-2'],
            securityGroupIds: ['sg-1'],
          },
        },
      ],
    });

    const result = await provider.readCurrentState('myproj', 'L', 'AWS::CodeBuild::Project');
    expect(result?.VpcConfig).toEqual({
      VpcId: 'vpc-abc',
      Subnets: ['subnet-1', 'subnet-2'],
      SecurityGroupIds: ['sg-1'],
    });
  });

  it('returns undefined when project is gone (empty projects array)', async () => {
    mockSend.mockResolvedValueOnce({ projects: [] });
    const result = await provider.readCurrentState('myproj', 'L', 'AWS::CodeBuild::Project');
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from BatchGetProjects with aws:* filtered out (CodeBuild lower-case shape)', async () => {
    mockSend.mockResolvedValueOnce({
      projects: [
        {
          name: 'myproj',
          tags: [
            { key: 'Foo', value: 'Bar' },
            { key: 'aws:cdk:path', value: 'MyStack/MyProj/Resource' },
          ],
        },
      ],
    });

    const result = await provider.readCurrentState('myproj', 'L', 'AWS::CodeBuild::Project');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when BatchGetProjects returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      projects: [
        {
          name: 'myproj',
          tags: [{ key: 'aws:cdk:path', value: 'MyStack/MyProj/Resource' }],
        },
      ],
    });

    const result = await provider.readCurrentState('myproj', 'L', 'AWS::CodeBuild::Project');
    expect(result?.Tags).toEqual([]);
  });
});
