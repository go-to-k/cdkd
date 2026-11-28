/**
 * go-to-k/cdkd#7188: `cdkd scrub` repairs a `NoEcho` value too short for a
 * needle (1-3 characters) that an older binary persisted in plaintext, by the
 * rules a deploy applies since go-to-k/cdkd#7186: a custom resource attribute
 * EQUAL to it under a key no template `Fn::GetAtt` reads is masked and named
 * in `noEchoAttributeNames` (#7183), an off-template readback leaf EQUAL to it
 * is masked (#7181), and an attribute KEY equal to it is dropped. The stored
 * bag holds only the mask at the `NoEcho` position, so the value comes from
 * what this scrub resolves. Through `scrubStack` and the REAL resolver.
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
/** A stack name short enough to be an input no needle covers. */
const STACK = 'Stk';
const SHORT = 'q7z';
/** Long enough for a needle, but the physical id contains it. */
const IN_ID = 'cr7188-physical';
const PHYSICAL_ID = `${IN_ID}-1`;

function stackInfo(getAtt?: string): { stackName: string; template: CloudFormationTemplate } {
  return {
    stackName: STACK,
    template: {
      Parameters: {
        Short: { Type: 'String', NoEcho: true, Default: SHORT },
        InId: { Type: 'String', NoEcho: true, Default: IN_ID },
        Named: { Type: 'String', NoEcho: true, Default: STACK },
      },
      Resources: {
        Cr: {
          Type: 'Custom::Thing',
          Properties: {
            ServiceToken: 'arn',
            Pw: { Ref: 'Short' },
            Id: { Ref: 'InId' },
            Sn: { Ref: 'Named' },
          },
        },
        Echo: { Type: 'AWS::Test::Echo7188', Properties: { Pw: { Ref: 'Short' } } },
        ...(getAtt !== undefined && {
          Reader: {
            Type: 'AWS::SNS::Topic',
            Properties: { DisplayName: { 'Fn::GetAtt': ['Cr', getAtt] } },
          },
        }),
      },
    } as unknown as CloudFormationTemplate,
  };
}

/** The record an older binary wrote: masked at its positions, the echoes in the clear. */
function customRecord(): ResourceState {
  return {
    physicalId: PHYSICAL_ID,
    resourceType: 'Custom::Thing',
    properties: { ServiceToken: 'arn', Pw: '***', Id: '***', Sn: '***' },
    noEchoLeaves: [['Id'], ['Pw'], ['Sn']],
    attributes: {
      Out: SHORT,
      Whole: IN_ID,
      // Over-mask controls: a public value that only CONTAINS the short one,
      // the stack name (public, never an input), and an unrelated value.
      Label: `x${SHORT}y`,
      Named: STACK,
      Count: '3',
    },
  };
}

function echoRecord(): ResourceState {
  return {
    physicalId: 'echo-1',
    resourceType: 'AWS::Test::Echo7188',
    properties: { Pw: '***' },
    noEchoLeaves: [['Pw']],
    observedProperties: { Pw: '***', Extra: SHORT, Note: `x${SHORT}y` },
  };
}

