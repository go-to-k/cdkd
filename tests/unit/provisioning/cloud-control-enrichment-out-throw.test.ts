/**
 * The bare-`String()` out-throw in `cloud-control-provider.ts`'s catch blocks
 * (issue [#3309](https://github.com/go-to-k/cdkd/issues/3309)).
 *
 * `String(value)` THROWS for a null-prototype object (`TypeError: Cannot
 * convert object to primitive value`) and for anything with a hostile or
 * `null` `toString`. Fifteen `catch` blocks in that file read the caught
 * failure's text that way, inside handlers whose whole job is to DEGRADE: an
 * enrichment that cannot read an attribute logs at `debug` and carries on. The
 * out-throw turns each of those into a hard failure of the create or update,
 * reporting a `TypeError` that names nothing about the resource.
 *
 * Two instruments, because they catch different regressions:
 *
 *  - a BEHAVIOURAL case, proving the degradation actually survives a value
 *    that cannot be stringified. One site is enough to prove the class; the
 *    fifteen are the identical expression in identical handlers.
 *  - a POPULATION fence, proving no sixteenth appears. The behavioural case
 *    cannot see a re-introduction at a DIFFERENT site, and fourteen more
 *    behavioural cases would be fourteen near-identical fixtures pinning one
 *    fact.
 *
 * The fence carries its one KNOWN exception by name rather than by count, so a
 * future reader learns why it is exempt instead of adjusting a number. A second,
 * `cleanupFailedCreateRemnant`'s catch, was converted by go-to-k/cdkd#5254.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `vi.hoisted` because `vi.mock` factories are hoisted above ordinary
// top-level consts; the sibling suites in this directory use the same shape.
const { mockCloudControlSend, mockLoggerDebug, mockLoggerWarn } = vi.hoisted(() => ({
  mockCloudControlSend: vi.fn(),
  mockLoggerDebug: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: vi.fn() },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

// The KMS ARN branch's try calls `accountInfoForSynthesizedArn`, which is the
// only thing inside it -- so this is the seam that drives its catch. Rejecting
// with a NULL-PROTOTYPE object is the shape `String()` cannot convert.
const { mockGetAccountInfo } = vi.hoisted(() => ({ mockGetAccountInfo: vi.fn() }));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: mockGetAccountInfo,
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: mockLoggerDebug,
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  CloudControlOperationFailedError,
  CloudControlProvider,
} from '../../../src/provisioning/cloud-control-provider.js';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/provisioning/cloud-control-provider.ts'),
  'utf-8'
);

/**
 * The expression this issue is about, in every identifier spelling AND every
 * whitespace shape the file can take.
 *
 * The identifier is captured and back-referenced so a rename of the caught
 * binding cannot slip a site past the fence. The whitespace flexibility is not
 * decoration and was MEASURED missing: with the fence's first, rigid spelling,
 * review re-introduced the defect as a formatter-WRAPPED ternary
 *
 *     error instanceof Error
 *       ? error.message
 *       : String(error)
 *
 * and BOTH tests in this file passed green. That wrap is not exotic -- it is
 * what Prettier itself emits at this repo's `printWidth` of 100 for an
 * identifier a few characters longer than `error`, and one surviving site in
 * the file already sits at 97 characters. A fence whose only job is catching a
 * sixteenth site must not be defeated by the repo's own formatter.
 */
const BARE_STRINGIFY =
  /(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\s*\1\s*\)/g;

