import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codecommit')>();
  return {
    ...actual,
    CodeCommitClient: vi.fn().mockImplementation(() => ({
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

import { CodeCommitRepositoryProvider } from '../../../../src/provisioning/providers/codecommit-repository-provider.js';
import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  GetRepositoryCommand,
  ListRepositoriesCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateRepositoryDescriptionCommand,
  UpdateRepositoryEncryptionKeyCommand,
  UpdateRepositoryNameCommand,
  RepositoryDoesNotExistException,
} from '@aws-sdk/client-codecommit';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const REPO_ARN = 'arn:aws:codecommit:us-east-1:123456789012:my-repo';
const REPO_ID = '12a345b6-bbb7-4bb6-90b0-8c9577a2d2b9';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    repositoryName: 'my-repo',
    repositoryId: REPO_ID,
    Arn: REPO_ARN,
    cloneUrlHttp: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo',
    cloneUrlSsh: 'ssh://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo',
    ...overrides,
  };
}

function notFound() {
  return new RepositoryDoesNotExistException({
    message: 'repository does not exist',
    $metadata: {},
  });
}

describe('CodeCommitRepositoryProvider', () => {
  let provider: CodeCommitRepositoryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodeCommitRepositoryProvider();
  });

  describe('create', () => {
    it('creates a repository with description, kms key, and tags (CFn Tag[] -> SDK map)', async () => {
      mockSend.mockResolvedValueOnce({
        repositoryMetadata: metadata({ kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k1' }),
      });

      const result = await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        RepositoryDescription: 'a description',
        KmsKeyId: 'alias/my-key',
        Tags: [
          { Key: 'env', Value: 'test' },
          { Key: 'team', Value: 'dev' },
        ],
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(CreateRepositoryCommand);
      expect(cmd.input).toEqual({
        repositoryName: 'my-repo',
        repositoryDescription: 'a description',
        kmsKeyId: 'alias/my-key',
        tags: { env: 'test', team: 'dev' },
      });
      expect(result.physicalId).toBe('my-repo');
      expect(result.attributes).toEqual({
        Arn: REPO_ARN,
        CloneUrlHttp: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo',
        CloneUrlSsh: 'ssh://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo',
        Name: 'my-repo',
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k1',
        RepositoryId: REPO_ID,
      });
    });

    it('omits optional fields when absent and generates a name when RepositoryName is missing', async () => {
      mockSend.mockResolvedValueOnce({
        repositoryMetadata: metadata({ repositoryName: 'generated-name' }),
      });

      const result = await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {});

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(CreateRepositoryCommand);
      expect(Object.keys(cmd.input)).toEqual(['repositoryName']);
      expect(typeof cmd.input.repositoryName).toBe('string');
      expect(cmd.input.repositoryName.length).toBeGreaterThan(0);
      expect(result.physicalId).toBe('generated-name');
    });

    it('wraps SDK errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));

      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', { RepositoryName: 'my-repo' })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });
  });

  describe('update', () => {
    it('updates description when changed', async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateRepositoryDescription
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }); // final GetRepository

      const result = await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'my-repo', RepositoryDescription: 'new desc' },
        { RepositoryName: 'my-repo', RepositoryDescription: 'old desc' }
      );

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateRepositoryDescriptionCommand);
      expect(cmd.input).toEqual({ repositoryName: 'my-repo', repositoryDescription: 'new desc' });
      expect(result).toEqual({
        physicalId: 'my-repo',
        wasReplaced: false,
        attributes: expect.objectContaining({ Arn: REPO_ARN, RepositoryId: REPO_ID }),
      });
    });

    it('clears the description with an empty string when the property is removed', async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateRepositoryDescription
        .mockResolvedValueOnce({ repositoryMetadata: metadata() });

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'my-repo' },
        { RepositoryName: 'my-repo', RepositoryDescription: 'old desc' }
      );

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateRepositoryDescriptionCommand);
      expect(cmd.input).toEqual({ repositoryName: 'my-repo', repositoryDescription: '' });
    });

    it('renames in place via UpdateRepositoryName and returns the new physicalId (CFn parity — no replacement)', async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateRepositoryName
        .mockResolvedValueOnce({ repositoryMetadata: metadata({ repositoryName: 'new-name' }) });

      const result = await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'new-name' },
        { RepositoryName: 'my-repo' }
      );

      const renameCmd = mockSend.mock.calls[0][0];
      expect(renameCmd).toBeInstanceOf(UpdateRepositoryNameCommand);
      expect(renameCmd.input).toEqual({ oldName: 'my-repo', newName: 'new-name' });
      const getCmd = mockSend.mock.calls[1][0];
      expect(getCmd).toBeInstanceOf(GetRepositoryCommand);
      expect(getCmd.input).toEqual({ repositoryName: 'new-name' });
      expect(result.physicalId).toBe('new-name');
      expect(result.wasReplaced).toBe(false);
    });

    it('updates the encryption key when KmsKeyId changed', async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateRepositoryEncryptionKey
        .mockResolvedValueOnce({ repositoryMetadata: metadata() });

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'my-repo', KmsKeyId: 'alias/new-key' },
        { RepositoryName: 'my-repo', KmsKeyId: 'alias/old-key' }
      );

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateRepositoryEncryptionKeyCommand);
      expect(cmd.input).toEqual({ repositoryName: 'my-repo', kmsKeyId: 'alias/new-key' });
    });

    it('reverts to the AWS-managed key when KmsKeyId is removed', async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateRepositoryEncryptionKey
        .mockResolvedValueOnce({ repositoryMetadata: metadata() });

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'my-repo' },
        { RepositoryName: 'my-repo', KmsKeyId: 'alias/old-key' }
      );

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(UpdateRepositoryEncryptionKeyCommand);
      expect(cmd.input).toEqual({ repositoryName: 'my-repo', kmsKeyId: 'alias/aws/codecommit' });
    });

    it('adds and removes tags (partial removal untags only the dropped keys)', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // GetRepository (arn for tagging)
        .mockResolvedValueOnce({}) // UntagResource
        .mockResolvedValueOnce({}) // TagResource
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }); // final GetRepository

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        {
          RepositoryName: 'my-repo',
          Tags: [{ Key: 'keep', Value: 'v2' }],
        },
        {
          RepositoryName: 'my-repo',
          Tags: [
            { Key: 'keep', Value: 'v1' },
            { Key: 'drop', Value: 'x' },
          ],
        }
      );

      const untagCmd = mockSend.mock.calls[1][0];
      expect(untagCmd).toBeInstanceOf(UntagResourceCommand);
      expect(untagCmd.input).toEqual({ resourceArn: REPO_ARN, tagKeys: ['drop'] });
      const tagCmd = mockSend.mock.calls[2][0];
      expect(tagCmd).toBeInstanceOf(TagResourceCommand);
      expect(tagCmd.input).toEqual({ resourceArn: REPO_ARN, tags: { keep: 'v2' } });
    });

    it('removes ALL tags when the Tags property is dropped entirely (issue #981 regression class)', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // GetRepository (arn)
        .mockResolvedValueOnce({}) // UntagResource
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }); // final GetRepository

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'my-repo' },
        {
          RepositoryName: 'my-repo',
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        }
      );

      const untagCmd = mockSend.mock.calls[1][0];
      expect(untagCmd).toBeInstanceOf(UntagResourceCommand);
      expect(untagCmd.input).toEqual({ resourceArn: REPO_ARN, tagKeys: ['a', 'b'] });
      // No TagResource call — the new set is empty.
      const tagCalls = mockSend.mock.calls.filter((c) => c[0] instanceof TagResourceCommand);
      expect(tagCalls).toHaveLength(0);
    });

    it('no-ops (single GetRepository only) when nothing changed', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() });

      const result = await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'my-repo', RepositoryDescription: 'same' },
        { RepositoryName: 'my-repo', RepositoryDescription: 'same' }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetRepositoryCommand);
      expect(result.physicalId).toBe('my-repo');
    });

    it('wraps SDK errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));

      await expect(
        provider.update(
          'MyRepo',
          'my-repo',
          'AWS::CodeCommit::Repository',
          { RepositoryDescription: 'new' },
          { RepositoryDescription: 'old' }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
    });
  });

  describe('delete', () => {
    it('deletes the repository by name', async () => {
      mockSend.mockResolvedValueOnce({ repositoryId: REPO_ID });

      await provider.delete('MyRepo', 'my-repo', 'AWS::CodeCommit::Repository');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(DeleteRepositoryCommand);
      expect(cmd.input).toEqual({ repositoryName: 'my-repo' });
    });

    it('treats RepositoryDoesNotExist as idempotent success when regions match', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('MyRepo', 'my-repo', 'AWS::CodeCommit::Repository', undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.toBeUndefined();
    });

    it('refuses NotFound-as-success when the client region does not match the state region', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('MyRepo', 'my-repo', 'AWS::CodeCommit::Repository', undefined, {
          expectedRegion: 'ap-northeast-1',
        })
      ).rejects.toThrow(/region/i);
    });

    it('wraps other SDK errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));

      await expect(
        provider.delete('MyRepo', 'my-repo', 'AWS::CodeCommit::Repository')
      ).rejects.toBeInstanceOf(ProvisioningError);
    });
  });

  describe('getAttribute', () => {
    it('returns the physicalId for Name without an API call', async () => {
      const value = await provider.getAttribute('my-repo', 'AWS::CodeCommit::Repository', 'Name');
      expect(value).toBe('my-repo');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['Arn', REPO_ARN],
      ['CloneUrlHttp', 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo'],
      ['CloneUrlSsh', 'ssh://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo'],
      ['KmsKeyId', 'arn:aws:kms:us-east-1:123456789012:key/k1'],
    ])('fetches %s via GetRepository', async (attr, expected) => {
      mockSend.mockResolvedValueOnce({
        repositoryMetadata: metadata({ kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k1' }),
      });

      const value = await provider.getAttribute('my-repo', 'AWS::CodeCommit::Repository', attr);

      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetRepositoryCommand);
      expect(value).toBe(expected);
    });

    it('returns undefined for unknown attributes', async () => {
      const value = await provider.getAttribute('my-repo', 'AWS::CodeCommit::Repository', 'Nope');
      expect(value).toBeUndefined();
    });
  });

  describe('import', () => {
    function makeInput(
      overrides: Partial<{
        knownPhysicalId: string;
        cdkPath: string;
        properties: Record<string, unknown>;
      }> = {}
    ) {
      return {
        logicalId: 'MyRepo',
        resourceType: 'AWS::CodeCommit::Repository',
        cdkPath: 'MyStack/MyRepo/Resource',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('explicit override: verifies via GetRepository and returns physicalId + attributes', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() });

      const result = await provider.import(makeInput({ knownPhysicalId: 'my-repo' }));

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(GetRepositoryCommand);
      expect(cmd.input).toEqual({ repositoryName: 'my-repo' });
      expect(result).toEqual({
        physicalId: 'my-repo',
        attributes: expect.objectContaining({ Arn: REPO_ARN, RepositoryId: REPO_ID }),
      });
    });

    it('template RepositoryName: verifies via GetRepository', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() });

      const result = await provider.import(
        makeInput({ properties: { RepositoryName: 'my-repo' } })
      );

      expect(result?.physicalId).toBe('my-repo');
    });

    it('explicit override not found: returns null', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      const result = await provider.import(makeInput({ knownPhysicalId: 'gone' }));

      expect(result).toBeNull();
    });

    it('tag-based lookup: ListRepositories + GetRepository + ListTagsForResource (tag-map shape)', async () => {
      mockSend
        .mockResolvedValueOnce({
          repositories: [{ repositoryName: 'other' }, { repositoryName: 'my-repo' }],
        }) // ListRepositories
        .mockResolvedValueOnce({
          repositoryMetadata: metadata({
            repositoryName: 'other',
            Arn: 'arn:aws:codecommit:us-east-1:123456789012:other',
          }),
        }) // GetRepository(other)
        .mockResolvedValueOnce({ tags: { 'aws:cdk:path': 'MyStack/Other/Resource' } }) // ListTags(other)
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // GetRepository(my-repo)
        .mockResolvedValueOnce({ tags: { 'aws:cdk:path': 'MyStack/MyRepo/Resource' } }); // ListTags(my-repo)

      const result = await provider.import(makeInput());

      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListRepositoriesCommand);
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(ListTagsForResourceCommand);
      expect(result).toEqual({
        physicalId: 'my-repo',
        attributes: expect.objectContaining({ RepositoryId: REPO_ID }),
      });
    });

    it('tag-based lookup with no match: returns null', async () => {
      mockSend
        .mockResolvedValueOnce({ repositories: [{ repositoryName: 'other' }] })
        .mockResolvedValueOnce({
          repositoryMetadata: metadata({
            repositoryName: 'other',
            Arn: 'arn:aws:codecommit:us-east-1:123456789012:other',
          }),
        })
        .mockResolvedValueOnce({ tags: {} });

      const result = await provider.import(makeInput());

      expect(result).toBeNull();
    });
  });

  describe('property classification', () => {
    it('declares handledProperties + unhandledByDesign covering the CFn schema write-side set', () => {
      const handled = provider.handledProperties.get('AWS::CodeCommit::Repository');
      expect(handled).toBeDefined();
      expect([...(handled ?? [])].sort()).toEqual([
        'KmsKeyId',
        'RepositoryDescription',
        'RepositoryName',
        'Tags',
      ]);
      const byDesign = provider.unhandledByDesign.get('AWS::CodeCommit::Repository');
      expect(byDesign?.has('Code')).toBe(true);
      expect(byDesign?.has('Triggers')).toBe(true);
    });
  });
});
