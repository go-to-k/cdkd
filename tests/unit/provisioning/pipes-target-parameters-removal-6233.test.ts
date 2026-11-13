/**
 * go-to-k/cdkd#6233: `UpdatePipe` keeps a member it is not sent, so a removed
 * `TargetParameters` / `EnrichmentParameters` `InputTemplate` is sent as `''`
 * (measured to clear it; `{}` kept it), whether the whole block or only the
 * member left the template. Every other member a block drops is reported in
 * one warning, since what AWS does with it is unmeasured.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, mockWarn } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWarn: vi.fn() }));
vi.mock('@aws-sdk/client-pipes', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-pipes')>('@aws-sdk/client-pipes');
  return {
    ...actual,
    PipesClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { PipesPipeProvider } from '../../../src/provisioning/providers/pipes-provider.js';
import {
  parameterMembersLeftInPlace,
  toUpdateParameterBlock,
} from '../../../src/provisioning/providers/pipes/shared.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const TYPE = 'AWS::Pipes::Pipe';
const BASE = { Name: 'p', Source: 'arn:src', Target: 'arn:tgt', RoleArn: 'arn:role' };
const TEMPLATE = '{"wrapped": <$.body>}';

function serve(): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'DescribePipeCommand':
        return {
          Name: 'p',
          Arn: 'arn:aws:pipes:us-east-1:123456789012:pipe/p',
          Source: BASE.Source,
          Target: BASE.Target,
          RoleArn: BASE.RoleArn,
          DesiredState: 'RUNNING',
          CurrentState: 'RUNNING',
          LastModifiedTime: new Date(2_000),
          Tags: {},
        };
      case 'UpdatePipeCommand':
        return { LastModifiedTime: new Date(1_000) };
      default:
        return {};
    }
  });
}

const updateInput = () => {
  const calls = mockSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c.constructor.name === 'UpdatePipeCommand');
  expect(calls).toHaveLength(1);
  return calls[0].input as Record<string, unknown>;
};

function provider(): PipesPipeProvider {
  let clock = 0;
  return new PipesPipeProvider({
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  });
}

describe('Pipes InputTemplate removal (go-to-k/cdkd#6233)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve();
  });

  it('sends InputTemplate "" when the whole TargetParameters block is removed', async () => {
    await provider().update('P', 'p', TYPE, { ...BASE }, {
      ...BASE,
      TargetParameters: { InputTemplate: TEMPLATE },
    });
    expect(updateInput()['TargetParameters']).toEqual({ InputTemplate: '' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('clears only InputTemplate and keeps a sibling member, with no warning (the silent case)', async () => {
    const sqs = { MessageGroupId: 'g' };
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, TargetParameters: { SqsQueueParameters: sqs } },
      { ...BASE, TargetParameters: { InputTemplate: TEMPLATE, SqsQueueParameters: sqs } }
    );
    expect(updateInput()['TargetParameters']).toEqual({ SqsQueueParameters: sqs, InputTemplate: '' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('clears a removed EnrichmentParameters InputTemplate the same way', async () => {
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, Enrichment: 'arn:fn', Description: 'changed' },
      { ...BASE, Enrichment: 'arn:fn', EnrichmentParameters: { InputTemplate: TEMPLATE } }
    );
    expect(updateInput()['EnrichmentParameters']).toEqual({ InputTemplate: '' });
  });

  it('sends a declared InputTemplate as declared, and nothing when neither side declares the block', async () => {
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, TargetParameters: { InputTemplate: 'new' }, Description: 'd' },
      { ...BASE, TargetParameters: { InputTemplate: TEMPLATE } }
    );
    const input = updateInput();
    expect(input['TargetParameters']).toEqual({ InputTemplate: 'new' });
    expect(input).not.toHaveProperty('EnrichmentParameters');
  });

  it('warns about every other removed member, naming the block, and still clears InputTemplate', async () => {
    await provider().update('P', 'p', TYPE, { ...BASE }, {
      ...BASE,
      TargetParameters: { InputTemplate: TEMPLATE, SqsQueueParameters: { MessageGroupId: 'g' } },
      EnrichmentParameters: { HttpParameters: { HeaderParameters: { a: 'b' } } },
    });
    expect(updateInput()['TargetParameters']).toEqual({ InputTemplate: '' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const line = String(mockWarn.mock.calls[0][0]);
    expect(line).toContain('EnrichmentParameters.HttpParameters');
    expect(line).toContain('TargetParameters.SqsQueueParameters');
    expect(line).toContain('removed from the template');
    expect(line).not.toContain('InputTemplate');
  });

  it('words the warning for a rollback revert', async () => {
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE },
      { ...BASE, TargetParameters: { SqsQueueParameters: { MessageGroupId: 'g' } } },
      { replayingState: true }
    );
    expect(String(mockWarn.mock.calls[0][0])).toContain('absent from the state being restored');
  });

  it('leaves the update alone when the recorded block never declared InputTemplate (drift --revert bag)', async () => {
    // drift --revert hands a readback-built bag with no write-only
    // TargetParameters on EITHER side: nothing to clear, nothing to report.
    await provider().update('P', 'p', TYPE, { ...BASE, Description: 'x' }, { ...BASE });
    expect(updateInput()).not.toHaveProperty('TargetParameters');
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('an unsettled TargetParameters (its recorded value replaced by a read that omits it)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve();
  });

  it('still sends UpdatePipe and clears InputTemplate when the template removed the whole block', async () => {
    const marks: string[] = [];
    await provider().update('P', 'p', TYPE, { ...BASE }, { ...BASE }, {
      unsettledProperties: new Set(['TargetParameters']),
      markUnsettled: (key: string) => marks.push(key),
    });
    expect(updateInput()['TargetParameters']).toEqual({ InputTemplate: '' });
    expect(marks).toContain('TargetParameters');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('sends a declared InputTemplate as declared, and clears it beside a kept sibling', async () => {
    const unsettled = { unsettledProperties: new Set(['TargetParameters']) };
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, TargetParameters: { InputTemplate: 'keep' } },
      { ...BASE },
      unsettled
    );
    expect(updateInput()['TargetParameters']).toEqual({ InputTemplate: 'keep' });
    vi.clearAllMocks();
    serve();
    const sqs = { MessageGroupId: 'g' };
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, TargetParameters: { SqsQueueParameters: sqs } },
      { ...BASE },
      unsettled
    );
    expect(updateInput()['TargetParameters']).toEqual({ SqsQueueParameters: sqs, InputTemplate: '' });
  });
});

describe('drift --revert of an out-of-band EnrichmentParameters InputTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve();
  });

  it('sends "" to restore the unset state the readback-built bag declares', async () => {
    // read-state.ts emits `EnrichmentParameters: {}` for an unconfigured pipe.
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, EnrichmentParameters: {} },
      { ...BASE, EnrichmentParameters: { InputTemplate: TEMPLATE } },
      { desiredFromAwsReadback: true }
    );
    expect(updateInput()['EnrichmentParameters']).toEqual({ InputTemplate: '' });
  });
});

describe('toUpdateParameterBlock / parameterMembersLeftInPlace', () => {
  const id = (v: unknown) => v as Record<string, unknown> | undefined;

  it('passes a malformed desired block through unchanged and reports nothing for it', () => {
    expect(toUpdateParameterBlock('junk', { InputTemplate: 't' }, id)).toBe('junk');
    expect(parameterMembersLeftInPlace('TargetParameters', 'junk', { SqsQueueParameters: {} })).toEqual(
      []
    );
  });

  it('reads a malformed recorded block as declaring nothing', () => {
    expect(toUpdateParameterBlock(undefined, 'junk', id)).toBeUndefined();
    expect(parameterMembersLeftInPlace('TargetParameters', undefined, 'junk')).toEqual([]);
  });
});

describe('the engine no longer reports the two blocks itself', () => {
  it('lists EnrichmentParameters / TargetParameters as handled by update()', () => {
    const prep = prepareRemovalForUpdate(new PipesPipeProvider(), TYPE, { ...BASE }, {
      ...BASE,
      TargetParameters: { InputTemplate: TEMPLATE },
      EnrichmentParameters: { InputTemplate: TEMPLATE },
    });
    expect(prep.unhandled).toEqual([]);
  });
});
