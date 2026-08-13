import { describe, it, expect } from 'vite-plus/test';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import {
  S3_WEBSITE_ENDPOINT_LEGACY_DASH_REGIONS,
  s3BucketDomainName,
  s3BucketDualStackDomainName,
  s3BucketRegionalDomainName,
  s3BucketWebsiteUrl,
} from '../../../src/utils/s3-endpoints.js';

// Issue #1745: all four `AWS::S3::Bucket` host attributes hardcoded the
// commercial `amazonaws.com` suffix, so outside that partition each emitted a
// hostname that does not resolve. Every non-commercial assertion below is
// paired with a commercial counter-case asserting the output is UNCHANGED (the
// #1758 convention) — that is what makes the change safe to ship without a
// non-commercial account to test against.
describe('S3 bucket endpoint construction (issue #1745)', () => {
  describe('commercial output is byte-identical to the pre-fix hardcoded form', () => {
    it('builds the four attributes for us-east-1 exactly as before', () => {
      expect(s3BucketDomainName('my-bucket', 'us-east-1')).toBe('my-bucket.s3.amazonaws.com');
      expect(s3BucketRegionalDomainName('my-bucket', 'us-east-1')).toBe(
        'my-bucket.s3.us-east-1.amazonaws.com'
      );
      expect(s3BucketDualStackDomainName('my-bucket', 'us-east-1')).toBe(
        'my-bucket.s3.dualstack.us-east-1.amazonaws.com'
      );
      expect(s3BucketWebsiteUrl('my-bucket', 'us-east-1')).toBe(
        'http://my-bucket.s3-website-us-east-1.amazonaws.com'
      );
    });
  });

  describe('non-commercial partitions derive their own suffix', () => {
    it('builds cn-north-1 hosts under amazonaws.com.cn', () => {
      expect(s3BucketDomainName('my-bucket', 'cn-north-1')).toBe('my-bucket.s3.amazonaws.com.cn');
      expect(s3BucketRegionalDomainName('my-bucket', 'cn-north-1')).toBe(
        'my-bucket.s3.cn-north-1.amazonaws.com.cn'
      );
      expect(s3BucketDualStackDomainName('my-bucket', 'cn-north-1')).toBe(
        'my-bucket.s3.dualstack.cn-north-1.amazonaws.com.cn'
      );
      expect(s3BucketWebsiteUrl('my-bucket', 'cn-north-1')).toBe(
        'http://my-bucket.s3-website.cn-north-1.amazonaws.com.cn'
      );
    });

    it('builds us-iso-east-1 hosts under c2s.ic.gov', () => {
      expect(s3BucketDomainName('my-bucket', 'us-iso-east-1')).toBe('my-bucket.s3.c2s.ic.gov');
      expect(s3BucketRegionalDomainName('my-bucket', 'us-iso-east-1')).toBe(
        'my-bucket.s3.us-iso-east-1.c2s.ic.gov'
      );
      expect(s3BucketWebsiteUrl('my-bucket', 'us-iso-east-1')).toBe(
        'http://my-bucket.s3-website.us-iso-east-1.c2s.ic.gov'
      );
    });

    it('keeps the commercial suffix for GovCloud, which has none of its own', () => {
      // The one non-commercial partition whose URL suffix IS `amazonaws.com` —
      // so this pair is what distinguishes "derives the suffix" from "swaps in
      // a non-commercial suffix whenever the region is not commercial".
      expect(s3BucketRegionalDomainName('my-bucket', 'us-gov-west-1')).toBe(
        'my-bucket.s3.us-gov-west-1.amazonaws.com'
      );
      expect(s3BucketDomainName('my-bucket', 'us-gov-west-1')).toBe('my-bucket.s3.amazonaws.com');
    });
  });

  describe('the website endpoint separator is per REGION, not per partition', () => {
    it('uses the legacy hyphen form only for the nine legacy regions', () => {
      expect(s3BucketWebsiteUrl('b', 'ap-northeast-1')).toBe(
        'http://b.s3-website-ap-northeast-1.amazonaws.com'
      );
      // A commercial region NOT in the legacy set: the pre-fix hardcoded
      // template emitted the hyphen form here too, which AWS does not serve.
      expect(s3BucketWebsiteUrl('b', 'eu-central-1')).toBe(
        'http://b.s3-website.eu-central-1.amazonaws.com'
      );
    });

    it('splits the two GovCloud regions across the two forms', () => {
      // Same partition, same suffix, different separator — the case that makes
      // a partition-derived separator wrong.
      expect(s3BucketWebsiteUrl('b', 'us-gov-west-1')).toBe(
        'http://b.s3-website-us-gov-west-1.amazonaws.com'
      );
      expect(s3BucketWebsiteUrl('b', 'us-gov-east-1')).toBe(
        'http://b.s3-website.us-gov-east-1.amazonaws.com'
      );
    });

    it('falls back to the current dot form for an unknown region', () => {
      // Matches what CDK does when `region-info` carries no fact for a region:
      // no new region has been added to the legacy hyphen set.
      expect(s3BucketWebsiteUrl('b', 'zz-future-1')).toBe(
        'http://b.s3-website.zz-future-1.amazonaws.com'
      );
    });
  });

  // The legacy-region set and the derived suffixes are both claims about AWS,
  // not about cdkd, so they are fenced against an AWS-AUTHORED table rather
  // than against a second hand-written list: `aws-cdk-lib`'s `region-info`
  // facts, the same data CDK resolves a bucket's website endpoint from. A
  // region AWS adds (or moves between the two forms) reds here.
  describe('fence against the aws-cdk-lib region-info fact table', () => {
    const regionsWithEndpoint = RegionInfo.regions.filter((r) => r.s3StaticWebsiteEndpoint);

    it('sees a real region table', () => {
      // Floor, so a table that stopped resolving cannot pass vacuously: 46
      // regions carried the fact at aws-cdk-lib 2.244.0.
      expect(regionsWithEndpoint.length).toBeGreaterThanOrEqual(40);
      expect(S3_WEBSITE_ENDPOINT_LEGACY_DASH_REGIONS.size).toBe(9);
    });

    it('builds every known region the website endpoint AWS publishes for it', () => {
      for (const region of regionsWithEndpoint) {
        expect(s3BucketWebsiteUrl('b', region.name), region.name).toBe(
          `http://b.${region.s3StaticWebsiteEndpoint}`
        );
      }
    });

    it('declares exactly the regions whose published endpoint uses the hyphen form', () => {
      const dashRegions = regionsWithEndpoint
        .filter((r) => r.s3StaticWebsiteEndpoint!.startsWith('s3-website-'))
        .map((r) => r.name)
        .sort();
      expect(dashRegions).toEqual([...S3_WEBSITE_ENDPOINT_LEGACY_DASH_REGIONS].sort());
    });

    it('derives every known region the URL suffix AWS publishes for it', () => {
      for (const region of regionsWithEndpoint) {
        const suffix = region.domainSuffix;
        if (!suffix) continue;
        expect(s3BucketDomainName('b', region.name), region.name).toBe(`b.s3.${suffix}`);
        expect(s3BucketRegionalDomainName('b', region.name), region.name).toBe(
          `b.s3.${region.name}.${suffix}`
        );
        expect(s3BucketDualStackDomainName('b', region.name), region.name).toBe(
          `b.s3.dualstack.${region.name}.${suffix}`
        );
      }
    });
  });
});
