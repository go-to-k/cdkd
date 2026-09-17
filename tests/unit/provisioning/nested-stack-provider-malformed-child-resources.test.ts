/**
 * Issue go-to-k/cdkd#3161, nested-stack half.
 *
 * `runDestroyForStack` refuses a child record whose `resources` bag cannot be
 * read — but `NestedStackProvider.delete` counts the CHILD's bag one call
 * EARLIER, to log `N resource(s)` before handing the record over:
 *
 *   const resourceCount = Object.keys(childStateData.state.resources).length;
 *
 * So the runner's guard, however well placed, could not see a `null` or absent
 * child bag: the `TypeError` fired here first, naming no stack, no key and no
 * remedy — exactly what go-to-k/cdkd#3018 exists to remove. A `[]` / number /
 * boolean reached the runner, but only after this line had already logged
 * `0 resource(s)`, which is the reading the whole issue is about.
 *
 * The same helper is called here, so a child's refusal reads identically to a
 * top-level one rather than being a second spelling that can drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn(),
  DEFAULT_RESOURCE_WARN_AFTER_MS: 5 * 60 * 1000,
  DEFAULT_RESOURCE_TIMEOUT_MS: 30 * 60 * 1000,
}));
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: vi.fn(async () => ({
    stackName: 'Parent~Child',
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 0,
    retainedCount: 0,
    skippedCount: 0,
    guardIndeterminateCount: 0,
    errorCount: 0,
    interrupted: false,
  })),
}));

const REGION = 'us-east-1';

function childState(resources: unknown, opts: { omitResources?: boolean } = {}): StackState {
  const state: StackState = {
    version: 9,
    stackName: 'Parent~Child',
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 1,
  };
  if (opts.omitResources) delete (state as Partial<StackState>).resources;
  return state;
}

function templatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-3161-nested-'));
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

function makeContext(state: StackState): NestedStackProviderContext {
  return {
    stateBackend: {
      getState: vi.fn(async () => ({ state, etag: 'e' })),
    } as unknown as NestedStackProviderContext['stateBackend'],
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
    nestedTemplates: { Child: templatePath() },
  };
}

const destroyChild = async (state: StackState): Promise<void> => {
  const provider = new NestedStackProvider();
  await withNestedStackContext(makeContext(state), () =>
    provider.delete('Child', 'Parent~Child', 'AWS::CloudFormation::Stack')
  );
};

describe("NestedStackProvider.delete refuses a child's malformed resources (go-to-k/cdkd#3161)", () => {
  beforeEach(() => vi.clearAllMocks());

  // One row per outcome the unguarded count produced, as in the top-level
  // suites: the three that enumerate no keys, the string, and the two that
  // threw a bare `TypeError` out of `Object.keys` before the runner was
  // reached at all.
  const MALFORMED: Array<[string, unknown]> = [
    ['a list bag', []],
    ['a number bag', 5],
    ['a boolean bag', true],
    ['a string bag', 'ab'],
    ['a null bag', null],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`refuses ${label} with the shared code, before the child destroy runs`, async () => {
      const err = (await destroyChild(childState(bag)).catch((e: unknown) => e)) as CdkdError;
      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      // Not a bare `TypeError` — the failure mode this closes for `null` and
      // an absent field.
      expect(err).not.toBeInstanceOf(TypeError);
      // DOMINANCE over the count AND over the hand-off: a guard placed inside
      // `runDestroyForStack` alone cannot stop this line, and the runner is
      // mocked here so reaching it is observable.
      expect(
        runDestroyForStack,
        'the child destroy was entered before the refusal, so the count above it already ran'
      ).not.toHaveBeenCalled();
    });
  }

  it('refuses an ABSENT child resources bag', async () => {
    const err = (await destroyChild(childState(undefined, { omitResources: true })).catch(
      (e: unknown) => e
    )) as CdkdError;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(runDestroyForStack).not.toHaveBeenCalled();
  });

  it("names the CHILD's stack, not the parent's", async () => {
    const err = (await destroyChild(childState([])).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('Parent~Child');
    expect(
      err.message,
      'the refusal named the parent, so an operator inspects the wrong record'
    ).not.toMatch(/State for 'Parent'/);
  });

  // THE OTHER DIRECTION — without these, a guard that refused every child
  // would satisfy every case above while making nested destroys impossible.
  it('lets a POPULATED child bag through to the child destroy', async () => {
    await destroyChild(
      childState({ Foo: { physicalId: 'foo-123', resourceType: 'AWS::S3::Bucket', properties: {} } })
    );
    expect(runDestroyForStack).toHaveBeenCalled();
  });

  it('lets a legitimately EMPTY child bag through to the child destroy', async () => {
    await destroyChild(childState({}));
    expect(runDestroyForStack).toHaveBeenCalled();
  });
});
