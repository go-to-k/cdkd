/**
 * go-to-k/cdkd#4705 (review CB-2, G4): after `cdkd import` writes a record,
 * the stack's registry marker is claimed through the guard: with no marker
 * (or a stale one) the prefix scan runs ONCE first and only a clear answer
 * claims; a pair the scan finds is named and nothing is claimed.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
  return { getLogger: () => ({ ...quiet, child: () => quiet }) };
});

import { claimRegistryMarkerAfterImport } from '../../../src/cli/commands/import.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

function backendOf(opts: { marker?: string; segments: string[]; holders?: string[] }) {
  let marker = opts.marker === undefined ? null : { prefix: opts.marker, etag: '"e0"' };
  return {
    prefix: 'cdkd',
    getRegistryMarker: vi.fn(async () => marker),
    claimRegistryMarker: vi.fn(async () => {
      marker = { prefix: 'cdkd', etag: '"e1"' };
      return 'claimed' as const;
    }),
    lockUnderPrefix: vi.fn(async () => false),
    listTopLevelPrefixes: vi.fn(async () => opts.segments),
    recordUnderPrefix: vi.fn(async (p: string) => ((opts.holders ?? []).includes(p) ? 'holder' : 'absent')),
  };
}
const logger = () => ({ warn: vi.fn(), debug: vi.fn() });

describe('the import claim (go-to-k/cdkd#4705)', () => {
  it('no marker and a clear scan: scans once, then claims', async () => {
    const b = backendOf({ segments: ['cdkd', 'team-b'] });
    const log = logger();
    await claimRegistryMarkerAfterImport(b as unknown as S3StateBackend, 'App', 'us-east-1', log);
    expect(b.listTopLevelPrefixes).toHaveBeenCalledTimes(1);
    expect(b.claimRegistryMarker).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('no marker and a pre-registry holder under another prefix: named, nothing claimed', async () => {
    const b = backendOf({ segments: ['cdkd', 'team-b'], holders: ['team-b'] });
    const log = logger();
    await claimRegistryMarkerAfterImport(b as unknown as S3StateBackend, 'App', 'us-east-1', log);
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/also records App .* under another state prefix \(team-b\)/));
  });

  it('a stale marker (another prefix holding nothing) with a holder the scan finds: named, not taken over', async () => {
    const b = backendOf({ marker: 'team-c', segments: ['cdkd', 'team-b', 'team-c'], holders: ['team-b'] });
    const log = logger();
    await claimRegistryMarkerAfterImport(b as unknown as S3StateBackend, 'App', 'us-east-1', log);
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/team-b/));
  });
});
