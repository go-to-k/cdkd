/**
 * go-to-k/cdkd#3642: every line the orphan-adoption pre-pass prints or throws
 * renders its STATE-CHOSEN fields (`logicalId`, `state.resourceType`,
 * `state.physicalId`) and its PROVIDER-returned text (`found.physicalId`, a
 * caught error's message) through the display-safe helpers.
 *
 * `state.json` is a hand-editable S3 object, so each of those fields can carry a
 * newline (a forged second log line), an ESC (a terminal escape sequence) or a
 * bidi override (Trojan-Source reordering). Every fixture below plants all three
 * in every field the arm under test prints, and every assertion checks two
 * things: no raw control / bidi character reaches the text, and the printable
 * interior survives, so the id stays findable in the log.
 *
 * The expected renderings are LITERALS, not recomputed through the helpers: a
 * case that re-derives its expectation from the function it guards cannot see
 * that function being swapped out. They also pin the per-field choice — the
 * logical id is quoted (`displayIdent`, the boundary the `<id> (<type>)` shape
 * needs), the physical id and the type are not (`displaySafe`, since a physical
 * id is neither ASCII- nor length-bounded).
 *
 * `cdkd diff` consumes the same `refusals`, and needs no case of its own here:
 * it receives the strings this module already built.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const quiet = vi.hoisted(() => {
  const q = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => q,
  };
  return q;
});

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  // PARTIAL, for the reason `orphan-adoption-wiring.test.ts` gives: the engine
  // reaches for several exports of this module.
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  return { ...actual, logger: quiet, getLogger: () => quiet };
});

// The engine asks the REAL name table whether a type is one cdkd names, and the
// hostile TYPE is none it knows — it would stop at the type gate and never reach
// the `Adopting ...` line. Answering for that one string only lets the hostile
// type travel the whole path; every real type still gets the real answer.
vi.mock('../../../src/provisioning/resource-name.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/resource-name.js')>();
  return {
    ...actual,
    explicitNamePropertyFor: (type: string) =>
      type === 'AWS::IAM::Role\n\x1b]0;pwn\x07\u202e' ? 'RoleName' : actual.explicitNamePropertyFor(type),
  };
});

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  makeSiblingClaimReader,
  planOrphanAdoption,
} from '../../../src/deployment/orphan-adoption.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState, StackOrphanRecord, StackState } from '../../../src/types/state.js';

// Newline + ESC + a bidi override in each field.
const ID = 'Kept\n\x1b[2KRole\u202e';
const TYPE = 'AWS::IAM::Role\n\x1b]0;pwn\x07\u202e';
const PHYS = 'MyStack-KeptRole\r\n\x1b[1Aforged\u2066';
const FOUND_PHYS = 'Other\n\x1b[31mRole\u202d';
const ERROR_TEXT = 'Rate\n\x1b[2Kexceeded\u202e';

// What each renders as. Quoted for the id only: `displayIdent` shows where a
// sanitized id ENDS, which an id planting its own `(AWS::...)` would otherwise
// hide.
const SHOWN_ID = '"Kept  [2KRole"';
const SHOWN_TYPE = 'AWS::IAM::Role  ]0;pwn';
const SHOWN_PHYS = 'MyStack-KeptRole   [1Aforged';
const SHOWN_FOUND_PHYS = 'Other  [31mRole';
const SHOWN_ERROR = 'Rate  [2Kexceeded';

/** Every character `displaySafe` strips — C0, DEL, C1, U+2028/9, bidi. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function expectSafe(text: string | undefined, ...shown: string[]): void {
  expect(text).toBeDefined();
  expect(UNSAFE.test(text as string)).toBe(false);
  for (const part of shown) expect(text).toContain(part);
}

function hostileRecord(): StackOrphanRecord {
  const state: ResourceState = {
    physicalId: PHYS,
    resourceType: TYPE,
    properties: {},
    deletionPolicy: 'Retain',
  };
  return { logicalId: ID, orphanedAt: 1, state };
}

/** A template declaring the hostile id with the hostile type, and no name. */
const declaring = {
  Resources: { [ID]: { Type: TYPE, Properties: {} } },
} as unknown as CloudFormationTemplate;

