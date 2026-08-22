import { describe, it, expect, beforeEach } from 'vite-plus/test';

import {
  acquireIdempotencyToken,
  resetIdempotencyTokensForTests,
} from '../../../src/provisioning/providers/idempotency-token.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';

/**
 * Issue #2039. The whole value of the module is that ONE property holds: the
 * token a retry sees is the token the failed attempt sent. Every case here is
 * written so that a derivation using anything per-attempt (a clock, a random,
 * a counter incremented on acquire) fails it.
 */
describe('acquireIdempotencyToken (issue #2039)', () => {
  beforeEach(() => {
    resetIdempotencyTokensForTests();
  });

  it('returns the SAME value for every acquire of one logical create', () => {
    const first = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });
    const second = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });
    const third = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });

    expect(second.value).toBe(first.value);
    expect(third.value).toBe(first.value);
  });

  it('mints a DIFFERENT value once the previous create has been released', () => {
    const first = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });
    first.release();
    const afterSuccess = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });

    // A `--replace` re-create must not be handed back the instance the deploy
    // just terminated: EC2 keeps a RunInstances token for ~24h.
    expect(afterSuccess.value).not.toBe(first.value);
  });

  it('a double release does not advance the generation twice', () => {
    const first = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });
    first.release();
    first.release();
    const second = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });
    second.release();
    const third = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });

    expect(new Set([first.value, second.value, third.value]).size).toBe(3);
  });

  it('separates call sites by scope and resources by logical id', () => {
    const runInstances = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'A' });
    const natGateway = acquireIdempotencyToken({ scope: 'CreateNatGateway', logicalId: 'A' });
    const otherResource = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'B' });

    expect(new Set([runInstances.value, natGateway.value, otherResource.value]).size).toBe(3);
  });

  it('separates two REGIONS deployed by one process', () => {
    const before = process.env['AWS_REGION'];
    try {
      process.env['AWS_REGION'] = 'us-east-1';
      const east = withStackName('Stack', () =>
        acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' })
      );
      process.env['AWS_REGION'] = 'eu-west-1';
      const west = withStackName('Stack', () =>
        acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' })
      );
      // cdkd identifies a resource as {stackName}/{region}/{logicalId}; sharing
      // a token across regions would have the second create answered with the
      // first region's resource.
      expect(west.value).not.toBe(east.value);
    } finally {
      if (before === undefined) delete process.env['AWS_REGION'];
      else process.env['AWS_REGION'] = before;
    }
  });

  it('separates two stacks deployed by one process that share a logical id', () => {
    const inStackA = withStackName('StackA', () =>
      acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' })
    );
    const inStackB = withStackName('StackB', () =>
      acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' })
    );

    expect(inStackB.value).not.toBe(inStackA.value);
  });

  it('honours the API length limit and stays inside a safe character set', () => {
    const token = acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Instance' });

    // EC2 documents `Maximum 64 ASCII characters` for RunInstances ClientToken.
    expect(token.value.length).toBeLessThanOrEqual(64);
    expect(token.value).toMatch(/^cdkd-[0-9a-f]+$/);

    const shorter = acquireIdempotencyToken({
      scope: 'CreateHostedZone',
      logicalId: 'Zone',
      maxLength: 20,
    });
    expect(shorter.value.length).toBe(20);
  });

  // Issue #2169: ACM's `RequestCertificate` documents `Pattern: \w+`, and a
  // hyphen is not in `\w`, so the default spelling is REJECTED by the API
  // rather than merely un-deduplicated.
  it("emits a \\w-only value under charset 'alphanumeric', with the same stability guarantees", () => {
    const first = acquireIdempotencyToken({
      scope: 'RequestCertificate',
      logicalId: 'Cert',
      maxLength: 32,
      charset: 'alphanumeric',
    });

    expect(first.value).toMatch(/^\w+$/);
    expect(first.value).not.toContain('-');
    expect(first.value.length).toBe(32);

    // Same create -> same token, exactly as on the default charset.
    expect(
      acquireIdempotencyToken({
        scope: 'RequestCertificate',
        logicalId: 'Cert',
        maxLength: 32,
        charset: 'alphanumeric',
      }).value
    ).toBe(first.value);

    first.release();
    expect(
      acquireIdempotencyToken({
        scope: 'RequestCertificate',
        logicalId: 'Cert',
        maxLength: 32,
        charset: 'alphanumeric',
      }).value
    ).not.toBe(first.value);
  });

  it('keys the memo by charset and length, so two shapes cannot hand each other their spelling', () => {
    // The memo returns the FIRST value minted for a key verbatim. If the key
    // ignored these, a second call site asking for `alphanumeric` would be
    // handed the hyphenated spelling already in flight -- which ACM's
    // `RequestCertificate` (`Pattern: \w+`) REJECTS outright rather than merely
    // failing to deduplicate.
    const alphanumeric = acquireIdempotencyToken({
      scope: 'RequestCertificate',
      logicalId: 'Cert',
      maxLength: 32,
      charset: 'alphanumeric',
    });
    const dflt = acquireIdempotencyToken({ scope: 'RequestCertificate', logicalId: 'Cert' });
    const shorter = acquireIdempotencyToken({
      scope: 'RequestCertificate',
      logicalId: 'Cert',
      maxLength: 32,
      charset: 'default',
    });

    // Each shape keeps its own contract rather than inheriting the first one's.
    expect(alphanumeric.value).toMatch(/^\w{32}$/);
    expect(alphanumeric.value).not.toContain('-');
    expect(dflt.value).toMatch(/^cdkd-[0-9a-f]+$/);
    expect(dflt.value.length).toBe(64);
    expect(shorter.value).toMatch(/^cdkd-[0-9a-f]+$/);
    expect(shorter.value.length).toBe(32);

    // ...and no two of them collide.
    expect(new Set([alphanumeric.value, dflt.value, shorter.value]).size).toBe(3);
  });
});
