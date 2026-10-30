import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// #5123 / #5570: `Replicas[].DisassociationProtectionEnabled` reaches DynamoDB
// only as a solo per-replica UpdateTable, which the provider does not make yet.
// A declared value is refused on the template path instead of being dropped
// while the deploy reports success; a state replay or a drift revert warns and
// goes on without it.

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  };
});

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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'my-table';
const BASE = {
  TableName: TABLE,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
};
const REFUSED = /DisassociationProtectionEnabled cannot be sent by cdkd yet/;
/** What every AWS call answers: a run that gets this far was not refused. */
const PAST_THE_REFUSAL = 'reached AWS';

/** Two replicas; `eu` is the cross-region replica's DisassociationProtectionEnabled. */
function bag(local: unknown, eu: unknown): Record<string, unknown> {
  const entry = (Region: string, value: unknown) =>
    value === undefined ? { Region } : { Region, DisassociationProtectionEnabled: value };
  return { ...BASE, Replicas: [entry('us-east-1', local), entry('eu-west-1', eu)] };
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockRejectedValue(new Error(PAST_THE_REFUSAL));
  warn.mockReset();
});

describe('GlobalTable Replicas[].DisassociationProtectionEnabled (#5570)', () => {
  const provider = new DynamoDBGlobalTableProvider();

  // Said only for a declared `true`, and as the SDK's documentation, not a cdkd measurement.
  const DEFAULT_NOTE =
    'The AWS SDK documents disassociation protection as enabled by default, so removing a declared true likely loses nothing; cdkd has not verified this.';

  it.each([
    ['the local replica', bag(false, undefined), 'Replicas[0]', false],
    ['a cross-region replica', bag(undefined, true), 'Replicas[1]', true],
    ['a replica, as a CFn string', bag(undefined, 'true'), 'Replicas[1]', true],
  ])('a template-path create declaring it on %s is refused before any call', async (_w, props, path, note) => {
    const err = (await provider.create('Gt', TYPE, props).then(
      () => new Error('not refused'),
      (e: unknown) => e
    )) as Error;
    expect(err.message).toMatch(REFUSED);
    expect(err.message).toContain(`${path}.DisassociationProtectionEnabled`);
    expect(err.message.includes(DEFAULT_NOTE)).toBe(note);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a template-path update refuses an added or changed value before any call', async () => {
    for (const [next, prev] of [
      [bag(undefined, false), bag(undefined, undefined)],
      [bag(true, undefined), bag(false, undefined)],
    ] as const) {
      await expect(provider.update('Gt', TABLE, TYPE, next, prev)).rejects.toThrow(REFUSED);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an unchanged or removed value is not refused on update', async () => {
    const reordered = (props: Record<string, unknown>) => ({
      ...props,
      Replicas: [...(props['Replicas'] as unknown[])].reverse(),
    });
    for (const [next, prev] of [
      [bag(undefined, false), bag(undefined, false)],
      [bag(undefined, undefined), bag(undefined, true)],
      // Matched by Region, not position: the recorded list in another order.
      [bag(undefined, false), reordered(bag(undefined, false))],
      [bag(true, false), reordered(bag(true, false))],
    ] as const) {
      await expect(provider.update('Gt', TABLE, TYPE, next, prev)).rejects.toThrow(
        PAST_THE_REFUSAL
      );
    }
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(REFUSED));
  });

  it('a state replay and a drift revert warn and go on without it', async () => {
    await expect(
      provider.create('Gt', TYPE, bag(undefined, true), { replayingState: true })
    ).rejects.toThrow(PAST_THE_REFUSAL);
    await expect(
      provider.update('Gt', TABLE, TYPE, bag(undefined, true), bag(undefined, undefined), {
        replayingState: true,
      })
    ).rejects.toThrow(PAST_THE_REFUSAL);
    await expect(
      provider.update('Gt', TABLE, TYPE, bag(undefined, true), bag(undefined, undefined), {
        desiredFromAwsReadback: true,
      })
    ).rejects.toThrow(PAST_THE_REFUSAL);
    const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => REFUSED.test(m));
    expect(warned).toHaveLength(3);
    for (const command of mockSend.mock.calls.map((c) => c[0] as { input: object })) {
      expect(JSON.stringify(command.input)).not.toContain('DisassociationProtectionEnabled');
    }
  });
});
