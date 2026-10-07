/**
 * Issue go-to-k/cdkd#4159, the `cdkd diff` half: every malformed-record
 * warning `buildDiffTree` prints — the six at the state load, the three in the
 * adoption preview, and those at a nested child's node, live or deleted —
 * carries the run's account flags on its `cdkd state show` pointer, from the
 * `refusalRecovery` arg `diff.ts` builds. With no context the command carries
 * no account flag.
 *
 * The harness is `diff-recursive-deploy-refusal-blocking.test.ts`'s.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

import { getLogger } from '../../../src/utils/logger.js';
import { buildDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockRecoveryContext } from '../../../src/state/lock-contention-message.js';

/** `calculateDiff`'s `refusalRecovery` position (a NoEcho comparison follows it, go-to-k/cdkd#4043). */
const REFUSAL_RECOVERY_ARG = 9;

const STACK = 'S';
const REGION = 'us-east-1';
const RECOVERY: LockRecoveryContext = {
  profile: 'prod',
  stateBucket: 'my-bucket',
  statePrefix: 'team-a',
};
const FLAGS = '--profile prod --state-bucket my-bucket --state-prefix team-a';
const show = (stack: string): string => `cdkd state show ${stack} --stack-region ${REGION} --json`;

function entry(extra: Partial<Record<keyof ResourceState, unknown>> = {}): ResourceState {
  return {
    physicalId: 'q',
    resourceType: 'AWS::SQS::Queue',
    properties: { QueueName: 'q' },
    ...extra,
  } as ResourceState;
}

function record(extra: Record<string, unknown> = {}): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: { Q: entry() },
    outputs: {},
    lastModified: 0,
    ...extra,
  } as StackState;
}

type Preview = Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'];

async function diff(
  state: StackState,
  rec: LockRecoveryContext | undefined,
  extra: {
    tpl?: CloudFormationTemplate;
    children?: Record<string, StackState>;
    nestedTemplates?: Record<string, string>;
    previewOrphanAdoption?: Preview;
  } = {}
) {
  const states: Record<string, StackState> = { [STACK]: state, ...(extra.children ?? {}) };
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template: extra.tpl ?? { Resources: { Q: { Type: 'AWS::SQS::Queue' } } },
    nestedTemplates: extra.nestedTemplates ?? {},
    recursive: true,
    stateBackend: {
      getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
    } as unknown as S3StateBackend,
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    ...(extra.previewOrphanAdoption && { previewOrphanAdoption: extra.previewOrphanAdoption }),
    ...(rec && { refusalRecovery: rec }),
  });
}

function warnings(): string {
  return (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => String(args[0]))
    .join('\n');
}

