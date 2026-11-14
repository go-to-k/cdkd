/**
 * go-to-k/cdkd#6271: a container `Command` / `EntryPoint` /
 * `HealthCheck.Command` element that is an intrinsic used to be dropped
 * silently, so `cdkd local run-task` ran a different command
 * (`--bucket` with no value). Each element now resolves against state, and
 * one that cannot resolve refuses the run naming the container and index.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyCrossStackResolverToTask,
  assertEcsTaskCommandsResolved,
  detectEcsImageResolutionNeeds,
  EcsTaskResolutionError,
  resolveEcsTaskTarget,
} from '../../../src/local/ecs-task-resolver.js';
import type { CrossStackResolver } from '../../../src/local/state-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

function buildStack(container: Record<string, unknown>): StackInfo {
  const resources: Record<string, TemplateResource> = {
    B08E7C7AF: { Type: 'AWS::S3::Bucket', Properties: {} },
    TD: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: 'fam',
        NetworkMode: 'bridge',
        ContainerDefinitions: [{ Name: 'cli', Image: 'busybox:latest', ...container }],
      },
    },
  };
  return {
    stackName: 'S1',
    displayName: 'S1',
    artifactId: 'S1',
    template: { Resources: resources },
    dependencyNames: [],
  };
}

function bucketState(): Record<string, ResourceState> {
  return {
    B08E7C7AF: {
      physicalId: 'deployed-bucket-123',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: { Arn: 'arn:aws:s3:::deployed-bucket-123' },
      dependencies: [],
    },
  };
}

const bucketCommand = ['s3api', 'head-bucket', '--bucket', { Ref: 'B08E7C7AF' }];

describe('container argv intrinsics (go-to-k/cdkd#6271)', () => {
  it('substitutes a Ref element of Command against state, keeping its position', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: bucketCommand })], {
      stateResources: bucketState(),
    });
    expect(task.containers[0]!.command).toEqual([
      's3api',
      'head-bucket',
      '--bucket',
      'deployed-bucket-123',
    ]);
    expect(task.containers[0]!.unresolvedCommandElements).toBeUndefined();
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('substitutes EntryPoint and HealthCheck.Command elements (Fn::GetAtt / Fn::Join)', () => {
    const task = resolveEcsTaskTarget(
      'TD',
      [
        buildStack({
          EntryPoint: ['sh', '-c', { 'Fn::Join': ['', ['echo ', { Ref: 'B08E7C7AF' }]] }],
          HealthCheck: { Command: ['CMD', 'test', { 'Fn::GetAtt': ['B08E7C7AF', 'Arn'] }] },
        }),
      ],
      { stateResources: bucketState() }
    );
    const c = task.containers[0]!;
    expect(c.entryPoint).toEqual(['sh', '-c', 'echo deployed-bucket-123']);
    expect(c.healthCheck?.command).toEqual(['CMD', 'test', 'arn:aws:s3:::deployed-bucket-123']);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('refuses, naming the container and index, when there is no state source', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: bucketCommand })]);
    expect(task.containers[0]!.unresolvedCommandElements).toEqual([
      { field: 'Command', index: 3, reason: expect.stringContaining('--from-state') },
    ]);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(EcsTaskResolutionError);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container 'cli' Command\[3\]/);
  });

  it('refuses when the referenced resource is missing from state', () => {
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ HealthCheck: { Command: ['CMD', { Ref: 'B08E7C7AF' }] } })],
      { stateResources: {} }
    );
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Container 'cli' HealthCheck\.Command\[1\]/
    );
  });

  it('refuses an EntryPoint element that is not a string or an intrinsic', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ EntryPoint: ['sh', null] })], {
      stateResources: bucketState(),
    });
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container 'cli' EntryPoint\[1\]/);
  });

  it('keeps number and boolean literals as their strings', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['sleep', 5, true] })]);
    expect(task.containers[0]!.command).toEqual(['sleep', '5', 'true']);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('stringifies an element that substitutes to a number', () => {
    const state = bucketState();
    state['B08E7C7AF']!.attributes = { Port: 5432 };
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ Command: ['--port', { 'Fn::GetAtt': ['B08E7C7AF', 'Port'] }] })],
      { stateResources: state }
    );
    expect(task.containers[0]!.command).toEqual(['--port', '5432']);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('does not refuse an all-literal Command with no state source', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['echo', 'hi'] })]);
    expect(task.containers[0]!.command).toEqual(['echo', 'hi']);
    expect(task.containers[0]!.unresolvedCommandElements).toBeUndefined();
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('flags an intrinsic argv element as needing state, a cross-stack one the resolver too', () => {
    const same = detectEcsImageResolutionNeeds(buildStack({ Command: bucketCommand }));
    expect(same.needsEnvOrSecretSubstitution).toBe(true);
    expect(same.needsCrossStackResolver).toBe(false);
    const cross = detectEcsImageResolutionNeeds(
      buildStack({ HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'P-Bucket' }] } })
    );
    expect(cross.needsEnvOrSecretSubstitution).toBe(true);
    expect(cross.needsCrossStackResolver).toBe(true);
    const literal = detectEcsImageResolutionNeeds(buildStack({ Command: ['echo', 'hi'] }));
    expect(literal.needsEnvOrSecretSubstitution).toBe(false);
  });

  describe('a secret read from state never lands on the argv', () => {
    const secretState: Record<string, ResourceState> = {
      Key: {
        physicalId: 'AKIAEXAMPLE',
        resourceType: 'AWS::IAM::AccessKey',
        properties: {},
        attributes: { SecretAccessKey: 'plaintext-secret-key' },
        dependencies: [],
      },
      ApiKey: {
        physicalId: 'da2-xyz',
        resourceType: 'AWS::AppSync::ApiKey',
        properties: {},
        attributes: { ApiKey: 'da2-plaintext-api-key' },
        dependencies: [],
      },
      Cr: {
        physicalId: 'cr-1',
        resourceType: 'Custom::Thing',
        properties: {},
        attributes: { Token: '***', Name: 'cr-name' },
        dependencies: [],
      },
    };
    const resolve = (command: unknown[]) =>
      resolveEcsTaskTarget('TD', [buildStack({ Command: command })], {
        stateResources: secretState,
      });

    it.each([
      ['a credential-named attribute', { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] }, 'Key.SecretAccessKey'],
      ['a dotted-string Fn::GetAtt', { 'Fn::GetAtt': 'Key.SecretAccessKey' }, 'Key.SecretAccessKey'],
      ['a secret-valued attribute inside Fn::Sub', { 'Fn::Sub': 'x-api-key: ${ApiKey.ApiKey}' }, 'ApiKey.ApiKey'],
      ['an attribute recorded as the mask', { 'Fn::Join': ['', ['t=', { 'Fn::GetAtt': ['Cr', 'Token'] }]] }, 'Cr.Token'],
    ])('refuses %s', (_label, element, named) => {
      const task = resolve(['run', element]);
      expect(task.containers[0]!.command).toEqual(['run', '']);
      expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        new RegExp(`Command\\[1\\]: reads the secret attribute ${named.replace('.', '\\.')}`)
      );
    });

    it('still resolves a non-secret attribute of the same custom resource', () => {
      const task = resolve(['run', { 'Fn::GetAtt': ['Cr', 'Name'] }]);
      expect(task.containers[0]!.command).toEqual(['run', 'cr-name']);
      expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
    });
  });

  describe('cross-stack post-pass', () => {
    function resolver(value: string | undefined): CrossStackResolver {
      return {
        resolveImport: vi.fn().mockResolvedValue(value),
        resolveGetStackOutput: vi.fn().mockResolvedValue(undefined),
      };
    }
    const importCommand = ['--bucket', { 'Fn::ImportValue': 'Producer-Bucket' }];

    it('patches a Fn::ImportValue element the sync pass left unresolved', async () => {
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })], {
        stateResources: {},
      });
      expect(task.containers[0]!.unresolvedCommandElements).toHaveLength(1);
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.command).toEqual(['--bucket', 'producer-bucket']);
      expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
    });

    it('refuses a Fn::ImportValue nested in Fn::Join with the engine reason (top-level only)', async () => {
      const nested = ['--uri', { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'Producer-Bucket' }]] }];
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: nested })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.command).toEqual(['--uri', '']);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Command\[1\]: Fn::Join element \[1\]: unsupported intrinsic Fn::ImportValue/
      );
    });

    it('names a cross-stack reference when no post-pass ran', () => {
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })]);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Command\[1\]: a cross-stack reference \(Fn::ImportValue/
      );
    });

    it('patches EntryPoint and HealthCheck.Command elements too', async () => {
      const stack = buildStack({
        EntryPoint: ['sh', { 'Fn::ImportValue': 'Producer-Bucket' }],
        HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'Producer-Bucket' }] },
      });
      const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.entryPoint).toEqual(['sh', 'producer-bucket']);
      expect(task.containers[0]!.healthCheck?.command).toEqual(['CMD', 'producer-bucket']);
      expect(task.containers[0]!.unresolvedCommandElements).toBeUndefined();
    });

    it("replaces the sync pass's reason with the post-pass's own when the producer output is missing", async () => {
      // No state record for the consumer stack: the sync pass had no context.
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })]);
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver(undefined),
      });
      const [u] = task.containers[0]!.unresolvedCommandElements!;
      expect(u!.reason).toMatch(/Producer-Bucket/);
      expect(u!.reason).not.toMatch(/a cross-stack reference|--from-state/);
    });

    it('still refuses when the producer output is missing', async () => {
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver(undefined),
      });
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container 'cli' Command\[1\]/);
    });

    it('refuses a producer output that is a dynamic reference rather than put it on the argv', async () => {
      const hook = vi.fn().mockResolvedValue('plaintext');
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('{{resolve:secretsmanager:s:SecretString}}'),
        resolveDynamicReferences: hook,
      });
      expect(hook).not.toHaveBeenCalled();
      expect(task.containers[0]!.command).toEqual(['--bucket', '']);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Container 'cli' Command\[1\]: resolved to a CloudFormation dynamic reference.*Environment variable or a Secrets entry/
      );
    });
  });
});
