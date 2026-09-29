import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3948 (sibling site): the Firehose Tags diff read each side as
// `Array.isArray(x) ? x : []`, so a present-but-malformed desired `Tags` (a
// rollback replays update() with a recorded bag as the DESIRED side) read as
// EMPTY and untagged every key the record held. A malformed side is now refused
// before any call; absent still reads as the empty list.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-firehose', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-firehose')>(
    '@aws-sdk/client-firehose'
  );
  return {
    ...actual,
    FirehoseClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  DescribeDeliveryStreamCommand,
  TagDeliveryStreamCommand,
  UntagDeliveryStreamCommand,
} from '@aws-sdk/client-firehose';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const NEEDLE = 'issue3948-firehose-needle';
const VALID = [{ Key: 'env', Value: 'dev' }];
const SECRET_REF = '{{resolve:secretsmanager:issue3948/tags:SecretString:v::}}';

const MALFORMED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an object', { Key: NEEDLE }],
  ['an entry with no Key', [{ Value: NEEDLE }]],
  ['an entry with an empty Key', [{ Key: '', Value: NEEDLE }]],
  ['a string entry', [NEEDLE]],
  ['a false', false],
];

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to be refused');
}

describe('FirehoseProvider.update — malformed Tags are refused before any call (#3948)', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: {
            DeliveryStreamARN: 'arn:aws:firehose:us-east-1:111:deliverystream/my-stream',
            VersionId: '1',
            Destinations: [{ DestinationId: 'destinationId-000000000001' }],
          },
        });
      }
      return Promise.resolve({});
    });
  });

  it.each(MALFORMED)('%s on the DESIRED side sends nothing', async (_label, malformed) => {
    const error = await refusal(() =>
      provider.update('L', 'my-stream', TYPE, { Tags: malformed }, { Tags: VALID })
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(error.message).toContain('desired Tags');
    expect(error.message).not.toContain(NEEDLE);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it.each(MALFORMED)('%s on the RECORDED side sends nothing', async (_label, malformed) => {
    const error = await refusal(() =>
      provider.update('L', 'my-stream', TYPE, { Tags: VALID }, { Tags: malformed })
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(error.message).toContain('repair the recorded Tags in state.json');
    expect(error.message).not.toContain(NEEDLE);
  });

  it('a secret-derived recorded Tags gets the [] repair, never "write it into state.json"', async () => {
    const error = await refusal(() =>
      provider.update('L', 'my-stream', TYPE, { Tags: VALID }, { Tags: SECRET_REF })
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(error.message).toContain('set it to [] in state.json');
    expect(error.message).not.toContain('repair the recorded Tags');
    expect(error.message).not.toContain(SECRET_REF);
  });

  it('a masked (***) recorded Tags gets the [] repair too', async () => {
    const error = await refusal(() =>
      provider.update('L', 'my-stream', TYPE, { Tags: VALID }, { Tags: '***' })
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(error.message).toContain('set it to [] in state.json');
  });

  it('a tag Key holding a dynamic reference is refused on both sides', async () => {
    const bad = [{ Key: SECRET_REF, Value: 'v' }];
    await expect(
      provider.update('L', 'my-stream', TYPE, { Tags: bad }, { Tags: VALID })
    ).rejects.toThrow('desired Tags');
    const recorded = await refusal(() =>
      provider.update('L', 'my-stream', TYPE, { Tags: VALID }, { Tags: bad })
    );
    expect(recorded.message).toContain('set it to [] in state.json');
    expect(recorded.message).not.toContain(SECRET_REF);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('an ABSENT (%s) desired Tags still untags what the record holds', async (_l, absent) => {
    await provider.update('L', 'my-stream', TYPE, { Tags: absent }, { Tags: VALID });
    const untags = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UntagDeliveryStreamCommand) as unknown as Array<{
      input: Record<string, unknown>;
    }>;
    expect(untags.map((c) => c.input['TagKeys'])).toEqual([['env']]);
    expect(mockSend.mock.calls.some((c) => c[0] instanceof TagDeliveryStreamCommand)).toBe(false);
  });
});

describe('FirehoseProvider.create — malformed Tags are refused before any call (#3948)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ DeliveryStreamARN: 'arn:aws:firehose:us-east-1:1:deliverystream/s' });
  });

  it.each(MALFORMED)('%s sends nothing', async (_label, malformed) => {
    const error = await refusal(() =>
      new FirehoseProvider().create('L', TYPE, { DeliveryStreamName: 's', Tags: malformed })
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(error.message).toContain('Tags of Firehose delivery stream L');
    expect(error.message).not.toContain(NEEDLE);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });
});
