import { describe, expect, it } from 'vite-plus/test';
import {
  LocalInvokeResolutionError,
  resolveLambdaLayers,
} from '../../../src/local/lambda-resolver.js';
import {
  PARTITION_TABLE,
  derivePartitionAndUrlSuffix,
} from '../../../src/utils/aws-partition.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue #2143 — the layer-version ARN parse rejected five of eight partitions
 * and carried the issue #2001 two-letter region prefix.
 *
 * This is a CLASSIFIER change (an ARN in, accept/reject plus parsed fields
 * out), so hand-picked cases cannot fence it: a pattern widened until it
 * accepts everything satisfies every positive assertion ever written. The file
 * therefore has three layers:
 *
 * 1. a DIFFERENTIAL fence (`describe('differential fence')`) that runs the
 *    pre-fix regex and the shipped code over a generated input space and fails
 *    on any difference outside an enumerated set of intended classes, with a
 *    FLOOR per class so a pool that stops covering one cannot pass as "no
 *    regressions";
 * 2. per-partition cases driven through the REAL CALLER, so what is asserted
 *    is the hard-throw at `resolveLambdaLayers` rather than the regex in
 *    isolation; and
 * 3. negative controls that must still be REJECTED after the fix.
 */

const ACCOUNT = '111122223333';

/** The caller needs no resources: a string Layers entry is handled first. */
const STACK: StackInfo = {
  stackName: 'ArnLayerStack',
  displayName: 'ArnLayerStack',
  artifactId: 'ArnLayerStack',
  template: { Resources: {} },
  dependencyNames: [],
};

type Verdict =
  | { accepted: true; region: string; accountId: string; name: string; version: string }
  | { accepted: false; message: string };

/**
 * Drive one literal ARN through `resolveLambdaLayers` — the real caller, which
 * HARD-THROWS on an unparsed ARN (`lambda-resolver.ts`, the `!parsed` arm).
 * Every assertion below reads this verdict, so the throw path is what is
 * fenced, not `parseLayerVersionArn` in isolation.
 */
function callerVerdict(arn: string): Verdict {
  try {
    const layers = resolveLambdaLayers(STACK, 'Fn', { Layers: [arn] });
    const layer = layers[0]!;
    if (layer.kind !== 'arn') return { accepted: false, message: `resolved as ${layer.kind}` };
    return {
      accepted: true,
      region: layer.region,
      accountId: layer.accountId,
      name: layer.name,
      version: layer.version,
    };
  } catch (e) {
    if (e instanceof LocalInvokeResolutionError) return { accepted: false, message: e.message };
    throw e;
  }
}

/**
 * The pre-fix pattern, transcribed from
 * `git show origin/main:src/local/lambda-resolver.ts` line 878 — NOT from
 * memory. Its two defects are the point of the exercise: a three-of-eight
 * partition alternation, and a region group whose first token is exactly two
 * letters with interior `<word>-` chunks capped at two.
 */
const OLD_PATTERN =
  /^arn:(aws|aws-cn|aws-us-gov):lambda:([a-z]{2}-(?:[a-z]+-){1,2}\d+):(\d{12}):layer:([A-Za-z0-9_-]+):(\d+)$/;

/** The pre-fix `parseLayerVersionArn`, field for field. */
function oldVerdict(arn: string): Verdict {
  const m = OLD_PATTERN.exec(arn);
  if (!m) return { accepted: false, message: 'old: no match' };
  return { accepted: true, region: m[2]!, accountId: m[3]!, name: m[4]!, version: m[5]! };
}

/**
 * INDEPENDENT oracle for "this ARN should be accepted after the fix".
 *
 * Deliberately built from `split(':')` / `split('-')` plus per-token tests
 * rather than from a regex, and using a hand-written prefix table rather than
 * calling `derivePartitionAndUrlSuffix`, so it cannot agree with the
 * implementation by construction. The hand-written table is pinned against
 * `PARTITION_TABLE` by a test below, so a stale copy here fails loudly instead
 * of quietly weakening the oracle.
 */
