import { describe, it, expect } from 'vite-plus/test';
import {
  foldRecording,
  maskSecretsInText,
  mergeResolvedPairs,
  openRecordingScope,
  recordLogOnlyValue,
  recordSecretResolution,
  redactForState,
  scrubResourceRecord,
  SECRET_MASK,
  type LiveScopePolicy,
  type RecordedSecretValues,
  type RecordingKind,
  type RecordingPolicy,
} from '../../../src/deployment/secret-redaction.js';
import { RECORDING_KINDS } from '../../../src/deployment/secret-redaction/recording.js';
import { resolvedPlaintextOf } from '../../../src/deployment/secret-redaction/pairs.js';
import { logOnlyValuesOf } from '../../../src/deployment/secret-redaction/log-only.js';
import {
  containmentValuesOf,
  freshNoEchoValuesOf,
  noEchoParameterValuesOf,
  recordNoEchoParameterFreshValue,
  recordDerivedMaskOnlyValue,
  recordProvenPublicExpression,
  provenPublicValue,
} from '../../../src/deployment/secret-redaction/mask-only.js';
import {
  hasPassProvenance,
  recordReferenceResolution,
} from '../../../src/deployment/secret-redaction/reference-provenance.js';
import {
  physicalNameCopiesOf,
  recordPhysicalNameCopy,
} from '../../../src/deployment/secret-redaction/physical-name-copies.js';
import { redactAtProvenance } from '../../../src/deployment/secret-redaction/context.js';
import { EXPORT_NAME_SCOPE } from '../../../src/deployment/deploy-engine/outputs.js';
import { OUTPUTS_PASS_FOLD } from '../../../src/deployment/deploy-engine/masking.js';

// go-to-k/cdkd#5048: RECORDING and REGISTRATION through one mechanism. A map
// recording on a pass's behalf names, per kind, what reaches the pass; the
// entries and (for a live scope) the log-only needles always do.

const EXPR = '{{resolve:secretsmanager:db:SecretString:password}}';
const PLAINTEXT = 'S3CRETVALUE0001';
const PUBLIC_EXPR = '{{resolve:ssm:/public/host}}';
const PUBLIC_VALUE = 'db.example.com';
const DERIVED = 'UzNDUkVUVkFMVUUwMDAx';
const PHYSICAL_ID = 'arn:aws:sqs:us-east-1:123456789012:queue-S3CRETVALUE0001';
const LOG_ONLY = 'NOECHO-PARAMETER-VALUE';
const FRESH_PARAMETER = 'FRESH-NOECHO-PARAMETER-1';

/** One recording of every kind, written into `secrets`. */
function recordEveryKind(secrets: RecordedSecretValues): void {
  recordSecretResolution(secrets, EXPR, PLAINTEXT, { pairEvidence: true });
  recordLogOnlyValue(secrets, LOG_ONLY);
  recordDerivedMaskOnlyValue(secrets, DERIVED);
  recordNoEchoParameterFreshValue(FRESH_PARAMETER, secrets);
  recordReferenceResolution(secrets, EXPR, {
    region: 'us-east-1',
    version: 'v1',
    route: 'literal',
  });
  recordPhysicalNameCopy(secrets, PHYSICAL_ID);
  recordProvenPublicExpression(secrets, PUBLIC_EXPR, PUBLIC_VALUE);
}

/** Which kinds `pass` holds, read through each kind's own reader. */
function allOrNone(held: boolean[]): boolean | 'partial' {
  if (held.every(Boolean)) return true;
  return held.some(Boolean) ? 'partial' : false;
}

function kindsHeldBy(pass: RecordedSecretValues): Record<RecordingKind, boolean | 'partial'> {
  return {
    pairs: resolvedPlaintextOf(pass, EXPR) === PLAINTEXT,
    'log-only': logOnlyValuesOf.get(pass)?.has(LOG_ONLY) ?? false,
    // All three mark tables, each read separately: `partial` fails either way.
    'mask-only-marks': allOrNone([
      containmentValuesOf.get(pass)?.has(DERIVED) ?? false,
      freshNoEchoValuesOf.get(pass)?.has(FRESH_PARAMETER) ?? false,
      noEchoParameterValuesOf.get(pass)?.has(FRESH_PARAMETER) ?? false,
    ]),
    'reference-provenance': hasPassProvenance(pass),
    'physical-name-copies': physicalNameCopiesOf.get(pass)?.has(PHYSICAL_ID) ?? false,
    'public-proofs': provenPublicValue(pass, PUBLIC_EXPR) === PUBLIC_VALUE,
  };
}

