/**
 * go-to-k/cdkd#7191: `cdkd scrub` positions and masks a `NoEcho` value in a
 * rollback-orphan or superseded record too. A record an older (pre-v11)
 * binary wrote holds the plaintext at its `properties` position and no
 * `noEchoLeaves`; the positions come from the record's own field, from
 * today's template while it declares the logical id as the record's type, or
 * from the live record of that id and type. A record none of them positions
 * is reported, never called clean. Through `scrubStack` and the REAL resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState, ResourceState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

vi.mock('../../../../src/utils/logger.js', () => {
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

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: vi.fn() },
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const STACK = 'Stk7191';
const TYPE = 'AWS::Test::Db7191';
/** Under the needle floor: no value scan can find it. */
const SHORT = 'q7';
/** Long enough for a needle; a copy of it sits elsewhere in the record. */
const LONG = 'pw-7191-long-value';

function stackInfo(withParameter = true): { stackName: string; template: CloudFormationTemplate } {
  return {
    stackName: STACK,
    template: {
      ...(withParameter && {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: SHORT } },
      }),
      Resources: {
        Db: {
          Type: TYPE,
          Properties: { Password: withParameter ? { Ref: 'Pw' } : 'plain', Name: 'public' },
        },
      },
    } as unknown as CloudFormationTemplate,
  };
}

/** What a v11+ deploy wrote for the live record. */
function liveRecord(): ResourceState {
  return {
    physicalId: 'db-live',
    resourceType: TYPE,
    properties: { Password: '***', Name: 'public' },
    noEchoLeaves: [['Password']],
  };
}

/** What a pre-v11 binary wrote: the plaintext at the position, no `noEchoLeaves`. */
function preV11(value: string, overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'db-old',
    resourceType: TYPE,
    properties: { Password: value, Name: 'public', Note: `note-${value}` },
    ...overrides,
  };
}