describe('cloud-control-provider bare String() out-throw (#3309)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudControlProvider();
  });

  it('degrades an enrichment whose failure cannot be stringified, instead of failing the create', async () => {
    // `AWS::KMS::Key` takes the ARN-construction branch, whose catch is one of
    // the fifteen and whose try contains exactly one call --
    // `accountInfoForSynthesizedArn`. Rejecting THAT with a null-prototype
    // object is what reaches the catch; a first cut rejected the SDK send
    // instead and never entered this branch at all, so the case passed while
    // the site it names was reverted (measured).
    //
    // Under the bare form this create rejects with `TypeError: Cannot convert
    // object to primitive value` and the user is told nothing about the key.
    mockGetAccountInfo.mockRejectedValue(
      Object.assign(Object.create(null) as object, { code: 'ECONNRESET' })
    );
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({
          ProgressEvent: { RequestToken: 'tok', OperationStatus: 'SUCCESS', Identifier: 'key-1' },
        });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: 'key-1' },
        });
      }
      return Promise.resolve({});
    });

    const result = await provider.create('Key', 'AWS::KMS::Key', {});

    // The CREATE succeeded and reported the physical id -- the degradation held.
    expect(result.physicalId).toBe('key-1');
    // ...and nothing anywhere reported a primitive-conversion failure.
    const logged = [...mockLoggerDebug.mock.calls, ...mockLoggerWarn.mock.calls]
      .flat()
      .map((c) => String(c))
      .join('\n');
    expect(logged).not.toContain('convert object to primitive');
  });

  it('warns about a remnant whose cleanup rejected with a value that cannot be stringified (go-to-k/cdkd#5254)', async () => {
    // `cleanupFailedCreateRemnant`'s catch, converted from the bare ternary.
    // `delete()` wraps every failure today, so the remnant delete is stubbed
    // to reject with the shape `String()` throws for. Under the bare form the
    // cleanup throws `TypeError: Cannot convert object to primitive value`
    // out of its catch, replacing the create failure the caller rethrows.
    vi.spyOn(provider, 'delete').mockRejectedValue(
      Object.assign(Object.create(null) as object, { code: 'ECONNRESET' })
    );
    const createFailure = new CloudControlOperationFailedError(
      'stabilization failed',
      'AWS::Synthetics::Canary',
      'Canary',
      'cdkd-remnant',
      'GeneralServiceException',
      'CREATE'
    );
    const cleanup = (
      provider as unknown as {
        cleanupFailedCreateRemnant(
          error: unknown,
          resourceType: string,
          logicalId: string,
          mask: (s: string) => string
        ): Promise<void>;
      }
    ).cleanupFailedCreateRemnant(createFailure, 'AWS::Synthetics::Canary', 'Canary', (s) => s);

    await expect(cleanup).resolves.toBeUndefined();
    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain(
      'Failed to delete the remnant cdkd-remnant left by the failed CREATE of Canary ' +
        '(a retry may fail with AlreadyExists until it is removed manually): ' +
        'a value that could not be converted to text'
    );
  });

  it('leaves exactly the one documented exception, and no sixteenth site', () => {
    const matches = [...SOURCE.matchAll(BARE_STRINGIFY)];
    const withContext = matches.map((m) => {
      const before = SOURCE.slice(0, m.index ?? 0);
      const line = before.split('\n').length;
      const lineText = SOURCE.split('\n')[line - 1] ?? '';
      // `//` and the ` * ` of a block comment, because this file documents the
      // banned form in BOTH. Missing a comment shape is fail-LOUD (the mention
      // counts as live and reds the fence rather than hiding a site), but a
      // false red on an ordinary doc edit is still a false red.
      const trimmed = lineText.trim();
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
      return { line, isComment };
    });

    // ONE is inside a comment: the paragraph in the re-poll warn explaining why
    // the bare form is wrong there, written by go-to-k/cdkd#3236. It is prose
    // about the defect, not the defect.
    const comments = withContext.filter((m) => m.isComment);
    expect(comments, 'the explanatory comment should still quote the banned form').toHaveLength(1);

    // NONE is live. `cleanupFailedCreateRemnant`'s catch kept the bare form
    // as an unreachable carve-out until go-to-k/cdkd#5254 converted it to
    // `describeAwsFailure(cleanupError).detail`, byte-identical for every value
    // `String()` converts.
    const live = withContext.filter((m) => !m.isComment);
    expect(live).toHaveLength(0);

    // Non-vacuity, and the assertion that actually buys it: the comment
    // check above already implies a non-zero match count, so a bare
    // `toBeGreaterThan(0)` would be dead. What a silently-stopped regex CANNOT
    // fake is the replacement's presence.
    expect(SOURCE).toContain('describeAwsFailure(error).detail');
    expect(SOURCE).toContain('describeAwsFailure(cleanupError).detail');
  });
});
