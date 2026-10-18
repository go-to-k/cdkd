/**
 * Issue #1160 (EventBus slice): a Description / KmsKeyIdentifier / LogConfig /
 * DeadLetterConfig REMOVED from the template is cleared, as CloudFormation
 * does. `UpdateEventBus` keeps any field it is not given, so before the fix the
 * old value stayed live. The clear values are the ones measured to clear each
 * field on the API, and the LogConfig one is the readback CloudFormation
 * leaves (`OFF` / `NONE`).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateEventBusCommand } from '@aws-sdk/client-eventbridge';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import {
  prepareRemovalForUpdate,
  withoutInjectedRemovals,
} from '../../../src/provisioning/update-removal.js';

const TYPE = 'AWS::Events::EventBus';
const NAME = 'my-bus';
const KEY = 'arn:aws:kms:us-east-1:111122223333:key/abc';
const DLQ = 'arn:aws:sqs:us-east-1:111122223333:dlq';

const FULL = {
  Name: NAME,
  Description: 'old description',
  KmsKeyIdentifier: KEY,
  LogConfig: { Level: 'INFO', IncludeDetail: 'FULL' },
  DeadLetterConfig: { Arn: DLQ },
};

function without(key: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...FULL };
  delete out[key];
  return out;
}

function updateInputs(): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof UpdateEventBusCommand)
    .map((c) => (c[0] as UpdateEventBusCommand).input as Record<string, unknown>);
}

describe('EventBridgeBusProvider removal (issue #1160)', () => {
  let provider: EventBridgeBusProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    provider = new EventBridgeBusProvider();
  });

  const CLEARS: Array<[string, unknown]> = [
    ['Description', ''],
    ['KmsKeyIdentifier', ''],
    ['LogConfig', { Level: 'OFF', IncludeDetail: 'NONE' }],
    ['DeadLetterConfig', { Arn: '' }],
  ];

  describe.each(CLEARS)('removed %s', (key, clear) => {
    it('is cleared on a direct call (previous bag decides)', async () => {
      await provider.update('Bus', NAME, TYPE, without(key), { ...FULL });

      const inputs = updateInputs();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]![key]).toEqual(clear);
    });

    it('is cleared through the deploy caller (prepareRemovalForUpdate)', async () => {
      const desired = without(key);
      const prep = prepareRemovalForUpdate(provider, TYPE, desired, { ...FULL });

      const result = await provider.update('Bus', NAME, TYPE, prep.properties, { ...FULL }, {
        ...prep.context,
      });

      expect(prep.context.removedProperties).toEqual(new Set([key]));
      expect(prep.unhandled).toEqual([]);
      const inputs = updateInputs();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]![key]).toEqual(clear);
      // State keeps the template as-is: the clear value is never recorded.
      expect(withoutInjectedRemovals(result, prep.injected).effectiveProperties).toBeUndefined();
      expect(desired[key]).toBeUndefined();
    });

    it('keeps every other field at its declared value', async () => {
      await provider.update('Bus', NAME, TYPE, without(key), { ...FULL });

      const input = updateInputs()[0]!;
      for (const [other] of CLEARS) {
        if (other === key) continue;
        expect(input[other]).toEqual(FULL[other as keyof typeof FULL]);
      }
    });
  });

  it('clears all four in ONE UpdateEventBus call when all are removed', async () => {
    await provider.update('Bus', NAME, TYPE, { Name: NAME }, { ...FULL });

    expect(updateInputs()).toEqual([
      {
        Name: NAME,
        Description: '',
        KmsKeyIdentifier: '',
        LogConfig: { Level: 'OFF', IncludeDetail: 'NONE' },
        DeadLetterConfig: { Arn: '' },
      },
    ]);
  });

  it('sends nothing for a property that was never declared', async () => {
    await provider.update('Bus', NAME, TYPE, { Name: NAME }, { Name: NAME });

    expect(updateInputs()).toEqual([]);
  });

  it('does not clear a DeadLetterConfig whose previous value set no DLQ', async () => {
    // A previous `{ Arn: '' }` is the readback placeholder: there is no DLQ to
    // clear, and the call goes out only for the Description change.
    await provider.update(
      'Bus',
      NAME,
      TYPE,
      { Name: NAME, Description: 'new' },
      { Name: NAME, Description: 'old', DeadLetterConfig: { Arn: '' } }
    );

    expect(updateInputs()).toEqual([{ Name: NAME, Description: 'new' }]);
  });

  it('writes no clear on drift --revert (empty removedProperties, readback baseline)', async () => {
    // The revert bag is built from the readback, so the drifted fields are
    // present; a key absent from it is never a template removal.
    const readback = { ...FULL };
    const desired = { Name: NAME, Description: 'old description' };

    await provider.update('Bus', NAME, TYPE, desired, readback, {
      removedProperties: new Set(),
      desiredFromAwsReadback: true,
    });

    const inputs = updateInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({ Name: NAME, Description: 'old description' });
  });
});
