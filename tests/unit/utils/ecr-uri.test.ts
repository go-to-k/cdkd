import { describe, expect, it } from 'vite-plus/test';
import {
  looksLikeEcrHostWithForeignSuffix,
  parseEcrRegistryHost,
} from '../../../src/utils/ecr-uri.js';

/**
 * Issue #1786: DNS is case-insensitive, so every casing of a host must produce
 * the SAME verdict as its lower-cased form. The 2x2 below is deliberate — a
 * suite pinning only the fixed casing would launder the defect, because the
 * bug was that the two host CLASSES swapped verdicts under an upper-cased
 * region:
 *
 *   - a LOOK-ALIKE (commercial suffix on an ISO region) was ACCEPTED, because
 *     `US-ISO-EAST-1` fails every `startsWith` prefix test in
 *     `derivePartitionAndUrlSuffix` and falls through to the commercial
 *     partition, whose suffix is exactly what the host carries;
 *   - a GENUINE host was REJECTED, because its region no longer resolved to
 *     the partition whose suffix it carries.
 *
 * Both are measured against the lower-cased answer rather than against a
 * hand-written expectation, so a future change to the partition table cannot
 * make the two arms agree on a WRONG answer.
 */

/** `<acct>.dkr.ecr.<region>.<suffix>/<repo>:<tag>` */
const uri = (region: string, suffix: string): string =>
  `123456789012.dkr.ecr.${region}.${suffix}/my-repo:latest`;

/** Both exported entry points at once, so neither can be fixed in isolation. */
const verdict = (imageUri: string) => ({
  parse: parseEcrRegistryHost(imageUri),
  foreignSuffix: looksLikeEcrHostWithForeignSuffix(imageUri),
});

describe('parseEcrRegistryHost / looksLikeEcrHostWithForeignSuffix', () => {
  describe('baseline (all-lower-case)', () => {
    it('accepts a genuine commercial host', () => {
      expect(verdict(uri('us-east-1', 'amazonaws.com'))).toEqual({
        parse: { accountId: '123456789012', region: 'us-east-1' },
        foreignSuffix: false,
      });
    });

    it('accepts a genuine ISO host', () => {
      expect(verdict(uri('us-iso-east-1', 'c2s.ic.gov'))).toEqual({
        parse: { accountId: '123456789012', region: 'us-iso-east-1' },
        foreignSuffix: false,
      });
    });

    it('accepts a genuine China host', () => {
      expect(verdict(uri('cn-north-1', 'amazonaws.com.cn'))).toEqual({
        parse: { accountId: '123456789012', region: 'cn-north-1' },
        foreignSuffix: false,
      });
    });

    it('rejects a look-alike: commercial suffix on an ISO region', () => {
      // The exact probe from issue #1786.
      expect(verdict(uri('us-iso-east-1', 'amazonaws.com'))).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
    });

    it('rejects a look-alike: an unrelated suffix cdkd does not own', () => {
      expect(verdict(uri('us-east-1', 'example.com'))).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
    });
  });

  // The 2x2 the issue asks for: {genuine, look-alike} x {UPPER, mixed} region,
  // each asserted to behave IDENTICALLY to the lower-cased spelling.
  describe('region casing does not change the verdict (issue #1786)', () => {
    const genuine = uri('us-iso-east-1', 'c2s.ic.gov');
    const lookAlike = uri('us-iso-east-1', 'amazonaws.com');

    it('GENUINE host + UPPER-case region matches the lower-case verdict', () => {
      expect(verdict(uri('US-ISO-EAST-1', 'c2s.ic.gov'))).toEqual(verdict(genuine));
    });

    it('GENUINE host + mixed-case region matches the lower-case verdict', () => {
      expect(verdict(uri('Us-IsO-eAsT-1', 'c2s.ic.gov'))).toEqual(verdict(genuine));
    });

    it('LOOK-ALIKE host + UPPER-case region matches the lower-case verdict', () => {
      // The bypass measured in the issue: this used to ACCEPT.
      expect(verdict(uri('US-ISO-EAST-1', 'amazonaws.com'))).toEqual(verdict(lookAlike));
    });

    it('LOOK-ALIKE host + mixed-case region matches the lower-case verdict', () => {
      expect(verdict(uri('Us-IsO-eAsT-1', 'amazonaws.com'))).toEqual(verdict(lookAlike));
    });

    it('the look-alike arms are actually REJECTED, not merely equal', () => {
      // Guards the two assertions above from passing vacuously if the
      // lower-cased baseline ever regressed to accepting.
      expect(parseEcrRegistryHost(uri('US-ISO-EAST-1', 'amazonaws.com'))).toBeUndefined();
      expect(parseEcrRegistryHost(uri('Us-IsO-eAsT-1', 'amazonaws.com'))).toBeUndefined();
    });
  });

  // The issue names the host SUFFIX as case-sensitive too, not just the region.
  describe('suffix casing does not change the verdict (issue #1786)', () => {
    const genuine = uri('us-east-1', 'amazonaws.com');

    it('UPPER-case suffix on a genuine commercial host is still accepted', () => {
      expect(verdict(uri('us-east-1', 'AMAZONAWS.COM'))).toEqual(verdict(genuine));
    });

    it('mixed-case suffix on a genuine commercial host is still accepted', () => {
      expect(verdict(uri('us-east-1', 'AmAzOnAwS.CoM'))).toEqual(verdict(genuine));
    });

    it('UPPER-case suffix on a genuine China host is still accepted', () => {
      expect(verdict(uri('cn-north-1', 'AMAZONAWS.COM.CN'))).toEqual(
        verdict(uri('cn-north-1', 'amazonaws.com.cn'))
      );
    });

    it('both region AND suffix upper-cased still matches the lower-case verdict', () => {
      expect(verdict(uri('US-EAST-1', 'AMAZONAWS.COM'))).toEqual(verdict(genuine));
    });

    it('an upper-cased FOREIGN suffix is still rejected', () => {
      // Case-folding must not make an unrelated suffix pass.
      expect(verdict(uri('us-east-1', 'EXAMPLE.COM'))).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
    });
  });

  describe('the returned region is canonical (lower-case)', () => {
    it('lower-cases an UPPER-case region on a genuine host', () => {
      // Consumed as an SDK client region by `ecr-puller.ts`, so the canonical
      // spelling matters beyond the comparison itself.
      expect(parseEcrRegistryHost(uri('US-ISO-EAST-1', 'c2s.ic.gov'))?.region).toBe(
        'us-iso-east-1'
      );
    });

    it('lower-cases a mixed-case region on a genuine host', () => {
      expect(parseEcrRegistryHost(uri('Us-EaSt-1', 'amazonaws.com'))?.region).toBe('us-east-1');
    });
  });

  describe('non-ECR URIs are unaffected', () => {
    it.each([
      ['docker hub', 'nginx:latest'],
      ['public ECR', 'public.ecr.aws/lambda/nodejs:20'],
      ['gcr', 'gcr.io/project/image:tag'],
      ['too-short account id', '12345.dkr.ecr.us-east-1.amazonaws.com/r:t'],
      ['no repository path', '123456789012.dkr.ecr.us-east-1.amazonaws.com'],
    ])('%s', (_label, imageUri) => {
      expect(verdict(imageUri)).toEqual({ parse: undefined, foreignSuffix: false });
    });
  });
});