function stateWith(extra: Partial<StackState> = {}): StackState {
  return {
    version: 18 as never,
    region: 'us-east-1',
    stackName: STACK,
    resources: { Cr: customRecord(), Echo: echoRecord() },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

const REPAIRED = {
  Out: '***',
  Whole: '***',
  Label: `x${SHORT}y`,
  Named: STACK,
  Count: '3',
};

describe('cdkd scrub - a short NoEcho echo an older binary persisted (go-to-k/cdkd#7188)', () => {
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

  async function scrub(state: StackState, info = stackInfo()): Promise<StackState | undefined> {
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    await scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger: logger as never,
    });
    const call = stateBackend['saveState']!.mock.calls.at(-1);
    return call ? (call[2] as StackState) : undefined;
  }

  it('masks and declares an unread attribute EQUAL to an input on the live record', async () => {
    const saved = await scrub(stateWith());
    const cr = saved!.resources['Cr']!;
    expect(cr.attributes).toEqual(REPAIRED);
    expect(cr.noEchoAttributeNames).toEqual(['Out', 'Whole']);
  });

  it('a second scrub over the repaired state changes nothing', async () => {
    const once = await scrub(stateWith());
    stateBackend['saveState']!.mockClear();
    const twice = await scrub(once!);
    expect(twice).toBeUndefined();
  });

  it('repairs an orphan and a superseded record of a logical id the scrub resolves', async () => {
    const saved = await scrub(
      stateWith({
        orphans: [{ logicalId: 'Cr', orphanedAt: 1, state: customRecord() }],
        supersededResources: [{ logicalId: 'Cr', supersededAt: 1, state: customRecord() }],
      })
    );
    expect(saved!.orphans![0]!.state.attributes).toEqual(REPAIRED);
    expect(saved!.orphans![0]!.state.noEchoAttributeNames).toEqual(['Out', 'Whole']);
    expect(saved!.supersededResources![0]!.state.attributes).toEqual(REPAIRED);
  });

  it('keeps an attribute a template Fn::GetAtt reads', async () => {
    const saved = await scrub(stateWith(), stackInfo('Out'));
    const cr = saved!.resources['Cr']!;
    expect(cr.attributes!['Out']).toBe(SHORT);
    expect(cr.attributes!['Whole']).toBe('***');
    expect(cr.noEchoAttributeNames).toEqual(['Whole']);
  });

  it('declares nothing on equality where a Fn::GetAtt names the attribute by an expression', async () => {
    const info = stackInfo();
    (info.template.Resources as Record<string, unknown>)['Reader'] = {
      Type: 'AWS::SNS::Topic',
      Properties: { DisplayName: { 'Fn::GetAtt': ['Cr', { Ref: 'AWS::Region' }] } },
    };
    const saved = await scrub(stateWith(), info);
    const cr = (saved ?? stateWith()).resources['Cr']!;
    expect(cr.attributes!['Out']).toBe(SHORT);
    expect(cr.noEchoAttributeNames).toBeUndefined();
  });

  it('keeps an attribute equal to the physical id', async () => {
    const record = { ...customRecord(), physicalId: SHORT, attributes: { Ref: SHORT } };
    const state = stateWith({ resources: { Cr: record } });
    const saved = await scrub(state);
    const cr = (saved ?? state).resources['Cr']!;
    expect(cr.attributes).toEqual({ Ref: SHORT });
  });

  it('declares nothing on a resource that is not a custom resource', async () => {
    const info = stackInfo();
    (info.template.Resources as Record<string, { Type: string }>)['Cr']!.Type = 'AWS::Test::Cr7188';
    const record = { ...customRecord(), resourceType: 'AWS::Test::Cr7188' };
    const state = stateWith({ resources: { Cr: record } });
    const saved = await scrub(state, info);
    const cr = (saved ?? state).resources['Cr']!;
    expect(cr.attributes!['Out']).toBe(SHORT);
    expect(cr.noEchoAttributeNames).toBeUndefined();
  });

  it('masks an off-template readback leaf EQUAL to the short input, not one containing it', async () => {
    const saved = await scrub(stateWith());
    const echo = saved!.resources['Echo']!;
    expect(echo.observedProperties).toEqual({ Pw: '***', Extra: '***', Note: `x${SHORT}y` });
    expect(echo.observedMaskedLeaves).toEqual([['Extra']]);
  });

  it('repairs a stack whose only NoEcho input is too short for a needle', async () => {
    const info = stackInfo();
    const template = info.template as unknown as {
      Parameters: Record<string, unknown>;
      Resources: Record<string, { Properties: Record<string, unknown> }>;
    };
    delete template.Parameters['InId'];
    delete template.Parameters['Named'];
    template.Resources['Cr']!.Properties = { ServiceToken: 'arn', Pw: { Ref: 'Short' } };
    const record = customRecord();
    record.properties = { ServiceToken: 'arn', Pw: '***' };
    record.noEchoLeaves = [['Pw']];
    record.attributes = { Out: SHORT, Count: '3' };
    const saved = await scrub(stateWith({ resources: { Cr: record } }), info);
    expect(saved!.resources['Cr']!.attributes).toEqual({ Out: '***', Count: '3' });
    expect(saved!.resources['Cr']!.noEchoAttributeNames).toEqual(['Out']);
  });

  it('drops an attribute KEY equal to the short input', async () => {
    const record = customRecord();
    record.attributes = { [SHORT]: 'x', Count: '3' };
    const saved = await scrub(stateWith({ resources: { Cr: record } }));
    expect(saved!.resources['Cr']!.attributes).toEqual({ Count: '3' });
  });
});