const EXPECTED_PARTITION_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['cn-', 'aws-cn'],
  ['us-gov-', 'aws-us-gov'],
  ['us-iso-', 'aws-iso'],
  ['us-isob-', 'aws-iso-b'],
  ['us-isof-', 'aws-iso-f'],
  ['eu-isoe-', 'aws-iso-e'],
  ['eusc-', 'aws-eusc'],
];

function expectedPartition(region: string): string {
  for (const [prefix, partition] of EXPECTED_PARTITION_PREFIXES) {
    if (region.startsWith(prefix)) return partition;
  }
  return 'aws';
}

/** Token-wise region grammar: `<2+ letters>(-<letters>)+-<digits>`. */
function isRegionShaped(region: string): boolean {
  const tokens = region.split('-');
  if (tokens.length < 3) return false;
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  if (!/^[a-z]{2,}$/.test(first)) return false;
  if (!/^[0-9]+$/.test(last)) return false;
  return tokens.slice(1, -1).every((t) => /^[a-z]+$/.test(t));
}

function intendedAccept(arn: string): boolean {
  const parts = arn.split(':');
  if (parts.length !== 8) return false;
  const [literal, partition, service, region, account, keyword, name, version] = parts as string[];
  if (literal !== 'arn' || service !== 'lambda' || keyword !== 'layer') return false;
  if (!/^[a-z][a-z0-9-]*$/.test(partition!)) return false;
  if (!isRegionShaped(region!)) return false;
  if (expectedPartition(region!) !== partition) return false;
  if (!/^\d{12}$/.test(account!)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(name!)) return false;
  if (!/^\d+$/.test(version!)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The generated input space.
// ---------------------------------------------------------------------------

/** Every partition string cdkd knows, plus two that are not partitions. */
const PARTITIONS = [
  'aws',
  'aws-cn',
  'aws-us-gov',
  'aws-iso',
  'aws-iso-b',
  'aws-iso-e',
  'aws-iso-f',
  'aws-eusc',
  'aws-bogus',
  'notaws',
];

const REGIONS = [
  // real regions, at least one per partition prefix
  'us-east-1',
  'eu-west-1',
  'ap-southeast-7',
  'mx-central-1',
  'il-central-1',
  'ca-west-1',
  'cn-north-1',
  'cn-northwest-1',
  'us-gov-west-1',
  'us-gov-east-1',
  'us-iso-east-1',
  'us-iso-west-1',
  'us-isob-east-1',
  'eu-isoe-west-1',
  'us-isof-south-1',
  'us-isof-east-1',
  'eusc-de-east-1',
  // region-shaped but unknown to the partition table
  'zz-nowhere-9',
  'abcd-ef-gh-1',
  // more interior hyphen groups than the pre-fix `{1,2}` cap allowed
  'us-central-north-east-1',
  // malformed region shapes
  'us-east',
  'useast1',
  'u-east-1',
  'US-EAST-1',
  'us-east-1-1',
  'us--east-1',
  '',
  'evil.example.com#',
];

/** Structural mutations applied to a well-formed, self-consistent base ARN. */
function malformedVariants(): string[] {
  const bases = [
    ['aws', 'us-east-1'],
    ['aws-cn', 'cn-north-1'],
    ['aws-eusc', 'eusc-de-east-1'],
    ['aws-iso-b', 'us-isob-east-1'],
  ] as const;
  const out: string[] = [];
  for (const [p, r] of bases) {
    out.push(
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1`, // control: well formed
      `arn:${p}:lambda:${r}:${ACCOUNT}:function:MyLayer:1`, // wrong keyword
      `arn:${p}:s3:${r}:${ACCOUNT}:layer:MyLayer:1`, // wrong service
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer`, // unversioned
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:latest`, // non-numeric version
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:`, // empty version
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1:2`, // extra segment
      `arn:${p}:lambda:${r}:11112222333:layer:MyLayer:1`, // 11-digit account
      `arn:${p}:lambda:${r}:1111222233334:layer:MyLayer:1`, // 13-digit account
      `arn:${p}:lambda:${r}:not-an-account:layer:MyLayer:1`, // non-numeric account
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer::1`, // empty name
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:My.Layer:1`, // dot in name
      `ARN:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1`, // upper-case literal
      `${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1`, // no `arn:`
      ` arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1`, // leading space
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1 `, // trailing space
      `arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1\n`, // trailing newline
      `arn::lambda:${r}:${ACCOUNT}:layer:MyLayer:1` // empty partition
    );
  }
  return out;
}

function inputSpace(): string[] {
  const out: string[] = [];
  for (const p of PARTITIONS) {
    for (const r of REGIONS) {
      out.push(`arn:${p}:lambda:${r}:${ACCOUNT}:layer:MyLayer:1`);
    }
  }
  out.push(...malformedVariants());
  return out;
}

describe('layer-ARN classifier: differential fence vs the pre-#2143 pattern', () => {
  // `classifyLayerVersionArn` reports `derivedFromTable` as `derived !== 'aws'`
  // rather than re-walking `PARTITION_TABLE`, because a second walk is a second
  // DECISION and can drift from the one `derivePartitionAndUrlSuffix` made: that
  // helper walks `canonicalizeRegion(region)`, so the moment the ARN's region
  // group admits upper case, a re-walk over the RAW region misses while `derived`
  // still says `aws-cn`, and the miss arm renders the self-contradiction
  // "resolves it to the commercial partition 'aws-cn'".
  //
  // The two are equivalent only because no `PARTITION_TABLE` row carries `aws` --
  // commercial is the fallback `return`, not a row. Both halves are pinned here,
  // over the whole region pool, so the substitution cannot silently stop holding.
  it('no PARTITION_TABLE row carries the commercial partition', () => {
    expect(PARTITION_TABLE.filter((row) => row.partition === 'aws')).toEqual([]);
    expect(PARTITION_TABLE.length).toBeGreaterThanOrEqual(7);
  });

  it("`derived !== 'aws'` equals a PARTITION_TABLE walk, for every region in the pool", () => {
    const disagreements: string[] = [];
    for (const region of REGIONS) {
      const walk = PARTITION_TABLE.some((row) => region.startsWith(row.prefix));
      const viaDerived = derivePartitionAndUrlSuffix(region).partition !== 'aws';
      if (walk !== viaDerived) disagreements.push(`${region}: walk=${walk} derived=${viaDerived}`);
    }
    expect(disagreements).toEqual([]);
    // Both verdicts must actually OCCUR in the pool, or the equality is vacuous.
    const hits = REGIONS.filter((r) => derivePartitionAndUrlSuffix(r).partition !== 'aws');
    expect(hits.length).toBeGreaterThanOrEqual(8);
    expect(REGIONS.length - hits.length).toBeGreaterThanOrEqual(8);
  });

  it('the oracle prefix table still matches PARTITION_TABLE', () => {
    expect([...EXPECTED_PARTITION_PREFIXES].sort()).toEqual(
      PARTITION_TABLE.map((r) => [r.prefix, r.partition] as const)
        .map((r) => [...r])
        .sort()
    );
  });

  it('every difference falls in an enumerated intended class, and each class has coverage', () => {
    const inputs = inputSpace();
    expect(inputs.length).toBeGreaterThanOrEqual(150);

    const newlyAccepted: string[] = [];
    const newlyRejected: string[] = [];
    const fieldDrift: string[] = [];
    const bothAccepted: string[] = [];
    const bothRejected: string[] = [];

    for (const arn of inputs) {
      const oldV = oldVerdict(arn);
      const newV = callerVerdict(arn);

      if (oldV.accepted && newV.accepted) {
        bothAccepted.push(arn);
        // Nothing about the parsed FIELDS was meant to change. Compare them
        // for every cell both implementations accept.
        if (
          oldV.region !== newV.region ||
          oldV.accountId !== newV.accountId ||
          oldV.name !== newV.name ||
          oldV.version !== newV.version
        ) {
          fieldDrift.push(arn);
        }
        continue;
      }
      if (!oldV.accepted && !newV.accepted) {
        bothRejected.push(arn);
        continue;
      }
      // Classified by the value the NEW code returns, not by the input's
      // shape — so a total regression (everything rejected) lands wholly in
      // `newlyRejected` and fails that bucket's predicate, instead of being
      // silently sorted into "expected" buckets by input shape.
      if (newV.accepted) newlyAccepted.push(arn);
      else newlyRejected.push(arn);
    }

    // ---- no unintended differences -------------------------------------
    expect(fieldDrift).toEqual([]);

    // Class A — newly ACCEPTED. Intended iff the independent oracle says the
    // ARN is well formed AND its partition agrees with its region.
    expect(newlyAccepted.filter((a) => !intendedAccept(a))).toEqual([]);

    // Class B — newly REJECTED. Intended iff the pair is INCONSISTENT: the
    // pre-fix pattern accepted `arn:aws-cn:...` in a commercial region.
    expect(newlyRejected.filter((a) => intendedAccept(a))).toEqual([]);

    // ---- and the pool still covers each class ---------------------------
    // The floors below read the OUTCOME, which is not enough on its own: several
    // cells are reachable from BOTH the partition x region cross-product AND the
    // `malformedVariants` control bases, and for `eusc-de-east-1` / `us-isob-east-1`
    // the two sources produce the IDENTICAL string. So an outcome floor of ">= 1"
    // survives deleting that member from `REGIONS`, and A1's set match survives
    // deleting `aws-iso-b` from `PARTITIONS` -- redundant coverage, not a false
    // pass, but exactly the "floor names only the central member" mode. Assert the
    // POOL directly as well, so removing a member from either source list reds
    // here even when the control base still supplies the cell.
    //
    // All three are CONTAINMENT or a floor, never an exact match, and that is a
    // deliberate choice rather than laziness. What they owe the floors below is
    // only "REGIONS / PARTITIONS still SOURCE a cell of this class". A second
    // legitimate `eusc-` region -- `eusc-fr-west-2`, say -- would be added
    // coverage, not a regression, and it moves NO floor below it: every one is a
    // `>=`, and A1's exact set is unmoved because such a region lands in the
    // `aws-eusc` partition that set already names. So pinning the list exactly
    // would red on an improvement while catching nothing a `>= 1` misses --
    // DELETION, the only real regression here, reds under both forms (probed).
    expect(REGIONS.filter((r) => r.startsWith('eusc-')).length).toBeGreaterThanOrEqual(1);
    expect(REGIONS.filter((r) => r.split('-').length > 4).length).toBeGreaterThanOrEqual(1);
    for (const p of ['aws-iso', 'aws-iso-b', 'aws-iso-e', 'aws-iso-f', 'aws-eusc']) {
      expect(PARTITIONS).toContain(p);
    }

    // A1: the five partitions the alternation omitted.
    const a1 = new Set(
      newlyAccepted.map((a) => a.split(':')[1]!).filter((p) => p !== 'aws' && p !== 'aws-cn' && p !== 'aws-us-gov')
    );
    expect([...a1].sort()).toEqual(['aws-eusc', 'aws-iso', 'aws-iso-b', 'aws-iso-e', 'aws-iso-f']);

    // A2: the four-letter region first token (issue #2001's defect).
    expect(newlyAccepted.filter((a) => a.split(':')[3]!.startsWith('eusc-')).length).toBeGreaterThanOrEqual(1);

    // A3: more interior hyphen groups than the pre-fix `{1,2}` cap.
    expect(
      newlyAccepted.filter((a) => a.split(':')[3]!.split('-').length > 4).length
    ).toBeGreaterThanOrEqual(1);

    // B: partition/region mismatches the pre-fix pattern let through.
    expect(newlyRejected.length).toBeGreaterThanOrEqual(10);
    expect(
      newlyRejected.filter((a) => {
        const parts = a.split(':');
        return expectedPartition(parts[3]!) !== parts[1]!;
      }).length
    ).toBe(newlyRejected.length);

    // Unchanged cells: the commercial-partition happy path and the malformed
    // pool must both still be represented, or "no regressions" is vacuous.
    expect(bothAccepted.length).toBeGreaterThanOrEqual(10);
    expect(bothRejected.length).toBeGreaterThanOrEqual(60);
  });
});

describe('layer-ARN parse through the real caller (issue #2143)', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['aws', 'us-east-1'],
    ['aws-cn', 'cn-north-1'],
    ['aws-us-gov', 'us-gov-west-1'],
    ['aws-iso', 'us-iso-east-1'],
    ['aws-iso-b', 'us-isob-east-1'],
    ['aws-iso-e', 'eu-isoe-west-1'],
    ['aws-iso-f', 'us-isof-south-1'],
    ['aws-eusc', 'eusc-de-east-1'],
  ];

  it('covers all eight partitions', () => {
    expect(CASES.length).toBe(PARTITION_TABLE.length + 1);
  });

  for (const [partition, region] of CASES) {
    it(`resolves a layer ARN in ${partition} (${region})`, () => {
      const arn = `arn:${partition}:lambda:${region}:${ACCOUNT}:layer:MyLayer:7`;
      expect(callerVerdict(arn)).toEqual({
        accepted: true,
        region,
        accountId: ACCOUNT,
        name: 'MyLayer',
        version: '7',
      });
    });
  }

  it('resolves the European Sovereign Cloud region (four-letter first token)', () => {
    const arn = `arn:aws-eusc:lambda:eusc-de-east-1:${ACCOUNT}:layer:Sovereign:1`;
    const v = callerVerdict(arn);
    expect(v.accepted).toBe(true);
    expect(v.accepted && v.region).toBe('eusc-de-east-1');
  });

  it('resolves a region with three interior hyphen groups (past the old {1,2} cap)', () => {
    const arn = `arn:aws:lambda:us-central-north-east-1:${ACCOUNT}:layer:MyLayer:1`;
    const v = callerVerdict(arn);
    expect(v.accepted).toBe(true);
    expect(v.accepted && v.region).toBe('us-central-north-east-1');
  });

  it('resolves an unknown-prefix region to the commercial partition', () => {
    // `derivePartitionAndUrlSuffix` answers `aws` for a region it does not
    // know, so a brand-new COMMERCIAL region keeps working before the table
    // hears about it.
    const v = callerVerdict(`arn:aws:lambda:zz-nowhere-9:${ACCOUNT}:layer:MyLayer:1`);
    expect(v.accepted).toBe(true);
  });
});

describe('layer-ARN negative controls (must still be REJECTED)', () => {
  const REJECTED: ReadonlyArray<readonly [string, string]> = [
    ['partition/region mismatch (China partition, commercial region)', `arn:aws-cn:lambda:us-east-1:${ACCOUNT}:layer:MyLayer:1`],
    ['partition/region mismatch (commercial partition, China region)', `arn:aws:lambda:cn-north-1:${ACCOUNT}:layer:MyLayer:1`],
    ['partition/region mismatch (GovCloud partition, commercial region)', `arn:aws-us-gov:lambda:us-east-1:${ACCOUNT}:layer:MyLayer:1`],
    ['unknown-prefix region claiming a non-commercial partition', `arn:aws-eusc:lambda:zz-nowhere-9:${ACCOUNT}:layer:MyLayer:1`],
    ['a partition string that is not a partition', `arn:aws-bogus:lambda:us-east-1:${ACCOUNT}:layer:MyLayer:1`],
    ['wrong service', `arn:aws:s3:us-east-1:${ACCOUNT}:layer:MyLayer:1`],
    ['wrong keyword (function, not layer)', `arn:aws:lambda:us-east-1:${ACCOUNT}:function:MyFn:1`],
    ['unversioned', `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:MyLayer`],
    ['non-numeric version', `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:MyLayer:latest`],
    ['13-digit account id', `arn:aws:lambda:us-east-1:1111222233334:layer:MyLayer:1`],
    ['upper-case region', `arn:aws:lambda:US-EAST-1:${ACCOUNT}:layer:MyLayer:1`],
    ['region carrying a host delimiter', `arn:aws:lambda:evil.example.com#:${ACCOUNT}:layer:MyLayer:1`],
    ['region with no numeric suffix', `arn:aws:lambda:us-east:${ACCOUNT}:layer:MyLayer:1`],
    ['one-letter region first token', `arn:aws:lambda:u-east-1:${ACCOUNT}:layer:MyLayer:1`],
    ['empty partition', `arn::lambda:us-east-1:${ACCOUNT}:layer:MyLayer:1`],
    ['trailing newline', `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:MyLayer:1\n`],
  ];

  for (const [label, arn] of REJECTED) {
    it(`rejects ${label}`, () => {
      const v = callerVerdict(arn);
      expect(v.accepted).toBe(false);
      expect(v.accepted === false && v.message).toContain('cdkd cannot resolve locally');
    });
  }

  // The refusal message (issue #2143). A mismatch is the one rejection a
  // reader cannot see in the ARN's own shape AND the one class this change
  // newly refuses, so it is the only one that earns a hint.
  // The message has TWO partition arms, and the split is about what cdkd
  // actually knows rather than about the input's shape.
  // `derivePartitionAndUrlSuffix` answers `aws` both for a real commercial
  // region and for one no `PARTITION_TABLE` prefix matches, so only a table
  // HIT licenses stating membership as fact.
  it('states membership as fact when PARTITION_TABLE matches the region', () => {
    const v = callerVerdict(`arn:aws:lambda:eusc-de-east-1:${ACCOUNT}:layer:MyLayer:1`);
    expect(v.accepted).toBe(false);
    expect(v.accepted === false && v.message).toContain(
      "The partition 'aws' does not match region 'eusc-de-east-1', which is in partition 'aws-eusc'."
    );
  });

  // `PARTITION_TABLE` has no commercial ROW -- `aws` is the fallback `return`
  // in `derivePartitionAndUrlSuffix` -- so this MISS arm is the arm every
  // genuinely commercial region takes, and `us-east-1` is the canonical
  // example the docs, the integ fixture and the changelog all use. Its wording
  // therefore has to read correctly for a region cdkd recognises perfectly
  // well, which an earlier revision ("no partition prefix CDKD KNOWS matches
  // that region") did not: true of the mechanism, and readable as cdkd not
  // recognising the commonest AWS region. The negative pins that regression.
  it('names the FALLBACK, not a membership claim, when no table prefix matches', () => {
    const v = callerVerdict(`arn:aws-cn:lambda:us-east-1:${ACCOUNT}:layer:MyLayer:1`);
    expect(v.accepted).toBe(false);
    const message = v.accepted === false ? v.message : '';
    expect(message).toContain(
      "The partition 'aws-cn' does not match region 'us-east-1': no partition prefix matches " +
        "that region, so cdkd resolves it to the commercial partition 'aws'."
    );
    expect(message).not.toContain('cdkd knows');
  });

  // The case the fact-arm would get WRONG. `us-isog-east-1` matches no
  // `PARTITION_TABLE` prefix (`us-iso-` does not cover `us-isog-`), so it
  // derives `aws` by fallback -- and it is plainly not a commercial region.
  // A single assertive arm would tell the reader it "is in partition 'aws'".
  it('does not claim a hypothetical future partition region is commercial', () => {
    const v = callerVerdict(`arn:aws-iso-g:lambda:us-isog-east-1:${ACCOUNT}:layer:MyLayer:1`);
    expect(v.accepted).toBe(false);
    const message = v.accepted === false ? v.message : '';
    expect(message).toContain(
      "The partition 'aws-iso-g' does not match region 'us-isog-east-1': no partition prefix " +
        "matches that region, so cdkd resolves it to the commercial partition 'aws'."
    );
    expect(message).not.toContain("which is in partition 'aws'");
  });

  it('adds NO hint to a rejection whose reason is visible in the ARN itself', () => {
    for (const arn of [
      `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:MyLayer`,
      `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:MyLayer:latest`,
      `arn:aws:lambda:US-EAST-1:${ACCOUNT}:layer:MyLayer:1`,
      `arn:aws:s3:us-east-1:${ACCOUNT}:layer:MyLayer:1`,
    ]) {
      const v = callerVerdict(arn);
      expect(v.accepted).toBe(false);
      expect(v.accepted === false && v.message).not.toContain('does not match region');
    }
  });
});