function stateWith(extra: Partial<StackState>): StackState {
  return {
    version: 18 as never,
    region: 'us-east-1',
    stackName: STACK,
    resources: { Db: liveRecord() },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

describe('cdkd scrub - NoEcho plaintext in an orphan or superseded record (go-to-k/cdkd#7191)', () => {
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  const lockManager = {
    acquireLockWithRetry: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    };
  });

  async function scrub(
    state: StackState,
    info = stackInfo()
  ): Promise<{ saved: StackState | undefined; unverifiable: number }> {
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    const result = (await scrubStack(
      info as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    )) as { unverifiableNoEchoRecords?: number };
    const call = stateBackend['saveState']!.mock.calls.at(-1);
    return {
      saved: call ? (call[2] as StackState) : undefined,
      unverifiable: result.unverifiableNoEchoRecords ?? 0,
    };
  }

  it('masks a pre-v11 orphan of a logical id today’s template declares, its copy too', async () => {
    const { saved, unverifiable } = await scrub(
      stateWith({ orphans: [{ logicalId: 'Db', orphanedAt: 1, state: preV11(LONG) }] })
    );
    const orphan = saved!.orphans![0]!.state;
    expect(orphan.properties).toEqual({ Password: '***', Name: 'public', Note: '***' });
    expect(orphan.noEchoLeaves).toEqual([['Password']]);
    expect(unverifiable).toBe(0);
  });

  it('masks a coordinate an Fn::If positions, but takes no needle from it', async () => {
    // One branch the NoEcho parameter, the other a public literal: an old
    // record's verdict is unknown, so the position is masked, but its value
    // may be the literal, whose copies elsewhere in the record stay.
    const literal = 'public-literal-7191';
    const info = stackInfo();
    info.template.Conditions = { UseSecret: { 'Fn::Equals': ['a', 'a'] } };
    info.template.Resources!['Db']!.Properties!['Password'] = {
      'Fn::If': ['UseSecret', { Ref: 'Pw' }, literal],
    };
    const { saved } = await scrub(
      stateWith({ orphans: [{ logicalId: 'Db', orphanedAt: 1, state: preV11(literal) }] }),
      info
    );
    const orphan = saved!.orphans![0]!.state;
    expect(orphan.properties).toEqual({
      Password: '***',
      Name: 'public',
      Note: `note-${literal}`,
    });
    expect(orphan.noEchoLeaves).toEqual([['Password']]);
  });

  it('masks a pre-v11 superseded record holding a value under the needle floor', async () => {
    const { saved } = await scrub(
      stateWith({ supersededResources: [{ logicalId: 'Db', supersededAt: 1, state: preV11(SHORT) }] })
    );
    const superseded = saved!.supersededResources![0]!.state;
    expect(superseded.properties['Password']).toBe('***');
    expect(superseded.properties['Name']).toBe('public');
    expect(superseded.noEchoLeaves).toEqual([['Password']]);
  });

  it('positions a record whose logical id left the template by its own noEchoLeaves', async () => {
    const { saved, unverifiable } = await scrub(
      stateWith({
        orphans: [
          {
            logicalId: 'Gone',
            orphanedAt: 1,
            state: preV11(SHORT, { noEchoLeaves: [['Password']] }),
          },
        ],
      })
    );
    expect(saved!.orphans![0]!.state.properties['Password']).toBe('***');
    expect(unverifiable).toBe(0);
  });

  it('positions a superseded record whose id left the template by the live record of that id', async () => {
    const { saved, unverifiable } = await scrub(
      stateWith({
        resources: { Db: liveRecord(), Gone: { ...liveRecord(), physicalId: 'gone-live' } },
        supersededResources: [{ logicalId: 'Gone', supersededAt: 1, state: preV11(SHORT) }],
      })
    );
    const superseded = saved!.supersededResources![0]!.state;
    expect(superseded.properties['Password']).toBe('***');
    expect(superseded.properties['Name']).toBe('public');
    expect(unverifiable).toBe(0);
  });

  it('reports a pre-v11 orphan no evidence positions, and leaves it unguessed', async () => {
    const state = stateWith({
      orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: preV11(SHORT) }],
    });
    const { saved, unverifiable } = await scrub(state);
    expect(unverifiable).toBe(1);
    expect(saved?.orphans?.[0]?.state.properties ?? state.orphans![0]!.state.properties).toEqual(
      preV11(SHORT).properties
    );
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('orphan record Gone');
    expect(warned).not.toContain(SHORT + "'");
  });

  it('reports a record of the same logical id under another type', async () => {
    const { unverifiable } = await scrub(
      stateWith({
        orphans: [
          { logicalId: 'Db', orphanedAt: 1, state: preV11(SHORT, { resourceType: 'AWS::Test::Other' }) },
        ],
      })
    );
    expect(unverifiable).toBe(1);
  });

  it('reports nothing for such a record in a stack with no NoEcho evidence at all', async () => {
    const { unverifiable } = await scrub(
      {
        ...stateWith({ orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: preV11(SHORT) }] }),
        resources: { Db: { ...liveRecord(), properties: { Password: 'plain', Name: 'public' }, noEchoLeaves: undefined } },
      },
      stackInfo(false)
    );
    expect(unverifiable).toBe(0);
  });

  it('positions by today\'s template when no live record names the positions', async () => {
    const { saved } = await scrub(
      stateWith({
        resources: {},
        supersededResources: [{ logicalId: 'Db', supersededAt: 1, state: preV11(SHORT) }],
      })
    );
    const superseded = saved!.supersededResources![0]!.state;
    expect(superseded.properties['Password']).toBe('***');
    expect(superseded.noEchoLeaves).toEqual([['Password']]);
  });

  it('keeps the attribute names the stored-record finish declares beside the plan\'s', async () => {
    const info = {
      stackName: STACK,
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: SHORT } },
        Resources: {
          Cr: { Type: 'Custom::Thing7191', Properties: { ServiceToken: 'arn', Pw: { Ref: 'Pw' } } },
        },
      } as unknown as CloudFormationTemplate,
    };
    const orphan: ResourceState = {
      physicalId: 'cr-old',
      resourceType: 'Custom::Thing7191',
      properties: { ServiceToken: 'arn', Pw: SHORT },
      noEchoLeaves: [['Pw']],
      // `Pw` echoes the positioned property (the plan's); `Out` equals the
      // input under a key no template reads (the finish's, #7188).
      attributes: { Pw: SHORT, Out: SHORT, Count: '3' },
    };
    const { saved } = await scrub(
      stateWith({ resources: {}, orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: orphan }] }),
      info
    );
    const state = saved!.orphans![0]!.state;
    expect(state.attributes).toEqual({ Pw: '***', Out: '***', Count: '3' });
    expect(state.noEchoAttributeNames).toEqual(['Out', 'Pw']);
  });

  it('reports nothing for such a record holding no string leaf', async () => {
    const { unverifiable } = await scrub(
      stateWith({
        orphans: [
          {
            logicalId: 'Gone',
            orphanedAt: 1,
            state: { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: { VisibilityTimeout: 30 } },
          },
        ],
      })
    );
    expect(unverifiable).toBe(0);
  });

  it('repairs a short echo in a pre-v11 record positioned only by the template', async () => {
    const info = {
      stackName: STACK,
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: SHORT } },
        Resources: {
          Cr: { Type: 'Custom::Thing7191', Properties: { ServiceToken: 'arn', Pw: { Ref: 'Pw' } } },
        },
      } as unknown as CloudFormationTemplate,
    };
    const orphan: ResourceState = {
      physicalId: 'cr-old',
      resourceType: 'Custom::Thing7191',
      properties: { ServiceToken: 'arn', Pw: SHORT },
      observedProperties: { ServiceToken: 'arn', Pw: SHORT, Echo: SHORT },
      attributes: { Pw: SHORT, Out: SHORT, Count: '3' },
    };
    const { saved } = await scrub(
      stateWith({ resources: {}, orphans: [{ logicalId: 'Cr', orphanedAt: 1, state: orphan }] }),
      info
    );
    const state = saved!.orphans![0]!.state;
    expect(state.properties['Pw']).toBe('***');
    expect(state.attributes).toEqual({ Pw: '***', Out: '***', Count: '3' });
    expect(state.noEchoAttributeNames).toEqual(['Out', 'Pw']);
    expect(state.observedProperties?.['Echo']).toBe('***');
  });

  it('a second scrub over the repaired state changes nothing', async () => {
    const { saved } = await scrub(
      stateWith({
        orphans: [{ logicalId: 'Db', orphanedAt: 1, state: preV11(LONG) }],
        supersededResources: [{ logicalId: 'Db', supersededAt: 1, state: preV11(SHORT) }],
      })
    );
    stateBackend['saveState']!.mockClear();
    const again = await scrub(saved!);
    expect(again.saved).toBeUndefined();
  });
});
