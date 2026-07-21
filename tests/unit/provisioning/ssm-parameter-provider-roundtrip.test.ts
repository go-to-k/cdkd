import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PutParameterCommand } from '@aws-sdk/client-ssm';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';

const PARAM_NAME = '/foo/bar';
const RESOURCE_TYPE = 'AWS::SSM::Parameter';

describe('SSMParameterProvider read-update round-trip', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SSMParameterProvider();
  });

  it('truthy-gate fix: empty Description placeholder reaches PutParameter on round-trip', async () => {
    // Mechanical guard against the truthy-gate silent-fail mode:
    // readCurrentState emits `Description: ''` as the always-emit
    // placeholder. If update() truthy-gates on Description, the empty
    // string is silently dropped, the AWS-side description is never
    // cleared, and `cdkd drift --revert` reports `✓ reverted` while the
    // next drift run re-detects the same drift.
    //
    // After the fix (`!== undefined`), the empty string must reach
    // PutParameterCommand.input.Description.
    mockSend.mockResolvedValueOnce({}); // PutParameter response

    const observed = {
      Name: PARAM_NAME,
      Type: 'String',
      Value: 'bar',
      Description: '', // ← placeholder from readCurrentState minimum response
      AllowedPattern: '',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', PARAM_NAME, RESOURCE_TYPE, observed, observed);

    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutParameterCommand);
    expect(putCall).toBeDefined();
    const input = putCall![0].input as {
      Description?: string;
      AllowedPattern?: string;
    };
    expect(input.Description).toBe('');
    expect(input.AllowedPattern).toBe('');
  });

  it('round-trip on no-drift snapshot does not emit truthy-dropped fields', async () => {
    // Symmetric assertion: a populated observedProperties round-trip
    // must reach AWS with every user-controllable field — never silently
    // dropped by a stale truthy gate.
    mockSend.mockResolvedValueOnce({});

    const observed = {
      Name: PARAM_NAME,
      Type: 'String',
      Value: 'hello',
      Description: 'a description',
      AllowedPattern: '^[a-z]+$',
      Tier: 'Standard',
      DataType: 'text',
      Tags: [{ Key: 'team', Value: 'platform' }],
    };

    await provider.update('L', PARAM_NAME, RESOURCE_TYPE, observed, observed);

    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutParameterCommand);
    expect(putCall).toBeDefined();
    const input = putCall![0].input as {
      Name?: string;
      Type?: string;
      Value?: string;
      Description?: string;
      AllowedPattern?: string;
      Tier?: string;
      DataType?: string;
      Overwrite?: boolean;
    };
    expect(input.Name).toBe(PARAM_NAME);
    expect(input.Type).toBe('String');
    expect(input.Value).toBe('hello');
    expect(input.Description).toBe('a description');
    expect(input.AllowedPattern).toBe('^[a-z]+$');
    expect(input.Tier).toBe('Standard');
    expect(input.DataType).toBe('text');
    expect(input.Overwrite).toBe(true);
  });

  it('Class 1: KeyId only valid for SecureString — readCurrentState does not emit it for String parameters', async () => {
    // KeyId is the SSM Parameter Class 1 discriminator field: it is
    // only valid when Type === 'SecureString'. Emitting it as a
    // placeholder on a String / StringList parameter would cause
    // `cdkd drift --revert` to push KeyId back to AWS and AWS rejects
    // ("KeyId is not allowed for parameters of type String").
    //
    // The current readCurrentState (correctly) omits KeyId entirely
    // for non-SecureString parameters. This test pins that behavior so
    // a future "always-emit" refactor can't silently regress it.
    const { GetParameterCommand, DescribeParametersCommand, ListTagsForResourceCommand } =
      await import('@aws-sdk/client-ssm');
    mockSend
      .mockResolvedValueOnce({
        Parameter: { Name: PARAM_NAME, Type: 'String', Value: 'bar' },
      })
      .mockResolvedValueOnce({ Parameters: [{ Name: PARAM_NAME }] })
      .mockResolvedValueOnce({ TagList: [] });

    const observed = await provider.readCurrentState(PARAM_NAME, 'L', RESOURCE_TYPE);

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeParametersCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);

    // KeyId must NOT be in the snapshot for a String parameter.
    expect(observed).toBeDefined();
    expect(Object.keys(observed!)).not.toContain('KeyId');

    // Round-trip: pushing this snapshot back through update() must not
    // include KeyId in the PutParameter call.
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({});
    await provider.update('L', PARAM_NAME, RESOURCE_TYPE, observed!, observed!);
    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutParameterCommand);
    expect(putCall).toBeDefined();
    const input = putCall![0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('KeyId');
  });
});

// Issue #1134: the `aws:cdk:path` tag walk is removed. AWS rejects
// `aws:`-prefixed tag writes, so that tag never exists on a real resource and
// the walk could not match. import() now resolves only from an explicit
// `--resource` / `Properties.Name`; anything else returns null without a
// lookup.
describe('SSMParameterProvider import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drop once-queued responses leaked by earlier tests - clearAllMocks()
    // clears calls but NOT unconsumed mockResolvedValueOnce entries.
    mockSend.mockReset();
  });

  const importInput = () => ({
    logicalId: 'MyParameter',
    resourceType: RESOURCE_TYPE,
    stackName: 'MyStack',
    region: 'us-east-1',
    properties: {},
  });

  it('returns null without any AWS call when no explicit id is given', async () => {
    const provider = new SSMParameterProvider();
    const result = await provider.import(importInput());

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
