/**
 * `NestedStackProvider.update()` under a ROLLBACK (issue
 * [#3754](https://github.com/go-to-k/cdkd/issues/3754)).
 *
 * The revert arms call `update()` with `UpdateContext.replayingState`. Before
 * the fix that flag stopped at this provider: `update()` re-deployed the
 * CURRENT child template through a child `DeployEngine`, which diffs NO_CHANGE
 * over the child's just-saved state — the rollback reported the row restored
 * while the child kept the failed deploy's configuration. Now the flag routes
 * to the child's journal replay, and a normal nested deploy is untouched.
 *
 * The replay itself is fenced in `tests/unit/deployment/nested-child-journal.test.ts`;
 * here it is mocked so the cases can pin the ROUTING and what is passed.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestedStackProviderContext } from '../../../src/provisioning/nested-stack-context.js';
import type { StackState } from '../../../src/types/state.js';

const engines = vi.hoisted(() => ({ constructed: 0, deployed: [] as string[] }));
const reverts = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  error: undefined as Error | undefined,
  warnings: 0,
}));

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => {
    engines.constructed++;
    return {
      deploy: vi.fn(async (stackName: string) => {
        engines.deployed.push(stackName);
        return { stackName };
      }),
    };
  }),
}));

vi.mock('../../../src/deployment/nested-child-journal.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/deployment/nested-child-journal.js')>();
  return {
    ...real,
    revertNestedChildFromJournal: vi.fn(async (args: Record<string, unknown>) => {
      reverts.calls.push(args);
      if (reverts.error) throw reverts.error;
      return { warnings: reverts.warnings };
    }),
  };
});

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import { withNestedStackContext } from '../../../src/provisioning/nested-stack-context.js';
import { withNestedRevertRun } from '../../../src/deployment/nested-child-journal.js';
import { withProducerRegions } from '../../../src/deployment/producer-regions-scope.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';

const ARN = 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child';

function childTemplatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-revert-'));
  const p = join(dir, 'child.nested.template.json');
  writeFileSync(p, JSON.stringify({ Resources: { Foo: { Type: 'AWS::S3::Bucket' } } }));
  return p;
}

function context(deployMode: boolean): NestedStackProviderContext {
  const childState: StackState = {
    version: 10,
    stackName: 'Parent~Child',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 0,
  };
  return {
    stateBackend: {
      getState: vi.fn(async () => ({ state: childState, etag: 'e' })),
    } as never,
    lockManager: {} as never,
    providerRegistry: {} as never,
    parentStackName: 'Parent',
    parentRegion: 'us-east-1',
    accountId: '123456789012',
    awsClients: {} as never,
    stateBucket: 'b',
    ...(deployMode && {
      nestedTemplates: { Child: childTemplatePath() },
      dagBuilder: {} as never,
      diffCalculator: {} as never,
      options: { concurrency: 1 },
    }),
  };
}

beforeEach(() => {
  engines.constructed = 0;
  engines.deployed.length = 0;
  reverts.calls.length = 0;
  reverts.error = undefined;
  reverts.warnings = 0;
});

describe('NestedStackProvider.update() — rollback revert (#3754)', () => {
  it('replayingState replays the child journal for the bound run and deploys NO template', async () => {
    const provider = new NestedStackProvider();

    const result = await withNestedStackContext(context(true), () =>
      withNestedRevertRun('run-9', () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, { replayingState: true })
      )
    );

    expect(engines.constructed).toBe(0);
    expect(reverts.calls).toHaveLength(1);
    expect(reverts.calls[0]).toMatchObject({
      logicalId: 'Child',
      childStackName: 'Parent~Child',
      region: 'us-east-1',
      run: expect.objectContaining({ runId: 'run-9' }),
    });
    expect(result).toEqual({ physicalId: ARN, wasReplaced: false });
  });

  it('CONTROL: an ordinary nested update (no replayingState) still deploys the child template', async () => {
    const provider = new NestedStackProvider();

    await withNestedStackContext(context(true), () =>
      withNestedRevertRun('run-9', () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, {})
      )
    );

    expect(engines.constructed).toBe(1);
    expect(engines.deployed).toEqual(['Parent~Child']);
    expect(reverts.calls).toHaveLength(0);
  });

  it('works in a DESTROY-mode context (standalone `cdkd rollback` carries no templates)', async () => {
    const provider = new NestedStackProvider();

    await withNestedStackContext(context(false), () =>
      withNestedRevertRun('run-9', () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, { replayingState: true })
      )
    );

    expect(reverts.calls).toHaveLength(1);
  });

  it('CONTROL: a destroy-mode context still refuses an ORDINARY update', async () => {
    const provider = new NestedStackProvider();

    await expect(
      withNestedStackContext(context(false), () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, {})
      )
    ).rejects.toThrow(/deploy-mode context fields/);
  });

  it('REFUSES a replay with no rollback run in scope rather than guessing one', async () => {
    const provider = new NestedStackProvider();

    await expect(
      withNestedStackContext(context(true), () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, { replayingState: true })
      )
    ).rejects.toThrow(/outside a rollback run/);
    expect(reverts.calls).toHaveLength(0);
    expect(engines.constructed).toBe(0);
  });

  it('a failed child revert FAILS the row instead of reporting it restored', async () => {
    reverts.error = new Error('Cannot revert nested stack Parent~Child');
    const provider = new NestedStackProvider();

    await expect(
      withNestedStackContext(context(true), () =>
        withNestedRevertRun('run-9', () =>
          provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, { replayingState: true })
        )
      )
    ).rejects.toThrow(/Cannot revert nested stack/);
  });

  it('a child replay that SKIPPED ops makes the row PARTIAL, naming the child and the count', async () => {
    reverts.warnings = 2;
    const provider = new NestedStackProvider();

    const result = await withNestedStackContext(context(true), () =>
      withNestedRevertRun('run-9', () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, { replayingState: true })
      )
    );

    expect(result).toEqual({
      physicalId: ARN,
      wasReplaced: false,
      outcome: 'partial',
      reason: 'nested stack Parent~Child skipped 2 operation(s) of its revert',
    });
  });

  it('a runId-less run is forwarded to the journal replay (which refuses it)', async () => {
    const provider = new NestedStackProvider();

    await withNestedStackContext(context(true), () =>
      withNestedRevertRun(undefined, () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, { replayingState: true })
      )
    );

    expect(reverts.calls[0]).toMatchObject({ run: expect.objectContaining({ runId: undefined }) });
  });
});

describe("NestedStackProvider hands the child the parent's producer regions (#4174)", () => {
  const EVIDENCE = { regions: ['us-west-2'], complete: true };

  it("a revert passes the reverting replay's evidence to the child journal replay", async () => {
    const provider = new NestedStackProvider();

    await withNestedStackContext(context(false), () =>
      withProducerRegions(
        () => EVIDENCE,
        () =>
          withNestedRevertRun('run-9', () =>
            provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, {
              replayingState: true,
            })
          )
      )
    );

    expect(reverts.calls[0]!['inheritedProducerRegions']).toEqual(EVIDENCE);
  });

  it('CONTROL: with no evidence bound the child gets none, which it reads as incomplete', async () => {
    const provider = new NestedStackProvider();

    await withNestedStackContext(context(false), () =>
      withNestedRevertRun('run-9', () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, { replayingState: true })
      )
    );

    expect(reverts.calls[0]!['inheritedProducerRegions']).toBeUndefined();
  });

  it("an ordinary nested update hands the child engine the parent engine's evidence getter", async () => {
    const provider = new NestedStackProvider();
    const getter = () => EVIDENCE;

    await withNestedStackContext(context(true), () =>
      withProducerRegions(getter, () =>
        provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, {})
      )
    );

    const options = vi.mocked(DeployEngine).mock.calls.at(-1)![5] as Record<string, unknown>;
    expect(options['inheritedProducerRegions']).toBe(getter);
  });

  it('CONTROL: an inherited top-level option never reaches the child: the spread site overwrites it', async () => {
    const provider = new NestedStackProvider();
    const ctx = context(true);
    ctx.options = { concurrency: 1, inheritedProducerRegions: () => EVIDENCE };

    await withNestedStackContext(ctx, () =>
      provider.update('Child', ARN, 'AWS::CloudFormation::Stack', {}, {}, {})
    );

    const options = vi.mocked(DeployEngine).mock.calls.at(-1)![5] as Record<string, unknown>;
    expect(options['inheritedProducerRegions']).toBeUndefined();
  });
});