function plan(params: {
  provider?: Partial<ResourceProvider>;
  getProviderThrows?: boolean;
  template?: CloudFormationTemplate;
  nameProperties?: readonly string[];
  managed?: string[];
  claims?: string[];
}) {
  const debug = vi.fn();
  const promise = planOrphanAdoption({
    records: [hostileRecord()],
    managedLogicalIds: new Set(params.managed ?? []),
    template: params.template ?? declaring,
    stackName: 'MyStack',
    region: 'us-east-1',
    getProvider: () => {
      if (params.getProviderThrows) throw new Error(ERROR_TEXT);
      return (params.provider ?? {
        import: vi.fn(async () => ({ physicalId: PHYS })),
      }) as ResourceProvider;
    },
    // Stubbed, unlike `orphan-adoption.test.ts`: the hostile TYPE is no type
    // the real table knows, and the gate is not what these cases are about —
    // a non-empty answer is what lets the later arms be reached at all.
    nameProperties: () => params.nameProperties ?? ['RoleName'],
    readSiblingClaims: async () => new Set(params.claims ?? []),
    logger: { debug },
  });
  return { promise, debug };
}

describe('planOrphanAdoption renders state-chosen fields display-safe (#3642)', () => {
  it('already-managed debug line', async () => {
    const { promise, debug } = plan({ managed: [ID] });
    await promise;
    expect(debug).toHaveBeenCalledTimes(1);
    expectSafe(debug.mock.calls[0]?.[0] as string, SHOWN_ID);
  });

  it('unroutable-type notice, including the thrown message', async () => {
    const { notices } = await plan({ getProviderThrows: true }).promise;
    expect(notices).toHaveLength(1);
    expectSafe(notices[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS, SHOWN_ERROR);
  });

  it('no-import notice', async () => {
    const { notices } = await plan({ provider: {} }).promise;
    expect(notices).toHaveLength(1);
    expectSafe(notices[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS);
  });

  it('import-threw notice, including the provider error text', async () => {
    const { notices } = await plan({
      provider: {
        import: vi.fn(async () => {
          throw new Error(ERROR_TEXT);
        }),
      },
    }).promise;
    expect(notices).toHaveLength(1);
    expectSafe(notices[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS, SHOWN_ERROR);
  });

  it('provider-answered-for-another-id notice, including the returned physical id', async () => {
    const { notices } = await plan({
      provider: { import: vi.fn(async () => ({ physicalId: FOUND_PHYS })) },
    }).promise;
    expect(notices).toHaveLength(1);
    expectSafe(notices[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS, SHOWN_FOUND_PHYS);
  });

  it('no-longer-exists debug line', async () => {
    const { promise, debug } = plan({ provider: { import: vi.fn(async () => null) } });
    await promise;
    expect(debug).toHaveBeenCalledTimes(1);
    expectSafe(debug.mock.calls[0]?.[0] as string, SHOWN_ID, SHOWN_PHYS);
  });

  it('refused-type notice', async () => {
    const { notices } = await plan({ nameProperties: [] }).promise;
    expect(notices).toHaveLength(1);
    expectSafe(notices[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS);
  });

  it('template-does-not-declare notice', async () => {
    const { notices } = await plan({
      template: { Resources: {} } as unknown as CloudFormationTemplate,
    }).promise;
    expect(notices).toHaveLength(1);
    expectSafe(notices[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS);
  });

  it('claimed-by-another-stack refusal', async () => {
    const { refusals } = await plan({ claims: [PHYS] }).promise;
    expect(refusals).toHaveLength(1);
    expectSafe(refusals[0], SHOWN_ID, SHOWN_PHYS);
  });

  it('keeps a long, comma-joined physical id WHOLE — no ASCII rewrite, no cap', async () => {
    // `SnsTopicPolicyProvider` records a comma-joined ARN list, and a Custom
    // Resource's id is provider-defined. `displayIdent`'s 255 cap would cut the
    // very id the notice exists to name.
    const arns = Array.from(
      { length: 12 },
      (_, i) => `arn:aws:sns:us-east-1:111122223333:topic-${i}-${'x'.repeat(40)}`
    ).join(',');
    const record = hostileRecord();
    record.state.physicalId = arns;
    const { notices } = await planOrphanAdoption({
      records: [record],
      managedLogicalIds: new Set(),
      template: declaring,
      stackName: 'MyStack',
      region: 'us-east-1',
      getProvider: () => ({}) as ResourceProvider,
      nameProperties: () => ['RoleName'],
      readSiblingClaims: async () => new Set(),
      logger: { debug: vi.fn() },
    });
    expect(arns.length).toBeGreaterThan(255);
    expect(notices[0]).toContain(` ${arns}, `);
  });
});

describe('makeSiblingClaimReader debug lines render display-safe (#3642)', () => {
  it('the failed-listing line', async () => {
    const debug = vi.fn();
    await makeSiblingClaimReader({
      stateBackend: {
        listStacks: async () => {
          throw new Error(ERROR_TEXT);
        },
        getState: async () => null,
      },
      selfStackName: 'MyStack',
      selfRegion: 'us-east-1',
      logger: { debug },
    })();
    expect(debug).toHaveBeenCalledTimes(1);
    expectSafe(debug.mock.calls[0]?.[0] as string, SHOWN_ERROR);
  });

  it('the unreadable-sibling line, naming the stack', async () => {
    const debug = vi.fn();
    await makeSiblingClaimReader({
      stateBackend: {
        listStacks: async () => [{ stackName: 'Sib\n\x1b[2Kling\u202e', region: 'us-east-1' }],
        getState: async () => {
          throw new Error(ERROR_TEXT);
        },
      },
      selfStackName: 'MyStack',
      selfRegion: 'us-east-1',
      logger: { debug },
    })();
    expect(debug).toHaveBeenCalledTimes(1);
    expectSafe(debug.mock.calls[0]?.[0] as string, '"Sib  [2Kling"', SHOWN_ERROR);
  });
});

describe('DeployEngine adoption path renders display-safe (#3642)', () => {
  type Backend = { getState: ReturnType<typeof vi.fn>; listStacks: ReturnType<typeof vi.fn> };
  let backend: Backend;
  let importFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    quiet.info.mockClear();
    backend = { getState: vi.fn(), listStacks: vi.fn().mockResolvedValue([]) };
    importFn = vi.fn(async () => ({ physicalId: PHYS }));
  });

  /** The private pre-pass, as `executeDeployment` calls it. */
  function adopt(state: StackState, template = declaring): Promise<unknown> {
    const provider = { import: importFn };
    const engine = new DeployEngine(
      backend as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      } as unknown as never,
      {},
      'us-east-1'
    );
    return (
      engine as unknown as {
        adoptRollbackOrphans: (s: StackState, t: CloudFormationTemplate) => Promise<unknown>;
      }
    ).adoptRollbackOrphans(state, template);
  }

  function stackState(): StackState {
    return {
      version: 9,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      orphans: [hostileRecord()],
      lastModified: 1,
    } as StackState;
  }

  function infoLines(): string[] {
    return quiet.info.mock.calls.map((c) => String(c[0]));
  }

  it('the `Adopting ...` log line', async () => {
    const state = stackState();
    await adopt(state);

    expect(state.resources[ID]).toBeDefined();
    const adopting = infoLines().filter((l) => l.startsWith('Adopting '));
    expect(adopting).toHaveLength(1);
    expectSafe(adopting[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS);
  });

  it('the logged notices', async () => {
    // A template that no longer declares the id: the record is kept, with a
    // notice the engine then logs.
    await adopt(stackState(), { Resources: {} } as unknown as CloudFormationTemplate);
    const notices = infoLines().filter((l) => l.includes('earlier rollback'));
    expect(notices).toHaveLength(1);
    expectSafe(notices[0], SHOWN_ID, SHOWN_TYPE, SHOWN_PHYS);
  });

  it('the thrown refusal', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({
      state: { resources: { X: { physicalId: PHYS } } },
    });
    const error = await adopt(stackState())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The joined list's own `\n  ` separator is cdkd's, not the record's: strip
    // the one line break the join adds, then require nothing else remain.
    const lines = message.split('\n  ');
    expect(lines).toHaveLength(2);
    expectSafe(lines[1], SHOWN_ID, SHOWN_PHYS);
  });
});
