import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  BatchGetProjectsCommand,
  CreateProjectCommand,
  UpdateProjectCommand,
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

const RESOURCE_TYPE = 'AWS::CodeBuild::Project';

describe('CodeBuildProvider read-update round-trip', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodeBuildProvider();
  });

  it('Class 2 sanitize: empty-string ServiceRole / EncryptionKey / SourceVersion placeholders are dropped before UpdateProject', async () => {
    // Mechanical guard for Class 2 placeholder regression on
    // structurally-incomplete-when-empty fields. See
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    // readCurrentState emits `''` placeholders for ServiceRole /
    // EncryptionKey / SourceVersion so a console-side ADD on a project
    // deployed without those keys surfaces as drift. But shipping `''`
    // back through UpdateProject is invalid — AWS rejects empty
    // serviceRole / encryptionKey strings. The sanitize layer in
    // mapProperties must drop the empty placeholders so the SDK call
    // never sees them.

    // Mirror the readCurrentState shape for a project deployed without
    // ServiceRole / EncryptionKey / SourceVersion (CodeBuild always
    // requires a ServiceRole at create-time, but the round-trip test
    // exercises the sanitize symmetry — what readCurrentState would
    // emit on `serviceRole: undefined`).
    const observed = {
      Name: 'myproj',
      Description: '',
      ServiceRole: '',
      EncryptionKey: '',
      BadgeEnabled: false,
      SourceVersion: '',
      Source: { Type: 'NO_SOURCE' },
      Artifacts: { Type: 'NO_ARTIFACTS' },
      Environment: {
        Type: 'LINUX_CONTAINER',
        Image: 'aws/codebuild/standard:7.0',
        ComputeType: 'BUILD_GENERAL1_SMALL',
        EnvironmentVariables: [],
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({ project: { name: 'myproj', arn: 'arn:1' } });

    await provider.update('L', 'myproj', RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateProjectCommand);
    expect(updateCall).toBeDefined();
    const input = (updateCall![0] as UpdateProjectCommand).input;

    // Class 2 sanitize assertions — empty-string placeholders must NOT
    // reach the SDK call (AWS would reject them).
    expect(input.serviceRole).toBeUndefined();
    expect(input.encryptionKey).toBeUndefined();
    expect(input.sourceVersion).toBeUndefined();
  });

  it('Class 2 sanitize: non-empty ServiceRole / EncryptionKey / SourceVersion pass through unchanged', async () => {
    // Complement of the empty-string test: real values must NOT be
    // sanitized away.
    const observed = {
      Name: 'myproj',
      Description: 'd',
      ServiceRole: 'arn:aws:iam::1:role/r',
      EncryptionKey: 'arn:aws:kms:us-east-1:1:key/abc',
      BadgeEnabled: false,
      SourceVersion: 'main',
      Source: { Type: 'GITHUB', Location: 'https://x' },
      Artifacts: { Type: 'NO_ARTIFACTS' },
      Environment: {
        Type: 'LINUX_CONTAINER',
        Image: 'aws/codebuild/standard:7.0',
        ComputeType: 'BUILD_GENERAL1_SMALL',
        EnvironmentVariables: [],
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({ project: { name: 'myproj', arn: 'arn:1' } });

    await provider.update('L', 'myproj', RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateProjectCommand);
    expect(updateCall).toBeDefined();
    const input = (updateCall![0] as UpdateProjectCommand).input;

    expect(input.serviceRole).toBe('arn:aws:iam::1:role/r');
    expect(input.encryptionKey).toBe('arn:aws:kms:us-east-1:1:key/abc');
    expect(input.sourceVersion).toBe('main');
  });

  it('round-trip: readCurrentState observed snapshot survives update() without AWS-invalid empty-string inputs', async () => {
    // Full pipeline: readCurrentState -> update. Mocks the AWS-minimum
    // BatchGetProjects response (only required fields, optionals
    // undefined), captures the observed snapshot, then round-trips it
    // back through update() and asserts no AWS-rejection-shape values
    // reach the SDK.

    // 1. readCurrentState on a minimum-shape project (no description,
    //    no role returned, no encryption key, no badge, no source
    //    version).
    mockSend.mockResolvedValueOnce({
      projects: [
        {
          name: 'myproj',
          source: { type: 'NO_SOURCE' },
          artifacts: { type: 'NO_ARTIFACTS' },
          environment: {
            type: 'LINUX_CONTAINER',
            image: 'aws/codebuild/standard:7.0',
            computeType: 'BUILD_GENERAL1_SMALL',
          },
        },
      ],
    });

    const observed = await provider.readCurrentState('myproj', 'L', RESOURCE_TYPE);
    expect(observed).toBeDefined();

    // Confirm the always-emit placeholders are present (these are what
    // would be re-shipped on --revert).
    expect(observed!['Description']).toBe('');
    expect(observed!['ServiceRole']).toBe('');
    expect(observed!['EncryptionKey']).toBe('');
    expect(observed!['BadgeEnabled']).toBe(false);
    expect(observed!['SourceVersion']).toBe('');

    // 2. Round-trip: pass observed as both new and old.
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({ project: { name: 'myproj', arn: 'arn:1' } });

    await provider.update('L', 'myproj', RESOURCE_TYPE, observed!, observed!);

    // 3. Inspect the UpdateProject input — Class 2 sanitize must have
    //    dropped every empty-string placeholder.
    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateProjectCommand);
    expect(updateCall).toBeDefined();
    const input = (updateCall![0] as UpdateProjectCommand).input;

    expect(input.serviceRole).toBeUndefined();
    expect(input.encryptionKey).toBeUndefined();
    expect(input.sourceVersion).toBeUndefined();
    // Description '' is allowed by AWS UpdateProject (clears the
    // description) — it is NOT sanitized away. Verify it passes
    // through.
    expect(input.description).toBe('');
  });

  it('Class 1 audit: BadgeEnabled placeholder ships safely on round-trip (no discriminator dependency)', async () => {
    // CodeBuild has no Class 1 type-discriminator-dependent top-level
    // fields among the always-emit set. BadgeEnabled is universally
    // applicable across source types (incl. NO_SOURCE — AWS accepts
    // false but the badge URL is not generated). This test pins that
    // assumption: shipping `BadgeEnabled: false` on a NO_SOURCE
    // project must NOT throw or surface as an AWS-rejection-shape
    // input.
    const observed = {
      Name: 'myproj',
      Description: '',
      ServiceRole: 'arn:aws:iam::1:role/r',
      EncryptionKey: '',
      BadgeEnabled: false,
      SourceVersion: '',
      Source: { Type: 'NO_SOURCE' },
      Artifacts: { Type: 'NO_ARTIFACTS' },
      Environment: {
        Type: 'LINUX_CONTAINER',
        Image: 'aws/codebuild/standard:7.0',
        ComputeType: 'BUILD_GENERAL1_SMALL',
        EnvironmentVariables: [],
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({ project: { name: 'myproj', arn: 'arn:1' } });

    await expect(
      provider.update('L', 'myproj', RESOURCE_TYPE, observed, observed)
    ).resolves.toBeDefined();

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateProjectCommand);
    expect(updateCall).toBeDefined();
    const input = (updateCall![0] as UpdateProjectCommand).input;
    expect(input.badgeEnabled).toBe(false);
    expect(input.source?.type).toBe('NO_SOURCE');
  });

  it('create round-trip also sanitizes empty-string placeholders', async () => {
    // mapProperties is shared between create() and update(), so the
    // Class 2 sanitize applies to create as well. A user importing a
    // project via cdkd import that round-trips a readCurrentState
    // snapshot back through create() (e.g. accidental drop of state
    // followed by re-deploy) must not see AWS-rejection-shape inputs
    // either.
    const observed = {
      Name: 'myproj',
      Description: '',
      ServiceRole: '',
      EncryptionKey: '',
      BadgeEnabled: false,
      SourceVersion: '',
      Source: { Type: 'NO_SOURCE' },
      Artifacts: { Type: 'NO_ARTIFACTS' },
      Environment: {
        Type: 'LINUX_CONTAINER',
        Image: 'aws/codebuild/standard:7.0',
        ComputeType: 'BUILD_GENERAL1_SMALL',
        EnvironmentVariables: [],
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValueOnce({ project: { name: 'myproj', arn: 'arn:1' } });

    await provider.create('L', RESOURCE_TYPE, observed);

    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateProjectCommand);
    expect(createCall).toBeDefined();
    const input = (createCall![0] as CreateProjectCommand).input;

    expect(input.serviceRole).toBeUndefined();
    expect(input.encryptionKey).toBeUndefined();
    expect(input.sourceVersion).toBeUndefined();
  });

  // Suppress unused-import warning for BatchGetProjectsCommand (used by
  // readCurrentState pipeline test path indirectly through mockSend).
  it('imports stay live', () => {
    expect(BatchGetProjectsCommand).toBeDefined();
  });
});
