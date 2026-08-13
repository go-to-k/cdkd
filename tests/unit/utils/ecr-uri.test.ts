import { describe, expect, it } from 'vite-plus/test';
import {
  ECR_REGISTRY_HOST_FORMS,
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

  // The same 2x2 as the region / suffix blocks above, extended to the LABELS.
  // This block REPLACES one that pinned the opposite ("the labels stay
  // case-sensitive") as a known bound, so the inversion is the binding proof:
  // with the `i` flag off, every arm here fails.
  describe('label casing does not change the verdict (issue #1792)', () => {
    /** `<acct>.<labels>.<region>.<suffix>/<repo>:<tag>` */
    const labelled = (labels: string, region: string, suffix: string): string =>
      `123456789012.${labels}.${region}.${suffix}/my-repo:latest`;

    const genuine = labelled('dkr.ecr', 'us-east-1', 'amazonaws.com');
    const lookAlike = labelled('dkr.ecr', 'us-iso-east-1', 'amazonaws.com');

    it.each([
      ['UPPER-case', 'DKR.ECR'],
      ['mixed-case', 'Dkr.Ecr'],
    ])('GENUINE host + %s labels matches the lower-case verdict', (_label, labels) => {
      expect(verdict(labelled(labels, 'us-east-1', 'amazonaws.com'))).toEqual(verdict(genuine));
    });

    it.each([
      ['UPPER-case', 'DKR.ECR'],
      ['mixed-case', 'Dkr.Ecr'],
    ])('LOOK-ALIKE host + %s labels matches the lower-case verdict', (_label, labels) => {
      expect(verdict(labelled(labels, 'us-iso-east-1', 'amazonaws.com'))).toEqual(
        verdict(lookAlike)
      );
    });

    it('the GENUINE arms are actually ACCEPTED, not merely equal', () => {
      // Without this the two arms above compare against a baseline that a
      // regression rejecting BOTH sides would also satisfy. This is also the
      // exact probe from issue #1792, which measured `undefined`.
      for (const labels of ['DKR.ECR', 'Dkr.Ecr']) {
        expect(parseEcrRegistryHost(labelled(labels, 'us-east-1', 'amazonaws.com'))).toEqual({
          accountId: '123456789012',
          region: 'us-east-1',
        });
      }
    });

    it('the LOOK-ALIKE arms are REJECTED and now DIAGNOSED, not silently inert', () => {
      // The regression this fences is not "the look-alike is accepted" — the
      // suffix check catches that — but the SHAPE miss the issue measured: a
      // mixed-case look-alike used to report `foreignSuffix: false`, so
      // `ecs-task-resolver.ts` logged nothing at all and the #1764 diagnostic
      // never fired. Asserting `true` is what a case-sensitive labels
      // alternation cannot produce.
      for (const labels of ['DKR.ECR', 'Dkr.Ecr']) {
        expect(verdict(labelled(labels, 'us-iso-east-1', 'amazonaws.com'))).toEqual({
          parse: undefined,
          foreignSuffix: true,
        });
      }
    });

    it('folding the labels does not admit a shape AWS does not serve', () => {
      // The negative side of the widening, asserted as the shape a REGRESSION
      // would produce rather than as today's output: a labels alternation
      // widened to a character class (`[a-z.-]+`) or a `.`-unescaped
      // `dkr.ecr` would accept each of these, so each must stay a
      // non-match at BOTH entry points.
      const notServed = [
        // `.` unescaped in `dkr.ecr` matches any character, incl. `-` and `x`.
        '123456789012.dkr-ecr.us-east-1.amazonaws.com/my-repo:latest',
        '123456789012.dkrxecr.us-east-1.amazonaws.com/my-repo:latest',
        // A label run that merely CONTAINS a served spelling.
        '123456789012.evil-dkr.ecr.us-east-1.amazonaws.com/my-repo:latest',
        '123456789012.dkr.ecr2.us-east-1.amazonaws.com/my-repo:latest',
        // U+212A KELVIN SIGN folds onto ASCII `k` under `toLowerCase()`. What
        // refuses this host is the ESCAPED literal alternation — the `i` flag
        // does not canonicalize U+212A onto `k` in non-unicode mode, so the
        // labels never match a form at all. The label FOLD is NOT what fences
        // it (this arm passes identically under an ASCII-only map and under
        // `toLowerCase()`); see `matchEcrRegistryHost` for why the labels take
        // full folding while the region / suffix guards test the raw capture.
        '123456789012.d\u212Ar.ecr.us-east-1.amazonaws.com/my-repo:latest',
      ];
      for (const imageUri of notServed) {
        // `dkr-ecr` + a partition suffix IS a real form spelled with the wrong
        // suffix, so it is diagnosed rather than inert — see the mispairing
        // block below. Only the parse verdict is common to all five.
        expect(parseEcrRegistryHost(imageUri), imageUri).toBeUndefined();
      }
    });
  });

  // Unifying the grammar with `gc.ts` (issue #1793) WIDENS what this module
  // recognizes: the FIPS and dual-stack forms are real AWS registry endpoints
  // that used to classify as ordinary public images here (anonymous pull, no
  // `docker login`), while `gc.ts` had carried three of the four all along.
  describe('every AWS-served host form is recognized (issue #1793)', () => {
    it.each([
      // Each region is one AWS actually serves that form in, per the published
      // `ecr` endpoint list.
      ['FIPS IPv4, commercial', '123456789012.dkr.ecr-fips.us-east-1.amazonaws.com/r:t', 'us-east-1'],
      [
        'FIPS IPv4, GovCloud',
        '123456789012.dkr.ecr-fips.us-gov-west-1.amazonaws.com/r:t',
        'us-gov-west-1',
      ],
      ['dual-stack', '123456789012.dkr-ecr.us-east-1.on.aws/r:t', 'us-east-1'],
      ['dual-stack FIPS', '123456789012.dkr-ecr-fips.us-gov-west-1.on.aws/r:t', 'us-gov-west-1'],
    ])('%s', (_label, imageUri, region) => {
      expect(verdict(imageUri)).toEqual({
        parse: { accountId: '123456789012', region },
        foreignSuffix: false,
      });
    });

    it('the dual-stack forms are case-insensitive too', () => {
      // The #1792 fold and the #1793 widening have to compose: the `on.aws`
      // literal is matched by the same regex, so a case-sensitive fixed suffix
      // would leave the new forms half-fixed.
      expect(verdict('123456789012.DKR-ECR.US-EAST-1.ON.AWS/r:t')).toEqual(
        verdict('123456789012.dkr-ecr.us-east-1.on.aws/r:t')
      );
      expect(parseEcrRegistryHost('123456789012.DKR-ECR-FIPS.us-east-1.ON.AWS/r:t')).toEqual({
        accountId: '123456789012',
        region: 'us-east-1',
      });
    });

    it('a FIPS host still has its suffix paired with the region', () => {
      // The widening must not weaken the #1758 check: the FIPS forms carry the
      // region's OWN partition suffix, so a foreign one is still refused —
      // and now diagnosed, where before the shape did not match at all.
      expect(verdict('123456789012.dkr.ecr-fips.us-east-1.example.com/r:t')).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
      expect(verdict('123456789012.dkr.ecr-fips.us-iso-east-1.amazonaws.com/r:t')).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
    });

    it.each([
      // The pairing is what a "collapse the forms into one loose alternation"
      // regression would lose: `(?:dkr[.-]ecr(?:-fips)?)` over a single suffix
      // slot accepts all four of these, and each is a host AWS does not serve.
      ["dual-stack labels + a partition suffix", '123456789012.dkr-ecr.us-east-1.amazonaws.com/r:t'],
      [
        'dual-stack FIPS labels + a partition suffix',
        '123456789012.dkr-ecr-fips.us-east-1.amazonaws.com/r:t',
      ],
      ['IPv4 labels + the dual-stack suffix', '123456789012.dkr.ecr.us-east-1.on.aws/r:t'],
      ['FIPS IPv4 labels + the dual-stack suffix', '123456789012.dkr.ecr-fips.us-east-1.on.aws/r:t'],
    ])('rejects a form/suffix MISPAIRING: %s', (_label, imageUri) => {
      expect(verdict(imageUri)).toEqual({ parse: undefined, foreignSuffix: true });
    });

    it('the `on.aws` literal is exact, not a prefix', () => {
      // `on.aws.evil.com` is the look-alike a `[^/]+` suffix slot would admit
      // on the dual-stack arm; `on.aws` is only safe as a fixed literal check
      // BECAUSE the whole suffix must equal it.
      expect(verdict('123456789012.dkr-ecr.us-east-1.on.aws.evil.com/r:t')).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
      expect(verdict('123456789012.dkr-ecr.us-east-1.not-on.aws/r:t')).toEqual({
        parse: undefined,
        foreignSuffix: true,
      });
    });

    it('accepts a dual-stack host in ANY partition, deliberately', () => {
      // A recorded decision, not an oversight: AWS documents the dual-stack
      // endpoints for commercial + GovCloud, and refusing the others would
      // re-inherit the #1764 failure (a cdkd table lagging AWS rejecting a
      // GENUINE registry). `on.aws` is AWS-owned, so unlike a captured suffix
      // it cannot be substituted by a host someone else controls.
      expect(parseEcrRegistryHost('123456789012.dkr-ecr.cn-north-1.on.aws/r:t')).toEqual({
        accountId: '123456789012',
        region: 'cn-north-1',
      });
    });
  });

  // The fence for the classification table in `ECR_URI_HOST_REGEX`'s doc. Its
  // DIAGNOSTIC-ONLY rows are the ones a summary silently drops (`parse` is
  // unchanged there, so only `foreignSuffix` moves), and a table nobody checks
  // goes stale — so every row is asserted here, including the ones that did not
  // change, since "nothing changed" is a claim too.
  describe('the issues #1792 / #1793 classification table is complete', () => {
    const A = '123456789012';
    const R = 'us-east-1';
    const S = 'amazonaws.com';
    const F = 'example.com';

    it.each([
      // [row, uri, parses, diagnoses]
      ['plain + partition suffix (unchanged)', `${A}.dkr.ecr.${R}.${S}/r:t`, true, false],
      ['plain + foreign suffix (unchanged)', `${A}.dkr.ecr.${R}.${F}/r:t`, false, true],
      // Already `true` BEFORE the change: the pre-#1793 pattern matched the
      // plain labels against a wildcard suffix slot, so `on.aws` was simply a
      // suffix that is not `amazonaws.com`.
      ['plain + on.aws (unchanged, already diagnosed)', `${A}.dkr.ecr.${R}.on.aws/r:t`, false, true],
      // #1792: PARSE flip.
      ['UPPER labels + partition suffix', `${A}.DKR.ECR.${R}.${S}/r:t`, true, false],
      // #1792: DIAGNOSTIC-ONLY flip (was quiet at BOTH entry points).
      ['UPPER labels + foreign suffix', `${A}.DKR.ECR.${R}.${F}/r:t`, false, true],
      // #1793: PARSE flips.
      ['FIPS IPv4 + partition suffix', `${A}.dkr.ecr-fips.${R}.${S}/r:t`, true, false],
      ['dual-stack + on.aws', `${A}.dkr-ecr.${R}.on.aws/r:t`, true, false],
      ['dual-stack FIPS + on.aws', `${A}.dkr-ecr-fips.${R}.on.aws/r:t`, true, false],
      // #1793: DIAGNOSTIC-ONLY flips — the rows the table exists to record.
      ['FIPS IPv4 + foreign suffix', `${A}.dkr.ecr-fips.${R}.${F}/r:t`, false, true],
      ['dual-stack labels + partition suffix', `${A}.dkr-ecr.${R}.${S}/r:t`, false, true],
      ['dual-stack FIPS labels + partition suffix', `${A}.dkr-ecr-fips.${R}.${S}/r:t`, false, true],
      ['FIPS IPv4 labels + on.aws', `${A}.dkr.ecr-fips.${R}.on.aws/r:t`, false, true],
    ])('%s', (_row, imageUri, parses, diagnoses) => {
      expect(verdict(imageUri)).toEqual({
        parse: parses ? { accountId: A, region: R } : undefined,
        foreignSuffix: diagnoses,
      });
    });

    it('covers every form in the table, in both suffix polarities', () => {
      // Keeps the row list above from silently under-covering when a fifth form
      // is added: each form must appear with its OWN suffix and with a suffix it
      // does not serve.
      expect(ECR_REGISTRY_HOST_FORMS).toHaveLength(4);
      for (const form of ECR_REGISTRY_HOST_FORMS) {
        const served = form.fixedUrlSuffix ?? S;
        const notServed = form.fixedUrlSuffix === undefined ? 'on.aws' : S;
        expect(parseEcrRegistryHost(`${A}.${form.labels}.${R}.${served}/r:t`), form.labels).toEqual({
          accountId: A,
          region: R,
        });
        expect(verdict(`${A}.${form.labels}.${R}.${notServed}/r:t`), form.labels).toEqual({
          parse: undefined,
          foreignSuffix: true,
        });
      }
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
