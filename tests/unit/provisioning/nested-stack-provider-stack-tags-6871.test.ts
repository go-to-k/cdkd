/**
 * go-to-k/cdkd#6871: the nested-stack provider hands the child engine its
 * effective stack tags -- the parent's, with the row's own `Tags` winning --
 * on create and update, and the child's context carries them on for a
 * grandchild. Harness from `nested-stack-provider-inherited-secrets.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const ctorCalls = vi.hoisted(() => [] as unknown[][]);
const childContexts = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../src/deployment/deploy-engine.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DeployEngine: vi.fn().mockImplementation((...ctor: unknown[]) => {
      ctorCalls.push(ctor);
      return {
        deploy: vi.fn(async (stackName: string) => {
          const { getCurrentNestedStackContext } = await import(
            '../../../src/provisioning/nested-stack-context.js'
          );
          childContexts.push(getCurrentNestedStackContext());
          return { stackName, created: 1, updated: 0, deleted: 0, unchanged: 0, durationMs: 1, outputs: {} };
        }),
      };
    }),
  };
});

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { DeployEngineOptions } from '../../../src/deployment/deploy-engine.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';

const NESTED = 'AWS::CloudFormation::Stack';
let dir: string;

function makeContext(stackTags?: Record<string, string>): NestedStackProviderContext {
  const childPath = join(dir, 'child.json');
  writeFileSync(childPath, JSON.stringify({ Resources: { R: { Type: 'AWS::SNS::Topic' } } }));
  return {
    stateBackend: {
      getState: vi.fn(async () => ({
        state: {
          version: 6,
          stackName: 'Parent~Child',
          region: 'us-east-1',
          resources: {},
          outputs: {},
          lastModified: 1,
        },
        etag: 'e',
      })),
    } as unknown as NestedStackProviderContext['stateBackend'],
    lockManager: {} as NestedStackProviderContext['lockManager'],
    providerRegistry: {} as NestedStackProviderContext['providerRegistry'],
    parentStackName: 'Parent',
    parentRegion: 'us-east-1',
    accountId: '123456789012',
    awsClients: {} as NestedStackProviderContext['awsClients'],
    stateBucket: 'cdkd-state-test',
    dagBuilder: {} as NestedStackProviderContext['dagBuilder'],
    diffCalculator: {} as NestedStackProviderContext['diffCalculator'],
    options: { concurrency: 1, ...(stackTags && { stackTags }) },
    nestedTemplates: { Child: childPath },
  };
}

const childOptions = (): DeployEngineOptions => ctorCalls[0]![5] as DeployEngineOptions;
const childContextOptions = (): DeployEngineOptions | undefined =>
  (childContexts[0] as NestedStackProviderContext | undefined)?.options;

describe('NestedStackProvider threads the child stack tags (go-to-k/cdkd#6871)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctorCalls.length = 0;
    childContexts.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'cdkd-6871-nsp-'));
  });

  it("create: the parent's tags merged with the row's own, the row winning", async () => {
    await withNestedStackContext(makeContext({ a: '1', b: '2' }), () =>
      new NestedStackProvider().create('Child', NESTED, {
        Tags: [{ Key: 'b', Value: 'row' }],
      })
    );
    expect(childOptions().stackTags).toEqual({ a: '1', b: 'row' });
    // A grandchild derives its tags from THIS child's.
    expect(childContextOptions()?.stackTags).toEqual({ a: '1', b: 'row' });
  });

  it('update: the same merge', async () => {
    await withNestedStackContext(makeContext({ a: '1' }), () =>
      new NestedStackProvider().update(
        'Child',
        'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        NESTED,
        { Tags: [{ Key: 'c', Value: '3' }] },
        {}
      )
    );
    expect(childOptions().stackTags).toEqual({ a: '1', c: '3' });
  });

  it("an untagged row under an untagged parent hands the child no tags, never the parent's value", async () => {
    await withNestedStackContext(makeContext(), () =>
      new NestedStackProvider().create('Child', NESTED, {})
    );
    expect(childOptions().stackTags).toEqual({});
  });

  it('hands a row tag resolved from a secret down as its expression, never the plaintext (security review M1)', async () => {
    const plaintext = 'row-tag-secret-6871';
    const expression = '{{resolve:secretsmanager:prod/tag:SecretString:v::}}';
    await withCurrentResourceSecrets(new Map([[plaintext, expression]]), () =>
      withNestedStackContext(makeContext({ a: '1' }), () =>
        new NestedStackProvider().create('Child', NESTED, {
          Tags: [{ Key: 's', Value: plaintext }],
        })
      )
    );
    expect(childOptions().stackTags).toEqual({ a: '1', s: expression });
    expect(JSON.stringify(childContextOptions()?.stackTags)).not.toContain(plaintext);
  });
});
