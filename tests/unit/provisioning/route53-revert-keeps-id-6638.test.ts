import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6638: a drift revert of an AWS::Route53::RecordSet UPSERTs the
// recorded record and keeps its recorded physical id. A pre-#1658 scalar id
// (the record name) used to come back as the composite, which the revert's
// backstop reads as a replacement. A deploy still re-builds the composite.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn(() => ({
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
    child: vi.fn(function (this: unknown) { return this; }),
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

import { ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { revertReplacementOf } from '../../../src/cli/commands/drift/revert-apply.js';

const ZONE = 'Z1234567890';
const TYPE = 'AWS::Route53::RecordSet';
const SCALAR_ID = 'app.example.com.';
const RECORD = {
  HostedZoneId: ZONE,
  Name: 'app.example.com.',
  Type: 'A',
  TTL: '300',
  ResourceRecords: ['192.0.2.1'],
};
const LIVE = { ...RECORD, ResourceRecords: ['192.0.2.99'] };

describe('Route53 RecordSet revert keeps the recorded id (#6638)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it('revert UPSERTs in place and keeps a pre-#1658 scalar id, so the backstop stays quiet', async () => {
    const result = await new Route53Provider().update('Rec', SCALAR_ID, TYPE, RECORD, LIVE, {
      desiredFromAwsReadback: true,
    });
    const changes = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is ChangeResourceRecordSetsCommand => c instanceof ChangeResourceRecordSetsCommand)
      .flatMap((c) => c.input.ChangeBatch?.Changes?.map((x) => x.Action) ?? []);
    expect(changes).toEqual(['UPSERT']);
    expect(result).toMatchObject({ physicalId: SCALAR_ID, wasReplaced: false });
    expect(revertReplacementOf(SCALAR_ID, result, 'AWS::Route53::RecordSet')).toBeUndefined();
  });

  it('deploy still records the composite id', async () => {
    const result = await new Route53Provider().update('Rec', SCALAR_ID, TYPE, RECORD, LIVE);
    expect(result.physicalId).toBe(`${ZONE}|app.example.com.|A`);
    expect(result.wasReplaced).toBe(false);
  });
});
