import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { displaySafe } from '../../../src/utils/display-safe.js';
import {
  normalizeReplicationRules,
  warnIfPurgeIsReplicated,
  clearReplicationProbeCache,
  DEFAULT_PURGED_OBJECT_DESCRIPTION,
} from '../../../src/state/s3-replication-purge-gap.js';

/**
 * Issue [#2447](https://github.com/go-to-k/cdkd/issues/2447) — the detector
 * that tells a user their "purged" secret is still readable in a replica.
 *
 * BOTH POLARITIES are pinned everywhere, because a detector that always warns
 * and a detector that never warns both pass a one-sided suite: every
 * `expect(warn).toHaveBeenCalled()` here has a sibling asserting silence on
 * the inverted input, and the coverage decision (which prefix covers which
 * key) is asserted against a rule that is ENABLED and REAL but points at a
 * different prefix — not merely against the absence of a configuration.
 */

const BUCKET = 'cdkd-state-123456789012';
const KEY = 'cdkd/MyStack/us-east-1/rollback-journal.json';

interface Recorded {
  name: string;
  bucket: string | undefined;
  owner: string | undefined;
}

describe('S3 replication purge gap (issue #2447)', () => {
  let recorded: Recorded[];
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The probe is cached per BUCKET for the process lifetime, so without this
    // the first test in the file would answer every later one.
    clearReplicationProbeCache();
    recorded = [];
    warn = vi.fn();
  });

  const logger = (): { warn: (m: string) => void } => ({
    warn: warn as unknown as (m: string) => void,
  });

  /** An S3 double that answers `GetBucketReplication` with `answer`. */
  const stub = (
    answer: (() => unknown) | unknown
  ): { send: (cmd: unknown) => Promise<unknown> } => ({
    send: (cmd: unknown) => {
      const c = cmd as {
        constructor: { name: string };
        input: { Bucket?: string; ExpectedBucketOwner?: string };
      };
      recorded.push({
        name: c.constructor.name,
        bucket: c.input.Bucket,
        owner: c.input.ExpectedBucketOwner,
      });
      if (typeof answer === 'function') return Promise.resolve((answer as () => unknown)());
      return Promise.resolve(answer);
    },
  });

  /** Build an SDK-shaped error: `name` carries the wire code. */
  const s3Error = (code: string, status?: number): Error => {
    const error = new Error(`${code}: refused`) as Error & {
      $metadata?: { httpStatusCode: number };
    };
    error.name = code;
    if (status !== undefined) error.$metadata = { httpStatusCode: status };
    return error;
  };

  const enabledRule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    Status: 'Enabled',
    Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' },
    ...over,
  });

  describe('normalizeReplicationRules', () => {
    it('reads the V2 `Filter.Prefix`', () => {
      expect(
        normalizeReplicationRules({ Rules: [enabledRule({ Filter: { Prefix: 'cdkd/' } })] })
      ).toEqual([{ prefix: 'cdkd/', destination: 'cdkd-state-replica', enabled: true }]);
    });

    it('reads the V2 `Filter.And.Prefix` when the rule combines prefix and tags', () => {
      expect(
        normalizeReplicationRules({
          Rules: [enabledRule({ Filter: { And: { Prefix: 'cdkd/' } } })],
        })
      ).toEqual([{ prefix: 'cdkd/', destination: 'cdkd-state-replica', enabled: true }]);
    });

    it('reads the V1 top-level `Prefix` when there is no `Filter`', () => {
      expect(normalizeReplicationRules({ Rules: [enabledRule({ Prefix: 'cdkd/' })] })).toEqual([
        { prefix: 'cdkd/', destination: 'cdkd-state-replica', enabled: true },
      ]);
    });

    it('treats a TAG-ONLY filter as covering EVERYTHING, not as covering nothing', () => {
      // Tags cannot be evaluated without reading each object, and the two
      // possible errors are not symmetric: a spurious warning sends a reader
      // to look at a replica, a spurious silence leaves them believing a
      // secret is gone.
      expect(
        normalizeReplicationRules({
          Rules: [enabledRule({ Filter: { Tag: { Key: 'a' } } as never })],
        })
      ).toEqual([{ prefix: '', destination: 'cdkd-state-replica', enabled: true }]);
    });

    it('treats an EMPTY `Filter` as the whole bucket rather than falling back to `Prefix`', () => {
      // A V2 rule carrying both an empty `Filter` and a legacy `Prefix` is
      // malformed; the `Filter` is the authoritative half, and reading the
      // stale `Prefix` would narrow coverage on the strength of a field S3
      // ignores.
      expect(
        normalizeReplicationRules({
          Rules: [enabledRule({ Filter: {}, Prefix: 'somewhere-else/' })],
        })
      ).toEqual([{ prefix: '', destination: 'cdkd-state-replica', enabled: true }]);
    });

    it('treats a rule with neither `Filter` nor `Prefix` as the whole bucket', () => {
      expect(normalizeReplicationRules({ Rules: [enabledRule()] })).toEqual([
        { prefix: '', destination: 'cdkd-state-replica', enabled: true },
      ]);
    });

    it('KEEPS a Disabled rule, flagged, and treats a missing Status as enabled', () => {
      // Disabling a rule stops FUTURE replication; it does not remove what the
      // rule already copied, so a bucket whose rule is disabled TODAY can still
      // hold every body ever purged. Dropping it was the first cut and is the
      // reassured-user failure this module exists to remove.
      //
      // `Status` is required by the model, so its absence means the response
      // was not what we assumed — the same "assume the unsafe thing" rule the
      // sibling purge applies to a missing `IsLatest`.
      expect(
        normalizeReplicationRules({
          Rules: [
            enabledRule({ Status: 'Disabled', Destination: { Bucket: 'arn:aws:s3:::off' } }),
            { Destination: { Bucket: 'arn:aws:s3:::unstated' } },
          ],
        })
      ).toEqual([
        { prefix: '', destination: 'off', enabled: false },
        { prefix: '', destination: 'unstated', enabled: true },
      ]);
    });

    it('strips the bucket ARN in ANY partition and names a cross-account destination', () => {
      expect(
        normalizeReplicationRules({
          Rules: [
            enabledRule({ Destination: { Bucket: 'arn:aws-cn:s3:::cn-replica' } }),
            enabledRule({
              Destination: { Bucket: 'arn:aws:s3:::other-acct', Account: '999988887777' },
            }),
            enabledRule({ Destination: {} }),
            // `Destination` ABSENT entirely — not a shape S3 returns (the
            // field is required) but the one a defensive reader must not
            // crash on, and the sibling `Destination: {}` above is the
            // half that was already covered.
            enabledRule({ Destination: undefined }),
          ],
        }).map((r) => r.destination)
      ).toEqual([
        'cn-replica',
        'other-acct (account 999988887777)',
        '<destination not named by the replication rule>',
        '<destination not named by the replication rule>',
      ]);
    });

    it('returns nothing for an empty rule list', () => {
      expect(normalizeReplicationRules({})).toEqual([]);
      expect(normalizeReplicationRules({ Rules: [] })).toEqual([]);
    });
  });

  describe('warnIfPurgeIsReplicated', () => {
    it('WARNS, naming the destination and what survives, when a rule covers the key', async () => {
      const s3 = stub({
        ReplicationConfiguration: { Rules: [enabledRule({ Filter: { Prefix: 'cdkd/' } })] },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: logger(),
        objectDescription: 'the rollback journal',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain(BUCKET);
      expect(message).toContain('cdkd-state-replica');
      expect(message).toContain('the rollback journal');
      // The mechanism, so the reader can tell this is not a cdkd bug to file.
      expect(message).toContain('NEVER replicates a version-id delete');
      // The remedy, which is theirs and not cdkd's.
      expect(message).toContain('list-object-versions');
    });

    it('falls back to the SHARED default description when the caller names nothing', async () => {
      const s3 = stub({ ReplicationConfiguration: { Rules: [enabledRule()] } });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      expect(String(warn.mock.calls[0]![0])).toContain(DEFAULT_PURGED_OBJECT_DESCRIPTION);
    });

    it('is SILENT when an enabled rule replicates a DIFFERENT prefix', async () => {
      // The inverted polarity of the test above, and the one that fails if
      // coverage ever degrades to "any rule at all". The rule is enabled, has
      // a real destination, and simply does not cover cdkd's keys.
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [enabledRule({ Filter: { Prefix: 'analytics/' } })],
        },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(warn).not.toHaveBeenCalled();
    });

    it('WARNS about a Disabled rule too, and says the rule is disabled', async () => {
      // The inverse of the obvious reading: a disabled rule replicates nothing
      // MORE, but everything it already copied is still sitting in the
      // destination. Staying silent would be the reassured-user failure.
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [enabledRule({ Status: 'Disabled', Filter: { Prefix: 'cdkd/' } })],
        },
      });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain('cdkd-state-replica');
      expect(message).toContain('rule currently Disabled');
    });

    it('reads ReplicationConfigurationNotFoundError as the ANSWER "not replicated", not as a failure', async () => {
      // S3 reports "no replication configuration" as an ERROR, not as an empty
      // response. Nearly every bucket takes this arm, so reading it as a
      // failure would warn the whole userbase.
      //
      // Silence alone does NOT pin that, and asserting only silence left this
      // case unfalsifiable: an UNRECOGNISED error is silent too. The
      // discriminator is CACHING — a definitive answer is kept for the process
      // while a failure is retried — so the second purge must send nothing.
      const s3 = stub(() => {
        throw s3Error('ReplicationConfigurationNotFoundError', 404);
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(warn).not.toHaveBeenCalled();
      expect(recorded).toHaveLength(1);
    });

    it('reads a 200 with no ReplicationConfiguration as "not replicated" too', async () => {
      // The SDK models the field as optional; a modelled field is not a
      // promise that the API populates it. Pinned by CACHING for the same
      // reason as the not-found arm above — silence alone cannot tell an
      // ANSWER apart from an unhandled shape.
      const s3 = stub({});
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      expect(warn).not.toHaveBeenCalled();
      expect(recorded).toHaveLength(1);
    });

    it('does not WARN on AccessDenied, and does not retry it', async () => {
      // Most callers will not hold `s3:GetReplicationConfiguration`. Warning
      // there would demand a permission from everyone in order to inform
      // almost no one; re-probing would spend a denied call per purge.
      const s3 = stub(() => {
        throw s3Error('AccessDenied', 403);
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(warn).not.toHaveBeenCalled();
      expect(recorded).toHaveLength(1);
    });

    it('caches a SUCCESSFUL probe per bucket but re-evaluates coverage per call', async () => {
      const s3 = stub({
        ReplicationConfiguration: { Rules: [enabledRule({ Filter: { Prefix: 'cdkd/' } })] },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      // Same bucket, a key the SAME rule does not cover: one API call, and the
      // second purge is silent. A cached VERDICT rather than a cached
      // configuration would have warned here.
      await warnIfPurgeIsReplicated(s3, BUCKET, ['elsewhere/x.json'], { logger: logger() });

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.name).toBe('GetBucketReplicationCommand');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('RETRIES a transient failure instead of caching it', async () => {
      let attempt = 0;
      const s3 = stub(() => {
        attempt += 1;
        if (attempt === 1) throw s3Error('SlowDown', 503);
        return { ReplicationConfiguration: { Rules: [enabledRule()] } };
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      expect(warn).not.toHaveBeenCalled();

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      expect(recorded).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('threads ExpectedBucketOwner onto the probe', async () => {
      const s3 = stub({});
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        requestFields: { ExpectedBucketOwner: '123456789012' },
        logger: logger(),
      });
      expect(recorded[0]!.owner).toBe('123456789012');
      expect(recorded[0]!.bucket).toBe(BUCKET);
    });

    it('sends nothing at all for an empty key list', async () => {
      await warnIfPurgeIsReplicated(stub({}), BUCKET, [], { logger: logger() });
      expect(recorded).toEqual([]);
    });

    it('never throws, even when the probe rejects with a non-Error', async () => {
      const s3 = { send: () => Promise.reject('not an Error') };
      await expect(
        warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() })
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('never throws when the warning SINK throws', async () => {
      const s3 = stub({ ReplicationConfiguration: { Rules: [enabledRule()] } });
      await expect(
        warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
          logger: {
            warn: () => {
              throw new Error('sink is gone');
            },
          },
        })
      ).resolves.toBeUndefined();
    });

    it('de-duplicates destinations and elides past the third', async () => {
      const dest = (name: string): Record<string, unknown> =>
        enabledRule({ Destination: { Bucket: `arn:aws:s3:::${name}` } });
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [dest('r1'), dest('r1'), dest('r2'), dest('r3'), dest('r4')],
        },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain('Destination(s): r1, r2, r3');
      expect(message).toContain('(and 1 more;');
      // The elided name must be RECOVERABLE -- a truncated warning naming a
      // replica cdkd never names anywhere leaves the reader unable to act.
      expect(message).toContain(`get-bucket-replication --bucket ${BUCKET}`);
      expect(message).not.toContain('r4');
    });

    it('warns when ONE of several keys is covered, not only when every key is', async () => {
      // `some` vs `every` is invisible to a single-key population -- for one
      // element the two are the same function -- and `cdkd gc` hands this
      // thousands of keys under a shared prefix. Under `every`, one key
      // outside the rule would silence a purge of 2999 covered ones.
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [enabledRule({ Filter: { Prefix: 'cdkd/' } })],
        },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, ['elsewhere/x.json', KEY], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('is SILENT when NONE of several keys is covered', async () => {
      // The control for the case above: with the same rule and no covered key
      // the answer must flip, so the assertion above is about coverage rather
      // than about the rule merely existing.
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [enabledRule({ Filter: { Prefix: 'cdkd/' } })],
        },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, ['elsewhere/x.json', 'other/y.json'], {
        logger: logger(),
      });

      expect(warn).not.toHaveBeenCalled();
    });

    it('caches an authorization refusal that carries NO http status', async () => {
      // Fences the `PERMANENT_DENIALS` half of the permanence test on its own.
      // The AccessDenied case above carries a 403 too, so it is satisfied by
      // either disjunct and cannot tell which one is doing the work.
      const s3 = stub(() => {
        throw s3Error('AccessDeniedException');
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(recorded).toHaveLength(1);
    });

    it('caches a 403 whose error code is NOT in the denial list', async () => {
      // Fences the `httpStatus === 403` half on its own. The real smithy shape
      // for an unmodelled error falls back to the status text rather than to
      // any code we could enumerate.
      const s3 = stub(() => {
        throw s3Error('Forbidden', 403);
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(recorded).toHaveLength(1);
    });

    it('RETRIES a credential-propagation 403 instead of caching it', async () => {
      // `InvalidAccessKeyId` arrives as a 403 and is the classic blip while an
      // IAM principal or an assumed-role credential propagates. Cached as
      // permanent, one such blip on the first purge of a long deploy would
      // silence the detector for the whole process.
      let attempt = 0;
      const s3 = stub(() => {
        attempt += 1;
        if (attempt === 1) throw s3Error('InvalidAccessKeyId', 403);
        return { ReplicationConfiguration: { Rules: [enabledRule()] } };
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(recorded).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('reports an undeterminable probe through the caller\'s DEBUG sink', async () => {
      // The arm that decides to stay quiet still has to say WHY somewhere, and
      // it has to name the grant -- otherwise a user who wants the check has no
      // way to find out it is switched off.
      const debug = vi.fn();
      const s3 = stub(() => {
        throw s3Error('AccessDenied', 403);
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: { warn: warn as unknown as (m: string) => void, debug },
      });

      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(1);
      const message = String(debug.mock.calls[0]![0]);
      expect(message).toContain(BUCKET);
      expect(message).toContain('s3:GetReplicationConfiguration');
      expect(message).toContain('AccessDenied');
    });

    it('sanitizes the AWS-supplied REASON on the debug line', async () => {
      // The last text in this module that reaches a terminal from an AWS
      // response. The destination and the bucket are both fenced; without this
      // the reason was the one raw path left.
      const debug = vi.fn();
      const s3 = stub(() => {
        throw s3Error('AccessDenied\u001b[31m', 403);
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: { warn: warn as unknown as (m: string) => void, debug },
      });

      const message = String(debug.mock.calls[0]![0]);
      expect(message).toContain(displaySafe('AccessDenied\u001b[31m: refused'));
      expect(message).not.toContain('\u001b[31m');
    });

    it('calls the caller\'s `debug` as a METHOD, so a `this`-reading sink works', async () => {
      // Every logger in this repo is a class instance whose `debug` reads
      // `this`. Destructuring the function off the sink and calling it bare
      // throws a TypeError into the outer catch -- a silently dead debug line.
      const seen: string[] = [];
      const sink = {
        prefix: 's3-replication-check',
        warn: warn as unknown as (m: string) => void,
        debug(message: string): void {
          // Reads `this`: a bare call would throw here.
          seen.push(`[${this.prefix}] ${message}`);
        },
      };
      const s3 = stub(() => {
        throw s3Error('AccessDenied', 403);
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: sink });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('[s3-replication-check]');
    });

    it('warns ONCE per object description and demotes the repeats to debug', async () => {
      // The varying half of the message is the description; the rest is a fact
      // about the bucket. Thirty custom resources repeating a 600-character
      // warning adds nothing and erodes the purge failure warning beside it.
      const debug = vi.fn();
      const sink = { warn: warn as unknown as (m: string) => void, debug };
      const dest = (name: string): Record<string, unknown> =>
        enabledRule({ Destination: { Bucket: `arn:aws:s3:::${name}` } });
      const s3 = stub({
        ReplicationConfiguration: { Rules: [dest('zulu'), dest('alpha')] },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: sink, objectDescription: 'a' });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: sink, objectDescription: 'a' });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]![0])).toContain('already reported once this run');
      // The repeat names the SAME set as the warn line, in the same order --
      // two lines about one set that order it differently read as two sets.
      expect(String(debug.mock.calls[0]![0])).toContain('alpha, zulu');
    });

    it('gives each object description its OWN slot, so a demoted caller cannot eat another\'s', async () => {
      // `lock-manager.ts` routes this module's `warn` to `debug` on the release
      // path. Keyed on the bucket alone, the lock's demoted line would consume
      // the one warning the rollback journal needed and the journal's purge
      // would be silent.
      const s3 = stub({ ReplicationConfiguration: { Rules: [enabledRule()] } });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: logger(),
        objectDescription: 'the lock heartbeat',
      });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: logger(),
        objectDescription: 'the rollback journal',
      });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]![0])).toContain('the rollback journal');
    });

    it('keys the probe cache on the OWNER assertion as well as the bucket', async () => {
      // A mismatched-owner 403 is an answer about THAT caller's request. Cached
      // under the bare bucket name it silenced every correctly-scoped caller in
      // the process -- and cdkd has both shapes today (the custom-resource
      // provider probes with no owner, the state backend and lock manager with
      // one).
      const s3 = stub(() => {
        throw s3Error('AccessDenied', 403);
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        requestFields: { ExpectedBucketOwner: '123456789012' },
        logger: logger(),
      });

      expect(recorded).toHaveLength(2);
    });

    it('shares ONE in-flight probe between concurrent callers', async () => {
      let release: (value: unknown) => void = () => {};
      const s3 = stub(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );

      const first = warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: logger(),
        objectDescription: 'first',
      });
      const second = warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: logger(),
        objectDescription: 'second',
      });
      release({ ReplicationConfiguration: { Rules: [enabledRule()] } });
      await Promise.all([first, second]);

      // ONE call, both callers answered. A cache that stored the settled value
      // rather than the in-flight promise would have issued two.
      expect(recorded).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('does not poison the cache when the SDK rejects with a non-object', async () => {
      // The rejection used to reach the classifier, throw a TypeError inside the
      // probe's own catch, and leave a REJECTED promise cached for the process
      // -- after which every purge on that bucket fell into the outer catch
      // with no warning and no debug line: a silently dead detector.
      //
      // Two mechanisms, and this case now fences BOTH halves separately:
      // `probe`'s rejection arm keeps the failure out of the cache (the
      // sibling below isolates that), and the null-guards decide WHAT the
      // debug line reports -- the rejection itself rather than the
      // classifier's own crash, which is the assertion at the bottom.
      let attempt = 0;
      const s3 = stub(() => {
        attempt += 1;
        if (attempt === 1) throw null;
        return { ReplicationConfiguration: { Rules: [enabledRule()] } };
      });
      const debug = vi.fn();

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], {
        logger: { warn: warn as unknown as (m: string) => void, debug },
      });
      expect(warn).not.toHaveBeenCalled();
      // The guards' own observable effect, and what fences them apart from the
      // rejection arm: guarded, the debug line reports the REJECTION; without
      // them it reports the classifier's own TypeError instead.
      expect(String(debug.mock.calls[0]![0])).toContain(': null');
      expect(String(debug.mock.calls[0]![0])).not.toContain('Cannot read properties');

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      expect(recorded).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('classifies on `Code` when `name` is specific but uninformative', async () => {
      // Collapsing the two to one string let a rejection carrying a specific
      // `name` beside `Code: InvalidAccessKeyId` miss the transient set and be
      // cached as permanent by the 403 rule -- the regression that set exists
      // to stop. The generic-`Error` case below is the other half.
      let attempt = 0;
      const s3 = stub(() => {
        attempt += 1;
        if (attempt === 1) {
          const e = s3Error('SomeWrapperError', 403) as Error & { Code?: string };
          e.Code = 'InvalidAccessKeyId';
          throw e;
        }
        return { ReplicationConfiguration: { Rules: [enabledRule()] } };
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(recorded).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('reads `Code` when `name` is the GENERIC `Error`', async () => {
      // Every `Error` inherits `name === 'Error'`. Preferring `name`
      // unconditionally made the `Code` fallback dead and classified
      // `{ name: 'Error', Code: 'AccessDenied' }` as retryable -- so a denied
      // principal would have re-probed on every purge for the whole run.
      const s3 = stub(() => {
        const e = new Error('denied') as Error & { Code?: string };
        e.Code = 'AccessDenied';
        throw e;
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(warn).not.toHaveBeenCalled();
      expect(recorded).toHaveLength(1);
    });

    it('survives a rejection whose own stringification throws', async () => {
      // Isolates the cached promise's REJECTION ARM from the null-guards in
      // `errorCodes` / `httpStatus`: the guards pass this value through happily
      // and `describe()` is what explodes, so only the rejection arm keeps the
      // failure out of the cache. Without it the pair is merely jointly fenced.
      let attempt = 0;
      const s3 = {
        send: (cmd: unknown) => {
          const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
          recorded.push({ name: c.constructor.name, bucket: undefined, owner: undefined });
          attempt += 1;
          if (attempt === 1) {
            return Promise.reject({
              name: 'Weird',
              toString() {
                throw new Error('stringification exploded');
              },
            });
          }
          return Promise.resolve({ ReplicationConfiguration: { Rules: [enabledRule()] } });
        },
      };

      await expect(
        warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() })
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });
      expect(recorded).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns again for a DIFFERENT destination set under the same description', async () => {
      // The dedupe key carries the destinations, not just the description.
      // Without them, purging a `cdkd/dev/...` key that matches only the first
      // rule burns the slot, and the later `cdkd/prod/...` purge -- which also
      // matches a SECOND replica -- is demoted to debug. The user cleans one
      // replica and never learns the other holds the production journal.
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [
            enabledRule({
              Filter: { Prefix: 'cdkd/' },
              Destination: { Bucket: 'arn:aws:s3:::replica-a' },
            }),
            enabledRule({
              Filter: { Prefix: 'cdkd/prod' },
              Destination: { Bucket: 'arn:aws:s3:::replica-b' },
            }),
          ],
        },
      });
      const desc = 'the rollback journal';

      await warnIfPurgeIsReplicated(s3, BUCKET, ['cdkd/dev/us-east-1/rollback-journal.json'], {
        logger: logger(),
        objectDescription: desc,
      });
      await warnIfPurgeIsReplicated(s3, BUCKET, ['cdkd/prod/us-east-1/rollback-journal.json'], {
        logger: logger(),
        objectDescription: desc,
      });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('replica-a');
      expect(String(warn.mock.calls[0]![0])).not.toContain('replica-b');
      expect(String(warn.mock.calls[1]![0])).toContain('replica-b');
    });

    it('gives each BUCKET its own warn slot', async () => {
      // The bucket half of the dedupe key. Two state buckets in one process is
      // ordinary (a cross-account read, a second profile), and one warning for
      // both would name the wrong replica.
      const s3 = stub({ ReplicationConfiguration: { Rules: [enabledRule()] } });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger(), objectDescription: 'x' });
      await warnIfPurgeIsReplicated(s3, 'cdkd-state-999988887777', [KEY], {
        logger: logger(),
        objectDescription: 'x',
      });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]![0])).toContain('cdkd-state-999988887777');
    });

    it('does NOT burn the warn slot when the sink throws', async () => {
      // Claiming the slot before the emit lost the one warning for the process
      // whenever the sink failed -- and a real `Logger` reaching a closed
      // stdout throws synchronously.
      const s3 = stub({ ReplicationConfiguration: { Rules: [enabledRule()] } });
      let firstCall = true;
      const flaky = {
        warn: (m: string) => {
          if (firstCall) {
            firstCall = false;
            throw new Error('sink is gone');
          }
          (warn as unknown as (s: string) => void)(m);
        },
      };

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: flaky });
      expect(warn).not.toHaveBeenCalled();

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: flaky });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('appends no tail when the destination count is exactly the naming cap', async () => {
      // The boundary the `(and N more)` suffix hangs off. Only the >cap case
      // was covered, so `elided > 0` could have been `elided >= 0` and every
      // other assertion -- all `toContain` -- would have missed the stray
      // `(and 0 more)`.
      const dest = (name: string): Record<string, unknown> =>
        enabledRule({ Destination: { Bucket: `arn:aws:s3:::${name}` } });
      const s3 = stub({
        ReplicationConfiguration: { Rules: [dest('r1'), dest('r2'), dest('r3')] },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain('Destination(s): r1, r2, r3');
      expect(message).not.toContain('more)');
    });

    it('sanitizes the BUCKET in the pasteable recovery command', async () => {
      // The truncation tail is a command a reader will paste. Every other use
      // of `bucket` in these messages is display-only; this one is not, so it
      // gets the same `asciiOnly` treatment the destinations get.
      const nastyBucket = 'cdkd-state\u001b[31m-000000000000';
      const dest = (name: string): Record<string, unknown> =>
        enabledRule({ Destination: { Bucket: `arn:aws:s3:::${name}` } });
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [dest('r1'), dest('r2'), dest('r3'), dest('r4')],
        },
      });

      await warnIfPurgeIsReplicated(s3, nastyBucket, [KEY], { logger: logger() });

      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain(`--bucket ${displaySafe(nastyBucket, { asciiOnly: true })}`);
      // ...and the s3:// rendering earlier in the SAME string, which is the
      // point of sanitizing once at the top: an escape left in the display
      // half can hide the sanitized command half.
      expect(message).toContain(`s3://${displaySafe(nastyBucket, { asciiOnly: true })}`);
      expect(message).not.toContain(nastyBucket);
    });

    it('keys the warn slot on the RAW bucket, so two buckets cannot collapse into one', async () => {
      // `displaySafe(..., { asciiOnly: true })` replaces a disallowed byte with
      // a SPACE rather than deleting it, so two genuinely different bucket
      // names can sanitize to the same string. The dedupe key is an identity,
      // not display text: sanitizing it would silence the second bucket
      // entirely.
      const rawA = 'cdkd-state-a\u001bb';
      const rawB = 'cdkd-state-a b';
      expect(displaySafe(rawA, { asciiOnly: true })).toBe(displaySafe(rawB, { asciiOnly: true }));

      const s3 = stub({ ReplicationConfiguration: { Rules: [enabledRule()] } });
      await warnIfPurgeIsReplicated(s3, rawA, [KEY], { logger: logger(), objectDescription: 'x' });
      await warnIfPurgeIsReplicated(s3, rawB, [KEY], { logger: logger(), objectDescription: 'x' });

      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('names destinations in SORTED order, not in rule order', async () => {
      // Rule order is S3's. Unsorted, two runs that found the identical set
      // could name a different three -- and the truncation would then hide a
      // different replica each time, which is the half that matters.
      const dest = (name: string): Record<string, unknown> =>
        enabledRule({ Destination: { Bucket: `arn:aws:s3:::${name}` } });
      const s3 = stub({
        ReplicationConfiguration: { Rules: [dest('zulu'), dest('alpha'), dest('mike')] },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(String(warn.mock.calls[0]![0])).toContain('Destination(s): alpha, mike, zulu');
    });

    it('names a CROSS-ACCOUNT destination with its account id', async () => {
      // The scariest shape: the surviving copy is in a bucket the cdkd operator
      // may not be able to read, so the account is the load-bearing half.
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [
            enabledRule({
              Destination: { Bucket: 'arn:aws:s3:::other-acct', Account: '999988887777' },
            }),
          ],
        },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      expect(String(warn.mock.calls[0]![0])).toContain('other-acct (account 999988887777)');
    });

    it('sanitizes the AWS-supplied destination name before it reaches a terminal', async () => {
      // `Destination.Bucket` is read out of an API response, so it is not
      // cdkd-authored text on its way to a terminal.
      const nasty = 'repl\u001b[31mica \u0000';
      const s3 = stub({
        ReplicationConfiguration: {
          Rules: [enabledRule({ Destination: { Bucket: `arn:aws:s3:::${nasty}` } })],
        },
      });

      await warnIfPurgeIsReplicated(s3, BUCKET, [KEY], { logger: logger() });

      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain(displaySafe(nasty));
      expect(message).not.toContain('\u001b[31m');
      expect(message).not.toContain('\u0000');
    });
  });
});
