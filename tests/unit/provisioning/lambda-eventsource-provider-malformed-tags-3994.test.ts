import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventSourceMappingCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';

// go-to-k/cdkd#3994: the Lambda event source mapping Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Issue #2080: the create call goes through a dedicated `LambdaClient` (one
// whose SDK retry refuses a 5xx); route it to the same mock.
vi.mock('@aws-sdk/client-lambda', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda')>()),
  LambdaClient: vi.fn().mockImplementation(() => ({
    send: (command: unknown) => mockSend(command),
    config: {},
  })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::Lambda::EventSourceMapping';
const NAME = 'abcdef12-3456-7890-abcd-ef1234567890';
const ARN = `arn:aws:lambda:us-east-1:123456789012:event-source-mapping:${NAME}`;
const BASE = {
  FunctionName: 'my-function',
  EventSourceArn: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
};
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(isMarkedNonRetryable(err)).toBe(true);
  const msg = (err as Error).message;
  expect(msg).not.toContain(TAG_FIXTURE.NEEDLE);
  expect(msg).not.toContain('issue3994/tags');
  return err as Error;
}

describe('LambdaEventSourceMappingProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof UpdateEventSourceMappingCommand ||
      cmd instanceof CreateEventSourceMappingCommand
        ? { UUID: NAME, EventSourceMappingArn: ARN }
        : {}
    );
    provider = new LambdaEventSourceMappingProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('Esm', NAME, TYPE, { ...BASE, Tags: tags }, { ...BASE, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} Esm`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('Esm', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} Esm`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('Esm', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      const tag = commands().filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tag.map((c) => c.input)).toEqual([{ Resource: ARN, Tags: { keep: 'same', add: '' } }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} Esm is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Tag / Untag calls', async () => {
    await provider.update('Esm', NAME, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
    ) as Array<TagResourceCommand | UntagResourceCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['UntagResourceCommand', { Resource: ARN, TagKeys: ['drop'] }],
      ['TagResourceCommand', { Resource: ARN, Tags: { add: '' } }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'Esm',
      NAME,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const untag = commands().filter(
      (c) => c instanceof UntagResourceCommand
    ) as UntagResourceCommand[];
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'Esm',
      NAME,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} Esm holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('creates with the desired tags', async () => {
    await provider.create('Esm', TYPE, { ...BASE, Tags: DESIRED });
    const create = commands().find(
      (c) => c instanceof CreateEventSourceMappingCommand
    ) as CreateEventSourceMappingCommand;
    expect(create.input.Tags).toEqual({ keep: 'same', add: '' });
  });

  it('creates with no Tags member when the template has none', async () => {
    await provider.create('Esm', TYPE, { ...BASE });
    const create = commands().find(
      (c) => c instanceof CreateEventSourceMappingCommand
    ) as CreateEventSourceMappingCommand;
    expect(create.input.Tags).toBeUndefined();
  });
});
