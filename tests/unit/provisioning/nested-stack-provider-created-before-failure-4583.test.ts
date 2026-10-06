/**
 * go-to-k/cdkd#4583: a nested-stack create whose child deploy RETURNED and
 * which then failed (reading the child's outputs back) leaves a deployed child
 * with no parent row. The thrown error carries the created-before-failure mark
 * with the id a successful create records, so the failed CREATE is journaled
 * for `cdkd rollback --revert-failed`. The child deploy's own failure, and a
 * refusal before it, are never marked.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { deployMock } = vi.hoisted(() => ({ deployMock: vi.fn() }));

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => ({ deploy: deployMock })),
  DEFAULT_RESOURCE_WARN_AFTER_MS: 5 * 60 * 1000,
  DEFAULT_RESOURCE_TIMEOUT_MS: 30 * 60 * 1000,
}));
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: vi.fn(),
}));

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import {
  createdBeforeFailure,
  markCreatedBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import type { StackState } from '../../../src/types/state.js';

const REGION = 'us-east-1';
const TYPE = 'AWS::CloudFormation::Stack';

function childState(outputs: unknown): StackState {
  return {
    version: 9,
    stackName: 'Parent~Child',
    region: REGION,
    resources: {
      Foo: { physicalId: 'foo-123', resourceType: 'AWS::S3::Bucket', properties: {} },
    },
    outputs: outputs as StackState['outputs'],
    lastModified: 1,
  };
}

function templatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-4583-nested-'));
  const file = join(dir, 'child.nested.template.json');
  writeFileSync(
    file,
    JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: { Foo: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b1' } } },
    })
  );
  return file;
}

function makeContext(
  getState: () => Promise<unknown>,
  nestedTemplates: Record<string, string> | undefined = { Child: templatePath() }
): NestedStackProviderContext {
  return {
    stateBackend: { getState: vi.fn(getState) } as unknown as NestedStackProviderContext['stateBackend'],
    lockManager: {} as NestedStackProviderContext['lockManager'],
    providerRegistry: {} as NestedStackProviderContext['providerRegistry'],
    parentStackName: 'Parent',
    parentRegion: REGION,
    accountId: '123456789012',
    awsClients: {} as NestedStackProviderContext['awsClients'],
    stateBucket: 'cdkd-state-test',
    dagBuilder: {} as NestedStackProviderContext['dagBuilder'],
    diffCalculator: {} as NestedStackProviderContext['diffCalculator'],
    options: { concurrency: 1 },
    nestedTemplates,
  };
}

const run = (ctx: NestedStackProviderContext): Promise<unknown> =>
  withNestedStackContext(ctx, () =>
    new NestedStackProvider().create('Child', TYPE, { TemplateURL: 'https://example.com/c.json' })
  );

const failure = (ctx: NestedStackProviderContext): Promise<unknown> =>
  run(ctx).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );

const deployed = {
  stackName: 'Parent~Child',
  created: 1,
  updated: 0,
  deleted: 0,
  unchanged: 0,
  durationMs: 1,
  outputs: {},
};

describe('NestedStackProvider create: the created-before-failure mark (go-to-k/cdkd#4583)', () => {
  beforeEach(() => {
    deployMock.mockReset();
    deployMock.mockResolvedValue(deployed);
  });

  it('marks the id a successful create records when the child outputs are refused', async () => {
    const success = (await run(makeContext(async () => ({ state: childState({}), etag: 'e' })))) as {
      physicalId: string;
    };
    const error = await failure(
      makeContext(async () => ({ state: childState('abcdef'), etag: 'e' }))
    );
    expect(deployMock).toHaveBeenCalledTimes(2);
    expect(createdBeforeFailure(error, 'Child', TYPE)).toBe(success.physicalId);
    expect(success.physicalId).toBe('arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child');
  });

  it('marks it when reading the child state back fails after the child deployed', async () => {
    const error = await failure(
      makeContext(async () => {
        throw new Error('AccessDenied: s3:GetObject');
      })
    );
    expect(deployMock).toHaveBeenCalledTimes(1);
    expect(createdBeforeFailure(error, 'Child', TYPE)).toBe(
      'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child'
    );
  });

  it("does not mark the child deploy's own failure", async () => {
    deployMock.mockRejectedValue(new Error('child resource Foo failed'));
    const getState = vi.fn(async () => ({ state: childState({}), etag: 'e' }));
    const error = await failure(makeContext(getState));
    expect(createdBeforeFailure(error, 'Child', TYPE)).toBeUndefined();
  });

  // A grandchild stack with the SAME construct id: its mark rides the child
  // deploy's rejection, and reading it here would journal the grandchild's
  // arn as this row's resource (the child's journal already holds it).
  it("does not let a same-id grandchild stack's mark be read as this row's", async () => {
    const grandchild = markCreatedBeforeFailure(
      new Error('grandchild outputs refused'),
      'Child',
      TYPE,
      'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent~Child/Child'
    );
    expect(createdBeforeFailure(grandchild, 'Child', TYPE)).toBeDefined();
    deployMock.mockRejectedValue(grandchild);
    const error = await failure(makeContext(async () => ({ state: childState({}), etag: 'e' })));
    expect(error).toBe(grandchild);
    expect(createdBeforeFailure(error, 'Child', TYPE)).toBeUndefined();
  });

  it('does not mark a refusal before the child deploy (no nested template)', async () => {
    const error = await failure(
      makeContext(async () => ({ state: childState({}), etag: 'e' }), {})
    );
    expect(deployMock).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Child', TYPE)).toBeUndefined();
  });
});
