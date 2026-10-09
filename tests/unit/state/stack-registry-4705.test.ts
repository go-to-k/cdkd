/**
 * go-to-k/cdkd#4705: the stack registry guard (`src/state/stack-registry.ts`),
 * one case per branch of its marker logic, against a fake backend.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { CrossPrefixGuard, topLevelStackName } from '../../../src/state/stack-registry.js';
import { CrossPrefixReadError } from '../../../src/state/cross-prefix-stack-scan.js';

type Held = 'absent' | 'empty' | 'holder';

const accessDenied = (): Error =>
  Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
const unavailable = (): Error =>
  Object.assign(new Error('Service Unavailable'), {
    name: 'ServiceUnavailable',
    $metadata: { httpStatusCode: 503 },
  });

/**
 * A backend with one marker slot per stack. `markers` holds the prefix a
 * marker names; `etag` changes on every write, as S3's does.
 */
function backendOf(opts: {
  prefix?: string;
  markers?: Record<string, string>;
  held?: Record<string, Held>;
  locks?: string[];
  segments?: string[];
  scanHolders?: Record<string, Held>;
  markerError?: Error;
  claimError?: Error;
  probeError?: Error;
  /** Answer `conflict` to this many claims before writing. */
  conflicts?: number;
}) {
  const markers = new Map(Object.entries(opts.markers ?? {}).map(([k, v]) => [k, { prefix: v, etag: '"e0"' }]));
  let conflicts = opts.conflicts ?? 0;
  let version = 0;
  const backend = {
    prefix: opts.prefix ?? 'cdkd',
    getRegistryMarker: vi.fn(async (stack: string) => {
      if (opts.markerError) throw new CrossPrefixReadError(`_cdkd-registry/r/${stack}.json`, opts.markerError);
      const m = markers.get(stack);
      return m === undefined ? null : { ...m };
    }),
    claimRegistryMarker: vi.fn(async (stack: string, _region: string, ifMatch?: string) => {
      if (opts.claimError) throw new CrossPrefixReadError(`_cdkd-registry/r/${stack}.json`, opts.claimError);
      if (conflicts > 0) {
        conflicts--;
        return 'conflict' as const;
      }
      const current = markers.get(stack);
      if (ifMatch === undefined && current !== undefined) return 'conflict' as const;
      if (ifMatch !== undefined && current?.etag !== ifMatch) return 'conflict' as const;
      markers.set(stack, { prefix: opts.prefix ?? 'cdkd', etag: `"e${++version}"` });
      return 'claimed' as const;
    }),
    lockUnderPrefix: vi.fn(async (prefix: string, stack: string) => (opts.locks ?? []).includes(`${prefix}|${stack}`)),
    listTopLevelPrefixes: vi.fn(async () => opts.segments ?? []),
    recordUnderPrefix: vi.fn(async (prefix: string, stack: string): Promise<Held> => {
      if (opts.probeError) throw opts.probeError;
      return opts.held?.[`${prefix}|${stack}`] ?? opts.scanHolders?.[`${prefix}|${stack}`] ?? 'absent';
    }),
    markers,
  };
  return backend;
}

describe('a first deploy (the claim)', () => {
  it('claims a missing marker with If-None-Match and answers clear, scanning nothing', async () => {
    const b = backendOf({ segments: ['cdkd', 'team-b'] });
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(b.claimRegistryMarker).toHaveBeenCalledWith('App', 'r', undefined);
    expect(b.markers.get('App')?.prefix).toBe('cdkd');
    expect(b.listTopLevelPrefixes).not.toHaveBeenCalled();
    expect(b.recordUnderPrefix).not.toHaveBeenCalled();
  });

  it('a lost race (412) re-reads the marker and acts on it', async () => {
    const b = backendOf({ conflicts: 1 });
    // The winner was this same prefix: after the conflict, the re-read finds it.
    b.claimRegistryMarker.mockImplementationOnce(async (stack: string) => {
      b.markers.set(stack, { prefix: 'team-b', etag: '"w"' });
      return 'conflict';
    });
    b.recordUnderPrefix.mockResolvedValueOnce('holder');
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toEqual({
      kind: 'found',
      prefixes: ['team-b'],
    });
    expect(b.getRegistryMarker).toHaveBeenCalledTimes(2);
  });

  it('a dry run reads but never writes the registry', async () => {
    const b = backendOf({});
    await expect(new CrossPrefixGuard(b, { readOnly: true }).firstDeploy('App', 'r')).resolves.toEqual({
      kind: 'clear',
    });
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
  });

  it('a 403 on the claim falls back to the scan, reported as a registry 403 when the scan is clear', async () => {
    const b = backendOf({ claimError: accessDenied(), segments: ['cdkd'] });
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toMatchObject({
      kind: 'denied',
      stage: 'registry',
    });
    expect(b.listTopLevelPrefixes).toHaveBeenCalledTimes(1);
  });

  it('any other claim failure refuses (failed)', async () => {
    const b = backendOf({ claimError: unavailable() });
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toMatchObject({ kind: 'failed' });
  });
});