const nothingAdopted: Preview = async () => ({ adopted: {}, refusals: [] });
const tornState = { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' };

/**
 * One case per warning site, each damaging only the container that site
 * reads. FACTORIES: the repairs mutate the record they are handed.
 */
const SITES: Array<
  [string, () => { state: StackState; tpl?: CloudFormationTemplate; preview?: Preview }]
> = [
  ['load: the resources bag', () => ({ state: record({ resources: 5 }) })],
  ['load: a resource row', () => ({ state: record({ resources: { Q: entry(), Bad: null } }) })],
  [
    "load: a row's properties map",
    () => ({ state: record({ resources: { Q: entry({ properties: 'abcdef' }) } }) }),
  ],
  ['load: the outputs bag', () => ({ state: record({ outputs: 'abc' }) })],
  ['load: the orphans container', () => ({ state: record({ orphans: 'abc' }) })],
  ['load: the exportNames field', () => ({ state: record({ exportNames: 5 }) })],
  [
    'preview: an unreadable orphan row',
    () => ({ state: record({ orphans: [null] }), preview: nothingAdopted }),
  ],
  [
    "preview: an ADOPTED row's torn properties map",
    () => ({
      state: record({ orphans: [{ logicalId: 'Adopted', state: tornState }] }),
      tpl: { Resources: { Q: { Type: 'AWS::SQS::Queue' }, Adopted: { Type: 'AWS::SQS::Queue' } } },
      preview: async () => ({ adopted: { Adopted: { ...tornState } as never }, refusals: [] }),
    }),
  ],
  [
    'preview: a KEPT orphan row the deploy refuses',
    () => ({
      state: record({
        orphans: [
          {
            logicalId: 'Kept',
            state: { physicalId: 'k', resourceType: 'AWS::SQS::Queue', properties: {}, attributes: 'x' },
          },
        ],
      }),
      preview: nothingAdopted,
    }),
  ],
];

describe('cdkd diff carries the account flags on its malformed-record warnings (go-to-k/cdkd#4159)', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [site, make] of SITES) {
    it(`${site}: the warning carries the flags`, async () => {
      const { state, tpl, preview } = make();
      await diff(state, RECOVERY, { ...(tpl && { tpl }), ...(preview && { previewOrphanAdoption: preview }) });
      expect(warnings()).toContain(`${show(STACK)} ${FLAGS}`);
    });

    it(`${site}: CONTROL — no context, no account flag`, async () => {
      const { state, tpl, preview } = make();
      await diff(state, undefined, {
        ...(tpl && { tpl }),
        ...(preview && { previewOrphanAdoption: preview }),
      });
      expect(warnings()).toContain(show(STACK));
      expect(warnings()).not.toContain('--state-bucket');
    });
  }

  // `calculateDiff`'s own refusals are dominated here (the load repairs
  // first), so the hand-over is pinned on the call's argument instead.
  it('hands the context to calculateDiff, and nothing without it', async () => {
    const spy = vi.spyOn(DiffCalculator.prototype, 'calculateDiff');
    await diff(record(), RECOVERY);
    expect(spy.mock.calls.at(-1)?.[REFUSAL_RECOVERY_ARG]).toBe(RECOVERY);
    await diff(record(), undefined);
    expect(spy.mock.calls.at(-1)?.[REFUSAL_RECOVERY_ARG]).toBeUndefined();
    spy.mockRestore();
  });

  describe('a nested child node carries them too', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cdkd-4159-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const parent = (): StackState =>
      record({
        resources: {
          Child: { physicalId: 'c', resourceType: 'AWS::CloudFormation::Stack', properties: {} },
        },
      });
    const child = (): StackState => ({ ...record({ resources: 5 }), stackName: `${STACK}~Child` });

    it('a LIVE child (the recursive buildDiffTree call)', async () => {
      const childPath = join(dir, 'child.template.json');
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
      await diff(parent(), RECOVERY, {
        tpl: { Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} } } },
        nestedTemplates: { Child: childPath },
        children: { [`${STACK}~Child`]: child() },
      });
      expect(warnings()).toContain(`${show(`'${STACK}~Child'`)} ${FLAGS}`);
    });

    it('a DELETED child (buildDeletedSubtree)', async () => {
      await diff(parent(), RECOVERY, {
        tpl: { Resources: {} },
        children: { [`${STACK}~Child`]: child() },
      });
      expect(warnings()).toContain(`${show(`'${STACK}~Child'`)} ${FLAGS}`);
    });

    it("a DELETED child's own nested child (buildDeletedSubtree's recursion)", async () => {
      // The deleted child is healthy and names a grandchild; only the
      // GRANDCHILD's record is malformed, so only the recursion can carry it.
      const deletedChild: StackState = {
        ...record({
          resources: {
            Grand: { physicalId: 'g', resourceType: 'AWS::CloudFormation::Stack', properties: {} },
          },
        }),
        stackName: `${STACK}~Child`,
      };
      const grand: StackState = { ...record({ resources: 5 }), stackName: `${STACK}~Child~Grand` };
      await diff(parent(), RECOVERY, {
        tpl: { Resources: {} },
        children: { [`${STACK}~Child`]: deletedChild, [`${STACK}~Child~Grand`]: grand },
      });
      expect(warnings()).toContain(`${show(`'${STACK}~Child~Grand'`)} ${FLAGS}`);
    });

    it("a DELETED child's diff hands the context to calculateDiff", async () => {
      // Its `calculateDiff` refusals are dominated by the load's repair, so the
      // hand-over is pinned on the call's argument, as at the root.
      const spy = vi.spyOn(DiffCalculator.prototype, 'calculateDiff');
      const deletedChild: StackState = { ...record(), stackName: `${STACK}~Child` };
      await diff(parent(), RECOVERY, {
        tpl: { Resources: {} },
        children: { [`${STACK}~Child`]: deletedChild },
      });
      const childCall = spy.mock.calls.find((call) => call[0].stackName === `${STACK}~Child`);
      expect(childCall, 'the deleted child was never diffed').toBeDefined();
      expect(childCall![REFUSAL_RECOVERY_ARG]).toBe(RECOVERY);
      spy.mockRestore();
    });
  });

  it('diff.ts builds the context from --profile, the RESOLVED bucket and --state-prefix, and hands it over', () => {
    const source = readFileSync(
      new URL('../../../src/cli/commands/diff.ts', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(
      /const refusalRecovery: LockRecoveryContext = \{\s*profile: options\.profile,\s*stateBucket,\s*statePrefix: options\.statePrefix,\s*\};/
    );
    const call = source.slice(source.indexOf('await buildDiffTree({'));
    // The call's own closing line, not the first `})` (a conditional spread
    // inside the argument object closes one too).
    expect(call.slice(0, call.indexOf('\n        })'))).toMatch(/^\s*refusalRecovery,$/m);
  });
});
