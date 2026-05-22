/**
 * Tests for `applyCrossStackResolverToTask` in `src/local/ecs-task-resolver.ts`.
 *
 * The function is the async post-pass invoked by `cdkd local run-task
 * --from-state` AFTER the synchronous `parseContainerDefinition` /
 * `resolveEcsTaskTarget` pass has produced a `ResolvedEcsTask`. It walks
 * each container's RAW template Environment / Secrets arrays, picks out
 * the cross-stack intrinsics (`Fn::ImportValue` / `Fn::GetStackOutput`)
 * that the sync pass warn-and-dropped, re-resolves them via the
 * `CrossStackResolver` on the supplied `SubstitutionContext`, and patches
 * the result onto `container.environment` / `container.secrets` in-place
 * while filtering the now-stale "dropped: ..." entries off the
 * container's and task's `warnings` arrays.
 *
 * Coverage axes (closes the HIGH-severity gap surfaced by the PR #487
 * test-adequacy review):
 *   - no-resolver early return (line 1487)
 *   - successful cross-stack Environment substitution + warning filter
 *   - successful cross-stack Secrets substitution + warning filter
 *   - skip-already-resolved (sync pass populated environment / secrets)
 *   - non-cross-stack intrinsic skipped (the `isCrossStackIntrinsic` guard)
 *   - resolver returns `undefined` → warning preserved
 *   - resolver returns `''` for secrets → entry NOT added (defensive guard)
 *   - container name fallback (`pickString(c.Name) ?? container.name`)
 *   - non-array Environment / Secrets / ContainerDefinitions defensive paths
 *   - warnings filtered at BOTH container.warnings AND task.warnings layers
 */

import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyCrossStackResolverToTask,
  type ResolvedEcsTask,
  type ResolvedEcsContainer,
} from '../../../src/local/ecs-task-resolver.js';
import type {
  CrossStackResolver,
  SubstitutionContext,
} from '../../../src/local/state-resolver.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function makeStack(name: string, resources: Record<string, TemplateResource>): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template,
    dependencyNames: [],
  };
}

function makeContainer(
  name: string,
  opts: { warnings?: string[]; environment?: Record<string, string>; secrets?: { name: string; valueFrom: string }[] } = {}
): ResolvedEcsContainer {
  return {
    name,
    image: { kind: 'public', uri: 'busybox:latest' },
    environment: opts.environment ?? {},
    secrets: opts.secrets ?? [],
    portMappings: [],
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: opts.warnings ?? [],
  };
}

function makeTask(
  stackName: string,
  containers: ResolvedEcsContainer[],
  rawContainers: unknown[],
  taskWarnings: string[] = []
): ResolvedEcsTask {
  const resource: TemplateResource = {
    Type: 'AWS::ECS::TaskDefinition',
    Properties: { ContainerDefinitions: rawContainers },
  };
  const stack = makeStack(stackName, { TD: resource });
  return {
    stack,
    taskDefinitionLogicalId: 'TD',
    resource,
    family: 'fam',
    networkMode: 'bridge',
    containers,
    volumes: [],
    warnings: taskWarnings,
  };
}

function makeResolver(impl: Partial<CrossStackResolver> = {}): CrossStackResolver {
  return {
    resolveImport: vi.fn().mockResolvedValue(undefined),
    resolveGetStackOutput: vi.fn().mockResolvedValue(undefined),
    ...impl,
  };
}

