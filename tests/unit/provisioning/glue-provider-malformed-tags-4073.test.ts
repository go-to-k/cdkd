import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateCrawlerCommand,
  CreateJobCommand,
  CreateTriggerCommand,
  CreateWorkflowCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-glue';

// go-to-k/cdkd#4073 (a #3994 follow-up): every Glue type's CFn `Tags` is a
// key -> value MAP. `cfnTagsToMap` read a non-object as no tags, dropped a
// list entry without a string Key, coerced a missing Value to '' and threw a
// TypeError on a null entry; the Job / Crawler / Trigger diffs then untagged
// every recorded key the short desired map lacked. The Workflow update dropped
// Tags altogether.

const mockSend = vi.fn();
const mockStsSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  GetCallerIdentityCommand: vi.fn(),
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

import {
  GlueCrawlerProvider,
  GlueJobProvider,
  GlueTriggerProvider,
  GlueWorkflowProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

interface GlueCase {
  type: string;
  segment: string;
  make: () => ResourceProvider;
  base: Record<string, unknown>;
  createCommand: new (...args: never[]) => { input: { Tags?: Record<string, string> } };
}

const NAME = 'issue4073-glue';

// Every Glue type that declares `Tags`. `AWS::Glue::Database` / `Table` /
// `Connection` / `SecurityConfiguration` declare none.
const CASES: GlueCase[] = [
  {
    type: 'AWS::Glue::Workflow',
    segment: 'workflow',
    make: () => new GlueWorkflowProvider(),
    base: { Name: NAME },
    createCommand: CreateWorkflowCommand,
  },
  {
    type: 'AWS::Glue::Job',
    segment: 'job',
    make: () => new GlueJobProvider(),
    base: {
      Name: NAME,
      Role: 'arn:aws:iam::123456789012:role/r',
      Command: { Name: 'glueetl', ScriptLocation: 's3://b/k.py' },
    },
    createCommand: CreateJobCommand,
  },
  {
    type: 'AWS::Glue::Crawler',
    segment: 'crawler',
    make: () => new GlueCrawlerProvider(),
    base: {
      Name: NAME,
      Role: 'arn:aws:iam::123456789012:role/r',
      Targets: { S3Targets: [{ Path: 's3://b/p' }] },
    },
    createCommand: CreateCrawlerCommand,
  },
  {
    type: 'AWS::Glue::Trigger',
    segment: 'trigger',
    make: () => new GlueTriggerProvider(),
    base: { Name: NAME, Type: 'ON_DEMAND', Actions: [{ JobName: 'j' }] },
    createCommand: CreateTriggerCommand,
  },
];

const RECORDED = { keep: 'same', drop: 'x' };
const DESIRED = { keep: 'same', add: '' };

/** Map-shape malformed values, on top of the list ones the shared fixtures carry. */
const MAP_MALFORMED: Array<[string, unknown]> = [
  ['a map with an object value', { env: { nested: TAG_FIXTURE.NEEDLE } }],
  ['a map with a null value', { env: null }],
  ['a map with an empty key', { '': TAG_FIXTURE.NEEDLE }],
  ['a number', 7],
  ['a list with a null entry', [null]],
];

function arnOf(c: GlueCase): string {
  return `arn:aws:glue:us-east-1:123456789012:${c.segment}/${NAME}`;
}

function tagCalls(): Array<[string, unknown]> {
  return mockSend.mock.calls
    .map((call) => call[0] as object)
    .filter((cmd) => cmd instanceof TagResourceCommand || cmd instanceof UntagResourceCommand)
    .map((cmd) => [
      cmd.constructor.name,
      (cmd as TagResourceCommand | UntagResourceCommand).input,
    ]);
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

describe.each(CASES)('$type Tags (go-to-k/cdkd#4073)', (c) => {
  let provider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = c.make();
  });

  it.each([...PROVIDER_MALFORMED_DESIRED, ...MAP_MALFORMED])(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('G', NAME, c.type, { ...c.base, Tags: tags }, { ...c.base, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${c.type} G is not a map of tag keys`);
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    }
  );

  it.each([...PROVIDER_MALFORMED_DESIRED, ...MAP_MALFORMED])(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('G', c.type, { ...c.base, Tags: tags }));
      expect(err.message).toContain(`Tags of ${c.type} G is not a map of tag keys`);
      // The create wording, not the update one.
      expect(err.message).not.toContain('desired ');
      expect(err.message).toContain('the resource was not created');
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    }
  );

  it('refuses a desired map whose key is secret-derived', async () => {
    const err = await refusal(() =>
      provider.update(
        'G',
        NAME,
        c.type,
        { ...c.base, Tags: { [TAG_FIXTURE.SECRET_REF]: 'v' } },
        { ...c.base, Tags: RECORDED }
      )
    );
    expect(err.message).toContain('holds a dynamic reference or its mask');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([...PROVIDER_MALFORMED_RECORDED, ...MAP_MALFORMED])(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update(
        'G',
        NAME,
        c.type,
        { ...c.base, Tags: DESIRED },
        { ...c.base, Tags: recorded }
      );
      expect(tagCalls()).toEqual([
        ['TagResourceCommand', { ResourceArn: arnOf(c), TagsToAdd: { keep: 'same', add: '' } }],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${c.type} G is not`));
      expect(warn.mock.calls.map((w) => String(w[0])).join('\n')).not.toContain(
        TAG_FIXTURE.NEEDLE
      );
    }
  );

  it('diffs a valid map pair into exact Tag / Untag calls', async () => {
    await provider.update('G', NAME, c.type, { ...c.base, Tags: DESIRED }, { ...c.base, Tags: RECORDED });
    expect(tagCalls()).toEqual([
      ['TagResourceCommand', { ResourceArn: arnOf(c), TagsToAdd: { add: '' } }],
      ['UntagResourceCommand', { ResourceArn: arnOf(c), TagsToRemove: ['drop'] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('diffs a readCurrentState-shaped list record against a map template', async () => {
    await provider.update(
      'G',
      NAME,
      c.type,
      { ...c.base, Tags: DESIRED },
      {
        ...c.base,
        Tags: [
          { Key: 'keep', Value: 'same' },
          { Key: 'drop', Value: 'x' },
        ],
      }
    );
    expect(tagCalls()).toEqual([
      ['TagResourceCommand', { ResourceArn: arnOf(c), TagsToAdd: { add: '' } }],
      ['UntagResourceCommand', { ResourceArn: arnOf(c), TagsToRemove: ['drop'] }],
    ]);
  });

  it('sends no tag call and resolves no ARN when the tags are unchanged', async () => {
    await provider.update('G', NAME, c.type, { ...c.base, Tags: RECORDED }, { ...c.base, Tags: RECORDED });
    expect(tagCalls()).toEqual([]);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'G',
      NAME,
      c.type,
      { ...c.base, Tags: {} },
      { ...c.base, Tags: { [TAG_FIXTURE.SECRET_REF]: 'v', ...RECORDED } }
    );
    expect(tagCalls()).toEqual([
      ['UntagResourceCommand', { ResourceArn: arnOf(c), TagsToRemove: ['keep', 'drop'] }],
    ]);
    const warned = warn.mock.calls.map((w) => String(w[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${c.type} G holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
  });

  it('untags every recorded key when the template drops Tags', async () => {
    await provider.update('G', NAME, c.type, { ...c.base }, { ...c.base, Tags: RECORDED });
    expect(tagCalls()).toEqual([
      ['UntagResourceCommand', { ResourceArn: arnOf(c), TagsToRemove: ['keep', 'drop'] }],
    ]);
  });

  it('fails the update when a tag call fails', async () => {
    mockSend.mockImplementation((cmd: object) =>
      cmd instanceof TagResourceCommand
        ? Promise.reject(new Error('tagging refused'))
        : Promise.resolve({})
    );
    await expect(
      provider.update('G', NAME, c.type, { ...c.base, Tags: DESIRED }, { ...c.base, Tags: RECORDED })
    ).rejects.toThrow(/Failed to update Glue \w+ G: tagging refused/);
  });

  it('creates with the desired tags, coercing a scalar value', async () => {
    await provider.create('G', c.type, { ...c.base, Tags: { n: 1, b: true, s: 'x' } });
    const create = mockSend.mock.calls
      .map((call) => call[0] as object)
      .find((cmd) => cmd instanceof c.createCommand) as { input: { Tags?: unknown } } | undefined;
    expect(create?.input.Tags).toEqual({ n: '1', b: 'true', s: 'x' });
  });

  it('creates with no Tags key when Tags is absent, null or empty', async () => {
    for (const tags of [undefined, null, {}, []]) {
      await provider.create('G', c.type, { ...c.base, Tags: tags });
    }
    const creates = mockSend.mock.calls
      .map((call) => call[0] as object)
      .filter((cmd) => cmd instanceof c.createCommand) as Array<{ input: { Tags?: unknown } }>;
    expect(creates).toHaveLength(4);
    for (const cmd of creates) expect(cmd.input.Tags).toBeUndefined();
  });
});
