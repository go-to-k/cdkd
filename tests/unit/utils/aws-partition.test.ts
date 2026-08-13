import { describe, expect, it } from 'vite-plus/test';
import {
  PARTITION_TABLE,
  derivePartitionAndUrlSuffix,
} from '../../../src/utils/aws-partition.js';
import { parseEcrRegistryHost } from '../../../src/utils/ecr-uri.js';

/**
 * The table is VERIFIED against AWS-authored partition data, not documentation
 * prose — see the module header for the three sources. These tests pin each row
 * so a future edit that mistypes a suffix fails here rather than silently
 * classifying a genuine registry host as a public image (issue #1764).
 *
 * Per the #1758 convention, every non-commercial assertion is paired with a
 * commercial counter-case asserting the UNCHANGED string, so a change that
 * widened the table by breaking the fallback cannot pass.
 */
describe('derivePartitionAndUrlSuffix', () => {
  const COMMERCIAL = { partition: 'aws', urlSuffix: 'amazonaws.com' };

  it('returns aws / amazonaws.com for commercial regions', () => {
    expect(derivePartitionAndUrlSuffix('us-east-1')).toEqual(COMMERCIAL);
    expect(derivePartitionAndUrlSuffix('eu-west-1')).toEqual(COMMERCIAL);
    expect(derivePartitionAndUrlSuffix('ap-northeast-1')).toEqual(COMMERCIAL);
  });

  it('returns aws-cn / amazonaws.com.cn for cn-* — commercial unchanged', () => {
    expect(derivePartitionAndUrlSuffix('cn-north-1')).toEqual({
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
    });
    expect(derivePartitionAndUrlSuffix('us-east-1')).toEqual(COMMERCIAL);
  });

  it('returns aws-us-gov / amazonaws.com for us-gov-* — commercial unchanged', () => {
    // GovCloud is the one non-commercial partition that shares the commercial
    // DNS suffix; confirmed against all three upstream sources.
    expect(derivePartitionAndUrlSuffix('us-gov-west-1')).toEqual({
      partition: 'aws-us-gov',
      urlSuffix: 'amazonaws.com',
    });
    expect(derivePartitionAndUrlSuffix('us-east-1')).toEqual(COMMERCIAL);
  });

  it('returns aws-iso / c2s.ic.gov for us-iso-* — commercial unchanged', () => {
    expect(derivePartitionAndUrlSuffix('us-iso-east-1')).toEqual({
      partition: 'aws-iso',
      urlSuffix: 'c2s.ic.gov',
    });
    expect(derivePartitionAndUrlSuffix('us-east-1')).toEqual(COMMERCIAL);
  });

  it('returns aws-iso-b / sc2s.sgov.gov for us-isob-* — commercial unchanged', () => {
    expect(derivePartitionAndUrlSuffix('us-isob-east-1')).toEqual({
      partition: 'aws-iso-b',
      urlSuffix: 'sc2s.sgov.gov',
    });
    expect(derivePartitionAndUrlSuffix('us-east-1')).toEqual(COMMERCIAL);
  });

  // ---------- rows added by issue #1764 ----------

  it('returns aws-iso-e / cloud.adc-e.uk for eu-isoe-* — commercial unchanged', () => {
    expect(derivePartitionAndUrlSuffix('eu-isoe-west-1')).toEqual({
      partition: 'aws-iso-e',
      urlSuffix: 'cloud.adc-e.uk',
    });
    // The counter-case is `eu-west-1`, NOT `us-east-1`: an `eu-isoe-` row
    // written as a bare `eu-` prefix would capture every commercial EU region,
    // and a `us-`-only counter-case could not see it.
    expect(derivePartitionAndUrlSuffix('eu-west-1')).toEqual(COMMERCIAL);
    expect(derivePartitionAndUrlSuffix('eu-central-1')).toEqual(COMMERCIAL);
  });

  it('returns aws-iso-f / csp.hci.ic.gov for us-isof-* — commercial unchanged', () => {
    expect(derivePartitionAndUrlSuffix('us-isof-east-1')).toEqual({
      partition: 'aws-iso-f',
      urlSuffix: 'csp.hci.ic.gov',
    });
    expect(derivePartitionAndUrlSuffix('us-isof-south-1')).toEqual({
      partition: 'aws-iso-f',
      urlSuffix: 'csp.hci.ic.gov',
    });
    expect(derivePartitionAndUrlSuffix('us-east-1')).toEqual(COMMERCIAL);
  });

  it('returns aws-eusc / amazonaws.eu for eusc-* — commercial unchanged', () => {
    expect(derivePartitionAndUrlSuffix('eusc-de-east-1')).toEqual({
      partition: 'aws-eusc',
      urlSuffix: 'amazonaws.eu',
    });
    expect(derivePartitionAndUrlSuffix('eu-west-1')).toEqual(COMMERCIAL);
  });

  it('matches eusc- more broadly than upstream, on purpose', () => {
    // Upstream scopes the partition to `eusc-de-` / `^eusc\-(de)\-…`. cdkd
    // matches the whole `eusc-` family because falling through to commercial is
    // exactly the #1764 bug, while a false match is impossible (no other
    // partition's regions start with `eusc-`).
    expect(derivePartitionAndUrlSuffix('eusc-fr-north-1')).toEqual({
      partition: 'aws-eusc',
      urlSuffix: 'amazonaws.eu',
    });
    expect(derivePartitionAndUrlSuffix('eu-south-2')).toEqual(COMMERCIAL);
  });

  // ---------- table invariants ----------

  it('has no prefix nested inside another, so every row is reachable', () => {
    // `us-iso-` would swallow `us-isob-` / `us-isof-` without its trailing
    // hyphen, making those rows dead code and re-opening the #1764 gap for two
    // partitions while the table LOOKED complete.
    for (const outer of PARTITION_TABLE) {
      for (const inner of PARTITION_TABLE) {
        if (outer === inner) continue;
        expect(
          inner.prefix.startsWith(outer.prefix),
          `${inner.prefix} is nested inside ${outer.prefix} and is unreachable`
        ).toBe(false);
      }
    }
  });

  it('reaches every row through the public function', () => {
    for (const row of PARTITION_TABLE) {
      expect(derivePartitionAndUrlSuffix(`${row.prefix}test-1`)).toEqual({
        partition: row.partition,
        urlSuffix: row.urlSuffix,
      });
    }
  });

  it('assigns each partition a distinct name', () => {
    const names = PARTITION_TABLE.map((p) => p.partition);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * The point of the table widening (issue #1764): since #1758 added a STRICT
 * host check, a partition missing from the table makes a GENUINE ECR registry
 * host get REJECTED and classified `public` — no `docker login`, anonymous
 * pull, opaque failure. These assert the consumer-visible effect, not just the
 * mapping.
 */
describe('parseEcrRegistryHost across partitions (issue #1764)', () => {
  it('accepts a genuine eu-isoe registry host — commercial unchanged', () => {
    expect(
      parseEcrRegistryHost('123456789012.dkr.ecr.eu-isoe-west-1.cloud.adc-e.uk/repo:tag')
    ).toEqual({ accountId: '123456789012', region: 'eu-isoe-west-1' });
    expect(parseEcrRegistryHost('123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag')).toEqual({
      accountId: '123456789012',
      region: 'us-east-1',
    });
  });

  it('accepts a genuine us-isof registry host — commercial unchanged', () => {
    expect(
      parseEcrRegistryHost('123456789012.dkr.ecr.us-isof-east-1.csp.hci.ic.gov/repo:tag')
    ).toEqual({ accountId: '123456789012', region: 'us-isof-east-1' });
    expect(parseEcrRegistryHost('123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag')).toEqual({
      accountId: '123456789012',
      region: 'us-east-1',
    });
  });

  it('accepts a genuine eusc registry host — commercial unchanged', () => {
    expect(
      parseEcrRegistryHost('123456789012.dkr.ecr.eusc-de-east-1.amazonaws.eu/repo:tag')
    ).toEqual({ accountId: '123456789012', region: 'eusc-de-east-1' });
    expect(parseEcrRegistryHost('123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag')).toEqual({
      accountId: '123456789012',
      region: 'us-east-1',
    });
  });

  it('still rejects a look-alike host in a newly covered partition', () => {
    // Widening the table must not weaken the #1758 check: the commercial
    // suffix on an `eu-isoe-` host is now WRONG for that region, so a
    // `docker login` must not be pointed at it.
    expect(
      parseEcrRegistryHost('123456789012.dkr.ecr.eu-isoe-west-1.amazonaws.com/repo:tag')
    ).toBeUndefined();
    expect(
      parseEcrRegistryHost('123456789012.dkr.ecr.eusc-de-east-1.example.com/repo:tag')
    ).toBeUndefined();
  });
});
