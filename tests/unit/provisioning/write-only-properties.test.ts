import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudFormationSend = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerDebug = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: mockLoggerDebug,
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
    }),
  }),
}));

import {
  getTopLevelWriteOnlyProperties,
  tryGetTopLevelWriteOnlyProperties,
  clearWriteOnlyPropertiesCache,
} from '../../../src/provisioning/write-only-properties.js';
import {
  LEAK_BODY,
  LEAK_TOKEN,
  expectLeakTokenOnlyAtDebug,
  expectV8QuotesLeakToken,
  loggedText,
} from '../_json-parse-leak.js';
import {
  describeTypeRetryDelays,
  resetAwsEmulatorRegistryMissReportForTests,
} from '../../../src/provisioning/describe-type.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';

function throttlingError(): Error {
  const error = new Error('Rate exceeded');
  error.name = 'Throttling';
  return error;
}

const ECS_SCHEMA = JSON.stringify({
  writeOnlyProperties: ['/properties/VolumeConfigurations', '/properties/ForceNewDeployment'],
});

describe('getTopLevelWriteOnlyProperties + throttle retry (issue #1236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  afterEach(() => {
    delete describeTypeRetryDelays.sleep;
  });

  it('rides out a transient DescribeType throttle and resolves the real set — no fallback warning', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValueOnce({ Schema: ECS_SCHEMA });

    const result = await getTopLevelWriteOnlyProperties('AWS::ECS::Service');

    expect([...result].sort()).toEqual(['ForceNewDeployment', 'VolumeConfigurations']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
    // The whole point of the retry: the graceful fallback (which drops
    // write-only properties from the patch) must NOT fire on a transient
    // throttle.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('falls back to the empty set with a warning when the throttle persists past the budget', async () => {
    mockCloudFormationSend.mockRejectedValue(throttlingError());

    const result = await getTopLevelWriteOnlyProperties('AWS::ECS::Service');

    expect(result.size).toBe(0);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    // 1 initial attempt + 4 throttle retries, then the resolver's fallback.
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(5);
  });
  it.each([
    'AWS::CDK::Metadata',
    'AWS::CloudFormation::CustomResource',
    'Custom::MyThing',
  ])('skips DescribeType entirely for the schema-less type %s', async (type) => {
    // Shares `hasNoRegistrySchema` with the sibling create-only resolver, so
    // the two cannot disagree about which types have no registry entry.
    const result = await getTopLevelWriteOnlyProperties(type);

    expect(result.size).toBe(0);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

describe('tryGetTopLevelWriteOnlyProperties (go-to-k/cdkd#3803)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  afterEach(() => {
    delete describeTypeRetryDelays.sleep;
  });

  it('answers undefined (unknown) on a failed lookup, warns nothing, and caches nothing', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    mockCloudFormationSend.mockRejectedValueOnce(denied).mockResolvedValueOnce({ Schema: ECS_SCHEMA });

    expect(await tryGetTopLevelWriteOnlyProperties('AWS::ECS::Service')).toBeUndefined();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    const retried = await tryGetTopLevelWriteOnlyProperties('AWS::ECS::Service');
    expect([...(retried ?? [])].sort()).toEqual(['ForceNewDeployment', 'VolumeConfigurations']);
  });

  it('reuses a settled success from either variant without a second DescribeType call', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: ECS_SCHEMA });

    await tryGetTopLevelWriteOnlyProperties('AWS::ECS::Service');
    await tryGetTopLevelWriteOnlyProperties('AWS::ECS::Service');
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);

    await getTopLevelWriteOnlyProperties('AWS::SNS::Topic');
    await tryGetTopLevelWriteOnlyProperties('AWS::SNS::Topic');
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });
});

describe('an unparseable DescribeType schema (issue #5254)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
  });

  it('warns with the size only, never a window of the schema', async () => {
    expectV8QuotesLeakToken();
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: LEAK_BODY });

    await getTopLevelWriteOnlyProperties('AWS::NoSnapshot::Type');

    const warned = loggedText(mockLoggerWarn);
    expect(warned).toContain(
      `the DescribeType schema is not valid JSON: invalid JSON; ${Buffer.byteLength(LEAK_BODY, 'utf8')} byte(s) read`
    );
    expectLeakTokenOnlyAtDebug({
      debug: mockLoggerDebug,
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
    });
  });
});

// go-to-k/cdkd#6249: under --aws-emulator a TypeNotFoundException is the
// emulator's registry lacking the type, not a missing permission.
describe('getTopLevelWriteOnlyProperties under --aws-emulator (#6249)', () => {
  function typeNotFound(): Error {
    const error = new Error("The type 'AWS::Lambda::Url' cannot be found.");
    error.name = 'TypeNotFoundException';
    return error;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    clearWriteOnlyPropertiesCache();
    resetAwsEmulatorRegistryMissReportForTests();
  });
  afterEach(() => {
    setAwsEndpointOverrideSource(undefined);
  });

  it('a registry miss falls back to an empty set with no Grant warning', async () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'https://127.0.0.1:9497' }));
    mockCloudFormationSend.mockRejectedValue(typeNotFound());
    expect([...(await getTopLevelWriteOnlyProperties('AWS::Lambda::Url'))]).toEqual([]);
    expect([...(await getTopLevelWriteOnlyProperties('AWS::SNS::Subscription'))]).toEqual([]);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('against real AWS the same failure still warns with the Grant remedy', async () => {
    mockCloudFormationSend.mockRejectedValue(typeNotFound());
    await getTopLevelWriteOnlyProperties('AWS::Lambda::Url');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerWarn.mock.calls[0]![0])).toContain('Grant cloudformation:DescribeType');
  });
});