describe('a marker naming a prefix', () => {
  it('this prefix: clear, with no other request', async () => {
    const b = backendOf({ markers: { App: 'cdkd' } });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(b.recordUnderPrefix).not.toHaveBeenCalled();
    expect(b.listTopLevelPrefixes).not.toHaveBeenCalled();
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
  });

  it('another prefix that holds the stack: found, naming it', async () => {
    const b = backendOf({ markers: { App: 'team-b' }, held: { 'team-b|App': 'holder' } });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toEqual({
      kind: 'found',
      prefixes: ['team-b'],
    });
    expect(b.lockUnderPrefix).not.toHaveBeenCalled();
  });

  it('another prefix with nothing but its lock: a deploy in progress', async () => {
    const b = backendOf({ markers: { App: 'team-b' }, locks: ['team-b|App'] });
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toEqual({
      kind: 'in-progress',
      prefix: 'team-b',
    });
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
  });

  it('another prefix with nothing at all: stale, re-claimed with If-Match on the version read', async () => {
    const b = backendOf({ markers: { App: 'team-b' } });
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(b.claimRegistryMarker).toHaveBeenCalledWith('App', 'r', '"e0"');
    expect(b.markers.get('App')?.prefix).toBe('cdkd');
  });

  it("another prefix whose record owns nothing: re-claimed, and that prefix is named as stale", async () => {
    const b = backendOf({ markers: { App: 'team-b' }, held: { 'team-b|App': 'empty' } });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toEqual({
      kind: 'clear',
      stale: ['team-b'],
    });
    expect(b.markers.get('App')?.prefix).toBe('cdkd');
  });

  it('a stale re-claim that keeps losing gives up (failed), never claiming blindly', async () => {
    const b = backendOf({ markers: { App: 'team-b' }, conflicts: 5 });
    const result = await new CrossPrefixGuard(b).full('App', 'r');
    expect(result).toMatchObject({ kind: 'failed' });
    expect(b.claimRegistryMarker).toHaveBeenCalledTimes(2);
  });

  it('a 403 reading the other prefix is denied; any other failure refuses', async () => {
    const denied = backendOf({ markers: { App: 'team-b' }, probeError: accessDenied() });
    await expect(new CrossPrefixGuard(denied).full('App', 'r')).resolves.toMatchObject({
      kind: 'denied',
      stage: 'probe',
    });
    const failed = backendOf({ markers: { App: 'team-b' }, probeError: unavailable() });
    await expect(new CrossPrefixGuard(failed).full('App', 'r')).resolves.toMatchObject({ kind: 'failed' });
  });

  it('a dry run never re-claims a stale marker', async () => {
    const b = backendOf({ markers: { App: 'team-b' } });
    await expect(new CrossPrefixGuard(b, { readOnly: true }).full('App', 'r')).resolves.toEqual({
      kind: 'clear',
    });
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
  });
});

describe('a stale marker is re-claimed only after the one-time scan (review CB-2)', () => {
  it('marker -> C (stale), a pre-registry holder under B: found, naming B, and the marker is NOT taken', async () => {
    const b = backendOf({
      markers: { App: 'team-c' },
      segments: ['cdkd', 'team-b', 'team-c'],
      scanHolders: { 'team-b|App': 'holder' },
    });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toMatchObject({
      kind: 'found',
      prefixes: ['team-b'],
    });
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
    expect(b.markers.get('App')?.prefix).toBe('team-c');
    // A first deploy meets the same stale marker: scanned too, refused.
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toMatchObject({
      kind: 'found',
      prefixes: ['team-b'],
    });
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
  });

  it('marker -> C (stale) and a clear scan: re-claimed, with the scan paid once', async () => {
    const b = backendOf({ markers: { App: 'team-c' }, segments: ['cdkd', 'team-c'] });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(b.listTopLevelPrefixes).toHaveBeenCalledTimes(1);
    expect(b.markers.get('App')?.prefix).toBe('cdkd');
  });
});

describe('an S3-compatible endpoint without conditional writes (review CB-6)', () => {
  it('NotImplemented on the claim falls back to the scan (reported like a registry 403), never refusing', async () => {
    const notImplemented = Object.assign(new Error('Not Implemented'), {
      name: 'NotImplemented',
      $metadata: { httpStatusCode: 501 },
    });
    const b = backendOf({ claimError: notImplemented, segments: ['cdkd'] });
    await expect(new CrossPrefixGuard(b).firstDeploy('App', 'r')).resolves.toMatchObject({
      kind: 'denied',
      stage: 'registry',
    });
    expect(b.listTopLevelPrefixes).toHaveBeenCalled();
  });
});

