import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTrailCommand,
  StartLoggingCommand,
  StopLoggingCommand,
  UpdateTrailCommand,
} from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cloudtrail');
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';

const TRAIL_ARN = 'arn:aws:cloudtrail:us-east-1:0:trail/my-trail';
const TYPE = 'AWS::CloudTrail::Trail';

function inputOf(command: unknown): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof (command as never));
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as Record<string, unknown>;
}

function sent(command: unknown): number {
  return mockSend.mock.calls.filter((c) => c[0] instanceof (command as never)).length;
}

// CloudFormation reads the strings 'true' / 'false' (a String parameter Ref)
// as booleans; the SDK would send them as JSON strings (#6166 review).
describe('CloudTrailProvider: CloudFormation string booleans are sent as booleans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ TrailARN: TRAIL_ARN });
  });

  it('create: every boolean reaches CreateTrail as a boolean, and IsLogging "false" does not start logging', async () => {
    await new CloudTrailProvider().create('Trail', TYPE, {
      TrailName: 'my-trail',
      S3BucketName: 'b',
      IsMultiRegionTrail: 'true',
      IncludeGlobalServiceEvents: 'True',
      EnableLogFileValidation: 'false',
      IsOrganizationTrail: 'false',
      RecursiveLogging: 'false',
      IsLogging: 'false',
    });

    const input = inputOf(CreateTrailCommand);
    expect(input['IsMultiRegionTrail']).toBe(true);
    expect(input['IncludeGlobalServiceEvents']).toBe(true);
    expect(input['EnableLogFileValidation']).toBe(false);
    expect(input['IsOrganizationTrail']).toBe(false);
    expect(input['RecursiveLogging']).toBe(false);
    expect(sent(StartLoggingCommand)).toBe(0);
  });

  it('create: an unreadable value still passes through for AWS to refuse', async () => {
    await new CloudTrailProvider().create('Trail', TYPE, {
      TrailName: 'my-trail',
      S3BucketName: 'b',
      RecursiveLogging: 'yes',
      IsLogging: false,
    });

    expect(inputOf(CreateTrailCommand)['RecursiveLogging']).toBe('yes');
  });

  it('update: booleans reach UpdateTrail as booleans, and a "false" IsLogging stops a logging trail', async () => {
    await new CloudTrailProvider().update(
      'Trail',
      TRAIL_ARN,
      TYPE,
      {
        S3BucketName: 'b',
        IsMultiRegionTrail: 'false',
        EnableLogFileValidation: 'true',
        IsOrganizationTrail: 'false',
        RecursiveLogging: 'false',
        IsLogging: 'false',
      },
      { S3BucketName: 'b', IsMultiRegionTrail: false, IncludeGlobalServiceEvents: true, IsLogging: true }
    );

    const input = inputOf(UpdateTrailCommand);
    expect(input['IsMultiRegionTrail']).toBe(false);
    expect(input['EnableLogFileValidation']).toBe(true);
    expect(input['IsOrganizationTrail']).toBe(false);
    expect(input['RecursiveLogging']).toBe(false);
    // 'false' marks the trail single-region, so the removed
    // IncludeGlobalServiceEvents takes its measured reset.
    expect(input['IncludeGlobalServiceEvents']).toBe(false);
    expect(sent(StopLoggingCommand)).toBe(1);
    expect(sent(StartLoggingCommand)).toBe(0);
  });

  it('update: a recorded "false" IsLogging equals a desired false (no logging call)', async () => {
    await new CloudTrailProvider().update(
      'Trail',
      TRAIL_ARN,
      TYPE,
      { S3BucketName: 'b', IsLogging: false },
      { S3BucketName: 'b', IsLogging: 'false' }
    );

    expect(sent(StopLoggingCommand)).toBe(0);
    expect(sent(StartLoggingCommand)).toBe(0);
  });
});
