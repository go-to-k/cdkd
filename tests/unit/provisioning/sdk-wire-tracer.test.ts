import { describe, it, expect } from 'vite-plus/test';
import * as sqs from '@aws-sdk/client-sqs';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { probe, traceLanding, wrapClientModule, type Bag } from './sdk-wire-harness.js';

/**
 * The wrong-member tracer's own discrimination (go-to-k/cdkd#3723): it is what
 * stands in for `gen-nested-key-coverage.ts`'s write pass, and no wire case
 * goes red on it while the providers are right, so these cases are the only
 * evidence that it reports a value sent in the wrong member at all.
 */

const line = (command: string, input: Record<string, unknown>): string =>
  JSON.stringify([command, input]);

describe('traceLanding', () => {
  const bag: Bag = { Primary: { Prefix: 'a' }, Backup: { Prefix: 'b' }, Name: 'n' };
  const alt: Bag = { Primary: { Prefix: 'a-alt' }, Backup: { Prefix: 'b' }, Name: 'n' };
  const path = ['Primary', 'Prefix'];

  it('accepts the leaf in its own member under its own parent', () => {
    const from = [line('PutCommand', { Primary: { Prefix: 'a' }, Backup: { Prefix: 'b' } })];
    const to = [line('PutCommand', { Primary: { Prefix: 'a-alt' }, Backup: { Prefix: 'b' } })];
    expect(traceLanding(bag, alt, path, from, to).wrong).toBeUndefined();
  });

  it('reports a same-named member under another parent', () => {
    const from = [line('PutCommand', { Primary: { Prefix: 'b' }, Backup: { Prefix: 'a' } })];
    const to = [line('PutCommand', { Primary: { Prefix: 'b' }, Backup: { Prefix: 'a-alt' } })];
    expect(traceLanding(bag, alt, path, from, to).wrong).toBe('PutCommand.Backup.Prefix');
  });

  it('reports a sibling member under the right parent', () => {
    const from = [line('PutCommand', { Primary: { Suffix: 'a' } })];
    const to = [line('PutCommand', { Primary: { Suffix: 'a-alt' } })];
    expect(traceLanding(bag, alt, path, from, to).wrong).toBe('PutCommand.Primary.Suffix');
  });

  it('reports an extra parent between the leaf and its own', () => {
    const from = [line('PutCommand', { Primary: { Backup: { Prefix: 'a' } } })];
    const to = [line('PutCommand', { Primary: { Backup: { Prefix: 'a-alt' } } })];
    expect(traceLanding(bag, alt, path, from, to).wrong).toBe('PutCommand.Primary.Backup.Prefix');
  });

  it('accepts a rename only where the table names it, and records it', () => {
    const from = [line('PutCommand', { Primary: { KeyPrefix: 'a' } })];
    const to = [line('PutCommand', { Primary: { KeyPrefix: 'a-alt' } })];
    expect(traceLanding(bag, alt, path, from, to).wrong).toBe('PutCommand.Primary.KeyPrefix');
    const renamed = traceLanding(bag, alt, path, from, to, {
      members: { 'Primary.Prefix': ['KeyPrefix'] },
    });
    expect(renamed.wrong).toBeUndefined();
    expect([...renamed.used]).toEqual(['Primary.Prefix->KeyPrefix']);
  });

  it('names a spread parent by its command, and refuses another command', () => {
    const renames = { containers: { Primary: ['PutPrimaryCommand'] } };
    const at = (command: string) =>
      traceLanding(bag, alt, path, [line(command, { Prefix: 'a' })], [line(command, { Prefix: 'a-alt' })], renames);
    expect(at('PutPrimaryCommand').wrong).toBeUndefined();
    expect(at('PutBackupCommand').wrong).toBe('PutBackupCommand.Prefix');
  });

  it('tells apart two calls of one command only through roots', () => {
    // The value goes out on the BACKUP's call: the same command, member and
    // value shape as the primary's, so only the root can tell.
    const call = (arn: string, prefix: string) => line('PutCommand', { Arn: arn, Prefix: prefix });
    const from = [call('primary', 'b'), call('backup', 'a')];
    const to = [call('primary', 'b'), call('backup', 'a-alt')];
    const containers = { Primary: ['PutCommand:primary'], Backup: ['PutCommand:backup'] };
    const roots = { PutCommand: (input: Record<string, unknown>) => String(input['Arn']) };
    expect(traceLanding(bag, alt, path, from, to, { containers }, roots).wrong).toBe(
      'PutCommand:backup.Prefix'
    );
    const right = [call('primary', 'a'), call('backup', 'b')];
    const rightAlt = [call('primary', 'a-alt'), call('backup', 'b')];
    expect(traceLanding(bag, alt, path, right, rightAlt, { containers }, roots).wrong).toBeUndefined();
  });

  it('requires a keyed Value to land as the entry its key names', () => {
    const tags: Bag = { Tags: [{ Key: 'k1', Value: 'v1' }, { Key: 'k2', Value: 'v2' }] };
    const tagsAlt: Bag = { Tags: [{ Key: 'k1', Value: 'v1-alt' }, { Key: 'k2', Value: 'v2' }] };
    const send = (k1: string, k2: string) => [line('TagCommand', { Tags: { k1, k2 } })];
    const p = ['Tags', 0, 'Value'];
    expect(traceLanding(tags, tagsAlt, p, send('v1', 'v2'), send('v1-alt', 'v2')).wrong).toBeUndefined();
    expect(traceLanding(tags, tagsAlt, p, send('v2', 'v1'), send('v2', 'v1-alt')).wrong).toBe(
      'TagCommand.Tags.k2'
    );
  });
});

describe('probe, end to end through a real SDK client', () => {
  const { SQSClient } = wrapClientModule(sqs, 'SQSClient');

  /** A provider sending DelaySeconds and VisibilityTimeout, optionally swapped. */
  const provider = (swapped: boolean): ResourceProvider =>
    ({
      async create(_l: string, _t: string, p: Record<string, unknown>) {
        const [delay, visibility] = swapped
          ? [p['VisibilityTimeout'], p['DelaySeconds']]
          : [p['DelaySeconds'], p['VisibilityTimeout']];
        await new SQSClient({}).send(
          new sqs.CreateQueueCommand({
            QueueName: String(p['QueueName']),
            Attributes: { DelaySeconds: String(delay), VisibilityTimeout: String(visibility) },
          })
        );
        return { physicalId: 'q', attributes: {} };
      },
      async update() {
        return { physicalId: 'q', wasReplaced: false };
      },
      async delete() {},
    }) as unknown as ResourceProvider;

  const bag: Bag = { QueueName: 'q', DelaySeconds: 1, VisibilityTimeout: 2 };
  const run = (swapped: boolean) =>
    probe({
      resourceType: 'AWS::SQS::Queue',
      provider: () => provider(swapped),
      physicalId: 'q',
      // Everything create-only: the stub's update sends nothing.
      createOnly: new Set(['QueueName', 'DelaySeconds', 'VisibilityTimeout']),
      bag,
    });

  it('traces nothing when each value lands in its own member', async () => {
    expect((await run(false)).wrongMembers).toEqual({});
  });

  it('reports both values of a swap, which the wire comparison alone cannot see', async () => {
    const result = await run(true);
    // The removal and vary probes all see the wire change: nothing is silent.
    expect(result.silent).toEqual([]);
    expect(result.wrongMembers).toEqual({
      'create-vary:DelaySeconds': 'CreateQueueCommand.Attributes.VisibilityTimeout',
      'create-vary:VisibilityTimeout': 'CreateQueueCommand.Attributes.DelaySeconds',
    });
  });
});
