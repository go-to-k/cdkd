/**
 * go-to-k/cdkd#4705: one stack name recorded under two state prefixes of one
 * bucket. The scan, its verdict rules, and what each result does.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

import {
  PROBE_CONCURRENCY,
  STACK_UNDER_OTHER_PREFIX,
  UNSUPPORTED_SENTENCE,
  CrossPrefixReadError,
  applyCrossPrefixScan,
  candidatePrefixPasses,
  isAccessDenied,
  recordCanOwnResources,
  scanOtherPrefixesForStack,
  withSharedListing,
  type CrossPrefixScanTarget,
  type RecordUnderPrefix,
} from '../../../src/state/cross-prefix-stack-scan.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

type Held = boolean | 'empty' | Error;

function target(opts: {
  prefix?: string;
  prefixes?: string[] | Error;
  holders?: Record<string, Held>;
  delayMs?: number;
}): CrossPrefixScanTarget & {
  listTopLevelPrefixes: ReturnType<typeof vi.fn>;
  recordUnderPrefix: ReturnType<typeof vi.fn>;
  maxInFlight: () => number;
} {
  let inFlight = 0;
  let max = 0;
  return {
    prefix: opts.prefix ?? 'cdkd',
    listTopLevelPrefixes: vi.fn(async () => {
      if (opts.prefixes instanceof Error) throw opts.prefixes;
      return opts.prefixes ?? [];
    }),
    recordUnderPrefix: vi.fn(async (p: string): Promise<RecordUnderPrefix> => {
      inFlight++;
      max = Math.max(max, inFlight);
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const v = opts.holders?.[p];
        if (v instanceof Error) throw v;
        return v === 'empty' ? 'empty' : v ? 'holder' : 'absent';
      } finally {
        inFlight--;
      }
    }),
    maxInFlight: () => max,
  };
}

const denied = (): Error =>
  Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
const slowDown = (): Error =>
  Object.assign(new Error('Please reduce your request rate'), {
    name: 'SlowDown',
    $metadata: { httpStatusCode: 503 },
  });
const SUBJECT = { stackName: 'App', region: 'us-east-1', bucket: 'cdkd-state-123456789012' };
const scan = (t: CrossPrefixScanTarget) => scanOtherPrefixesForStack(t, 'App', 'us-east-1');

describe('candidatePrefixPasses', () => {
  it('first the listed segments, then their trailing-slash twins, minus the own prefix', () => {
    expect(candidatePrefixPasses(['cdkd', 'team-a'], 'cdkd')).toEqual([
      ['team-a'],
      ['cdkd/', 'team-a/'],
    ]);
  });

  it("covers the issue's `--state-prefix team-a/` (keys `team-a//App/...`) without a self-match", () => {
    expect(candidatePrefixPasses(['team-a'], 'cdkd')[1]).toContain('team-a/');
    expect(candidatePrefixPasses(['team-a', 'cdkd'], 'team-a/')).toEqual([
      ['team-a', 'cdkd'],
      ['cdkd/'],
    ]);
  });

  it("covers the empty prefix (listed as '')", () => {
    expect(candidatePrefixPasses([''], 'cdkd')).toEqual([[''], ['/']]);
  });
});

describe('scanOtherPrefixesForStack', () => {

  it('finds the stack under another prefix, and never probes its own prefix', async () => {
    const t = target({ prefixes: ['cdkd', 'team-b'], holders: { cdkd: true, 'team-b': true } });
    await expect(scan(t)).resolves.toEqual({ kind: 'found', prefixes: ['team-b'] });
    expect(t.recordUnderPrefix.mock.calls.map((c) => c[0])).not.toContain('cdkd');
    expect(t.recordUnderPrefix).toHaveBeenCalledWith('team-b', 'App', 'us-east-1');
  });

  it("finds a trailing-slash prefix's record (`team-a/`)", async () => {
    const t = target({ prefixes: ['cdkd', 'team-a'], holders: { 'team-a/': true } });
    await expect(scan(t)).resolves.toEqual({ kind: 'found', prefixes: ['team-a/'] });
  });

  it('is clear when no other prefix holds the stack', async () => {
    await expect(scan(target({ prefixes: ['cdkd', 'team-b'] }))).resolves.toEqual({
      kind: 'clear',
    });
  });

  describe('the verdict over mixed probes (found wins, then failed, then denied)', () => {
    it('a holder beside a 403 refuses (found), not warn-and-proceed', async () => {
      const t = target({
        prefixes: ['restricted', 'team-b'],
        holders: { restricted: denied(), 'restricted/': denied(), 'team-b': true },
      });
      await expect(scan(t)).resolves.toMatchObject({ kind: 'found', prefixes: ['team-b'] });
    });

    it('a holder beside another failure refuses (found)', async () => {
      const t = target({ prefixes: ['broken', 'team-b'], holders: { broken: slowDown(), 'team-b': true } });
      await expect(scan(t)).resolves.toMatchObject({ kind: 'found', prefixes: ['team-b'] });
    });

    it('a holder in a LATER wave still wins over an early 403', async () => {
      const prefixes = Array.from({ length: 30 }, (_, i) => `p${i}`);
      const holders: Record<string, Held> = { p0: denied(), p29: true };
      const t = target({ prefixes, holders });
      await expect(scan(t)).resolves.toMatchObject({ kind: 'found', prefixes: ['p29'] });
    });

    it('a failure beside a 403 refuses (failed)', async () => {
      const t = target({ prefixes: ['a', 'b'], holders: { a: denied(), b: slowDown() } });
      await expect(scan(t)).resolves.toMatchObject({ kind: 'failed' });
    });

    it('a 403 on a read alone warns (denied, stage probe)', async () => {
      const t = target({ prefixes: ['a', 'b'], holders: { a: denied() } });
      await expect(scan(t)).resolves.toMatchObject({ kind: 'denied', stage: 'probe' });
    });

    it('a 403 on the listing is stage list', async () => {
      await expect(scan(target({ prefixes: denied() }))).resolves.toMatchObject({
        kind: 'denied',
        stage: 'list',
      });
    });


    it('any other listing failure is failed, and the scan never rejects', async () => {
      await expect(scan(target({ prefixes: slowDown() }))).resolves.toMatchObject({
        kind: 'failed',
      });
    });
  });

  it(`never runs more than ${PROBE_CONCURRENCY} probes at once`, async () => {
    const prefixes = Array.from({ length: 60 }, (_, i) => `p${i}`);
    const t = target({ prefixes, delayMs: 2 });
    await expect(scan(t)).resolves.toEqual({ kind: 'clear' });
    expect(t.recordUnderPrefix).toHaveBeenCalledTimes(120);
    expect(t.maxInFlight()).toBe(PROBE_CONCURRENCY);
  });

  it('probes every segment and its trailing-slash twin in ONE pass (go-to-k/cdkd#4705 PR2)', async () => {
    const t = target({ prefixes: ['a', 'b'], holders: { 'b/': true } });
    await expect(scan(t)).resolves.toMatchObject({ kind: 'found', prefixes: ['b/'] });
    // The twins started without waiting for the segments' pass to finish.
    expect(t.recordUnderPrefix.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'a/', 'b/']);
    const clear = target({ prefixes: ['a', 'b'] });
    await scan(clear);
    expect(clear.recordUnderPrefix.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'a/', 'b/']);
  });

  it('stops starting new probes once a holder is found', async () => {
    const prefixes = Array.from({ length: 100 }, (_, i) => `p${i}`);
    const t = target({ prefixes, holders: { p0: true }, delayMs: 1 });
    await expect(scan(t)).resolves.toMatchObject({ kind: 'found', prefixes: ['p0'] });
    // At most the first wave was in flight when the holder answered.
    expect(t.recordUnderPrefix.mock.calls.length).toBeLessThanOrEqual(2 * PROBE_CONCURRENCY);
    expect(t.recordUnderPrefix.mock.calls.length).toBeLessThan(200);
  });
});

describe('an empty leftover record under another prefix', () => {
  it('does not block: the scan is clear and names it as stale', async () => {
    const t = target({ prefixes: ['cdkd', 'old', 'team-b'], holders: { old: 'empty' } });
    await expect(scan(t)).resolves.toEqual({ kind: 'clear', stale: ['old'] });
  });

  it('still refuses for a holder beside it, and names both', async () => {
    const t = target({ prefixes: ['old', 'team-b'], holders: { old: 'empty', 'team-b': true } });
    await expect(scan(t)).resolves.toEqual({ kind: 'found', prefixes: ['team-b'], stale: ['old'] });
  });

  it('prints one info line naming the stale prefix and its cleanup, and never refuses', () => {
    const warn = vi.fn();
    const info = vi.fn();
    expect(() =>
      applyCrossPrefixScan({ kind: 'clear', stale: ['old'] }, SUBJECT, 'deploy', warn, info)
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain('that owns no resource');
    expect(line).toContain('cdkd state orphan App --stack-region us-east-1 --state-prefix old');
  });
});

describe('recordCanOwnResources', () => {
  const ops = [{ logicalId: 'Q', changeType: 'CREATE' }];
  it.each([
    ['an empty record, no journal', { resources: {} }, null, false],
    [
      'an empty record, a journal with failedOperations only',
      { resources: {} },
      { segments: [{ operations: [], failedOperations: ops }] },
      false,
    ],
    [
      'an empty record, a journal with a completed operation',
      { resources: {} },
      { segments: [{ operations: [], failedOperations: ops }, { operations: ops }] },
      true,
    ],
    ['a record with resources', { resources: { Q: {} } }, null, true],
    ['a record with orphans only', { resources: {}, orphans: [{ logicalId: 'Q' }] }, null, true],
    ['an empty orphans list', { resources: {}, orphans: [] }, null, false],
    ['a resources bag that is not an object (proves nothing)', { resources: 'x' }, null, true],
    ['an orphans container that is not a list', { resources: {}, orphans: {} }, null, true],
    ['journal segments that are not a list', { resources: {} }, { segments: 'x' }, true],
    [
      'a failed operation carrying a physicalId (a proven failed-CREATE orphan)',
      { resources: {} },
      { segments: [{ operations: [], failedOperations: [{ logicalId: 'Q', physicalId: 'q' }] }] },
      true,
    ],
    [
      'a failed operation with no physicalId',
      { resources: {} },
      { segments: [{ operations: [], failedOperations: [{ logicalId: 'Q' }] }] },
      false,
    ],
    ['a null segment', { resources: {} }, { segments: [null] }, true],
    ['a segment whose operations is not a list', { resources: {} }, { segments: [{ operations: {} }] }, true],
    ['failedOperations that is not a list', { resources: {} }, { segments: [{ failedOperations: 'x' }] }, true],
  ])('%s -> %s', (_what, state, journal, expected) => {
    expect(recordCanOwnResources(state, journal)).toBe(expected);
  });
});

describe('withSharedListing', () => {
  it('lists the bucket once for every stack scanned through it', async () => {
    const t = target({ prefixes: ['cdkd', 'team-b'], holders: { 'team-b': true } });
    const shared = withSharedListing(t);
    const results = await Promise.all(
      ['A', 'B', 'C'].map((name) =>
        scanOtherPrefixesForStack(shared, name, 'us-east-1')
      )
    );
    expect(results.map((r) => r.kind)).toEqual(['found', 'found', 'found']);
    expect(t.listTopLevelPrefixes).toHaveBeenCalledTimes(1);
  });
});

describe('isAccessDenied', () => {
  it.each([
    [{ name: 'AccessDenied' }, true],
    [{ name: 'Forbidden' }, true],
    [{ name: 'Unknown', $metadata: { httpStatusCode: 403 } }, true],
    [{ name: 'NotFound', $metadata: { httpStatusCode: 404 } }, false],
    [{ name: 'SlowDown', $metadata: { httpStatusCode: 503 } }, false],
    [{ name: 'StateError', cause: { name: 'AccessDenied' } }, true],
    [null, false],
  ])('%j -> %s', (error, expected) => {
    expect(isAccessDenied(error)).toBe(expected);
  });
});

describe('applyCrossPrefixScan', () => {
  const refusal = (fn: () => void): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(CdkdError);
      expect((e as CdkdError).code).toBe(STACK_UNDER_OTHER_PREFIX);
      return (e as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it.each(['clear'] as const)('does nothing on %s', (kind) => {
    const warn = vi.fn();
    expect(() => applyCrossPrefixScan({ kind }, SUBJECT, 'deploy', warn)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a deploy, naming the other prefix and every remedy', () => {
    const message = refusal(() =>
      applyCrossPrefixScan({ kind: 'found', prefixes: ['team-b'] }, SUBJECT, 'deploy', vi.fn())
    );
    expect(message).toContain('Refusing to deploy stack App (us-east-1)');
    expect(message).toContain('is already recorded under another state prefix of bucket');
    expect(message).toContain('(team-b)');
    expect(message).toContain(UNSUPPORTED_SENTENCE);
    expect(message).toContain('No resource of this stack was created.');
    expect(message).not.toContain('Nothing was deployed');
    expect(message).toContain('pass the same --state-prefix it was deployed with');
    expect(message).toContain('cdkd state destroy App --stack-region us-east-1 --state-prefix team-b');
    expect(message).toContain('cdkd state orphan App --stack-region us-east-1 --state-prefix team-b');
    expect(message).toContain('another name');
  });

  it('points a deploy refused by SEVERAL prefixes at releasing each, never at a destroy that would be refused', () => {
    const message = refusal(() =>
      applyCrossPrefixScan({ kind: 'found', prefixes: ['a', 'b'] }, SUBJECT, 'deploy', vi.fn())
    );
    expect(message).toContain('release each other record with `cdkd state orphan`');
    expect(message).toContain('re-run it until none is named');
    expect(message).not.toContain('cdkd state destroy');
  });

  it('caps the listed prefixes at 5, then "and N more"', () => {
    const prefixes = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const message = refusal(() =>
      applyCrossPrefixScan({ kind: 'found', prefixes }, SUBJECT, 'destroy', vi.fn())
    );
    expect(message).toContain('(p0, p1, p2, p3, p4 and 3 more)');
    expect(message).not.toContain('p5');
  });

  it('renders a listed prefix carrying a comma as a list member, so it cannot read as two', () => {
    const message = refusal(() =>
      applyCrossPrefixScan({ kind: 'found', prefixes: ['a,b'] }, SUBJECT, 'destroy', vi.fn())
    );
    expect(message).not.toContain('(a,b)');
  });

  it('refuses a destroy, pointing only at `state orphan` (a state destroy would be refused too)', () => {
    const message = refusal(() =>
      applyCrossPrefixScan({ kind: 'found', prefixes: ['team-b'] }, SUBJECT, 'destroy', vi.fn())
    );
    expect(message).toContain('Refusing to destroy stack App (us-east-1)');
    expect(message).toContain('is also recorded under another state prefix of bucket');
    expect(message).toContain('Nothing was deleted');
    expect(message).toContain('cdkd state orphan App --stack-region us-east-1 --state-prefix team-b');
    expect(message).not.toContain('cdkd state destroy');
  });

  it('refuses a destructive deploy plan', () => {
    const message = refusal(() =>
      applyCrossPrefixScan(
        { kind: 'found', prefixes: ['team-b'] },
        SUBJECT,
        'deploy-destructive',
        vi.fn()
      )
    );
    expect(message).toContain('this deploy deletes or replaces resources');
    expect(message).toContain('(team-b)');
    expect(message).toContain('No resource of this stack was changed.');
  });

  it("carries the run's --profile and resolved --state-bucket on every command it prints", () => {
    const subject = {
      ...SUBJECT,
      recovery: { profile: 'prod', stateBucket: 'my-state-bucket' },
    };
    for (const action of ['deploy', 'destroy', 'rollback', 'deploy-destructive'] as const) {
      const message = refusal(() =>
        applyCrossPrefixScan({ kind: 'found', prefixes: ['team-b'] }, subject, action, vi.fn())
      );
      expect(message, action).toContain(
        'cdkd state orphan App --stack-region us-east-1 --state-prefix team-b ' +
          "--profile prod --state-bucket my-state-bucket"
      );
    }
    const info = vi.fn();
    applyCrossPrefixScan({ kind: 'clear', stale: ['old'] }, subject, 'destroy', vi.fn(), info);
    expect(String(info.mock.calls[0]![0])).toContain('--profile prod --state-bucket my-state-bucket');
  });

  it('withholds a prefix that is not safe to paste', () => {
    const message = refusal(() =>
      applyCrossPrefixScan({ kind: 'found', prefixes: ['$(rm -rf ~)'] }, SUBJECT, 'deploy', vi.fn())
    );
    expect(message).not.toContain("--state-prefix '$(rm -rf ~)'");
    expect(message).toContain("--state-prefix '<prefix>'");
  });

  it.each(['probe', 'list'] as const)('warns and proceeds on a 403 (stage %s), every time', (stage) => {
    const warn = vi.fn();
    for (let i = 0; i < 3; i++) {
      applyCrossPrefixScan({ kind: 'denied', error: denied(), stage }, SUBJECT, 'deploy', warn);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('Continuing');
    expect(line).toContain(stage === 'list' ? 'S3 refused to list bucket' : 'S3 refused a read');
    // No found needle, so a fixture grepping one cannot match this.
    expect(line).not.toContain('is also recorded under another state prefix of bucket');
    expect(line).not.toContain('is already recorded under another state prefix of bucket');
  });

  it('a could-not-check refusal names the object, carries no cause, and no found needle', () => {
    const error = new CrossPrefixReadError(
      'team-b/App/us-east-1/state.json',
      new SyntaxError('Unexpected token s in JSON at position 3: {"secret":...')
    );
    let thrown: unknown;
    try {
      applyCrossPrefixScan({ kind: 'failed', error }, SUBJECT, 'destroy', vi.fn());
    } catch (e) {
      thrown = e;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('(SyntaxError reading s3 object team-b/App/us-east-1/state.json)');
    expect(message).not.toContain('secret');
    expect((thrown as Error).cause).toBeUndefined();
    expect(message).not.toContain('is also recorded under another state prefix of bucket');
  });

  it('refuses on any other failure', () => {
    expect(() =>
      applyCrossPrefixScan({ kind: 'failed', error: slowDown() }, SUBJECT, 'destroy', vi.fn())
    ).toThrow(/could not check.*\(SlowDown\).*Nothing was deleted/s);
  });
});