describe('G3: a nested child is locked by its TOP-LEVEL name', () => {
  it("the other prefix's lock on the parent makes the child's answer in-progress", async () => {
    const b = backendOf({ markers: { App: 'team-b' }, locks: ['team-b|App'] });
    await expect(new CrossPrefixGuard(b).full('App~Child', 'r')).resolves.toEqual({
      kind: 'in-progress',
      prefix: 'team-b',
    });
    expect(b.lockUnderPrefix).toHaveBeenCalledWith('team-b', 'App', 'r');
  });
});

describe('no marker for a recorded stack (a record that predates the registry)', () => {
  it('pays the scan ONCE, then claims, so the next read is O(1)', async () => {
    const b = backendOf({ segments: ['cdkd', 'team-b'] });
    const guard = new CrossPrefixGuard(b);
    await expect(guard.full('App', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(b.listTopLevelPrefixes).toHaveBeenCalledTimes(1);
    expect(b.markers.get('App')?.prefix).toBe('cdkd');
    // A later run reads the claimed marker and scans nothing.
    const next = backendOf({ markers: { App: 'cdkd' }, segments: ['cdkd', 'team-b'] });
    await expect(new CrossPrefixGuard(next).full('App', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(next.listTopLevelPrefixes).not.toHaveBeenCalled();
  });

  it('refuses a known pre-fix pair the scan finds, and claims nothing', async () => {
    const b = backendOf({ segments: ['cdkd', 'team-b'], scanHolders: { 'team-b|App': 'holder' } });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toEqual({
      kind: 'found',
      prefixes: ['team-b'],
    });
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
  });

  it('memoizes the answer per stack and region: one marker read, one scan', async () => {
    const b = backendOf({ segments: ['cdkd'] });
    const guard = new CrossPrefixGuard(b);
    await Promise.all([guard.full('App', 'r'), guard.full('App', 'r'), guard.full('App', 'r')]);
    expect(b.getRegistryMarker).toHaveBeenCalledTimes(1);
    expect(b.listTopLevelPrefixes).toHaveBeenCalledTimes(1);
    await guard.full('App', 'other');
    expect(b.getRegistryMarker).toHaveBeenCalledTimes(2);
  });
});

describe('the marker cannot be read', () => {
  it('a 403 falls back to the scan: a clear scan is reported as a registry 403', async () => {
    const b = backendOf({ markerError: accessDenied(), segments: ['cdkd'] });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toMatchObject({
      kind: 'denied',
      stage: 'registry',
    });
  });

  it('a 403 with a pair the scan finds still refuses', async () => {
    const b = backendOf({
      markerError: accessDenied(),
      segments: ['cdkd', 'team-b'],
      scanHolders: { 'team-b|App': 'holder' },
    });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toMatchObject({ kind: 'found' });
  });

  it('any other failure (a malformed marker, a 503) refuses', async () => {
    const b = backendOf({ markerError: unavailable() });
    await expect(new CrossPrefixGuard(b).full('App', 'r')).resolves.toMatchObject({ kind: 'failed' });
    expect(b.listTopLevelPrefixes).not.toHaveBeenCalled();
  });
});

describe('a nested child answers through its top-level stack', () => {
  it('reads the top-level marker, probes the CHILD record under the named prefix, and never claims', async () => {
    const b = backendOf({ markers: { App: 'team-b' }, held: { 'team-b|App~Child': 'holder' } });
    await expect(new CrossPrefixGuard(b).full('App~Child', 'r')).resolves.toEqual({
      kind: 'found',
      prefixes: ['team-b'],
    });
    expect(b.getRegistryMarker).toHaveBeenCalledWith('App', 'r');
    expect(b.recordUnderPrefix).toHaveBeenCalledWith('team-b', 'App~Child', 'r');
    const stale = backendOf({ markers: { App: 'team-b' } });
    await expect(new CrossPrefixGuard(stale).full('App~Child', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(stale.claimRegistryMarker).not.toHaveBeenCalled();
  });

  it('with no top-level marker, scans for the child and claims nothing', async () => {
    const b = backendOf({ segments: ['cdkd', 'team-b'] });
    await expect(new CrossPrefixGuard(b).full('App~Child', 'r')).resolves.toEqual({ kind: 'clear' });
    expect(b.recordUnderPrefix).toHaveBeenCalledWith('team-b', 'App~Child', 'r');
    expect(b.claimRegistryMarker).not.toHaveBeenCalled();
  });

  it('topLevelStackName strips every nesting level', () => {
    expect(topLevelStackName('App')).toBe('App');
    expect(topLevelStackName('App~Child~Grand')).toBe('App');
  });
});
