#!/usr/bin/env node
/**
 * Real-AWS probe for stack-lock renewal and conditional release (issue #2168).
 *
 * Drives cdkd's OWN `LockManager` (from `dist/`) against the real, versioned
 * state bucket. The unit suite mocks S3, so it can prove the code issues the
 * conditional calls but not that S3 HONOURS them -- and the whole fix rests on
 * two facts only a live run can settle:
 *
 *   - the ETag captured from a PutObject response is accepted verbatim as an
 *     `If-Match` value (ETags come back quoted, and a bad round-trip here
 *     fails OPEN: every conditional call would 412 and the process would
 *     refuse to release its own lock);
 *   - `If-Match` on DeleteObject is evaluated against the CURRENT version on a
 *     VERSIONED bucket, which is the shape `cdkd bootstrap` creates.
 *
 * Every step prints a receipt, so a probe that silently did not run cannot be
 * read as a pass.
 *
 * usage: node lock-probe.mjs <bucket> <region> <stackName>
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { LockManager } from '../../../dist/index.js';

const [bucket, region, stackName] = process.argv.slice(2);
if (!bucket || !region || !stackName) {
  console.error('usage: node lock-probe.mjs <bucket> <region> <stackName>');
  process.exit(2);
}

const PREFIX = 'cdkd';
const KEY = `${PREFIX}/${stackName}/${region}/lock.json`;
const s3 = new S3Client({ region });
const config = { bucket, prefix: PREFIX };

let passed = 0;
const pass = (msg) => {
  passed += 1;
  console.log(`[probe] PASS ${passed}: ${msg}`);
};
const fail = (msg) => {
  console.error(`[probe] FAIL: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readLock() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function wipeLock() {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: KEY })).catch(() => undefined);
}

async function main() {
  await wipeLock();

  // --- 1. A lock outliving its own TTL stays held ---------------------------
  // The exact scenario in the issue: with a 12s TTL and no renewal, the lock
  // would have read as FREE to the next process 8 seconds before this arm ends.
  {
    const lm = new LockManager(s3, config, { ttlMinutes: 0.2 });
    if ((await lm.acquireLock(stackName, region, 'probe-owner', 'renewal-probe')) !== true) {
      fail('could not acquire a lock on a clean key');
    }
    const first = await readLock();
    if (!first) fail('lock.json absent right after a successful acquire');
    pass(`acquired; initial expiresAt=${new Date(first.expiresAt).toISOString()}`);

    await sleep(20_000);

    const later = await readLock();
    if (!later) fail('lock.json vanished while the operation was still running');
    if (!(later.expiresAt > first.expiresAt)) {
      fail(`expiresAt did not move (${first.expiresAt} -> ${later.expiresAt}); renewal never ran`);
    }
    if (!(later.expiresAt > Date.now())) {
      fail('lock had already lapsed 20s into a 12s-TTL operation: renewal is not keeping up');
    }
    if (later.owner !== 'probe-owner' || later.operation !== 'renewal-probe') {
      fail(`renewal rewrote the identity fields: ${JSON.stringify(later)}`);
    }
    pass(
      `still held 20s into a 12s TTL; expiresAt advanced to ` +
        `${new Date(later.expiresAt).toISOString()} with owner/operation intact`
    );

    // --- 2. Releasing removes it, conditionally --------------------------
    // Proves the captured ETag is accepted as an `If-Match` value by real S3.
    // A quoting mistake here would 412 and leave the lock behind.
    await lm.releaseLock(stackName, region);
    if ((await readLock()) !== null) fail('conditional release left the lock in place');
    pass('conditional release removed the lock this process owned');
  }

  // --- 3. A process that lost its lock must not delete the new owner's ------
  // Renewal is disabled for this arm on purpose: with it on, the heartbeat
  // would notice the takeover first and the assertion could not tell which of
  // the two mechanisms did the work. What is under test here is the DELETE.
  {
    const lm = new LockManager(s3, config, { ttlMinutes: 30, disableRenewal: true });
    if ((await lm.acquireLock(stackName, region, 'probe-owner-a', 'cascade-probe')) !== true) {
      fail('could not acquire for the cascade arm');
    }
    const foreign = JSON.stringify(
      { owner: 'probe-owner-b', timestamp: Date.now(), expiresAt: Date.now() + 600_000, operation: 'takeover' },
      null,
      2
    );
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: KEY }));
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: KEY, Body: foreign, ContentType: 'application/json' })
    );

    await lm.releaseLock(stackName, region);

    const survivor = await readLock();
    if (!survivor) {
      fail("release deleted the SECOND process's lock -- this is the cascade issue #2168 describes");
    }
    if (survivor.owner !== 'probe-owner-b') {
      fail(`unexpected lock body after release: ${JSON.stringify(survivor)}`);
    }
    pass("release left the replacement owner's lock untouched");

    // --- 4. force-unlock still clears a lock this process does not own ----
    await lm.forceReleaseLock(stackName, region);
    if ((await readLock()) !== null) fail('force-unlock failed to remove a foreign lock');
    pass('force-unlock removed a foreign lock (still unconditional, by contract)');
  }

  // --- 5. Taking over a genuinely expired lock ------------------------------
  {
    const stale = new LockManager(s3, config, { ttlMinutes: 0.05, disableRenewal: true });
    if ((await stale.acquireLock(stackName, region, 'probe-owner-stale', 'expiry-probe')) !== true) {
      fail('could not seed a short-TTL lock');
    }
    await sleep(6000);

    const taker = new LockManager(s3, config, { ttlMinutes: 30, disableRenewal: true });
    if ((await taker.acquireLock(stackName, region, 'probe-owner-taker', 'takeover')) !== true) {
      fail('could not take over an expired lock');
    }
    const held = await readLock();
    if (held?.owner !== 'probe-owner-taker') {
      fail(`takeover did not install the new owner: ${JSON.stringify(held)}`);
    }
    // Deliberately does NOT claim the delete's `IfMatch` did any work: an
    // unconditional takeover delete passes this arm identically, because
    // nothing here changes the object between the read and the delete. The
    // condition is fenced by unit tests; what this arm settles is that the
    // conditional call is ACCEPTED by real S3 and the takeover still works.
    pass('took over an expired lock (conditional delete accepted by S3, fresh acquire succeeded)');

    await taker.releaseLock(stackName, region);
    if ((await readLock()) !== null) fail('takeover lock was not released');
    pass('takeover lock released');
  }

  // --- 6. Conditional delete against an object that is GONE ---------------
  // The SDK model documents the absent-object outcome for
  // `IfMatchLastModifiedTime` / `IfMatchSize` but NOT for `DeleteObject`'s
  // plain `IfMatch`, so whether S3 answers 404 or 412 here is unverified from
  // the docs -- and the two land in opposite branches. If it were 412,
  // `releaseLock` would print "another cdkd process now holds it" about a lock
  // that does not exist. The answer is printed, not just asserted, so the run
  // RECORDS what S3 actually did.
  {
    const lm = new LockManager(s3, config, { ttlMinutes: 30, disableRenewal: true });
    if ((await lm.acquireLock(stackName, region, 'probe-owner-vanish', 'vanish-probe')) !== true) {
      fail('could not acquire for the vanishing-lock arm');
    }
    // Someone force-unlocked underneath us.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: KEY }));

    let observed = 'no error';
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: KEY, IfMatch: '"deadbeef"' }));
    } catch (err) {
      observed = `${err?.name ?? 'unknown'} / ${err?.$metadata?.httpStatusCode ?? '?'}`;
    }

    // Whatever S3 answered, releasing must be quiet and must not resurrect or
    // remove anything, and the stack must be acquirable again straight away.
    await lm.releaseLock(stackName, region);
    if ((await readLock()) !== null) fail('release re-created a lock that had been removed');

    const next = new LockManager(s3, config, { ttlMinutes: 30, disableRenewal: true });
    if ((await next.acquireLock(stackName, region, 'probe-owner-next', 'after-vanish')) !== true) {
      fail('a stack whose lock was removed underneath its holder was not re-acquirable');
    }
    await next.releaseLock(stackName, region);
    if ((await readLock()) !== null) fail('post-vanish lock was not released');
    // ASSERT the answer, do not merely print it. `releaseLock`'s branching
    // depends on this being a not-found rather than a 412: on 412 it would
    // print "another cdkd process now holds it" about a lock that does not
    // exist, and this arm would pass either way. Pinning it here means a
    // change in S3's behaviour fails the run instead of silently invalidating
    // the branch.
    // `no error` is a PASS, not a failure: if the conditional delete succeeds
    // outright, `releaseLock` never enters the catch and the branch under
    // discussion is not reached at all. Only a DIFFERENT error is a problem.
    if (!/404|NoSuchKey|NotFound|no error/i.test(observed)) {
      fail(
        `a conditional delete against an absent object answered "${observed}", not a not-found. ` +
          `isGoneError no longer covers this case, so releaseLock will misreport it as a foreign lock.`
      );
    }
    pass(`released cleanly after the lock vanished underneath (S3 answered: ${observed})`);
  }

  if (passed !== 8) fail(`expected 8 receipts, got ${passed}`);
  console.log(`[probe] all ${passed} lock probes passed`);
}

main().catch((err) => {
  console.error('[probe] FAIL: unexpected error');
  console.error(err);
  process.exit(1);
});
