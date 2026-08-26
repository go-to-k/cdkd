/**
 * `NestedStackProvider` forwards the PARENT's per-resource secrets bag to the
 * child engine it builds (issue
 * [#1903](https://github.com/go-to-k/cdkd/issues/1903)), and records the
 * CHILD's region into the synthesized physicalId the resolver reads back (issue
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055)).
 *
 * Unlike `nested-stack-provider.test.ts`, which replaces the whole
 * `deploy-engine` module, this file keeps the REAL
 * `withCurrentResourceSecrets` / `getCurrentResourceSecrets` async-local store
 * — which lives in its own leaf module `resource-secrets-scope.ts`, so the
 * `deploy-engine` mock cannot reach it — and mocks only the `DeployEngine`
 * CLASS. The forwarding is a property of that store, so a stubbed accessor
 * could not fence it.
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
vi.mock('../../../src/deployment/deploy-engine.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DeployEngine: vi.fn().mockImplementation((...ctor: unknown[]) => {
      ctorCalls.push(ctor);
      return {
        deploy: vi.fn(async (stackName: string) => ({
          stackName,
          created: 1,
          updated: 0,
          deleted: 0,
          unchanged: 0,
          durationMs: 1,
          outputs: {},
        })),
      };
    }),
  };
});

import {
  NestedStackProvider,
} from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import type { DeployEngineOptions } from '../../../src/deployment/deploy-engine.js';
import type { StackState } from '../../../src/types/state.js';

const NESTED = 'AWS::CloudFormation::Stack';
const SECRET_PLAINTEXT = 'provider-forwarded-plaintext-1903';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/child/db:SecretString:password::}}';

let dir: string;

function childTemplatePath(): string {
  const p = join(dir, 'child.json');
  writeFileSync(p, JSON.stringify({ Resources: { ChildRes: { Type: 'AWS::SNS::Topic' } } }));
  return p;
}

function childState(): StackState {
  return {
    version: 6,
    stackName: 'Parent~Child',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 1,
  };
}

function makeContext(overrides: Partial<NestedStackProviderContext> = {}): NestedStackProviderContext {
  return {
    stateBackend: {
      getState: vi.fn(async () => ({ state: childState(), etag: 'e' })),
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
    options: { concurrency: 1 },
    nestedTemplates: { Child: childTemplatePath() },
    ...overrides,
  };
}

/** The options bag the provider handed the child `DeployEngine`. */
function childOptions(index = 0): DeployEngineOptions {
  return ctorCalls[index]![5] as DeployEngineOptions;
}

describe('NestedStackProvider — inherited secrets + child-region provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctorCalls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'cdkd-nsp-secrets-'));
  });

  it('seeds the child engine with the parent secrets bag bound around the provider call (#1903)', async () => {
    const provider = new NestedStackProvider();
    const parentSecrets = new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]);

    const result = await withCurrentResourceSecrets(parentSecrets, () =>
      withNestedStackContext(makeContext(), () =>
        provider.create('Child', NESTED, {
          // What the parent's resolution produced: PLAINTEXT.
          Parameters: { DbPassword: SECRET_PLAINTEXT },
        })
      )
    );

    expect(ctorCalls).toHaveLength(1);
    const opts = childOptions();
    expect(opts.parameters).toEqual({ DbPassword: SECRET_PLAINTEXT });
    expect(opts.inheritedSecrets).toBe(parentSecrets);
    expect(result.physicalId).toContain('nested-stack/Parent/Child');
  });

  it('forwards the bag on the UPDATE path too', async () => {
    // Both paths or the fix has a hole in the shape of whichever one a given
    // deploy takes: a nested stack that already exists takes update().
    const provider = new NestedStackProvider();
    const parentSecrets = new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]);

    await withCurrentResourceSecrets(parentSecrets, () =>
      withNestedStackContext(makeContext(), () =>
        provider.update(
          'Child',
          'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
          NESTED,
          { Parameters: { DbPassword: SECRET_PLAINTEXT } },
          {}
        )
      )
    );

    expect(childOptions().inheritedSecrets).toBe(parentSecrets);
  });

  it('omits the option entirely when the store is unbound or empty', async () => {
    // Every caller that is not the deploy engine reads as absent, which the
    // child engine treats as "nothing to inherit" — the pre-#1903 behaviour.
    const provider = new NestedStackProvider();
    await withNestedStackContext(makeContext(), () =>
      provider.create('Child', NESTED, { Parameters: {} })
    );
    expect(childOptions()).not.toHaveProperty('inheritedSecrets');

    ctorCalls.length = 0;
    await withCurrentResourceSecrets(new Map(), () =>
      withNestedStackContext(makeContext(), () => provider.create('Child', NESTED, {}))
    );
    expect(childOptions()).not.toHaveProperty('inheritedSecrets');
  });

  it('builds the physicalId region segment from the CONTEXT, never from the ambient environment (#2055)', async () => {
    // `IntrinsicFunctionResolver` reads this segment back as the producer
    // region when it re-resolves a redacted child output. A secret NAME is
    // regional, so a physicalId naming the wrong region resolves the wrong
    // secret.
    //
    // WHAT THIS CAN AND CANNOT DISCRIMINATE (review round 2). The title used to
    // say "the CHILD region", which this case cannot see: the provider assigns
    // `childRegion = ctx.parentRegion` (nested-stack-provider.ts), so the two
    // are the SAME VALUE and no assertion here could tell them apart. It will
    // become discriminating on its own the day cross-region nested stacks give
    // the child a region of its own.
    //
    // What it DOES fence, and what the ambient override below makes real, is
    // the regression that actually threatens the readback: the segment being
    // filled from `AWS_REGION` / a hard-coded `us-east-1` instead of from the
    // deploy context. Without the override, `AWS_REGION` is usually unset or
    // already `us-east-1` in a unit run, so a fix that read the environment
    // would pass.
    const previousRegion = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'ap-northeast-1';
    try {
      const provider = new NestedStackProvider();
      const result = await withNestedStackContext(makeContext({ parentRegion: 'eu-west-1' }), () =>
        provider.create('Child', NESTED, {})
      );

      expect(result.physicalId).toBe(
        'arn:cdkd-local:eu-west-1:123456789012:nested-stack/Parent/Child'
      );
      expect(result.physicalId).not.toContain('ap-northeast-1');
      expect(result.physicalId).not.toContain('us-east-1');
    } finally {
      if (previousRegion === undefined) delete process.env['AWS_REGION'];
      else process.env['AWS_REGION'] = previousRegion;
    }
  });

  it('surfaces the child stack outputs VERBATIM — the token is not resolved here', async () => {
    // The seam decision for #2055: re-resolving at attribute-BUILD time would
    // put the plaintext into the parent's `attributes`, and every consumer
    // reading it through `Fn::GetAtt` would then persist the plaintext into
    // its OWN record with nothing recorded to redact it back. The expression
    // stays here; the resolver re-resolves at the read site.
    const provider = new NestedStackProvider();
    const ctx = makeContext();
    (ctx.stateBackend as unknown as { getState: ReturnType<typeof vi.fn> }).getState = vi.fn(
      async () => ({
        state: { ...childState(), outputs: { DbPassword: SECRET_EXPR, Plain: 'public' } },
        etag: 'e',
      })
    );

    const result = await withNestedStackContext(ctx, () => provider.create('Child', NESTED, {}));

    expect(result.attributes).toEqual({
      'Outputs.DbPassword': SECRET_EXPR,
      'Outputs.Plain': 'public',
    });
  });
});
