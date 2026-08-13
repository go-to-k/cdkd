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
      // lower-cased baseline ever regressed to accepting. Asserts BOTH entry
      // points, not just the parse: a look-alike is exactly the case the
      // foreign-suffix predicate is documented to report.
      expect(verdict(uri('US-ISO-EAST-1', 'amazonaws.com'))).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
      expect(verdict(uri('Us-IsO-eAsT-1', 'amazonaws.com'))).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
    });

    it('the GENUINE arms are actually ACCEPTED, not merely equal', () => {
      // The mirror of the guard above. Without it, the two genuine-host casing
      // assertions compare a verdict against a baseline in ANOTHER describe
      // block, so a regression that rejected BOTH sides would satisfy them.
      expect(parseEcrRegistryHost(uri('US-ISO-EAST-1', 'c2s.ic.gov'))).toEqual({
        accountId: '123456789012',
        region: 'us-iso-east-1',
      });
      expect(parseEcrRegistryHost(uri('Us-IsO-eAsT-1', 'c2s.ic.gov'))).toEqual({
        accountId: '123456789012',
        region: 'us-iso-east-1',
      });
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

    it('the suffix-casing arms are actually ACCEPTED, not merely equal', () => {
      // This block's baseline lives in another `describe`, so without this
      // guard a regression rejecting BOTH sides would satisfy every arm above.
      for (const suffix of ['AMAZONAWS.COM', 'AmAzOnAwS.CoM']) {
        expect(parseEcrRegistryHost(uri('us-east-1', suffix))).toEqual({
          accountId: '123456789012',
          region: 'us-east-1',
        });
      }
      expect(parseEcrRegistryHost(uri('US-ISO-EAST-1', 'C2S.IC.GOV'))).toEqual({
        accountId: '123456789012',
        region: 'us-iso-east-1',
      });
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

  // A region id is `[a-z0-9-]`. Case was only ONE way to defeat the
  // `startsWith` partition classification; the captured segment then becomes an
  // `ECRClient({region})` and is interpolated into the fallback login endpoint,
  // so anything that is not a region id is refused outright.
  describe('a malformed region segment is refused (issue #1786 review)', () => {
    it.each([
      ['leading space', ' us-iso-east-1'],
      ['trailing space', 'us-iso-east-1 '],
      ['combining mark (not ASCII case-folding)', 'us-İso-east-1'],
      ['underscore', 'us_east_1'],
      ['leading hyphen', '-us-east-1'],
      ['empty-ish', '-'],
      // U+212A KELVIN SIGN folds to ASCII `k` under `toLowerCase()`. Guarding
      // the FOLDED segment would accept this and report the region
      // `us-ekst-1` -- a region the host does not name, which is exactly the
      // substitution the guard exists to refuse. It is refused only because
      // the test runs against the RAW capture; if this arm ever passes, the
      // guard has been moved back after the fold.
      ['Kelvin sign folding to ASCII k', 'us-e\u212Ast-1'],
      ['dotted capital I folding to i + combining dot', 'us-\u0130so-east-1'],
    ])('%s', (_label, region) => {
      // Refused on a GENUINE-looking suffix too — the point is that cdkd cannot
      // vouch for the classification, not that the suffix happened to mismatch.
      expect(verdict(uri(region, 'amazonaws.com'))).toEqual({
        parse: undefined,
        foreignSuffix: false,
      });
    });

    it.each([
      // The inverted control: the guard must not narrow the accepted set. Each
      // region is paired with the suffix its OWN partition uses — pairing them
      // all with `amazonaws.com` makes `cn-north-1` a look-alike, so the arm
      // would be rejected for a reason that has nothing to do with the guard.
      ['commercial', 'us-east-1', 'amazonaws.com'],
      ['china', 'cn-north-1', 'amazonaws.com.cn'],
      ['govcloud', 'us-gov-west-1', 'amazonaws.com'],
      ['a higher-numbered region', 'ap-southeast-4', 'amazonaws.com'],
    ])('still accepts a real region id: %s', (_label, region, suffix) => {
      expect(parseEcrRegistryHost(uri(region, suffix))).toEqual({
        accountId: '123456789012',
        region,
      });
    });

    it('refuses a folded look-alike SUFFIX as well as a folded region', () => {
      // The region guard's twin, one layer over. `aws-isoe`'s suffix is
      // `cloud.adc-e.uk`, which CONTAINS a `k`, so U+212A KELVIN SIGN folds
      // onto it -- guarding only the region would accept this as a genuine
      // ISO-E registry. Reachable only since #1790 added that partition, which
      // is why the first cut of this guard covered the region alone.
      expect(verdict(uri('eu-isoe-west-1', 'cloud.adc-e.uK'))).toEqual({
        parse: undefined,
        foreignSuffix: false,
      });
      // Inverted control: the real suffix is still accepted, in any casing.
      expect(parseEcrRegistryHost(uri('eu-isoe-west-1', 'CLOUD.ADC-E.UK'))).toEqual({
        accountId: '123456789012',
        region: 'eu-isoe-west-1',
      });
    });

    it('withdraws the #1764 foreign-suffix diagnostic too, deliberately', () => {
      // A malformed region carrying a genuinely FOREIGN suffix used to report
      // `foreignSuffix: true`; it now reports `false`. That is the correct
      // verdict, not a regression: the diagnostic's subject is "this suffix
      // does not belong to its region's PARTITION", and a segment that is not
      // a region id has no partition -- reporting it would send the reader
      // hunting for a partition-table entry that could never exist. Pinned so
      // a future widening of the guard cannot flip it back silently.
      expect(verdict(uri('us_east_1', 'example.com'))).toEqual({
        parse: undefined,
        foreignSuffix: false,
      });
      // ...while a WELL-FORMED region with the same foreign suffix still
      // reports it, so the arm above is a scoped withdrawal and not a
      // wholesale loss of the diagnostic.
      expect(verdict(uri('us-east-1', 'example.com'))).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
    });
  });

  // Pins the bound the #1786 fix deliberately did NOT widen, so a future change
  // to ECR_URI_HOST_REGEX cannot silently expand what cdkd `docker login`s to.
  describe('the `dkr.ecr` LABELS stay case-sensitive (known bound, issue #1792)', () => {
    it.each([
      ['upper-cased labels', '123456789012.DKR.ECR.us-east-1.amazonaws.com/r:t'],
      ['mixed-case labels', '123456789012.Dkr.Ecr.us-east-1.amazonaws.com/r:t'],
    ])('%s is inert at BOTH entry points', (_label, imageUri) => {
      // Not merely rejected by the suffix check — it does not match the host
      // SHAPE at all, so it classifies as an ordinary public image and no
      // diagnostic fires. That is the documented, safe failure direction.
      expect(verdict(imageUri)).toEqual({ parse: undefined, foreignSuffix: false });
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
