/**
 * go-to-k/cdkd#7161: `cdkd scrub` drops a custom resource attribute whose KEY
 * holds a secret this run resolved, on the live record, an orphan and a
 * superseded one. A deploy that leaves the custom resource UNCHANGED resolves
 * nothing for it, so a key an older binary persisted (before #7153) is
 * repaired here. Through `scrubStack` and the REAL resolver, which records the
 * `NoEcho` value itself.
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

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: ssmSend },
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const VALUE = 'scrub-7161-noecho-value';
const KEY = `By-${VALUE}`;
const ORPHAN_VALUE = 'scrub-7161-orphan-value';

function stackInfo(getAtt?: string): { stackName: string; template: CloudFormationTemplate } {
  return {
    stackName: 'AttrKeyScrubStack',
    template: {
      Parameters: { Token: { Type: 'String', NoEcho: true, Default: VALUE } },
      Resources: {
        Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn', Pw: { Ref: 'Token' } } },
        ...(getAtt !== undefined && {
          Reader: { Type: 'AWS::SNS::Topic', Properties: { DisplayName: { 'Fn::GetAtt': ['Cr', getAtt] } } },
        }),
      },
    } as unknown as CloudFormationTemplate,
  };
}

/** The record an older binary wrote: masked at its position, the key in the clear. */
function customRecord(): ResourceState {
  return {
    physicalId: 'cr-1',
    resourceType: 'Custom::Thing',
    properties: { ServiceToken: 'arn', Pw: '***' },
    noEchoLeaves: [['Pw']],
    attributes: { [KEY]: 'x', Plain: 'ok' },
  };
}

function stateWith(extra: Partial<StackState> = {}): StackState {
  return {
    version: 18 as never,
    region: 'us-east-1',
    stackName: 'AttrKeyScrubStack',
    resources: { Cr: customRecord() },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

describe('cdkd scrub - a custom resource attribute KEY holding a secret (go-to-k/cdkd#7161)', () => {
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  const lockManager = {
    acquireLockWithRetry: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ssmSend.mockResolvedValue({ Parameter: { Value: ORPHAN_VALUE, Type: 'SecureString', Version: 1 } });
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

  it('drops the key from the live record', async () => {
    const saved = await scrub(stateWith());
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    expect(saved!.resources['Cr']!.attributes).toEqual({ Plain: 'ok' });
  });

  it("drops it from an orphan by the orphan's own needles, and from a superseded record", async () => {
    const orphan: ResourceState = {
      ...customRecord(),
      properties: { ServiceToken: 'arn', Pw: '{{resolve:ssm-secure:/orphan/pw}}' },
      attributes: { [`By-${ORPHAN_VALUE}`]: 'x', Plain: 'ok' },
    };
    const saved = await scrub(
      stateWith({
        orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: orphan }],
        supersededResources: [{ logicalId: 'Cr', supersededAt: 1, state: customRecord() }],
      })
    );
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    expect(JSON.stringify(saved)).not.toContain(ORPHAN_VALUE);
    expect(saved!.orphans![0]!.state.attributes).toEqual({ Plain: 'ok' });
    expect(saved!.supersededResources![0]!.state.attributes).toEqual({ Plain: 'ok' });
  });

  it("an orphan's and a superseded record's key holding ANY secret this run knows is dropped", async () => {
    const superseded: ResourceState = { ...customRecord(), resourceType: 'Custom::Other' };
    const saved = await scrub(
      stateWith({
        orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: customRecord() }],
        supersededResources: [{ logicalId: 'Cr', supersededAt: 1, state: superseded }],
      })
    );
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    expect(saved!.orphans![0]!.state.attributes).toEqual({ Plain: 'ok' });
    expect(saved!.supersededResources![0]!.state.attributes).toEqual({ Plain: 'ok' });
  });

  it('drops a key naming the value an OLDER Default left at the position (the migration needle)', async () => {
    const OLD = 'scrub-7161-older-default';
    const record = customRecord();
    record.properties = { ServiceToken: 'arn', Pw: OLD };
    delete record.noEchoLeaves;
    record.attributes = { [`By-${OLD}`]: 'x', Plain: 'ok' };
    const saved = await scrub(stateWith({ resources: { Cr: record } }));
    expect(JSON.stringify(saved)).not.toContain(OLD);
    expect(saved!.resources['Cr']!.attributes).toEqual({ Plain: 'ok' });
  });

  it("masks an orphan's and a superseded record's off-template echo (go-to-k/cdkd#7158 / #7160)", async () => {
    const echoed: ResourceState = {
      physicalId: 'o-1',
      resourceType: 'AWS::Test::Echo7160',
      properties: { Password: '{{resolve:ssm:/orphan/pw}}' },
      observedProperties: { Password: 'pw-orphan-7160', Extra: 'x-pw-orphan-7160-y' },
    };
    const saved = await scrub(
      stateWith({
        orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: echoed }],
        supersededResources: [{ logicalId: 'Cr', supersededAt: 1, state: echoed }],
      })
    );
    expect(JSON.stringify(saved)).not.toContain('pw-orphan-7160');
    expect(saved!.orphans![0]!.state.observedMaskedLeaves).toEqual([['Extra']]);
    expect(saved!.supersededResources![0]!.state.observedMaskedLeaves).toEqual([['Extra']]);
  });

  it('keeps a key a template Fn::GetAtt spells', async () => {
    const state = stateWith();
    const saved = await scrub(state, stackInfo(KEY));
    // No write at all leaves the stored record, key included.
    expect(Object.keys((saved ?? state).resources['Cr']!.attributes ?? {})).toContain(KEY);
  });
});
