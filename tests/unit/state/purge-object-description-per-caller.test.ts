import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#2346](https://github.com/go-to-k/cdkd/issues/2346) — the shared
 * purge's warning must name the object the CALLER just failed to purge.
 *
 * ## What went wrong, and why "a warning was emitted" is not the test
 *
 * Before #2346 the warning's parenthetical was hard-coded to the custom-resource
 * response sidecar, which was true while the sidecar was the helper's only
 * caller. Three more callers joined in this change, and the sentence then told a
 * user chasing a warning about a bootstrap marker to go and look for "the
 * handler's full cfn-response body, including `Data`" — an object that does not
 * exist on that path.
 *
 * So this suite drives TWO REAL call sites end to end and asserts the warnings
 * DIFFER. That is the discriminator: an assertion that each site merely warns,
 * or that each warning is non-empty, passes with `objectDescription` wired to a
 * single constant — which is precisely the defect. Both halves are checked, the
 * inequality and each site's own phrase, because inequality alone would also be
 * satisfied by two wrong-but-different strings.
 */

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const base = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => base };
});

vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: vi.fn(async () => 'us-east-1'),
}));

const s3DestroyMock = vi.hoisted(() => vi.fn());
/**
 * Answers the version listing with ONE noncurrent row and then FAILS the
 * version delete through `Errors`, which is how `DeleteObjects` reports a
 * per-key failure — it does not throw. That failure is the only thing that
 * makes the helper warn at all, so it is what puts the descriptor on the wire.
 */
const s3SendMock = vi.hoisted(() =>
  vi.fn(async (cmd: { _name?: string; constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd._name ?? cmd.constructor.name;
    if (name === 'ListObjectVersions' || name === 'ListObjectVersionsCommand') {
      return {
        Versions: [{ Key: cmd.input['Prefix'], VersionId: 'v-old', IsLatest: false }],
        IsTruncated: false,
      };
    }
    if (name === 'DeleteObjects' || name === 'DeleteObjectsCommand') {
      return { Errors: [{ Key: 'k', VersionId: 'v-old', Code: 'AccessDenied', Message: 'nope' }] };
    }
    return {};
  })
);

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  // Spread the REAL module: this file needs the genuine command constructors
  // (the helper reads `constructor.name`), and a hand-written factory is the
  // very trap this change had to fix in three sibling suites.
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn(() => ({ send: s3SendMock, destroy: s3DestroyMock })),
  };
});

import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { uploadCfnTemplate } from '../../../src/cli/upload-cfn-template.js';

const BUCKET = 'cdkd-state-123456789012';

/** Only the purge warnings — the journal's own delete-failure warning is not one. */
const purgeWarnings = (): string[] =>
  warnSpy.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('noncurrent versions'));

describe('the purge warning names the CALLER\'s object (issue #2346)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    s3SendMock.mockClear();
  });

  const journalWarning = async (): Promise<string> => {
    const backend = new S3StateBackend(
      { send: s3SendMock, destroy: s3DestroyMock } as unknown as S3Client,
      { bucket: BUCKET, prefix: 'cdkd' }
    );
    await backend.deleteRollbackJournal('S', 'us-east-1');
    const [w] = purgeWarnings();
    expect(w, 'the rollback-journal call site emitted no purge warning').toBeDefined();
    return w!;
  };

  const templateWarning = async (): Promise<string> => {
    const { cleanup } = await uploadCfnTemplate({
      bucket: BUCKET,
      body: 'x'.repeat(100),
      stackName: 'MyStack',
    });
    await cleanup();
    const [w] = purgeWarnings();
    expect(w, 'the transient-template call site emitted no purge warning').toBeDefined();
    return w!;
  };

  it('the rollback-journal site names the journal and its attempted properties', async () => {
    const w = await journalWarning();
    expect(w).toContain('the rollback journal');
    expect(w).toContain('failedOperations[].attemptedProperties');
    // The pre-#2346 hard-coded text must be gone from THIS site.
    expect(w).not.toContain('cfn-response');
  });

  it('the transient-template site names the template body', async () => {
    const w = await templateWarning();
    expect(w).toContain('transient CloudFormation template body');
    expect(w).not.toContain('cfn-response');
    expect(w).not.toContain('rollback journal');
  });

  it('THE DISCRIMINATOR: the two sites produce DIFFERENT parentheticals', async () => {
    // A single constant — the pre-#2346 shape, and the shape a lazy wiring of
    // this option would reproduce — makes these two equal. Everything else in
    // this suite passes under that wiring; this is the assertion that does not.
    const journal = await journalWarning();
    warnSpy.mockClear();
    const template = await templateWarning();

    const parenthetical = (w: string): string =>
      w.slice(w.indexOf('VersionId (') + 'VersionId ('.length, w.indexOf('). Grant'));

    expect(parenthetical(journal)).not.toEqual(parenthetical(template));
    expect(parenthetical(journal)).toContain('rollback journal');
    expect(parenthetical(template)).toContain('template body');
  });

  it('the ACTIONABLE half is identical at both sites — only the object varies', async () => {
    // The two IAM grants and the by-hand remedy are correct everywhere, so they
    // are NOT parameterised. Pinning that keeps a future caller from
    // accidentally localising the part a reader acts on.
    const journal = await journalWarning();
    warnSpy.mockClear();
    const template = await templateWarning();

    for (const w of [journal, template]) {
      expect(w).toContain('Grant s3:ListBucketVersions and s3:DeleteObjectVersion on the state bucket');
      expect(w).toContain('or purge the key(s) by hand');
    }
  });
});
