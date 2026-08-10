import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

    // ─── issue #1386: nested sub-keys that were silently dropped ────────
    //
    // `mapSource` / `mapProperties` build FRESH objects, so a CFn sub-key
    // that is not named there never reaches the SDK. Each expectation below
    // fails against the pre-#1386 provider (the member is `undefined`).

    it('wires Source.Auth / GitSubmodulesConfig / BuildStatusConfig / SourceIdentifier on create', async () => {
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        Source: {
          Type: 'GITHUB',
          Location: 'https://github.com/example/repo.git',
          SourceIdentifier: 'primary',
          Auth: { Type: 'CODECONNECTIONS', Resource: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc' },
          GitSubmodulesConfig: { FetchSubmodules: true },
          BuildStatusConfig: { Context: 'cdkd-build', TargetUrl: 'https://example.com/build' },
        },
        Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Artifacts: { Type: 'NO_ARTIFACTS' },
      });

      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(CreateProjectCommand);
      expect(command.input.source.sourceIdentifier).toBe('primary');
      expect(command.input.source.auth).toEqual({
        type: 'CODECONNECTIONS',
        resource: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc',
      });
      expect(command.input.source.gitSubmodulesConfig).toEqual({ fetchSubmodules: true });
      expect(command.input.source.buildStatusConfig).toEqual({
        context: 'cdkd-build',
        targetUrl: 'https://example.com/build',
      });
    });

    it('wires Environment.Fleet / Environment.DockerServer and Cache.CacheNamespace on create', async () => {
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        Source: { Type: 'NO_SOURCE' },
        Environment: {
          Type: 'LINUX_CONTAINER',
          ComputeType: 'BUILD_GENERAL1_SMALL',
          Image: 'aws/codebuild/standard:7.0',
          Fleet: { FleetArn: 'arn:aws:codebuild:us-east-1:123456789012:fleet/my-fleet:1234' },
          DockerServer: { ComputeType: 'BUILD_GENERAL1_MEDIUM', SecurityGroupIds: ['sg-123', 'sg-456'] },
        },
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Artifacts: { Type: 'NO_ARTIFACTS' },
        Cache: { Type: 'S3', Location: 'my-bucket/cache', Modes: ['LOCAL_SOURCE_CACHE'], CacheNamespace: 'shared-ns' },
      });

      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(CreateProjectCommand);
      expect(command.input.environment.fleet).toEqual({
        fleetArn: 'arn:aws:codebuild:us-east-1:123456789012:fleet/my-fleet:1234',
      });
      expect(command.input.environment.dockerServer).toEqual({
        computeType: 'BUILD_GENERAL1_MEDIUM',
        securityGroupIds: ['sg-123', 'sg-456'],
      });
      expect(command.input.cache.cacheNamespace).toBe('shared-ns');
    });

    it('wires BuildBatchConfig.BatchReportMode on create', async () => {
      // The fifth member of the CFn ProjectBuildBatchConfig definition. The
      // #1386 sweep named the other four and missed this one; `readCurrentState`
      // already read it back, so the file was internally asymmetric.
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        Source: { Type: 'NO_SOURCE' },
        Environment: {
          Type: 'LINUX_CONTAINER',
          ComputeType: 'BUILD_GENERAL1_SMALL',
          Image: 'aws/codebuild/standard:7.0',
        },
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Artifacts: { Type: 'NO_ARTIFACTS' },
        BuildBatchConfig: {
          ServiceRole: 'arn:aws:iam::123456789012:role/batch-role',
          BatchReportMode: 'REPORT_INDIVIDUAL_BUILDS',
          TimeoutInMins: 60,
        },
      });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.buildBatchConfig.batchReportMode).toBe('REPORT_INDIVIDUAL_BUILDS');
    });

    // SecondarySources route through the SAME `mapSource` helper, so the
    // sub-key wiring must cover them without a second code path.
    it('wires the same sub-keys on every SecondarySources entry', async () => {
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        Source: { Type: 'NO_SOURCE' },
        Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Artifacts: { Type: 'NO_ARTIFACTS' },
        SecondarySources: [
          {
            Type: 'GITHUB',
            Location: 'https://github.com/example/second.git',
            SourceIdentifier: 'secondary',
            GitSubmodulesConfig: { FetchSubmodules: false },
            BuildStatusConfig: { Context: 'secondary-ctx' },
            Auth: { Type: 'OAUTH' },
          },
        ],
      });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.secondarySources).toHaveLength(1);
      expect(command.input.secondarySources[0].sourceIdentifier).toBe('secondary');
      expect(command.input.secondarySources[0].gitSubmodulesConfig).toEqual({
        fetchSubmodules: false,
      });
      expect(command.input.secondarySources[0].buildStatusConfig).toEqual({
        context: 'secondary-ctx',
        targetUrl: undefined,
      });
      expect(command.input.secondarySources[0].auth).toEqual({
        type: 'OAUTH',
        resource: undefined,
      });
    });

    it('omits the #1386 sub-key members entirely when the template does not set them', async () => {
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        Source: { Type: 'NO_SOURCE' },
        Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Artifacts: { Type: 'NO_ARTIFACTS' },
      });

      const command = mockSend.mock.calls[0][0];
      expect(command.input.source.auth).toBeUndefined();
      expect(command.input.source.gitSubmodulesConfig).toBeUndefined();
      expect(command.input.source.buildStatusConfig).toBeUndefined();
      expect(command.input.source.sourceIdentifier).toBeUndefined();
      expect(command.input.environment.fleet).toBeUndefined();
      expect(command.input.environment.dockerServer).toBeUndefined();
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

    // issue #1386 — `update` shares `mapProperties` with `create`, but the
    // silent drop is worse here: UpdateProject is read-modify-write on the
    // whole blob, so an unnamed sub-key is WIPED from an existing project.
    it('wires every #1386 sub-key on update as well as create', async () => {
      mockSend.mockResolvedValue({
        project: {
          name: 'my-project',
          arn: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
        },
      });

      await provider.update(
        'MyProject',
        'my-project',
        'AWS::CodeBuild::Project',
        {
          Name: 'my-project',
          Source: {
            Type: 'GITHUB',
            Location: 'https://github.com/example/repo.git',
            SourceIdentifier: 'primary',
            Auth: { Type: 'CODECONNECTIONS', Resource: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc' },
            GitSubmodulesConfig: { FetchSubmodules: true },
            BuildStatusConfig: { Context: 'cdkd-build', TargetUrl: 'https://example.com/build' },
          },
          Environment: {
            Type: 'LINUX_CONTAINER',
            ComputeType: 'BUILD_GENERAL1_SMALL',
            Image: 'aws/codebuild/standard:7.0',
            Fleet: { FleetArn: 'arn:aws:codebuild:us-east-1:123456789012:fleet/my-fleet:1234' },
            DockerServer: { ComputeType: 'BUILD_GENERAL1_MEDIUM', SecurityGroupIds: ['sg-123'] },
          },
          ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
          Artifacts: { Type: 'NO_ARTIFACTS' },
          Cache: { Type: 'S3', Location: 'my-bucket/cache', CacheNamespace: 'shared-ns' },
        },
        {
          Name: 'my-project',
          Source: { Type: 'NO_SOURCE' },
          Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
          ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
          Artifacts: { Type: 'NO_ARTIFACTS' },
        }
      );

      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(UpdateProjectCommand);
      expect(command.input.source.sourceIdentifier).toBe('primary');
      expect(command.input.source.auth).toEqual({
        type: 'CODECONNECTIONS',
        resource: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc',
      });
      expect(command.input.source.gitSubmodulesConfig).toEqual({ fetchSubmodules: true });
      expect(command.input.source.buildStatusConfig).toEqual({
        context: 'cdkd-build',
        targetUrl: 'https://example.com/build',
      });
      expect(command.input.environment.fleet).toEqual({
        fleetArn: 'arn:aws:codebuild:us-east-1:123456789012:fleet/my-fleet:1234',
      });
      expect(command.input.environment.dockerServer).toEqual({
        computeType: 'BUILD_GENERAL1_MEDIUM',
        securityGroupIds: ['sg-123'],
      });
      expect(command.input.cache.cacheNamespace).toBe('shared-ns');
    });
  });

  // ─── readCurrentState ───────────────────────────────────────────────

  describe('readCurrentState', () => {
    // Write-side wiring without a read-side reverse map would leave the
    // drift baseline asymmetric with the AWS-current snapshot (issue #1386).
    it('reverse-maps the #1386 sub-keys emit-when-present', async () => {
      mockSend.mockResolvedValue({
        projects: [
          {
            name: 'my-project',
            source: {
              type: 'GITHUB',
              location: 'https://github.com/example/repo.git',
              sourceIdentifier: 'primary',
              gitSubmodulesConfig: { fetchSubmodules: true },
              buildStatusConfig: { context: 'cdkd-build', targetUrl: 'https://example.com/build' },
            },
            environment: {
              type: 'LINUX_CONTAINER',
              image: 'aws/codebuild/standard:7.0',
              computeType: 'BUILD_GENERAL1_SMALL',
              fleet: { fleetArn: 'arn:aws:codebuild:us-east-1:123456789012:fleet/my-fleet:1234' },
              dockerServer: { computeType: 'BUILD_GENERAL1_MEDIUM', securityGroupIds: ['sg-123'] },
            },
            cache: { type: 'S3', location: 'my-bucket/cache', cacheNamespace: 'shared-ns' },
          },
        ],
        projectsNotFound: [],
      });

      const state = await provider.readCurrentState(
        'my-project',
        'MyProject',
        'AWS::CodeBuild::Project'
      );

      const source = state?.['Source'] as Record<string, unknown>;
      expect(source['SourceIdentifier']).toBe('primary');
      expect(source['GitSubmodulesConfig']).toEqual({ FetchSubmodules: true });
      expect(source['BuildStatusConfig']).toEqual({
        Context: 'cdkd-build',
        TargetUrl: 'https://example.com/build',
      });

      const environment = state?.['Environment'] as Record<string, unknown>;
      expect(environment['Fleet']).toEqual({
        FleetArn: 'arn:aws:codebuild:us-east-1:123456789012:fleet/my-fleet:1234',
      });
      expect(environment['DockerServer']).toEqual({
        ComputeType: 'BUILD_GENERAL1_MEDIUM',
        SecurityGroupIds: ['sg-123'],
      });

      expect((state?.['Cache'] as Record<string, unknown>)['CacheNamespace']).toBe('shared-ns');
    });

    it('omits the #1386 sub-keys when AWS does not return them', async () => {
      mockSend.mockResolvedValue({
        projects: [
          {
            name: 'my-project',
            source: { type: 'NO_SOURCE' },
            environment: {
              type: 'LINUX_CONTAINER',
              image: 'aws/codebuild/standard:7.0',
              computeType: 'BUILD_GENERAL1_SMALL',
            },
          },
        ],
        projectsNotFound: [],
      });

      const state = await provider.readCurrentState(
        'my-project',
        'MyProject',
        'AWS::CodeBuild::Project'
      );

      expect(state?.['Source']).not.toHaveProperty('GitSubmodulesConfig');
      expect(state?.['Source']).not.toHaveProperty('BuildStatusConfig');
      expect(state?.['Environment']).not.toHaveProperty('Fleet');
      expect(state?.['Environment']).not.toHaveProperty('DockerServer');
      expect(state?.['Cache']).not.toHaveProperty('CacheNamespace');
    });

    it('reverse-maps the sub-keys on SECONDARY sources too', async () => {
      // SecondarySources share `mapSource` on the write side, so the read
      // side has to match or a project with a submodule-fetching secondary
      // source reports phantom drift on every run.
      mockSend.mockResolvedValue({
        projects: [
          {
            name: 'my-project',
            source: { type: 'NO_SOURCE' },
            secondarySources: [
              {
                type: 'GITHUB',
                location: 'https://github.com/example/lib.git',
                sourceIdentifier: 'lib',
                gitSubmodulesConfig: { fetchSubmodules: true },
                buildStatusConfig: { context: 'lib-ctx', targetUrl: 'https://example.com/lib' },
              },
            ],
            environment: {
              type: 'LINUX_CONTAINER',
              image: 'aws/codebuild/standard:7.0',
              computeType: 'BUILD_GENERAL1_SMALL',
            },
          },
        ],
        projectsNotFound: [],
      });

      const state = await provider.readCurrentState(
        'my-project',
        'MyProject',
        'AWS::CodeBuild::Project'
      );

      const secondary = (state?.['SecondarySources'] as Array<Record<string, unknown>>)[0]!;
      expect(secondary['SourceIdentifier']).toBe('lib');
      expect(secondary['GitSubmodulesConfig']).toEqual({ FetchSubmodules: true });
      expect(secondary['BuildStatusConfig']).toEqual({
        Context: 'lib-ctx',
        TargetUrl: 'https://example.com/lib',
      });
    });

    it('deliberately does NOT reverse-map Source.Auth', async () => {
      // BatchGetProjects echoes `auth` back only partially, so emitting it
      // would fire phantom drift on every project that sets it. This pins the
      // omission so a later "symmetry" edit cannot reintroduce it untested.
      mockSend.mockResolvedValue({
        projects: [
          {
            name: 'my-project',
            source: {
              type: 'GITHUB',
              location: 'https://github.com/example/repo.git',
              auth: { type: 'OAUTH' },
            },
            environment: {
              type: 'LINUX_CONTAINER',
              image: 'aws/codebuild/standard:7.0',
              computeType: 'BUILD_GENERAL1_SMALL',
            },
          },
        ],
        projectsNotFound: [],
      });

      const state = await provider.readCurrentState(
        'my-project',
        'MyProject',
        'AWS::CodeBuild::Project'
      );

      expect(state?.['Source']).not.toHaveProperty('Auth');
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
    function makeInput(overrides: Partial<{ knownPhysicalId: string; properties: Record<string, unknown> }> = {}) {
      return {
        logicalId: 'MyProject',
        resourceType: 'AWS::CodeBuild::Project',
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

    // No `aws:cdk:path` tag walk (issue #1134): AWS rejects `aws:`-prefixed
    // tag writes, so the tag never exists on a real resource. Without an
    // explicit override or a template `Name` the provider returns null
    // without any AWS call.
    it('returns null without any AWS call when no explicit override or Name is supplied', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
  // ─── malformed nested config (issue #1493) ──────────────────────────

  describe('malformed nested config blocks (issue #1493)', () => {
    // The `??`-shaped sibling of the #1471 / #1490 `||` class. `mapSource` /
    // `mapArtifacts` / the Environment block all INDEX a nested container, so
    // a string / array / unresolved intrinsic there yields `undefined` and the
    // fallback substituted a value the template never asked for — a project
    // with NO source (`NO_SOURCE`), no artifacts, or the wrong compute size,
    // reported as a successful deploy.
    const base = {
      Name: 'my-project',
      Source: { Type: 'GITHUB', Location: 'https://github.com/example/repo' },
      Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_LARGE' },
      ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
      Artifacts: { Type: 'NO_ARTIFACTS' },
    };

    it('refuses a string Source instead of silently building a NO_SOURCE project', async () => {
      await expect(
        provider.create('MyProject', 'AWS::CodeBuild::Project', { ...base, Source: 'GITHUB' })
      ).rejects.toThrow(/AWS::CodeBuild::Project Source must be an object \(got a string\)/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a string Artifacts instead of silently building a NO_ARTIFACTS project', async () => {
      await expect(
        provider.create('MyProject', 'AWS::CodeBuild::Project', {
          ...base,
          Artifacts: 'NO_ARTIFACTS',
        })
      ).rejects.toThrow(/AWS::CodeBuild::Project Artifacts must be an object \(got a string\)/);
    });

    it('refuses a string Environment instead of silently downsizing the compute type', async () => {
      await expect(
        provider.create('MyProject', 'AWS::CodeBuild::Project', {
          ...base,
          Environment: 'LINUX_CONTAINER',
        })
      ).rejects.toThrow(/AWS::CodeBuild::Project Environment must be an object \(got a string\)/);
    });

    it('names the SecondarySources path so the message points at the right block', async () => {
      await expect(
        provider.create('MyProject', 'AWS::CodeBuild::Project', {
          ...base,
          SecondarySources: ['GITHUB'],
        })
      ).rejects.toThrow(/AWS::CodeBuild::Project SecondarySources\[\] must be an object/);
    });

    it('refuses a blank Environment.Type rather than defaulting it away', async () => {
      await expect(
        provider.create('MyProject', 'AWS::CodeBuild::Project', {
          ...base,
          Environment: { Type: '', ComputeType: 'BUILD_GENERAL1_LARGE' },
        })
      ).rejects.toThrow(/AWS::CodeBuild::Project Environment.Type must be a non-empty string/);
    });

    it('still defaults for an ABSENT container and an ABSENT key', async () => {
      mockSend.mockResolvedValue({
        project: { name: 'my-project', arn: 'arn:aws:codebuild:us-east-1:123456789012:project/p' },
      });

      await provider.create('MyProject', 'AWS::CodeBuild::Project', {
        Name: 'my-project',
        ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
        Environment: {},
      });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.source).toMatchObject({ type: 'NO_SOURCE' });
      expect(input.artifacts).toMatchObject({ type: 'NO_ARTIFACTS' });
      expect(input.environment).toMatchObject({
        type: 'LINUX_CONTAINER',
        computeType: 'BUILD_GENERAL1_SMALL',
      });
    });

    it('applies the update path guard too, so create and update agree', async () => {
      await expect(
        provider.update(
          'MyProject',
          'my-project',
          'AWS::CodeBuild::Project',
          { ...base, Source: ['GITHUB'] },
          base
        )
      ).rejects.toThrow(/AWS::CodeBuild::Project Source must be an object \(got an array\)/);
    });
  });
});
