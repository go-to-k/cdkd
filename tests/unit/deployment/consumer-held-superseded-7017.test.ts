/**
 * go-to-k/cdkd#7017: a superseded entry held for a run's consumers
 * (go-to-k/cdkd#7012) is kept by a later deploy while a stack importing the
 * producer's outputs still names it in its records.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  carriedNotHeldByConsumers,
  markHeldForConsumers,
} from '../../../src/deployment/deploy-engine/consumer-held-superseded.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { StackState, SupersededResourceRecord } from '../../../src/types/state.js';

const Q1_URL = 'https://sqs.us-east-1.amazonaws.com/111122223333/app-q1';
const Q1_ARN = 'arn:aws:sqs:us-east-1:111122223333:app-q1';

const entry = (held: boolean, physicalId = Q1_URL): SupersededResourceRecord => ({
  logicalId: 'Queue',
  supersededAt: 1,
  state: {
    physicalId,
    resourceType: 'AWS::SQS::Queue',
    properties: { QueueName: 'app-q1' },
    attributes: { Arn: Q1_ARN, QueueName: 'app-q1', DelaySeconds: '12345678' },
  } as never,
  ...(held && { heldForConsumers: true as const }),
});

function consumerState(properties: Record<string, unknown>, reads: 'imports' | 'outputReads' | 'none' = 'imports'): StackState {
  const ref = { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Producer:QueueUrl' };
  return {
    version: 18,
    stackName: 'Consumer',
    region: 'us-east-1',
    resources: {
      Fn: { physicalId: 'fn', resourceType: 'AWS::Lambda::Function', properties, attributes: {} },
    },
    outputs: {},
    ...(reads === 'imports' && { imports: [ref] }),
    ...(reads === 'outputReads' && { outputReads: [{ ...ref, outputName: 'QueueUrl' }] }),
    lastModified: 0,
  } as unknown as StackState;
}

function engineOver(stacks: Record<string, StackState | Error>, listFails = false) {
  const info = vi.fn();
  const listStacks = vi.fn(async () => {
    if (listFails) throw new Error('AccessDenied: s3:ListBucket');
    return [{ stackName: 'Producer', region: 'us-east-1' }, ...Object.keys(stacks).map((stackName) => ({ stackName, region: 'us-east-1' }))];
  });
  const getState = vi.fn(async (name: string) => {
    if (name === 'Producer') throw new Error('the producer reads itself');
    const held = stacks[name];
    if (held instanceof Error) throw held;
    return held === undefined ? null : { state: held, etag: 'e' };
  });
  const engine = {
    stackRegion: 'us-east-1',
    stateBackend: { listStacks, getState },
    logger: { info, debug: vi.fn(), warn: vi.fn() },
  } as unknown as DeployEngine;
  return { engine, info, listStacks, getState };
}

describe('consumer-held superseded entries (go-to-k/cdkd#7017)', () => {
  it('an unmarked carried entry is passed through without reading any state', async () => {
    const { engine, listStacks } = engineOver({});
    const carried = [entry(false)];
    expect(await carriedNotHeldByConsumers(engine, 'Producer', carried)).toEqual(carried);
    expect(listStacks).not.toHaveBeenCalled();
  });

  it('keeps a marked entry a consumer importing the producer still names, with one line', async () => {
    const { engine, info, getState } = engineOver({
      Consumer: consumerState({ Environment: { Variables: { QURL: Q1_URL } } }),
    });
    const held = entry(true);
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [held])).toEqual([]);
    expect(getState).not.toHaveBeenCalledWith('Producer', expect.anything(), expect.anything());
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toContain(
      'Consumer (importing this stack\'s outputs) still uses it'
    );
  });

  it('matches the old ARN inside a longer value, as an IAM grant spells it', async () => {
    const { engine } = engineOver({
      Consumer: consumerState({ PolicyDocument: { Statement: [{ Resource: `${Q1_ARN}/*` }] } }),
    });
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [entry(true)])).toEqual([]);
  });

  it('a consumer reading the outputs with Fn::GetStackOutput holds it too', async () => {
    const { engine } = engineOver({
      Consumer: consumerState({ QURL: Q1_URL }, 'outputReads'),
    });
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [entry(true)])).toEqual([]);
  });

  it('deletes a marked entry once the consumer moved off it', async () => {
    const { engine, info } = engineOver({
      Consumer: consumerState({ QURL: Q1_URL.replace('q1', 'q2') }),
    });
    const held = entry(true);
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [held])).toEqual([held]);
    expect(info).not.toHaveBeenCalled();
  });

  it('a name only sharing a prefix (q10) does not hold it', async () => {
    const { engine } = engineOver({
      Consumer: consumerState({ Arn: `${Q1_ARN}0`, Url: `${Q1_URL}0` }),
    });
    const held = entry(true);
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [held])).toEqual([held]);
  });

  it('a stack naming it without importing from the producer does not hold it', async () => {
    const { engine } = engineOver({ Other: consumerState({ QURL: Q1_URL }, 'none') });
    const held = entry(true);
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [held])).toEqual([held]);
  });

  it('a short or numeric attribute is no needle', async () => {
    const { engine } = engineOver({ Consumer: consumerState({ Delay: '12345678', Name: 'fifo' }) });
    // Neither a numeric attribute nor one under 8 characters is a needle.
    const held = entry(true, 'https://sqs.us-east-1.amazonaws.com/111122223333/other');
    held.state.attributes = { DelaySeconds: '12345678', Kind: 'fifo' };
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [held])).toEqual([held]);
  });

  it('keeps every marked entry when a record cannot be read, or the bucket cannot be listed', async () => {
    const unreadable = engineOver({ Consumer: new Error('AccessDenied: s3:GetObject') });
    expect(await carriedNotHeldByConsumers(unreadable.engine, 'Producer', [entry(true)])).toEqual(
      []
    );
    expect(String(unreadable.info.mock.calls[0]![0])).toContain('its state could not be read');
    const unlisted = engineOver({}, true);
    expect(await carriedNotHeldByConsumers(unlisted.engine, 'Producer', [entry(true)])).toEqual([]);
  });

  it('passes the unmarked entries beside a kept marked one', async () => {
    const { engine } = engineOver({ Consumer: consumerState({ QURL: Q1_URL }) });
    const plain = entry(false, 'https://sqs.us-east-1.amazonaws.com/111122223333/old');
    expect(await carriedNotHeldByConsumers(engine, 'Producer', [entry(true), plain])).toEqual([
      plain,
    ]);
  });

  it('markHeldForConsumers marks in place and reports a change once', () => {
    const first = entry(false);
    const host = { supersededResources: [first] };
    expect(markHeldForConsumers(host)).toBe(true);
    expect(host.supersededResources[0]).toBe(first);
    expect(first.heldForConsumers).toBe(true);
    expect(markHeldForConsumers(host)).toBe(false);
  });
});
