/**
 * go-to-k/cdkd#4705: one stack name recorded under two state prefixes of one
 * bucket. The scan, and what each result does.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  STACK_UNDER_OTHER_PREFIX,
  UNSUPPORTED_SENTENCE,
  applyCrossPrefixScan,
  isAccessDenied,
  scanOtherPrefixesForStack,
  type CrossPrefixScanTarget,
} from '../../../src/state/cross-prefix-stack-scan.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

function target(opts: {
  prefix?: string;
  own?: boolean | Error;
  prefixes?: string[] | Error;
  holders?: Record<string, boolean | Error>;
}): CrossPrefixScanTarget & {
  ownRecordExists: ReturnType<typeof vi.fn>;
  listTopLevelPrefixes: ReturnType<typeof vi.fn>;
  recordExistsUnderPrefix: ReturnType<typeof vi.fn>;
} {
  return {
    prefix: opts.prefix ?? 'cdkd',
    ownRecordExists: vi.fn(async () => {
      if (opts.own instanceof Error) throw opts.own;
      return opts.own ?? false;
    }),
    listTopLevelPrefixes: vi.fn(async () => {
      if (opts.prefixes instanceof Error) throw opts.prefixes;
      return opts.prefixes ?? [];
    }),
    recordExistsUnderPrefix: vi.fn(async (p: string) => {
      const v = opts.holders?.[p];
      if (v instanceof Error) throw v;
      return v ?? false;
    }),
  };
}

const denied = (): Error =>
  Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
const SUBJECT = { stackName: 'App', region: 'us-east-1', bucket: 'cdkd-state-123456789012' };

describe('scanOtherPrefixesForStack', () => {
  it('stops at own-record when this prefix already holds the stack: nothing is listed', async () => {
    const t = target({ own: true, prefixes: ['team-b'], holders: { 'team-b': true } });
    await expect(
      scanOtherPrefixesForStack(t, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'own-record' });
    expect(t.listTopLevelPrefixes).not.toHaveBeenCalled();
    expect(t.recordExistsUnderPrefix).not.toHaveBeenCalled();
  });

  it('finds the stack under another prefix, and never probes its own prefix', async () => {
    const t = target({
      prefix: 'cdkd',
      prefixes: ['cdkd', 'team-b', 'custom-resource-responses'],
      holders: { cdkd: true, 'team-b': true },
    });
    await expect(
      scanOtherPrefixesForStack(t, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'found', prefixes: ['team-b'] });
    const probed = t.recordExistsUnderPrefix.mock.calls.map((c) => c[0]);
    expect(probed).toEqual(['team-b', 'custom-resource-responses']);
    expect(t.recordExistsUnderPrefix).toHaveBeenCalledWith('team-b', 'App', 'us-east-1');
  });

  it('is clear when no other prefix holds the stack', async () => {
    const t = target({ prefixes: ['cdkd', 'team-b'] });
    await expect(
      scanOtherPrefixesForStack(t, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'clear' });
  });

  it('skips the own-record check for destroy, which holds the record it destroys', async () => {
    const t = target({ own: true, prefixes: ['team-b'], holders: { 'team-b': true } });
    await expect(
      scanOtherPrefixesForStack(t, 'App', 'us-east-1', { checkOwnRecord: false })
    ).resolves.toEqual({ kind: 'found', prefixes: ['team-b'] });
    expect(t.ownRecordExists).not.toHaveBeenCalled();
  });

  it('treats an empty prefix as a prefix like any other', async () => {
    const t = target({ prefix: 'cdkd', prefixes: [''], holders: { '': true } });
    await expect(
      scanOtherPrefixesForStack(t, 'App', 'us-east-1', { checkOwnRecord: false })
    ).resolves.toEqual({ kind: 'found', prefixes: [''] });
  });

  it('probes every prefix past the concurrency batch', async () => {
    const prefixes = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const t = target({ prefixes, holders: { p0: true, p39: true } });
    await expect(
      scanOtherPrefixesForStack(t, 'App', 'us-east-1', { checkOwnRecord: false })
    ).resolves.toEqual({ kind: 'found', prefixes: ['p0', 'p39'] });
    expect(t.recordExistsUnderPrefix).toHaveBeenCalledTimes(40);
  });

  it.each([
    ['the listing', { prefixes: denied() }],
    ['a probe', { prefixes: ['team-b'], holders: { 'team-b': denied() } }],
    ['the own-record check', { own: denied() }],
  ])('reports denied when S3 answers 403 to %s', async (_what, opts) => {
    const result = await scanOtherPrefixesForStack(target(opts), 'App', 'us-east-1', {
      checkOwnRecord: true,
    });
    expect(result.kind).toBe('denied');
  });

  it('reports failed, and never rejects, on any other error', async () => {
    const t = target({ prefixes: Object.assign(new Error('boom'), { name: 'SlowDown' }) });
    const result = await scanOtherPrefixesForStack(t, 'App', 'us-east-1', {
      checkOwnRecord: true,
    });
    expect(result.kind).toBe('failed');
  });
});

describe('isAccessDenied', () => {
  it.each([
    [{ name: 'AccessDenied' }, true],
    [{ name: 'Forbidden' }, true],
    [{ name: 'Unknown', $metadata: { httpStatusCode: 403 } }, true],
    [{ name: 'NotFound', $metadata: { httpStatusCode: 404 } }, false],
    [{ name: 'SlowDown', $metadata: { httpStatusCode: 503 } }, false],
    [null, false],
  ])('%j -> %s', (error, expected) => {
    expect(isAccessDenied(error)).toBe(expected);
  });
});

describe('applyCrossPrefixScan', () => {
  it.each(['own-record', 'clear'] as const)('does nothing on %s', (kind) => {
    const warn = vi.fn();
    expect(() => applyCrossPrefixScan({ kind }, SUBJECT, 'deploy', warn)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a deploy, naming the other prefix and every remedy', () => {
    let err: unknown;
    try {
      applyCrossPrefixScan({ kind: 'found', prefixes: ['team-b'] }, SUBJECT, 'deploy', vi.fn());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe(STACK_UNDER_OTHER_PREFIX);
    const message = (err as Error).message;
    expect(message).toContain('Refusing to deploy stack App (us-east-1)');
    expect(message).toContain('already recorded under another state prefix');
    expect(message).toContain('(team-b)');
    expect(message).toContain(UNSUPPORTED_SENTENCE);
    expect(message).toContain('Nothing was deployed');
    expect(message).toContain('pass the same --state-prefix it was deployed with');
    expect(message).toContain(
      "cdkd state destroy App --stack-region us-east-1 --state-prefix team-b"
    );
    expect(message).toContain(
      "cdkd state orphan App --stack-region us-east-1 --state-prefix team-b"
    );
    expect(message).toContain('another name');
  });

  it('refuses a destroy, pointing only at `state orphan` (a state destroy would be refused too)', () => {
    let message = '';
    try {
      applyCrossPrefixScan({ kind: 'found', prefixes: ['team-b'] }, SUBJECT, 'destroy', vi.fn());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('Refusing to destroy stack App (us-east-1)');
    expect(message).toContain('also recorded under another state prefix');
    expect(message).toContain('Nothing was deleted');
    expect(message).toContain(
      "cdkd state orphan App --stack-region us-east-1 --state-prefix team-b"
    );
    expect(message).not.toContain('cdkd state destroy');
  });

  it('withholds a prefix that is not safe to paste', () => {
    let message = '';
    try {
      applyCrossPrefixScan(
        { kind: 'found', prefixes: ['$(rm -rf ~)'] },
        SUBJECT,
        'deploy',
        vi.fn()
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("--state-prefix '$(rm -rf ~)'");
    expect(message).toContain("--state-prefix '<prefix>'");
  });

  it('warns and proceeds on denied', () => {
    const warn = vi.fn();
    applyCrossPrefixScan({ kind: 'denied', error: denied() }, SUBJECT, 'deploy', warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Continuing');
    expect(String(warn.mock.calls[0]![0])).toContain('AccessDenied');
  });

  it('refuses on any other failure', () => {
    expect(() =>
      applyCrossPrefixScan(
        { kind: 'failed', error: Object.assign(new Error('x'), { name: 'SlowDown' }) },
        SUBJECT,
        'destroy',
        vi.fn()
      )
    ).toThrow(/could not check.*\(SlowDown\).*Nothing was deleted/s);
  });
});
