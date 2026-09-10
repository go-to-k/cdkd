/**
 * A stack OUTPUT resolving a `Ref` out of a MASKED state record must publish
 * NOTHING (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847),
 * independent round-2 review — the BLOCKER).
 *
 * `DeployEngine.refuseRedactedAttributeReads` is called at exactly two sites,
 * both per-resource CREATE / UPDATE. `resolveOutputs` builds its OWN resolver
 * context, so the note `noteRefStateMask` records during the Outputs pass was
 * written and never read. That was harmless while a masked recovery key made
 * `refStateLookupFromResource` return `'***'`; once the lookup learned to
 * REFUSE the mask, the fall-through began publishing the raw physical id
 * instead — for a Cloud-Control-routed `AWS::S3Tables::Table`, a UUID-tailed
 * `TableARN` where the table NAME belongs.
 *
 * WHY THAT IS A BLOCKER RATHER THAN A COSMETIC REGRESSION, and what these
 * cases therefore have to pin: the two values are not equally bad downstream.
 * `'***'` is REFUSED by `reresolveCrossStackValue` in the CONSUMING stack
 * (it tests `carriesSecretMask`); an ARN passes, so the consumer resolves its
 * `Fn::ImportValue` to a wrong value and sends it to AWS — both deploys green.
 * So the assertion is not "the mask is gone" but "the ARN is not published
 * either", and every case pairs the two.
 *
 * The fixture is a NO-CHANGE deploy: no resource is created or updated, so the
 * two existing refusal sites cannot fire and the Outputs pass is the only thing
 * under test. A case that passed because a CREATE refused would say nothing
 * about this path.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
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
/** Pipe-free and UUID-tailed: the #614-routed shape whose `Ref` needs the state key. */
const TABLE_ARN =
  'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/6f1f5a90-2847-4b1a-9d6f-dddd';
const TABLE_NAME = 'orders_zz2847';

const stackName = 'outputs-masked-ref-stack';

function makeState(tableName: unknown): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName,
    region: 'us-east-1',
    resources: {
      Tbl: {
        physicalId: TABLE_ARN,
        resourceType: TABLE_TYPE,
        // The bag `cdkd import`'s Cloud Control narrowing writes: the KEY
        // survives, its value is the mask.
        properties: { TableName: tableName },
        observedProperties: { TableName: tableName },
        attributes: {},
        dependencies: [],
        provisionedBy: 'cc-api',
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

const TEMPLATE: CloudFormationTemplate = {
  Resources: { Tbl: { Type: TABLE_TYPE, Properties: { TableName: 'x' } } },
  Outputs: { TableRef: { Value: { Ref: 'Tbl' } } },
};

let saveState: ReturnType<typeof vi.fn>;
let engineDeps: unknown[];

function makeEngine(tableName: unknown, strictGetAtt?: boolean): DeployEngine {
  saveState = vi.fn().mockResolvedValue('etag-2');
  const mockStateBackend = {
    getState: vi.fn().mockResolvedValue({ state: makeState(tableName), etag: 'etag-1' }),
    saveState,
  };
  engineDeps = [
    mockStateBackend,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn().mockResolvedValue(undefined) },
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    },
    {
      // NO CHANGES: the CREATE / UPDATE refusal sites are unreachable, so the
      // Outputs pass is the only thing that can refuse.
      calculateDiff: vi.fn().mockReturnValue([]),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    },
    {
      getProvider: vi.fn(),
      getProviderFor: vi.fn(),
      getRegisteredTypes: vi.fn().mockReturnValue([TABLE_TYPE]),
      validateResourceTypes: vi.fn().mockReturnValue({ unsupported: [], custom: [] }),
      validateResourceProperties: vi.fn().mockReturnValue([]),
    },
  ];
  return new DeployEngine(
    ...(engineDeps as [never, never, never, never, never]),
    { dryRun: false, ...(strictGetAtt !== undefined && { strictGetAtt }) },
    'us-east-1'
  );
}

/** Every `outputs` bag this deploy handed to `saveState`, newest last. */
function savedOutputs(): Record<string, unknown> | undefined {
  const calls = saveState.mock.calls;
  if (calls.length === 0) return undefined;
  const state = calls[calls.length - 1]?.[2] as StackState | undefined;
  return state?.outputs;
}

describe('resolveOutputs refuses an output built from a masked state record (#2847)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes NEITHER the mask NOR the raw physical id', async () => {
    await makeEngine(SECRET_MASK).deploy(stackName, TEMPLATE);

    const outputs = savedOutputs();
    // The key is not published at all — `handleOutputResolutionFailure` leaves
    // it `undefined`, which `JSON.stringify` drops on the way to S3.
    expect(outputs?.['TableRef']).toBeUndefined();
    // THE LOAD-BEARING NEGATIVE. A fall-through publishes the ARN, which the
    // consumer stack's `carriesSecretMask` test does NOT catch — so asserting
    // only "not the mask" would pass on exactly the regression this fences.
    expect(JSON.stringify(outputs ?? {})).not.toContain(TABLE_ARN);
  });

  it('reports the refusal by NAME, at default verbosity', async () => {
    await makeEngine(SECRET_MASK).deploy(stackName, TEMPLATE);

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Routed through the ordinary output-failure handler, so it reads like
    // every other output failure rather than inventing a second shape.
    expect(warned).toContain('Failed to resolve output TableRef');
    // ...and names the read, which is what tells the user WHICH record to fix.
    expect(warned).toContain('Ref Tbl (state key TableName)');
    // The remedy is computed, not described.
    expect(warned).toContain('--resource Tbl=<physicalId>');
  });

  it('is PROMOTED to a deploy error under --strict-getatt', async () => {
    // It inherits `handleOutputResolutionFailure`'s whole contract, and this is
    // the half a warn-only implementation would silently drop.
    await expect(makeEngine(SECRET_MASK, true).deploy(stackName, TEMPLATE)).rejects.toThrow(
      /Failed to resolve output TableRef/
    );
  });

  it('publishes the recovered NAME when the record is not masked (scope control)', async () => {
    // The other direction. Without this, a refusal that fired on every
    // `Ref`-valued output would pass every case above while breaking every
    // stack that exports one.
    await makeEngine(TABLE_NAME).deploy(stackName, TEMPLATE);

    expect(savedOutputs()?.['TableRef']).toBe(TABLE_NAME);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).not.toContain('Failed to resolve output');
  });

  it('refuses an EXPORT NAME built from the same masked Ref', async () => {
    // Pass 2 shares the value pass's `redactedAttributeReads` array by
    // reference (the alias resolution spreads the context), so the guard has
    // to be per-pass rather than a single post-pass test — and an export whose
    // NAME is built from a raw physical id binds consumers to a name the
    // template does not describe.
    // `Export.Name` is typed `string`, but `resolveOutputs` explicitly branches
    // on `typeof ... === 'string'` and RESOLVES the other arm — the type is
    // narrower than the code, and this case exercises the arm the type denies.
    const template = {
      Resources: TEMPLATE.Resources,
      Outputs: {
        TableRef: {
          Value: 'literal-value',
          Export: { Name: { 'Fn::Sub': 'tbl-${Tbl}' } },
        },
      },
    } as unknown as CloudFormationTemplate;

    await makeEngine(SECRET_MASK).deploy(stackName, template);

    const outputs = savedOutputs();
    expect(JSON.stringify(outputs ?? {})).not.toContain(TABLE_ARN);
    // No alias key was published under any spelling.
    expect(Object.keys(outputs ?? {}).some((k) => k.startsWith('tbl-'))).toBe(false);
  });
});