describe('applyCrossStackResolverToTask', () => {
  it('returns early without mutation when no crossStackResolver is on the context', async () => {
    const container = makeContainer('app', {
      warnings: [`Environment 'EXT' dropped: Fn::ImportValue '...': unsupported intrinsic ...`],
    });
    const task = makeTask(
      'S1',
      [container],
      [{ Name: 'app', Environment: [{ Name: 'EXT', Value: { 'Fn::ImportValue': 'Other' } }] }],
      [`Container 'app': Environment 'EXT' dropped: unsupported intrinsic`]
    );

    const context: SubstitutionContext = { resources: {} };
    await applyCrossStackResolverToTask(task, context);

    // No resolver → no mutation: environment empty, warnings preserved.
    expect(container.environment).toEqual({});
    expect(container.warnings).toEqual([
      `Environment 'EXT' dropped: Fn::ImportValue '...': unsupported intrinsic ...`,
    ]);
    expect(task.warnings).toEqual([
      `Container 'app': Environment 'EXT' dropped: unsupported intrinsic`,
    ]);
  });

  it('returns early when ContainerDefinitions is not an array (defensive)', async () => {
    const container = makeContainer('app');
    const task = makeTask('S1', [container], []);
    // Wipe ContainerDefinitions to test the early-return.
    (task.resource.Properties as Record<string, unknown>)['ContainerDefinitions'] = undefined;

    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('should-not-be-called'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };
    await applyCrossStackResolverToTask(task, context);

    expect(resolver.resolveImport).not.toHaveBeenCalled();
  });

  it('patches a successful Fn::ImportValue Environment substitution onto container.environment', async () => {
    const container = makeContainer('app', {
      warnings: [
        `Environment 'OTHER_BUCKET' dropped: Fn::ImportValue 'ProducerStack-BucketName': unsupported intrinsic`,
      ],
    });
    const rawContainers = [
      {
        Name: 'app',
        Environment: [
          { Name: 'LITERAL', Value: 'plain' },
          { Name: 'OTHER_BUCKET', Value: { 'Fn::ImportValue': 'ProducerStack-BucketName' } },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers, [
      `Container 'app': Environment 'OTHER_BUCKET' dropped: Fn::ImportValue '...': unsupported intrinsic`,
    ]);

    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('producer-bucket-12345'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(resolver.resolveImport).toHaveBeenCalledWith('ProducerStack-BucketName');
    expect(container.environment).toEqual({ OTHER_BUCKET: 'producer-bucket-12345' });
    // Both container.warnings AND task.warnings filtered.
    expect(container.warnings).toEqual([]);
    expect(task.warnings).toEqual([]);
  });

  it('patches a successful Fn::GetStackOutput Environment substitution', async () => {
    const container = makeContainer('app');
    const rawContainers = [
      {
        Name: 'app',
        Environment: [
          {
            Name: 'PRODUCER_URL',
            Value: {
              'Fn::GetStackOutput': {
                StackName: 'OtherStack',
                OutputName: 'ApiUrl',
              },
            },
          },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);

    const resolver = makeResolver({
      resolveGetStackOutput: vi.fn().mockResolvedValue('https://other.example.com'),
    });
    const context: SubstitutionContext = {
      resources: {},
      crossStackResolver: resolver,
      consumerRegion: 'us-east-1',
    };

    await applyCrossStackResolverToTask(task, context);

    expect(resolver.resolveGetStackOutput).toHaveBeenCalledWith(
      'OtherStack',
      'us-east-1',
      'ApiUrl'
    );
    expect(container.environment).toEqual({ PRODUCER_URL: 'https://other.example.com' });
  });

  it('patches a successful Secrets[].ValueFrom cross-stack substitution', async () => {
    const container = makeContainer('app', {
      warnings: [`Secret 'PROD_TOKEN' dropped: Fn::ImportValue '...': unsupported intrinsic`],
    });
    const rawContainers = [
      {
        Name: 'app',
        Secrets: [
          {
            Name: 'PROD_TOKEN',
            ValueFrom: { 'Fn::ImportValue': 'ProducerStack-TokenArn' },
          },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers, [
      `Container 'app': Secret 'PROD_TOKEN' dropped: Fn::ImportValue '...': unsupported intrinsic`,
    ]);

    const resolver = makeResolver({
      resolveImport: vi
        .fn()
        .mockResolvedValue('arn:aws:secretsmanager:us-east-1:123:secret:tok-aBcDef'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.secrets).toEqual([
      {
        name: 'PROD_TOKEN',
        valueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:tok-aBcDef',
      },
    ]);
    expect(container.warnings).toEqual([]);
    expect(task.warnings).toEqual([]);
  });

  it('preserves the dropped warning when the resolver returns undefined', async () => {
    // When the producer stack hasn't been deployed yet, the resolver
    // reports `undefined` and the post-pass MUST NOT silently add a
    // bogus env entry — the original warn-and-drop must persist so the
    // user sees the failure.
    const container = makeContainer('app', {
      warnings: [
        `Environment 'OTHER_BUCKET' dropped: Fn::ImportValue 'ProducerStack-BucketName': export not found`,
      ],
    });
    const rawContainers = [
      {
        Name: 'app',
        Environment: [
          { Name: 'OTHER_BUCKET', Value: { 'Fn::ImportValue': 'ProducerStack-BucketName' } },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers, [
      `Container 'app': Environment 'OTHER_BUCKET' dropped: Fn::ImportValue 'ProducerStack-BucketName': export not found`,
    ]);

    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue(undefined),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.environment).toEqual({});
    expect(container.warnings.length).toBe(1);
    expect(task.warnings.length).toBe(1);
  });

  it('does NOT add a Secret entry when resolver returns an empty string (defensive)', async () => {
    // Secrets gate: even a literal `''` from the resolver is rejected
    // because ECS rejects empty `valueFrom` at registerTaskDefinition.
    const container = makeContainer('app');
    const rawContainers = [
      {
        Name: 'app',
        Secrets: [{ Name: 'EMPTY', ValueFrom: { 'Fn::ImportValue': 'EmptyExport' } }],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);

    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue(''),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.secrets).toEqual([]);
  });

  it('skips Environment entries already resolved by the sync pass (present in container.environment)', async () => {
    const container = makeContainer('app', {
      environment: { ALREADY: 'sync-pass-value' },
    });
    const rawContainers = [
      {
        Name: 'app',
        Environment: [
          // The sync pass already wrote ALREADY into environment; the
          // post-pass must NOT call the resolver again for it.
          { Name: 'ALREADY', Value: { 'Fn::ImportValue': 'WhateverExport' } },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);

    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('post-pass-value-DO-NOT-USE'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    // Original value preserved; resolver was NOT invoked.
    expect(container.environment).toEqual({ ALREADY: 'sync-pass-value' });
    expect(resolver.resolveImport).not.toHaveBeenCalled();
  });

  it('skips Secrets entries already present in container.secrets', async () => {
    const container = makeContainer('app', {
      secrets: [{ name: 'EXISTING', valueFrom: 'arn:aws:secretsmanager:...:existing' }],
    });
    const rawContainers = [
      {
        Name: 'app',
        Secrets: [
          { Name: 'EXISTING', ValueFrom: { 'Fn::ImportValue': 'WouldOverride' } },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);

    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('arn:NEW-arn'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    // Original sync-pass value preserved untouched.
    expect(container.secrets).toEqual([
      { name: 'EXISTING', valueFrom: 'arn:aws:secretsmanager:...:existing' },
    ]);
    expect(resolver.resolveImport).not.toHaveBeenCalled();
  });

  it('skips a non-cross-stack intrinsic (e.g. plain Ref) — the sync pass already tried it', async () => {
    const container = makeContainer('app');
    const rawContainers = [
      {
        Name: 'app',
        Environment: [{ Name: 'PLAIN_REF', Value: { Ref: 'SomeResource' } }],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);

    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('should-not-use'),
      resolveGetStackOutput: vi.fn().mockResolvedValue('should-not-use'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.environment).toEqual({});
    expect(resolver.resolveImport).not.toHaveBeenCalled();
    expect(resolver.resolveGetStackOutput).not.toHaveBeenCalled();
  });

  it('skips literal Environment values (string / number / boolean)', async () => {
    const container = makeContainer('app', { environment: { L: 'plain' } });
    const rawContainers = [
      {
        Name: 'app',
        Environment: [
          { Name: 'L', Value: 'plain' },
          { Name: 'N', Value: 42 },
          { Name: 'B', Value: true },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);

    const resolver = makeResolver();
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    // No resolver calls; the existing environment map is untouched.
    expect(resolver.resolveImport).not.toHaveBeenCalled();
    expect(resolver.resolveGetStackOutput).not.toHaveBeenCalled();
  });

  it('skips literal Secrets ValueFrom (literal ARN strings)', async () => {
    const container = makeContainer('app');
    const rawContainers = [
      {
        Name: 'app',
        Secrets: [
          { Name: 'PRESENT', ValueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:k' },
        ],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);

    const resolver = makeResolver();
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(resolver.resolveImport).not.toHaveBeenCalled();
  });

  it('uses container.name when the raw template entry omits Name (fallback)', async () => {
    // The raw template doesn't carry Name (unusual but defensive), but
    // container.name was set by the sync pass — the post-pass uses it as
    // the fallback when building the task.warnings filter.
    const container = makeContainer('fallback-name', {
      warnings: [
        `Environment 'X' dropped: Fn::ImportValue 'Other': unsupported intrinsic`,
      ],
    });
    const rawContainers = [
      {
        // Name omitted — container.name 'fallback-name' wins
        Environment: [{ Name: 'X', Value: { 'Fn::ImportValue': 'Other' } }],
      },
    ];
    const task = makeTask('S1', [container], rawContainers, [
      `Container 'fallback-name': Environment 'X' dropped: Fn::ImportValue 'Other': unsupported intrinsic`,
    ]);

    const resolver = makeResolver({ resolveImport: vi.fn().mockResolvedValue('resolved') });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.environment).toEqual({ X: 'resolved' });
    // task.warnings filtered using the fallback name.
    expect(task.warnings).toEqual([]);
  });

  it('skips a raw container entry whose Environment is not an array', async () => {
    const container = makeContainer('app');
    const rawContainers = [
      {
        Name: 'app',
        Environment: 'not-an-array' as unknown,
      },
    ];
    const task = makeTask('S1', [container], rawContainers);
    const resolver = makeResolver();
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.environment).toEqual({});
    expect(resolver.resolveImport).not.toHaveBeenCalled();
  });

  it('skips raw container entries that are not objects', async () => {
    const container = makeContainer('app');
    const rawContainers = ['malformed-string-entry', null, 42];
    const task = makeTask('S1', [container], rawContainers as unknown[]);
    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('should-not-call'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(resolver.resolveImport).not.toHaveBeenCalled();
  });

  it('skips Environment / Secrets entries whose Name is missing', async () => {
    const container = makeContainer('app');
    const rawContainers = [
      {
        Name: 'app',
        Environment: [{ Value: { 'Fn::ImportValue': 'WithNoName' } }],
        Secrets: [{ ValueFrom: { 'Fn::ImportValue': 'SecretWithNoName' } }],
      },
    ];
    const task = makeTask('S1', [container], rawContainers);
    const resolver = makeResolver({
      resolveImport: vi.fn().mockResolvedValue('resolved-but-no-key'),
    });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.environment).toEqual({});
    expect(container.secrets).toEqual([]);
  });

  it('handles a mix of Environment + Secrets resolution in one pass', async () => {
    const container = makeContainer('app', {
      warnings: [
        `Environment 'A' dropped: Fn::ImportValue 'ExportA': ...`,
        `Secret 'B' dropped: Fn::ImportValue 'ExportB': ...`,
        // Unrelated warning that must survive the filter.
        `Container '<other>': Environment 'C' dropped: ...`,
      ],
    });
    const rawContainers = [
      {
        Name: 'app',
        Environment: [{ Name: 'A', Value: { 'Fn::ImportValue': 'ExportA' } }],
        Secrets: [{ Name: 'B', ValueFrom: { 'Fn::ImportValue': 'ExportB' } }],
      },
    ];
    const task = makeTask('S1', [container], rawContainers, [
      `Container 'app': Environment 'A' dropped: Fn::ImportValue 'ExportA': ...`,
      `Container 'app': Secret 'B' dropped: Fn::ImportValue 'ExportB': ...`,
      // Sibling-stack warning that must NOT be touched.
      `Container 'other': Environment 'X' dropped: ...`,
    ]);

    const resolveImport = vi
      .fn<(name: string) => Promise<string>>()
      .mockImplementation(async (name) =>
        name === 'ExportA' ? 'valA' : name === 'ExportB' ? 'arn:secretB' : 'unexpected'
      );
    const resolver = makeResolver({ resolveImport });
    const context: SubstitutionContext = { resources: {}, crossStackResolver: resolver };

    await applyCrossStackResolverToTask(task, context);

    expect(container.environment).toEqual({ A: 'valA' });
    expect(container.secrets).toEqual([{ name: 'B', valueFrom: 'arn:secretB' }]);
    // The unrelated sibling warning must survive.
    expect(container.warnings).toEqual([`Container '<other>': Environment 'C' dropped: ...`]);
    expect(task.warnings).toEqual([`Container 'other': Environment 'X' dropped: ...`]);
  });
});
