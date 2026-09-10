/**
 * WHICH resolver contexts carry `redactedAttributeReads`, and what the answer
 * costs when it is wrong (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847), round-4 review — found
 * independently by the code and security reviewers).
 *
 * The bag started as a pure RECORD: `noteAttributeSecrecy` pushed into it and
 * returned the value unchanged, so putting it on every context the deploy
 * engine builds cost an array nobody consulted, and `buildResolverContext` set
 * one unconditionally with a comment saying so.
 *
 * That stopped being true when `resolveRefValue` began deciding, from the bag's
 * PRESENCE, whether `refStateLookupFromResource` may SKIP a masked leaf. On the
 * deploy-internal DIFF context — which has no refusal reader — the skip fired
 * anyway: `{Ref: X}` resolved to the raw physical id and was compared against
 * the `'***'` in state. A pre-existing issue #2274 stack (a `NoEcho` value in
 * `properties.TableName`, a sibling `{Ref: Tbl}`) reported NO_CHANGE and
 * deployed clean on `main`; with the bag present it reported a spurious UPDATE
 * and then hard-failed at the provisioning refusal. Fail-closed, so never an
 * exposure — but a regression for existing users, and divergent from standalone
 * `cdkd diff`, which is bagless and still reports NO_CHANGE.
 *
 * So the bag is now supplied by the CALLER and only where a reader exists. This
 * file asserts BOTH directions, because either alone is satisfied by the wrong
 * answer: the diff resolution must serve the MASK, and a provisioning
 * resolution must still REFUSE. The observable in each case is chosen so the
 * broken behaviour is not merely absent but positively excluded — the diff case
 * pins the value served rather than "no failure happened", since a diff that
 * resolved nothing at all would satisfy that.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

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

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';

const TABLE_TYPE = 'AWS::S3Tables::Table';
/**
 * Pipe-free and UUID-tailed: the #614-routed shape whose `Ref` is recovered
 * from the `TableName` state key. Its shape is what makes the two outcomes
 * distinguishable — no assertion here can mistake it for a table name.
 */
const TABLE_ARN =
  'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/6f1f5a90-2847-4b1a-9d6f-eeee';

const STACK = 'resolver-context-bag-scope-stack';

function makeState(): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: STACK,
    region: 'us-east-1',
    resources: {
      Tbl: {
        physicalId: TABLE_ARN,
        resourceType: TABLE_TYPE,
        // The pre-existing issue #2274 record: the KEY survives, its value is
        // the mask.
        properties: { TableName: SECRET_MASK },
        attributes: {},
        dependencies: [],
        provisionedBy: 'cc-api',
      },
      Ok: {
        physicalId: 'ok-physical-id',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

const TEMPLATE: CloudFormationTemplate = {
  Resources: {
    Tbl: { Type: TABLE_TYPE, Properties: { TableName: 'x' } },
    Ok: {
      Type: 'AWS::SSM::Parameter',
      // The sibling that READS the masked record — the leaf both passes
      // resolve, and the whole reason the two contexts must answer differently.
      Properties: { Name: '/app/token', Type: 'String', Value: { Ref: 'Tbl' } },
    },
  },
};

interface Deps {
  calculateDiff: ReturnType<typeof vi.fn>;
  executionLevels?: string[][];
  update?: ReturnType<typeof vi.fn>;
}

function makeEngine(deps: Deps): DeployEngine {
  const provider = {
    create: vi.fn(),
    update: deps.update ?? vi.fn(),
    delete: vi.fn(),
    getAttribute: vi.fn(),
  };
  const engineDeps = [
    {
      getState: vi.fn().mockResolvedValue({ state: makeState(), etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    },
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue(deps.executionLevels ?? []),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    },
    {
      calculateDiff: deps.calculateDiff,
      hasChanges: vi.fn().mockReturnValue((deps.executionLevels ?? []).length > 0),
      filterByType: vi.fn().mockReturnValue([]),
    },
    {
      getProvider: vi.fn(() => provider),
      getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
      getRegisteredTypes: vi.fn().mockReturnValue([TABLE_TYPE, 'AWS::SSM::Parameter']),
      validateResourceTypes: vi.fn().mockReturnValue({ unsupported: [], custom: [] }),
      validateResourceProperties: vi.fn().mockReturnValue([]),
    },
  ];
  return new DeployEngine(
    ...(engineDeps as unknown as [never, never, never, never, never]),
    { dryRun: false },
    'us-east-1'
  );
}

describe('the masked-read bag is scoped to contexts that READ it (#2847)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the DIFF resolution serves the MASK, so an untouched #2274 stack still reports NO_CHANGE', async () => {
    // The diff pass is handed a resolve function bound to its own context, so
    // calling it from the DiffCalculator double observes exactly what the diff
    // sees. That is the discriminating observable: with the bag present the
    // lookup skips the masked leaf and this resolves to `TABLE_ARN`, which is
    // then compared against the `'***'` in state — a change that is not real.
    let diffResolved: unknown;
    const calculateDiff = vi.fn(
      async (
        _state: unknown,
        _template: unknown,
        resolve: (value: unknown) => Promise<unknown>
      ) => {
        diffResolved = await resolve({ Ref: 'Tbl' });
        return [];
      }
    );

    await makeEngine({ calculateDiff }).deploy(STACK, TEMPLATE);

    expect(calculateDiff).toHaveBeenCalled();
    // POSITIVE: the value served is the mask itself, which the persisted bag
    // also holds — so the comparison is `***` against `***`.
    expect(diffResolved).toBe(SECRET_MASK);
    // NEGATIVE, and it is the one that fails under the regression: the raw
    // physical id is what the skip's fall-through emits.
    expect(diffResolved).not.toBe(TABLE_ARN);
  });

  it('a PROVISIONING resolution still REFUSES, so the guard is scoped rather than removed', async () => {
    // The control, and it is not optional: a fix that dropped the bag from
    // every context passes the case above while removing the refusal this PR
    // exists to add. `Ok` is UPDATEd and its `Value` reads the masked record,
    // so the CREATE/UPDATE arm's `refuseRedactedAttributeReads` must fire
    // before the provider is called.
    const update = vi.fn();
    const calculateDiff = vi.fn().mockResolvedValue(
      new Map([
        [
          'Ok',
          {
            logicalId: 'Ok',
            changeType: 'UPDATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: { Name: '/app/token', Type: 'String', Value: { Ref: 'Tbl' } },
            currentProperties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
          },
        ],
      ])
    );

    const failure = await makeEngine({ calculateDiff, executionLevels: [['Ok']], update })
      .deploy(STACK, TEMPLATE)
      .then(
        () => undefined,
        (error: unknown) => error as Error & { cause?: Error }
      );

    expect(failure).toBeInstanceOf(Error);
    // Read off the CAUSE — the engine wraps every per-resource failure, so
    // asserting the wrapper alone would pass for any failure at all.
    expect(String(failure?.cause?.message)).toContain('Ref Tbl (state key TableName)');
    // And nothing was sent: the refusal precedes the provider call, which is
    // the property that keeps the literal mask off the live resource.
    expect(update).not.toHaveBeenCalled();
  });
});
