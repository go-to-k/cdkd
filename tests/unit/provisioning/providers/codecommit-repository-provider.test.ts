import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const mockS3Send = vi.hoisted(() => vi.fn());
// Mutable holder for the entries the mocked AdmZip instance returns per test.
const admZipState = vi.hoisted(() => ({
  entries: [] as Array<{ entryName: string; isDirectory: boolean; getData: () => Buffer }>,
}));

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

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  };
});

vi.mock('adm-zip', () => ({
  default: vi.fn().mockImplementation(() => ({
    getEntries: () => admZipState.entries,
  })),
}));

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
  CreateCommitCommand,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  GetRepositoryCommand,
  ListRepositoriesCommand,
  ListTagsForResourceCommand,
  PutRepositoryTriggersCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateRepositoryDescriptionCommand,
  UpdateRepositoryEncryptionKeyCommand,
  UpdateRepositoryNameCommand,
  RepositoryDoesNotExistException,
} from '@aws-sdk/client-codecommit';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';
import { calculateResourceDrift } from '../../../../src/analyzer/drift-calculator.js';

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
    admZipState.entries = [];
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

    it('wraps a metadata-less CreateRepository response in ProvisioningError', async () => {
      mockSend.mockResolvedValueOnce({});

      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', { RepositoryName: 'my-repo' })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('coerces tag-value edge shapes: number/boolean stringified, invalid keys skipped, nullish value -> empty string', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() });

      await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Tags: [
          { Key: 'num', Value: 42 },
          { Key: 'bool', Value: true },
          { Key: 'nullish', Value: null },
          { Key: '', Value: 'dropped' },
          { Value: 'no-key' },
          { Key: 'obj', Value: { Ref: 'X' } },
        ],
      });

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.tags).toEqual({ num: '42', bool: 'true', nullish: '', obj: '' });
    });

    it('omits the tags field entirely when every entry is invalid', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() });

      await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Tags: [{ Value: 'no-key' }],
      });

      expect('tags' in mockSend.mock.calls[0][0].input).toBe(false);
    });
  });

  describe('create with Code seed', () => {
    it('unpacks the S3 zip and seeds the initial commit via CreateCommit (default branch main)', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockResolvedValueOnce({ commitId: 'abc123' }); // CreateCommit
      mockS3Send.mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
      });
      admZipState.entries = [
        { entryName: 'README.md', isDirectory: false, getData: () => Buffer.from('# hi') },
        { entryName: 'src/', isDirectory: true, getData: () => Buffer.from('') },
        { entryName: 'src/index.js', isDirectory: false, getData: () => Buffer.from('x') },
      ];

      const result = await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Code: { S3: { Bucket: 'seed-bucket', Key: 'seed.zip' } },
      });

      // GetObject with no VersionId
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const s3cmd = mockS3Send.mock.calls[0][0];
      expect(s3cmd).toBeInstanceOf(GetObjectCommand);
      expect(s3cmd.input).toEqual({ Bucket: 'seed-bucket', Key: 'seed.zip' });

      // CreateCommit carries only file entries (directory skipped), on main.
      const commitCmd = mockSend.mock.calls[1][0];
      expect(commitCmd).toBeInstanceOf(CreateCommitCommand);
      expect(commitCmd.input.repositoryName).toBe('my-repo');
      expect(commitCmd.input.branchName).toBe('main');
      expect(commitCmd.input.commitMessage).toBe('Initial commit');
      expect(commitCmd.input.putFiles.map((f: { filePath: string }) => f.filePath)).toEqual([
        'README.md',
        'src/index.js',
      ]);
      expect(result.physicalId).toBe('my-repo');
    });

    it('honors an explicit BranchName and ObjectVersion', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() })
        .mockResolvedValueOnce({ commitId: 'abc123' });
      mockS3Send.mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([1]) },
      });
      admZipState.entries = [
        { entryName: 'f.txt', isDirectory: false, getData: () => Buffer.from('a') },
      ];

      await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Code: {
          BranchName: 'develop',
          S3: { Bucket: 'b', Key: 'k.zip', ObjectVersion: 'v42' },
        },
      });

      expect(mockS3Send.mock.calls[0][0].input).toEqual({
        Bucket: 'b',
        Key: 'k.zip',
        VersionId: 'v42',
      });
      expect(mockSend.mock.calls[1][0].input.branchName).toBe('develop');
    });

    it('skips the seed commit (no CreateCommit) when the zip has no file entries', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() }); // CreateRepository only
      mockS3Send.mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([1]) },
      });
      admZipState.entries = [{ entryName: 'emptydir/', isDirectory: true, getData: () => Buffer.from('') }];

      const result = await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Code: { S3: { Bucket: 'b', Key: 'k.zip' } },
      });

      expect(result.physicalId).toBe('my-repo');
      expect(mockSend).toHaveBeenCalledTimes(1); // no CreateCommit
    });

    it('rejects a Code.S3 with a missing Bucket/Key and rolls back the repository', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockResolvedValueOnce({}); // DeleteRepository (rollback)

      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
          RepositoryName: 'my-repo',
          Code: { S3: { Key: 'k.zip' } }, // no Bucket
        })
      ).rejects.toBeInstanceOf(ProvisioningError);

      // Rollback deleted the just-created repository.
      const deleteCmd = mockSend.mock.calls[1][0];
      expect(deleteCmd).toBeInstanceOf(DeleteRepositoryCommand);
      expect(deleteCmd.input).toEqual({ repositoryName: 'my-repo' });
    });

    it('rolls back (deletes) the repository when the S3 download fails', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockResolvedValueOnce({}); // DeleteRepository (rollback)
      mockS3Send.mockRejectedValueOnce(new Error('access denied'));

      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
          RepositoryName: 'my-repo',
          Code: { S3: { Bucket: 'b', Key: 'k.zip' } },
        })
      ).rejects.toBeInstanceOf(ProvisioningError);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(DeleteRepositoryCommand);
    });

    it('rejects a Code.S3 with a missing Key and rolls back the repository', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockResolvedValueOnce({}); // DeleteRepository (rollback)

      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
          RepositoryName: 'my-repo',
          Code: { S3: { Bucket: 'b' } }, // no Key
        })
      ).rejects.toBeInstanceOf(ProvisioningError);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(DeleteRepositoryCommand);
    });

    it('rolls back when the S3 GetObject returns an empty body', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockResolvedValueOnce({}); // DeleteRepository (rollback)
      mockS3Send.mockResolvedValueOnce({ Body: undefined }); // empty body

      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
          RepositoryName: 'my-repo',
          Code: { S3: { Bucket: 'b', Key: 'k.zip' } },
        })
      ).rejects.toBeInstanceOf(ProvisioningError);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(DeleteRepositoryCommand);
    });

    it('still surfaces the original error when the rollback DeleteRepository also fails', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockRejectedValueOnce(new Error('cleanup boom')); // DeleteRepository (rollback) fails
      mockS3Send.mockRejectedValueOnce(new Error('seed download failed'));

      // The cleanup failure is swallowed; the ORIGINAL post-create error is
      // re-thrown (wrapped as ProvisioningError). Message carries the seed
      // failure, not the cleanup failure.
      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
          RepositoryName: 'my-repo',
          Code: { S3: { Bucket: 'b', Key: 'k.zip' } },
        })
      ).rejects.toThrow(/seed download failed/);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(DeleteRepositoryCommand);
    });
  });

  describe('create with Triggers', () => {
    it('applies Triggers via PutRepositoryTriggers (CFn PascalCase -> SDK camelCase)', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockResolvedValueOnce({ configurationId: 'cfg-1' }); // PutRepositoryTriggers

      await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Triggers: [
          {
            Name: 'notify',
            DestinationArn: 'arn:aws:sns:us-east-1:123456789012:topic',
            CustomData: 'ping',
            Branches: ['main'],
            Events: ['all'],
          },
        ],
      });

      const putCmd = mockSend.mock.calls[1][0];
      expect(putCmd).toBeInstanceOf(PutRepositoryTriggersCommand);
      expect(putCmd.input).toEqual({
        repositoryName: 'my-repo',
        triggers: [
          {
            name: 'notify',
            destinationArn: 'arn:aws:sns:us-east-1:123456789012:topic',
            customData: 'ping',
            branches: ['main'],
            events: ['all'],
          },
        ],
      });
    });

    it('omits optional customData but ALWAYS emits branches ([]) when absent (CodeCommit rejects null branches)', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() })
        .mockResolvedValueOnce({ configurationId: 'cfg-1' });

      await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Triggers: [
          {
            Name: 't',
            DestinationArn: 'arn:aws:sns:us-east-1:123456789012:topic',
            Events: ['createReference', 'deleteReference'],
          },
        ],
      });

      // branches defaults to [] (all branches) — PutRepositoryTriggers fails
      // with "branch name list cannot be null" if the field is absent.
      expect(mockSend.mock.calls[1][0].input.triggers[0]).toEqual({
        name: 't',
        destinationArn: 'arn:aws:sns:us-east-1:123456789012:topic',
        events: ['createReference', 'deleteReference'],
        branches: [],
      });
    });

    it('coerces non-string trigger field shapes (number/boolean scalar -> string; object -> "")', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() })
        .mockResolvedValueOnce({ configurationId: 'cfg-1' });

      await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Triggers: [
          {
            Name: 42, // number -> '42'
            DestinationArn: { Ref: 'Topic' }, // object -> ''
            Branches: ['main', 7], // mixed -> ['main', '7']
            Events: ['all', true], // boolean -> 'true'
          },
        ],
      });

      expect(mockSend.mock.calls[1][0].input.triggers[0]).toEqual({
        name: '42',
        destinationArn: '',
        events: ['all', 'true'],
        branches: ['main', '7'],
      });
    });

    it('does NOT call PutRepositoryTriggers when the Triggers array is empty', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() });

      await provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
        RepositoryName: 'my-repo',
        Triggers: [],
      });

      expect(mockSend).toHaveBeenCalledTimes(1); // CreateRepository only
    });

    it('rolls back the repository when PutRepositoryTriggers fails on create', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // CreateRepository
        .mockRejectedValueOnce(new Error('invalid destinationArn')) // PutRepositoryTriggers
        .mockResolvedValueOnce({}); // DeleteRepository (rollback)

      await expect(
        provider.create('MyRepo', 'AWS::CodeCommit::Repository', {
          RepositoryName: 'my-repo',
          Triggers: [{ Name: 'bad', DestinationArn: 'nope', Events: ['all'] }],
        })
      ).rejects.toBeInstanceOf(ProvisioningError);

      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(DeleteRepositoryCommand);
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

    it('rename + description change: every follow-up call targets the NEW name (rename runs first)', async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateRepositoryName
        .mockResolvedValueOnce({}) // UpdateRepositoryDescription
        .mockResolvedValueOnce({ repositoryMetadata: metadata({ repositoryName: 'new-name' }) });

      const result = await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'new-name', RepositoryDescription: 'new desc' },
        { RepositoryName: 'my-repo', RepositoryDescription: 'old desc' }
      );

      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(UpdateRepositoryNameCommand);
      const descCmd = mockSend.mock.calls[1][0];
      expect(descCmd).toBeInstanceOf(UpdateRepositoryDescriptionCommand);
      expect(descCmd.input.repositoryName).toBe('new-name');
      const getCmd = mockSend.mock.calls[2][0];
      expect(getCmd).toBeInstanceOf(GetRepositoryCommand);
      expect(getCmd.input.repositoryName).toBe('new-name');
      expect(result.physicalId).toBe('new-name');
    });

    it('rename retry-safety: NotFound on rename + newName already exists -> treated as already applied', async () => {
      mockSend
        .mockRejectedValueOnce(notFound()) // UpdateRepositoryName (old name gone — prior attempt renamed)
        .mockResolvedValueOnce({ repositoryMetadata: metadata({ repositoryName: 'new-name' }) }) // GetRepository(newName) probe
        .mockResolvedValueOnce({ repositoryMetadata: metadata({ repositoryName: 'new-name' }) }); // final GetRepository

      const result = await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'new-name' },
        { RepositoryName: 'my-repo' }
      );

      const probeCmd = mockSend.mock.calls[1][0];
      expect(probeCmd).toBeInstanceOf(GetRepositoryCommand);
      expect(probeCmd.input.repositoryName).toBe('new-name');
      expect(result.physicalId).toBe('new-name');
      expect(result.wasReplaced).toBe(false);
    });

    it('rename retry-safety: NotFound on rename + newName also missing -> fails', async () => {
      mockSend
        .mockRejectedValueOnce(notFound()) // UpdateRepositoryName
        .mockRejectedValueOnce(notFound()); // GetRepository(newName) probe

      await expect(
        provider.update(
          'MyRepo',
          'my-repo',
          'AWS::CodeCommit::Repository',
          { RepositoryName: 'new-name' },
          { RepositoryName: 'my-repo' }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
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

    it('a pure re-order of the Tags list is NOT a tag change (no Untag/Tag churn)', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() }); // final GetRepository only

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        {
          RepositoryName: 'my-repo',
          Tags: [
            { Key: 'b', Value: '2' },
            { Key: 'a', Value: '1' },
          ],
        },
        {
          RepositoryName: 'my-repo',
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetRepositoryCommand);
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

    it('applies changed Triggers via PutRepositoryTriggers (full replace)', async () => {
      mockSend
        .mockResolvedValueOnce({ configurationId: 'cfg-2' }) // PutRepositoryTriggers
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }); // final GetRepository

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        {
          RepositoryName: 'my-repo',
          Triggers: [
            { Name: 't', DestinationArn: 'arn:aws:sns:us-east-1:1:new', Events: ['all'] },
          ],
        },
        {
          RepositoryName: 'my-repo',
          Triggers: [
            { Name: 't', DestinationArn: 'arn:aws:sns:us-east-1:1:old', Events: ['all'] },
          ],
        }
      );

      const putCmd = mockSend.mock.calls[0][0];
      expect(putCmd).toBeInstanceOf(PutRepositoryTriggersCommand);
      expect(putCmd.input.triggers[0].destinationArn).toBe('arn:aws:sns:us-east-1:1:new');
    });

    it('clears all triggers with an empty array when the Triggers property is removed', async () => {
      mockSend
        .mockResolvedValueOnce({ configurationId: 'cfg-3' }) // PutRepositoryTriggers([])
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }); // final GetRepository

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'my-repo' }, // Triggers dropped
        {
          RepositoryName: 'my-repo',
          Triggers: [
            { Name: 't', DestinationArn: 'arn:aws:sns:us-east-1:1:old', Events: ['all'] },
          ],
        }
      );

      const putCmd = mockSend.mock.calls[0][0];
      expect(putCmd).toBeInstanceOf(PutRepositoryTriggersCommand);
      expect(putCmd.input).toEqual({ repositoryName: 'my-repo', triggers: [] });
    });

    it('does NOT call PutRepositoryTriggers when the Triggers block is unchanged (incl. re-order-stable fields)', async () => {
      mockSend.mockResolvedValueOnce({ repositoryMetadata: metadata() }); // final GetRepository only

      await provider.update(
        'MyRepo',
        'my-repo',
        'AWS::CodeCommit::Repository',
        {
          RepositoryName: 'my-repo',
          Triggers: [
            { Name: 't', DestinationArn: 'arn:aws:sns:us-east-1:1:x', Branches: ['main'], Events: ['all'] },
          ],
        },
        {
          RepositoryName: 'my-repo',
          Triggers: [
            { Name: 't', DestinationArn: 'arn:aws:sns:us-east-1:1:x', Branches: ['main'], Events: ['all'] },
          ],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetRepositoryCommand);
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

    it('treats a null repositoryId (already-deleted repo) as idempotent success when regions match', async () => {
      // DeleteRepository does NOT throw for a missing repository — it
      // returns a null repositoryId. The region check must still run on
      // that path (it is the main not-found shape for this API).
      mockSend.mockResolvedValueOnce({});

      await expect(
        provider.delete('MyRepo', 'my-repo', 'AWS::CodeCommit::Repository', undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.toBeUndefined();
    });

    it('refuses the null-repositoryId success when the client region does not match the state region', async () => {
      mockSend.mockResolvedValueOnce({});

      await expect(
        provider.delete('MyRepo', 'my-repo', 'AWS::CodeCommit::Repository', undefined, {
          expectedRegion: 'ap-northeast-1',
        })
      ).rejects.toThrow(/region/i);
    });

    it('null repositoryId with no DeleteContext is treated as success (no region to verify against)', async () => {
      mockSend.mockResolvedValueOnce({});

      await expect(
        provider.delete('MyRepo', 'my-repo', 'AWS::CodeCommit::Repository')
      ).resolves.toBeUndefined();
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

    it('tag-based lookup paginates ListRepositories via nextToken', async () => {
      mockSend
        .mockResolvedValueOnce({ repositories: [{ repositoryName: 'other' }], nextToken: 't1' }) // page 1
        .mockResolvedValueOnce({
          repositoryMetadata: metadata({
            repositoryName: 'other',
            Arn: 'arn:aws:codecommit:us-east-1:123456789012:other',
          }),
        })
        .mockResolvedValueOnce({ tags: {} }) // other: no match
        .mockResolvedValueOnce({ repositories: [{ repositoryName: 'my-repo' }] }) // page 2 (no nextToken)
        .mockResolvedValueOnce({ repositoryMetadata: metadata() })
        .mockResolvedValueOnce({ tags: { 'aws:cdk:path': 'MyStack/MyRepo/Resource' } });

      const result = await provider.import(makeInput());

      const page1 = mockSend.mock.calls[0][0];
      expect(page1).toBeInstanceOf(ListRepositoriesCommand);
      expect('nextToken' in page1.input).toBe(false);
      const page2 = mockSend.mock.calls[3][0];
      expect(page2).toBeInstanceOf(ListRepositoriesCommand);
      expect(page2.input.nextToken).toBe('t1');
      expect(result?.physicalId).toBe('my-repo');
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

  describe('readCurrentState (drift)', () => {
    it('maps the read side back to the flat CFn inputs (description, kmsKeyId, tags)', async () => {
      mockSend
        .mockResolvedValueOnce({
          repositoryMetadata: metadata({
            repositoryDescription: 'a description',
            kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k1',
          }),
        }) // GetRepository
        .mockResolvedValueOnce({ tags: { env: 'test', 'aws:cdk:path': 'MyStack/MyRepo/Resource' } }); // ListTagsForResource

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetRepositoryCommand);
      const tagsCmd = mockSend.mock.calls[1][0];
      expect(tagsCmd).toBeInstanceOf(ListTagsForResourceCommand);
      expect(tagsCmd.input).toEqual({ resourceArn: REPO_ARN });
      expect(current).toEqual({
        RepositoryName: 'my-repo',
        RepositoryDescription: 'a description',
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k1',
        // `aws:cdk:path` is dropped by normalizeAwsTagsToCfn.
        Tags: [{ Key: 'env', Value: 'test' }],
      });
    });

    it('detects drift on a changed field (description differs from state)', async () => {
      mockSend
        .mockResolvedValueOnce({
          repositoryMetadata: metadata({ repositoryDescription: 'aws-side desc' }),
        })
        .mockResolvedValueOnce({ tags: {} });

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      const drifts = calculateResourceDrift(
        { RepositoryName: 'my-repo', RepositoryDescription: 'state desc' },
        current!,
        { ignorePaths: provider.getDriftUnknownPaths('AWS::CodeCommit::Repository') }
      );
      expect(drifts).toEqual([
        { path: 'RepositoryDescription', stateValue: 'state desc', awsValue: 'aws-side desc' },
      ]);
    });

    it('reports zero drift on a no-op (state matches AWS-current)', async () => {
      mockSend
        .mockResolvedValueOnce({
          repositoryMetadata: metadata({ repositoryDescription: 'same' }),
        })
        .mockResolvedValueOnce({ tags: { env: 'test' } });

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      const drifts = calculateResourceDrift(
        {
          RepositoryName: 'my-repo',
          RepositoryDescription: 'same',
          Tags: [{ Key: 'env', Value: 'test' }],
        },
        current!,
        { ignorePaths: provider.getDriftUnknownPaths('AWS::CodeCommit::Repository') }
      );
      expect(drifts).toEqual([]);
    });

    it('a tag re-order between state and AWS-current is NOT phantom drift', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() })
        .mockResolvedValueOnce({ tags: { b: '2', a: '1' } }); // AWS order differs

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      const drifts = calculateResourceDrift(
        {
          RepositoryName: 'my-repo',
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        },
        current!,
        { ignorePaths: provider.getDriftUnknownPaths('AWS::CodeCommit::Repository') }
      );
      expect(drifts).toEqual([]);
    });

    it('does NOT surface create-only Code as drift (getDriftUnknownPaths)', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() })
        .mockResolvedValueOnce({ tags: {} });

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      // A state written under --allow-unsupported-properties could carry Code;
      // GetRepository never returns it, so it must be ignored, not drift.
      const drifts = calculateResourceDrift(
        {
          RepositoryName: 'my-repo',
          Code: { S3: { Bucket: 'seed', Key: 'seed.zip' } },
        },
        current!,
        { ignorePaths: provider.getDriftUnknownPaths('AWS::CodeCommit::Repository') }
      );
      expect(drifts).toEqual([]);
      expect(provider.getDriftUnknownPaths('AWS::CodeCommit::Repository')).toEqual([
        'Code',
        'Triggers',
      ]);
    });

    it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
      // Repository exists but every optional field is undefined / empty.
      mockSend
        .mockResolvedValueOnce({
          repositoryMetadata: {
            repositoryName: 'my-repo',
            repositoryId: REPO_ID,
            Arn: REPO_ARN,
            // no repositoryDescription, no kmsKeyId, no clone URLs
          },
        }) // GetRepository
        .mockResolvedValueOnce({ tags: {} }); // ListTagsForResource

      const result = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      expect(Object.keys(result ?? {}).sort()).toEqual(
        ['KmsKeyId', 'RepositoryDescription', 'RepositoryName', 'Tags'].sort()
      );
      expect(result?.RepositoryName).toBe('my-repo');
      expect(result?.RepositoryDescription).toBe(''); // string placeholder
      expect(result?.KmsKeyId).toBe(''); // string placeholder
      expect(result?.Tags).toEqual([]); // array placeholder
    });

    it('emits Tags: [] even when the ARN is absent (never omits the key)', async () => {
      mockSend.mockResolvedValueOnce({
        repositoryMetadata: { repositoryName: 'my-repo' }, // no Arn -> no ListTagsForResource
      });

      const result = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      expect(mockSend).toHaveBeenCalledTimes(1); // no ListTagsForResource call
      expect(result?.Tags).toEqual([]);
    });

    it('detects drift on a changed tag value', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() })
        .mockResolvedValueOnce({ tags: { env: 'prod' } }); // AWS has env=prod

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      const drifts = calculateResourceDrift(
        {
          RepositoryName: 'my-repo',
          Tags: [{ Key: 'env', Value: 'dev' }], // state has env=dev
        },
        current!,
        { ignorePaths: provider.getDriftUnknownPaths('AWS::CodeCommit::Repository') }
      );
      expect(drifts).toEqual([
        { path: 'Tags', stateValue: [{ Key: 'env', Value: 'dev' }], awsValue: [{ Key: 'env', Value: 'prod' }] },
      ]);
    });

    it('returns undefined when the repository no longer exists (drift-unknown)', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      const current = await provider.readCurrentState(
        'gone',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      expect(current).toBeUndefined();
    });

    it('returns undefined when GetRepository resolves with no metadata (drift-unknown)', async () => {
      mockSend.mockResolvedValueOnce({}); // no repositoryMetadata

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      expect(current).toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1); // no ListTagsForResource
    });

    it('treats a repo deleted BETWEEN GetRepository and ListTagsForResource as drift-unknown', async () => {
      mockSend
        .mockResolvedValueOnce({ repositoryMetadata: metadata() }) // GetRepository succeeds
        .mockRejectedValueOnce(notFound()); // ListTagsForResource: repo gone mid-read

      const current = await provider.readCurrentState(
        'my-repo',
        'MyRepo',
        'AWS::CodeCommit::Repository'
      );

      // Must not abort the whole drift run — reported as drift-unknown.
      expect(current).toBeUndefined();
    });

    it('propagates non-NotFound errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));

      await expect(
        provider.readCurrentState('my-repo', 'MyRepo', 'AWS::CodeCommit::Repository')
      ).rejects.toThrow('boom');
    });
  });

  describe('property classification', () => {
    it('declares handledProperties covering the full CFn schema write-side set (Code + Triggers now handled)', () => {
      const handled = provider.handledProperties.get('AWS::CodeCommit::Repository');
      expect(handled).toBeDefined();
      expect([...(handled ?? [])].sort()).toEqual([
        'Code',
        'KmsKeyId',
        'RepositoryDescription',
        'RepositoryName',
        'Tags',
        'Triggers',
      ]);
      // Code + Triggers moved out of unhandledByDesign (issue #1066); the
      // provider no longer declares any by-design-unhandled property.
      expect(provider.unhandledByDesign).toBeUndefined();
    });
  });
});
