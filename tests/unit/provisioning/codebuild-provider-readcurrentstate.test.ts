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
      Source: { Type: 'GITHUB', Location: 'https://x', BuildSpec: 'buildspec.yml' },
      Artifacts: { Type: 'S3', Location: 'mybucket', Name: 'art' },
      Environment: {
        Type: 'LINUX_CONTAINER',
        Image: 'aws/codebuild/standard:7.0',
        ComputeType: 'BUILD_GENERAL1_SMALL',
        PrivilegedMode: false,
        EnvironmentVariables: [{ Name: 'FOO', Value: 'BAR', Type: 'PLAINTEXT' }],
      },
    });
  });

  it('returns undefined when project is gone (empty projects array)', async () => {
    mockSend.mockResolvedValueOnce({ projects: [] });
    const result = await provider.readCurrentState('myproj', 'L', 'AWS::CodeBuild::Project');
    expect(result).toBeUndefined();
  });
});
