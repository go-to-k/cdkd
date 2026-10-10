/**
 * go-to-k/cdkd#4705: every path that removes a stack's record releases its
 * registry marker after it, non-fatally, so "a marker exists" keeps meaning
 * "a record exists under its prefix".
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  quiet.child.mockReturnValue(quiet);
  return { getLogger: () => quiet };
});

import { releaseRegistryMarkerQuietly } from '../../../src/cli/commands/registry-release.js';
import { removeExportedStackRecord } from '../../../src/cli/commands/export.js';
import { crossPrefixEngineOptions } from '../../../src/cli/commands/cross-prefix-gate.js';

const logger = () => ({ warn: vi.fn(), debug: vi.fn() });

describe('releaseRegistryMarkerQuietly', () => {
  it('releases a top-level stack by the version known, and skips a nested child', async () => {
    const backend = { releaseRegistryMarker: vi.fn(async () => 'released' as const) };
    const known = { prefix: 'cdkd', etag: '"e"' };
    await releaseRegistryMarkerQuietly(backend, 'App', 'us-east-1', logger(), known);
    await releaseRegistryMarkerQuietly(backend, 'App~Child', 'us-east-1', logger());
    expect(backend.releaseRegistryMarker.mock.calls).toEqual([['App', 'us-east-1', known]]);
  });

  it('warns on a failure, never throws', async () => {
    const backend = {
      releaseRegistryMarker: vi.fn(async () => {
        throw new Error('S3 down');
      }),
    };
    const log = logger();
    await expect(releaseRegistryMarkerQuietly(backend, 'App', 'us-east-1', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not delete the stack registry marker'));
  });
});

describe('export removes the record, then releases the marker', () => {
  it('in that order', async () => {
    const order: string[] = [];
    const backend = {
      deleteState: vi.fn(async () => {
        order.push('delete');
      }),
      releaseRegistryMarker: vi.fn(async () => {
        order.push('release');
        return 'released' as const;
      }),
    };
    await removeExportedStackRecord(backend, 'App', 'us-east-1', logger());
    expect(order).toEqual(['delete', 'release']);
  });

  it('a failed record delete throws and releases nothing', async () => {
    const backend = {
      deleteState: vi.fn(async () => {
        throw new Error('denied');
      }),
      releaseRegistryMarker: vi.fn(async () => 'released' as const),
    };
    await expect(removeExportedStackRecord(backend, 'App', 'us-east-1', logger())).rejects.toThrow('denied');
    expect(backend.releaseRegistryMarker).not.toHaveBeenCalled();
  });
});

describe('a failed first deploy that left no record (crossPrefixEngineOptions)', () => {
  const guard = {
    full: vi.fn(),
    firstDeploy: vi.fn(),
    knownMarker: vi.fn(async () => ({ prefix: 'cdkd', etag: '' })),
  };
  it('releases this stack\'s marker by the version this run read; not for another (nested) stack', async () => {
    const backend = { releaseRegistryMarker: vi.fn(async () => 'released' as const) };
    const opts = crossPrefixEngineOptions({
      stackName: 'App',
      region: 'us-east-1',
      bucket: 'b',
      guard: guard as never,
      backend,
    });
    await opts.onFirstDeployLeftNoRecord!('App~Child');
    expect(backend.releaseRegistryMarker).not.toHaveBeenCalled();
    await opts.onFirstDeployLeftNoRecord!('App');
    expect(backend.releaseRegistryMarker).toHaveBeenCalledWith('App', 'us-east-1', { prefix: 'cdkd', etag: '' });
  });
  it('offers no hook without a backend', () => {
    const opts = crossPrefixEngineOptions({ stackName: 'App', region: 'us-east-1', bucket: 'b', guard: guard as never });
    expect(opts.onFirstDeployLeftNoRecord).toBeUndefined();
  });
});
