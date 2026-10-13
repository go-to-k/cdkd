/**
 * `cachedCreateOnlyPropertyPaths` (state schema v12): the create-only paths
 * the persist writer's union rule reads, WITHOUT starting a `DescribeType`.
 * The cache when a lookup is cached or in flight, else the committed snapshot,
 * else `undefined` (the writer then takes every token's union).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudFormationSend = vi.fn();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ cloudFormation: { send: mockCloudFormationSend } }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

import {
  cachedCreateOnlyPropertyPaths,
  clearCreateOnlyPropertiesCache,
  getCreateOnlyPropertyPaths,
} from '../../../src/provisioning/create-only-properties.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';

beforeEach(() => {
  vi.clearAllMocks();
  clearCreateOnlyPropertiesCache();
});

describe('cachedCreateOnlyPropertyPaths', () => {
  it('starts no DescribeType: an uncached, unsnapshotted type is not known', () => {
    expect(cachedCreateOnlyPropertyPaths('AWS::NoSnapshot::Type')).toBeUndefined();
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });

  it('falls back to the committed snapshot, still with no call', async () => {
    const snapshot = CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue');
    expect(snapshot).toBeDefined();
    expect(await cachedCreateOnlyPropertyPaths('AWS::SQS::Queue')).toEqual(snapshot);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });

  it('a schema-less type has none', async () => {
    expect(await cachedCreateOnlyPropertyPaths('Custom::Thing')).toEqual([]);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });

  it('joins a cached lookup without a second call', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ createOnlyProperties: ['/properties/Live'] }),
    });
    await getCreateOnlyPropertyPaths('AWS::NoSnapshot::Type');
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
    expect(await cachedCreateOnlyPropertyPaths('AWS::NoSnapshot::Type')).toEqual([['Live']]);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('an IN-FLIGHT lookup is not known (it could still be cancelled into [])', async () => {
    let release: (value: unknown) => void = () => undefined;
    const answered = new Promise((resolve) => {
      release = resolve;
    });
    mockCloudFormationSend.mockImplementation(() => answered);
    const pending = getCreateOnlyPropertyPaths('AWS::NoSnapshot::Type');
    expect(cachedCreateOnlyPropertyPaths('AWS::NoSnapshot::Type')).toBeUndefined();
    release({ Schema: JSON.stringify({ createOnlyProperties: ['/properties/Live'] }) });
    await pending;
    expect(await cachedCreateOnlyPropertyPaths('AWS::NoSnapshot::Type')).toEqual([['Live']]);
  });
});