function policyWith(carried: ReadonlySet<RecordingKind>): RecordingPolicy {
  return Object.fromEntries(
    RECORDING_KINDS.map((kind) => [kind, carried.has(kind) ? 'carry' : 'withhold'])
  ) as unknown as RecordingPolicy;
}

describe('recordSecretResolution: the resolver seam', () => {
  it('writes the entry and its pair in one call', () => {
    const secrets: RecordedSecretValues = new Map();
    recordSecretResolution(secrets, EXPR, PLAINTEXT, { pairEvidence: true });
    expect(secrets.get(PLAINTEXT)).toBe(EXPR);
    expect(resolvedPlaintextOf(secrets, EXPR)).toBe(PLAINTEXT);
  });

  it('writes only the entry for a value read at a pinned generation', () => {
    const secrets: RecordedSecretValues = new Map();
    recordSecretResolution(secrets, EXPR, PLAINTEXT, { pairEvidence: false });
    expect(secrets.get(PLAINTEXT)).toBe(EXPR);
    expect(resolvedPlaintextOf(secrets, EXPR)).toBeUndefined();
  });
});

describe('openRecordingScope: a live scope', () => {
  it('keeps its own entries exact and writes each through to the pass', () => {
    const pass: RecordedSecretValues = new Map([['OTHERSECRET01', '{{resolve:secretsmanager:o}}']]);
    const scope = openRecordingScope(pass, EXPORT_NAME_SCOPE);
    recordSecretResolution(scope.secrets, EXPR, PLAINTEXT, { pairEvidence: true });
    expect([...scope.secrets.keys()]).toEqual([PLAINTEXT]);
    expect(pass.get(PLAINTEXT)).toBe(EXPR);
    expect(scope.pass).toBe(pass);
  });

  it('delivers a record made after the writer stopped looking (no release step)', () => {
    // #1940 / #2814: a recording that lands after a throw, or after the
    // block that opened the scope has ended, must still reach the pass.
    const pass: RecordedSecretValues = new Map();
    let late: RecordedSecretValues | undefined;
    try {
      const scope = openRecordingScope(pass, EXPORT_NAME_SCOPE);
      late = scope.secrets;
      throw new Error('resolution failed');
    } catch {
      // the writer abandons the scope here
    }
    recordSecretResolution(late!, EXPR, PLAINTEXT, { pairEvidence: true });
    recordLogOnlyValue(late!, LOG_ONLY);
    expect(maskSecretsInText(`a ${PLAINTEXT} b ${LOG_ONLY}`, pass)).toBe(
      `a ${SECRET_MASK} b ${SECRET_MASK}`
    );
  });

  it('registers a mask-only value with every masker of the pass', () => {
    const pass: RecordedSecretValues = new Map();
    const scope = openRecordingScope(pass, EXPORT_NAME_SCOPE);
    recordDerivedMaskOnlyValue(scope.secrets, DERIVED);
    expect(maskSecretsInText(`x ${DERIVED}`, pass)).toBe(`x ${SECRET_MASK}`);
  });

  for (const kind of RECORDING_KINDS.filter((k) => k !== 'log-only')) {
    it(`shares ${kind} with the pass only when the policy carries it`, () => {
      for (const carried of [true, false]) {
        const pass: RecordedSecretValues = new Map();
        const policy = policyWith(new Set<RecordingKind>(carried ? [kind, 'log-only'] : ['log-only']));
        const scope = openRecordingScope(pass, policy as LiveScopePolicy);
        recordEveryKind(scope.secrets);
        const held = kindsHeldBy(pass);
        expect({ kind, carried, held: held[kind] }).toEqual({ kind, carried, held: carried });
        // The scope itself always holds what it recorded.
        expect(kindsHeldBy(scope.secrets)[kind]).toBe(true);
      }
    });
  }

  it('cannot withhold log-only needles (compile time)', () => {
    const pass: RecordedSecretValues = new Map();
    const withholding = { ...EXPORT_NAME_SCOPE, 'log-only': 'withhold' } as const;
    // @ts-expect-error -- a live scope's log-only needles always reach the pass
    const scope = openRecordingScope(pass, withholding);
    expect(scope.pass).toBe(pass);
  });

  it('requires every kind to be named (compile time)', () => {
    // @ts-expect-error -- a policy missing a kind does not compile
    const partial: RecordingPolicy = { pairs: 'carry', 'log-only': 'carry' };
    expect(partial).toBeDefined();
  });
});

