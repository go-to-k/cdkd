import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-codebuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codebuild')>();
  return {
    ...actual,
    CodeBuildClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
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

import { CodeBuildProvider } from '../../../../src/provisioning/providers/codebuild-provider.js';
import {
  CreateProjectCommand,
  DeleteProjectCommand,
  UpdateProjectCommand,
  BatchGetProjectsCommand,
  ListProjectsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-codebuild';

describe('CodeBuildProvider', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodeBuildProvider();
  });

  // ─── create ─────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create project with basic properties', async () => {
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      const result = await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        Source: { Type: 'NO_SOURCE', BuildSpec: 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo hello' },
        Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Artifacts: { Type: 'NO_ARTIFACTS' },
      });

      expect(result.physicalId).toBe('my-project');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(CreateProjectCommand);
      expect(command.input.name).toBe('my-project');
      expect(command.input.source).toEqual({
        type: 'NO_SOURCE',
        buildspec: 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo hello',
        location: undefined,
      });
      expect(command.input.environment).toEqual({
        type: 'LINUX_CONTAINER',
        computeType: 'BUILD_GENERAL1_SMALL',
        image: 'aws/codebuild/standard:7.0',
        environmentVariables: undefined,
      });
      expect(command.input.serviceRole).toBe('arn:aws:iam::123456789012:role/codebuild-role');
      expect(command.input.artifacts).toEqual({ type: 'NO_ARTIFACTS' });
    });

    it('should JSON.stringify buildspec when it is an object', async () => {
      const buildspecObj = {
        version: 0.2,
        phases: { build: { commands: ['echo hello'] } },
      };

      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        Source: { Type: 'NO_SOURCE', BuildSpec: buildspecObj },
        Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Artifacts: { Type: 'NO_ARTIFACTS' },
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(CreateProjectCommand);
      expect(command.input.source.buildspec).toBe(JSON.stringify(buildspecObj));
    });
  });

  // ─── update ─────────────────────────────────────────────────────────

  describe('update', () => {
    it('should update project properties', async () => {
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      const result = await provider.update(
        'MyProject',
        'my-project',
        'AWS::CodeBuild::Project',
        {
          Name: 'my-project',
          Source: { Type: 'CODECOMMIT', Location: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo' },
          Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_MEDIUM', Image: 'aws/codebuild/standard:7.0' },
          ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
          Artifacts: { Type: 'NO_ARTIFACTS' },
        },
        {
          Name: 'my-project',
          Source: { Type: 'NO_SOURCE' },
          Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
          ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
          Artifacts: { Type: 'NO_ARTIFACTS' },
        }
      );

      expect(result.physicalId).toBe('my-project');
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(UpdateProjectCommand);
      expect(command.input.name).toBe('my-project');
      expect(command.input.source.type).toBe('CODECOMMIT');
      expect(command.input.environment.computeType).toBe('BUILD_GENERAL1_MEDIUM');
    });
  });

  // ─── delete ─────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should delete project', async () => {
      mockSend.mockResolvedValue({});

      await provider.delete('MyProject', 'my-project', 'AWS::CodeBuild::Project');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(DeleteProjectCommand);
      expect(command.input).toEqual({ name: 'my-project' });
    });

    it('should not throw when project is not found', async () => {
      mockSend.mockRejectedValue(
        new ResourceNotFoundException({ $metadata: {}, message: 'not found' })
      );

      await expect(
        provider.delete('MyProject', 'my-project', 'AWS::CodeBuild::Project')
      ).resolves.not.toThrow();
    });
  });

  // ─── import ─────────────────────────────────────────────────────────

  describe('import', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string; cdkPath: string; properties: Record<string, unknown> }> = {}) {
      return {
        logicalId: 'MyProject',
        resourceType: 'AWS::CodeBuild::Project',
        cdkPath: 'MyStack/MyProject/Resource',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('explicit override: verifies via BatchGetProjects and returns the physicalId', async () => {
      mockSend.mockResolvedValueOnce({
        projects: [{ name: 'my-project', arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project' }],
        projectsNotFound: [],
      });

      const result = await provider.import(makeInput({ knownPhysicalId: 'my-project' }));

      expect(result).toEqual({ physicalId: 'my-project', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(BatchGetProjectsCommand);
      expect(mockSend.mock.calls[0][0].input).toEqual({ names: ['my-project'] });
    });

    it('tag-based lookup: ListProjects + BatchGetProjects matches lowercase key/value tag', async () => {
      mockSend
        // ListProjects
        .mockResolvedValueOnce({ projects: ['other-project', 'my-project'] })
        // BatchGetProjects
        .mockResolvedValueOnce({
          projects: [
            {
              name: 'other-project',
              tags: [{ key: 'aws:cdk:path', value: 'OtherStack/Project/Resource' }],
            },
            {
              name: 'my-project',
              tags: [{ key: 'aws:cdk:path', value: 'MyStack/MyProject/Resource' }],
            },
          ],
        });

      const result = await provider.import(makeInput());

      expect(result).toEqual({ physicalId: 'my-project', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListProjectsCommand);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(BatchGetProjectsCommand);
      expect(mockSend.mock.calls[1][0].input).toEqual({ names: ['other-project', 'my-project'] });
    });

    it('returns null when no project matches the cdkPath', async () => {
      mockSend
        .mockResolvedValueOnce({ projects: ['unrelated'] })
        .mockResolvedValueOnce({
          projects: [
            {
              name: 'unrelated',
              tags: [{ key: 'aws:cdk:path', value: 'OtherStack/Project/Resource' }],
            },
          ],
        });

      const result = await provider.import(makeInput());

      expect(result).toBeNull();
    });
  });
});
