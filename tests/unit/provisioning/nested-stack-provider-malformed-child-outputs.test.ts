/**
 * Issue go-to-k/cdkd#3207: `NestedStackProvider.readChildOutputsAsAttributes`
 * rebuilt the PARENT's `Outputs.<Key>` attributes from the CHILD's persisted
 * `outputs` bag with a bare `?? {}`.
 *
 * `Object.entries` walks a string or a list as readily as a map, so a
 * six-character child bag became six fabricated `Outputs.<n>` attributes — and
 * those are returned as the nested-stack resource's `attributes`, which the
 * parent's deploy PERSISTS into the parent's own record and every `Fn::GetAtt`
 * against the nested stack then resolves into live AWS calls.
 *
 * REFUSE rather than repair, even though this file calls no `saveState`: what
 * it returns is written by its caller, so repairing would put a well-formed
 * fabricated attribute set into the parent's record with nothing left to say
 * the child was damaged.
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

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => ({
    deploy: vi.fn(async (stackName: string) => ({
      stackName,
      created: 1,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      durationMs: 1,
      outputs: {},
    })),
  })),
  DEFAULT_RESOURCE_WARN_AFTER_MS: 5 * 60 * 1000,
  DEFAULT_RESOURCE_TIMEOUT_MS: 30 * 60 * 1000,
}));
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: vi.fn(),
}));

const REGION = 'us-east-1';

function childState(outputs: unknown, opts: { omitOutputs?: boolean } = {}): StackState {
  const state: StackState = {
    version: 9,
    stackName: 'Parent~Child',
    region: REGION,
    resources: {
      Foo: { physicalId: 'foo-123', resourceType: 'AWS::S3::Bucket', properties: {} },
    },
    outputs: outputs as StackState['outputs'],
    lastModified: 1,
  };
  if (opts.omitOutputs) delete (state as Partial<StackState>).outputs;
  return state;
}

function templatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-3207-nested-'));
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

const create = async (state: StackState): Promise<{ attributes: Record<string, unknown> }> => {
  const provider = new NestedStackProvider();
  return (await withNestedStackContext(makeContext(state), () =>
    provider.create('Child', 'AWS::CloudFormation::Stack', {
      TemplateURL: 'https://example.com/child.json',
    })
  )) as { attributes: Record<string, unknown> };
};

describe("NestedStackProvider refuses a child's malformed outputs (go-to-k/cdkd#3207)", () => {
  beforeEach(() => vi.clearAllMocks());

  const MALFORMED: Array<[string, unknown]> = [
    ['a string bag', 'abcdef'],
    ['a list bag', ['a', 'b']],
    ['a null bag', null],
    ['a number bag', 5],
    ['a boolean bag', true],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`refuses ${label} with the shared code`, async () => {
      const err = (await create(childState(bag)).catch((e: unknown) => e)) as CdkdError;
      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    });
  }

  it('fabricates no `Outputs.<n>` attribute — the value a parent record would persist', async () => {
    // A confluence guard: "it threw" is satisfied by any failure. The pre-fix
    // code returned `{'Outputs.0': 'a', ..., 'Outputs.5': 'f'}`, so the
    // refusal's text must not be reachable as an attribute set — and the
    // failure must not be a bare `TypeError` either.
    const err = (await create(childState('abcdef')).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toContain("nested stack child 'Parent~Child'");
  });

  it('names the NESTED consequence, not the deploy one', async () => {
    const err = (await create(childState('abcdef')).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("PARENT's record");
    expect(err.message).toContain('Fn::GetAtt');
    expect(
      err.message,
      'the nested refusal borrowed the deploy text, which names the wrong record'
    ).not.toContain('republishes it into the shared exports index');
  });

  // THE OTHER DIRECTION.
  it('builds the attributes from a healthy bag unchanged', async () => {
    const result = await create(childState({ BucketName: 'my-bucket-123' }));
    expect(result.attributes).toEqual({ 'Outputs.BucketName': 'my-bucket-123' });
  });

  it('accepts an EMPTY bag — a child can legitimately publish no outputs', async () => {
    const result = await create(childState({}));
    expect(result.attributes).toEqual({});
  });

  it('accepts an ABSENT bag — a record cdkd writes on purpose', async () => {
    const result = await create(childState(undefined, { omitOutputs: true }));
    expect(result.attributes).toEqual({});
  });
});