describe('foldRecording: an accumulator built from several pass maps', () => {
  for (const kind of RECORDING_KINDS) {
    it(`carries ${kind} only when the policy carries it, and every entry always`, () => {
      for (const carried of [true, false]) {
        const from: RecordedSecretValues = new Map();
        recordEveryKind(from);
        const to: RecordedSecretValues = new Map();
        foldRecording(from, to, policyWith(new Set<RecordingKind>(carried ? [kind] : [])));
        expect([...to]).toEqual([...from]);
        expect({ kind, carried, held: kindsHeldBy(to)[kind] }).toEqual({
          kind,
          carried,
          held: carried,
        });
      }
    });
  }

  it('is safe to repeat: the second fold changes nothing', () => {
    const from: RecordedSecretValues = new Map();
    recordEveryKind(from);
    const to: RecordedSecretValues = new Map();
    foldRecording(from, to, OUTPUTS_PASS_FOLD);
    const once = { entries: [...to], kinds: kindsHeldBy(to) };
    foldRecording(from, to, OUTPUTS_PASS_FOLD);
    expect({ entries: [...to], kinds: kindsHeldBy(to) }).toEqual(once);
    expect(resolvedPlaintextOf(to, EXPR)).toBe(PLAINTEXT);
  });
});

describe('the two deploy-engine policies preserve what their sites carried before #5048', () => {
  it('the outputs fold carries what the entry copy + mergeResolvedPairs + physical-id copy did', () => {
    const from: RecordedSecretValues = new Map();
    recordEveryKind(from);
    const legacy: RecordedSecretValues = new Map();
    for (const [plaintext, expression] of from) legacy.set(plaintext, expression);
    mergeResolvedPairs(from, legacy);
    for (const id of physicalNameCopiesOf.get(from) ?? []) recordPhysicalNameCopy(legacy, id);
    const folded: RecordedSecretValues = new Map();
    foldRecording(from, folded, OUTPUTS_PASS_FOLD);
    expect([...folded]).toEqual([...legacy]);
    expect(kindsHeldBy(folded)).toEqual(kindsHeldBy(legacy));
  });

  it('the export-name scope shares what the write-through map + shared log-only set did', () => {
    const pass: RecordedSecretValues = new Map();
    const scope = openRecordingScope(pass, EXPORT_NAME_SCOPE);
    recordEveryKind(scope.secrets);
    expect(pass.get(PLAINTEXT)).toBe(EXPR);
    expect(pass.get(DERIVED)).toBe(SECRET_MASK);
    expect(kindsHeldBy(pass)).toEqual({
      pairs: false,
      'log-only': true,
      'mask-only-marks': false,
      'reference-provenance': false,
      'physical-name-copies': false,
      'public-proofs': false,
    });
  });
});

describe('the persistence choke point refuses a scope as its pass', () => {
  const scopeMap = (): RecordedSecretValues => {
    const scope = openRecordingScope(new Map(), EXPORT_NAME_SCOPE);
    recordSecretResolution(scope.secrets, EXPR, PLAINTEXT, { pairEvidence: true });
    return scope.secrets;
  };

  it('redactForState, for every provenance', () => {
    const secrets = scopeMap();
    expect(() => redactForState({ A: PLAINTEXT }, { provenance: 'value-scan', secrets })).toThrow(
      /recording scope/
    );
    expect(() =>
      redactForState(
        { A: PLAINTEXT },
        { provenance: 'state-readback', secrets, source: { A: EXPR } }
      )
    ).toThrow(/recording scope/);
  });

  it('the family-internal walk entry and scrubResourceRecord', () => {
    const secrets = scopeMap();
    expect(() =>
      redactAtProvenance({ A: PLAINTEXT }, secrets, { A: EXPR }, 'template-derived', true)
    ).toThrow(/recording scope/);
    expect(() => scrubResourceRecord({ properties: { A: PLAINTEXT } }, secrets)).toThrow(
      /recording scope/
    );
  });

  it('accepts the pass the scope recorded into', () => {
    const pass: RecordedSecretValues = new Map();
    const scope = openRecordingScope(pass, EXPORT_NAME_SCOPE);
    recordSecretResolution(scope.secrets, EXPR, PLAINTEXT, { pairEvidence: true });
    expect(redactForState({ A: PLAINTEXT }, { provenance: 'value-scan', secrets: pass })).toEqual({
      A: EXPR,
    });
  });
});
