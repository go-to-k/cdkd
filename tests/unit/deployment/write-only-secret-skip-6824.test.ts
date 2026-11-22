/**
 * go-to-k/cdkd#6824: the engine's decision to leave an unchanged write-only
 * secret reference out of a Cloud Control update, its write-ahead, and the
 * `versionsSent` attestation the decision reads, as pure functions. Each arm
 * of the decision is flipped singly against an all-green baseline: the key is
 * then SENT. The engine wiring is pinned in
 * `deploy-engine-write-only-secret-skip-6824.test.ts`, the provider's half in
 * `cloud-control-write-only-secret-6824.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  recordToWriteAhead,
  unchangedWriteOnlySecretProperties,
  type WriteOnlySecretSkipInput,
} from '../../../src/deployment/deploy-engine/update-in-place/write-only-secret-skip.js';
import { recordReferenceResolution } from '../../../src/deployment/secret-redaction/reference-provenance.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import {
  provenanceForWrittenRecord,
  recordedProvenanceOf,
  referenceProvenanceOf,
  validateReferenceProvenance,
  withTokenVersionsDropped,
  withoutVersionAttestation,
} from '../../../src/deployment/reference-provenance-record.js';
import type { ReferenceProvenance, ResourceState } from '../../../src/types/state.js';
import { recordAfterRollbackUpdate } from '../../../src/deployment/rollback-executor/replay-retry.js';
import { sentWriteOnlySecretTokens } from '../../../src/deployment/deploy-engine/state-persist.js';

const TOKEN = '{{resolve:secretsmanager:db-secret:SecretString:password::}}';
const OTHER = '{{resolve:secretsmanager:other-secret:SecretString:password::}}';
const PLAIN = 'resolved-password-value';
const OTHER_PLAIN = 'other-password-value';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const TYPE = 'AWS::DMS::Endpoint';
const REGION = 'us-east-1';

const attested = (overrides: Partial<ReferenceProvenance> = {}): ReferenceProvenance => ({
  region: REGION,
  versions: [V1],
  versionsSent: true,
  ...overrides,
});

function record(
  provenance: Record<string, ReferenceProvenance> | 'none' = { [TOKEN]: attested() },
  overrides: Partial<ResourceState> = {}
): ResourceState {
  return {
    physicalId: 'endpoint-1',
    resourceType: TYPE,
    provisionedBy: 'cc-api',
    properties: { Password: TOKEN, Tags: [{ Key: 'k', Value: 'a' }] },
    ...(provenance !== 'none' && { referenceProvenance: provenance }),
    ...overrides,
  };
}

/** A pass bag that resolved `TOKEN` to `PLAIN` at `versions` in `region`. */
function pass(versions: (string | undefined)[] = [V1], region: string | null = REGION) {
  const secrets = new Map<string, string>([[PLAIN, TOKEN]]);
  for (const version of versions) {
    recordReferenceResolution(secrets, TOKEN, {
      region: region ?? undefined,
      version,
      route: 'literal',
    });
  }
  return secrets;
}

function input(overrides: Partial<WriteOnlySecretSkipInput> = {}): WriteOnlySecretSkipInput {
  const secrets = overrides.secrets ?? pass();
  return {
    resourceType: TYPE,
    record: record(),
    route: 'cc-api',
    sdkMigration: false,
    skipAllowed: true,
    unsettled: new Set(),
    changed: new Set(),
    previous: { Password: TOKEN, Tags: [{ Key: 'k', Value: 'a' }] },
    desired: { Password: PLAIN, Tags: [{ Key: 'k', Value: 'b' }] },
    secrets,
    maskSecrets: createSecretMasker(secrets),
    ...overrides,
  };
}

describe('unchangedWriteOnlySecretProperties: the mutation table (go-to-k/cdkd#6824)', () => {
  it('every arm green: the key is named unchanged', () => {
    expect(unchangedWriteOnlySecretProperties(input())).toEqual(new Set(['Password']));
  });

  const sent: Array<[string, () => WriteOnlySecretSkipInput]> = [
    ['a different version this pass', () => input({ secrets: pass([V2]) })],
    ['two versions this pass', () => input({ secrets: pass([V1, V2]) })],
    ['a version-less resolution this pass', () => input({ secrets: pass([V1, undefined]) })],
    ['no pass provenance at all', () => input({ secrets: new Map([[PLAIN, TOKEN]]) })],
    ['a region-less resolution this pass', () => input({ secrets: pass([V1], null) })],
    ['the pass resolved another region', () => input({ secrets: pass([V1], 'eu-west-1') })],
    [
      'two recorded versions',
      () => input({ record: record({ [TOKEN]: attested({ versions: [V1, V2] }) }) }),
    ],
    ['an empty recorded entry ({})', () => input({ record: record({ [TOKEN]: {} }) })],
    ['no recorded field (a v11 record)', () => input({ record: record('none') })],
    ['no entry for the token', () => input({ record: record({ [OTHER]: attested() }) })],
    [
      'a recorded region that differs',
      () => input({ record: record({ [TOKEN]: attested({ region: 'eu-west-1' }) }) }),
    ],
    [
      'a region-less record',
      () => input({ record: record({ [TOKEN]: { versions: [V1], versionsSent: true } }) }),
    ],
    [
      'a recorded version that differs',
      () => input({ record: record({ [TOKEN]: attested({ versions: [V2] }) }) }),
    ],
    [
      'no attestation (a plain singleton an older binary wrote)',
      () => input({ record: record({ [TOKEN]: { region: REGION, versions: [V1] } }) }),
    ],
    [
      'the previous side holds the mask',
      () => input({ previous: { Password: SECRET_MASK, Tags: [{ Key: 'k', Value: 'a' }] } }),
    ],
    [
      'a literal added around the reference (changed as written)',
      () => input({ desired: { Password: `x${PLAIN}` }, changed: new Set(['Password']) }),
    ],
    ['the key is changed as written', () => input({ changed: new Set(['Password']) })],
    [
      'the desired side is not a value the masker recognises',
      () => input({ desired: { Password: 'some-other-literal' } }),
    ],
    ['the key is unsettled', () => input({ unsettled: new Set(['Password']) })],
    ['the journal arm (a journal segment, or an unreadable journal)', () => input({ skipAllowed: false })],
    [
      'an SDK-written record',
      () => input({ record: { ...record(), provisionedBy: 'sdk' } }),
    ],
    ['a record with no recorded route', () => input({ record: { ...record(), provisionedBy: undefined } })],
    ['an SDK route', () => input({ route: 'sdk' })],
    ['a sticky Cloud Control record moving to its SDK provider', () => input({ sdkMigration: true })],
    ['a type the table does not name', () => input({ resourceType: 'AWS::SQS::Queue' })],
  ];
  for (const [arm, build] of sent) {
    it(`flipped singly, ${arm}: the key is sent`, () => {
      expect(unchangedWriteOnlySecretProperties(build())?.has('Password') ?? false).toBe(false);
    });
  }

  it('a second token under the key that fails any arm sends the key', () => {
    const secrets = pass();
    secrets.set(OTHER_PLAIN, OTHER);
    recordReferenceResolution(secrets, OTHER, { region: REGION, version: V2, route: 'literal' });
    const both = `${TOKEN}:${OTHER}`;
    expect(
      unchangedWriteOnlySecretProperties(
        input({
          secrets,
          maskSecrets: createSecretMasker(secrets),
          record: record(
            { [TOKEN]: attested(), [OTHER]: attested() },
            { properties: { Password: both } }
          ),
          previous: { Password: both },
          desired: { Password: `${PLAIN}:${OTHER_PLAIN}` },
        })
      )
    ).toBeUndefined();
  });
});

describe('recordToWriteAhead (go-to-k/cdkd#6824)', () => {
  const ahead = (overrides: Partial<WriteOnlySecretSkipInput> = {}) => {
    const i = input(overrides);
    return recordToWriteAhead(i);
  };

  it('the same attested version: nothing to write ahead', () => {
    expect(ahead()).toBeUndefined();
  });

  it('a rotated version: the token loses its version arm, keeping its region', () => {
    const held = record();
    const out = ahead({ record: held, secrets: pass([V2]) });
    expect(out).toBeDefined();
    expect(referenceProvenanceOf(out)).toEqual({ [TOKEN]: { region: REGION } });
    // The properties bag is the record's own object, never re-marked.
    expect(out!.properties).toBe(held.properties);
  });

  it('the key changed as written at the same version (a literal added): written ahead', () => {
    expect(
      ahead({ desired: { Password: `x${PLAIN}` }, changed: new Set(['Password']) })
    ).toBeDefined();
  });

  it('the key moving to a literal: written ahead too (the old version is about to be overwritten)', () => {
    const literal = 'a-template-literal';
    const secrets = new Map<string, string>();
    expect(
      ahead({ secrets, maskSecrets: createSecretMasker(secrets), desired: { Password: literal } })
    ).toBeDefined();
  });

  it('the key removed from the template: written ahead', () => {
    expect(ahead({ desired: { Tags: [] } })).toBeDefined();
  });

  it('an unattested record: nothing to write ahead (it already names no trusted version)', () => {
    expect(
      ahead({ record: record({ [TOKEN]: { region: REGION, versions: [V1] } }), secrets: pass([V2]) })
    ).toBeUndefined();
  });

  it('an attested token outside the measured keys is left alone', () => {
    expect(
      ahead({
        record: record(
          { [TOKEN]: attested() },
          { properties: { Description: TOKEN, Tags: [] } }
        ),
        secrets: pass([V2]),
      })
    ).toBeUndefined();
  });
});

describe('the versionsSent attestation (go-to-k/cdkd#6824)', () => {
  it('is kept only beside a valid versions arm', () => {
    expect(validateReferenceProvenance(TOKEN, attested())).toEqual(attested());
    expect(validateReferenceProvenance(TOKEN, { region: REGION, versionsSent: true })).toEqual({
      region: REGION,
    });
    expect(
      validateReferenceProvenance(TOKEN, { region: REGION, versions: ['bad'], versionsSent: true })
    ).toEqual({ region: REGION });
    expect(validateReferenceProvenance(TOKEN, { ...attested(), versionsSent: 'yes' })).toEqual({
      region: REGION,
      versions: [V1],
    });
  });

  it('withTokenVersionsDropped keeps the other tokens whole', () => {
    const out = withTokenVersionsDropped(
      record({ [TOKEN]: attested(), [OTHER]: attested() }),
      new Set([TOKEN])
    );
    expect(recordedProvenanceOf(out, TOKEN)).toEqual({ region: REGION });
    expect(recordedProvenanceOf(out, OTHER)).toEqual(attested());
  });

  it('withoutVersionAttestation strips it and keeps the versions (the rollback pin)', () => {
    const out = withoutVersionAttestation(record());
    expect(recordedProvenanceOf(out, TOKEN)).toEqual({ region: REGION, versions: [V1] });
    const bare = record({ [TOKEN]: { region: REGION, versions: [V1] } });
    expect(withoutVersionAttestation(bare)).toBe(bare);
  });

  describe('provenanceForWrittenRecord', () => {
    const written = { properties: { Password: TOKEN } };

    it('stamps a named token whose pass entry is a single version', () => {
      expect(
        provenanceForWrittenRecord({
          record: written,
          secrets: pass(),
          previous: undefined,
          inPlace: undefined,
          attest: new Set([TOKEN]),
        })
      ).toEqual({ [TOKEN]: attested() });
    });

    it('does not stamp a region-less entry (the skip could never take it)', () => {
      expect(
        provenanceForWrittenRecord({
          record: written,
          secrets: pass([V1], null),
          previous: undefined,
          inPlace: undefined,
          attest: new Set([TOKEN]),
        })
      ).toEqual({ [TOKEN]: { versions: [V1] } });
    });

    it('does not stamp an unnamed token, nor two versions', () => {
      expect(
        provenanceForWrittenRecord({
          record: written,
          secrets: pass(),
          previous: undefined,
          inPlace: undefined,
        })
      ).toEqual({ [TOKEN]: { region: REGION, versions: [V1] } });
      expect(
        provenanceForWrittenRecord({
          record: written,
          secrets: pass([V1, V2]),
          previous: undefined,
          inPlace: undefined,
          attest: new Set([TOKEN]),
        })
      ).toEqual({ [TOKEN]: { region: REGION, versions: [V1, V2] } });
    });

    it('never stamps through the union rule, nor carries a previous stamp', () => {
      const previous = record();
      const inPlace = { createOnly: 'all' as const, attributesCarried: false };
      expect(
        provenanceForWrittenRecord({
          record: written,
          secrets: pass(),
          previous,
          inPlace,
          attest: new Set([TOKEN]),
        })
      ).toEqual({ [TOKEN]: { region: REGION, versions: [V1] } });
      expect(
        provenanceForWrittenRecord({
          record: written,
          secrets: new Map([[OTHER_PLAIN, OTHER]]),
          previous,
          inPlace,
          attest: new Set([TOKEN]),
          walkWithoutPassProvenance: true,
        })
      ).toEqual({ [TOKEN]: { region: REGION, versions: [V1] } });
    });
  });
});

describe('sentWriteOnlySecretTokens: which written records attest (go-to-k/cdkd#6824)', () => {
  const engine = (resumed: string[] = []) =>
    ({ resumedCreates: new Map(resumed.map((id) => [id, {}])) }) as never;

  it('a Cloud Control write names the tokens under its measured keys only', () => {
    const r = record('none', { properties: { Password: TOKEN, Description: OTHER } });
    expect(sentWriteOnlySecretTokens(engine(), 'P', r)).toEqual(new Set([TOKEN]));
  });

  it('a resumed create names none: its value went out in an earlier run', () => {
    expect(sentWriteOnlySecretTokens(engine(['P']), 'P', record('none'))).toBeUndefined();
  });

  it('an SDK write names none', () => {
    expect(
      sentWriteOnlySecretTokens(engine(), 'P', record('none', { provisionedBy: 'sdk' }))
    ).toBeUndefined();
  });

  it('a key refused on update is no candidate: a rotated value there is never sent', () => {
    const user = record('none', {
      resourceType: 'AWS::Connect::User',
      properties: { Password: TOKEN },
    });
    expect(sentWriteOnlySecretTokens(engine(), 'P', user)).toBeUndefined();
  });
});

describe('a rollback restore never vouches for a sent version (go-to-k/cdkd#6824)', () => {
  it('recordAfterRollbackUpdate strips the attestation and keeps the version', () => {
    const restored = recordAfterRollbackUpdate(record(), { physicalId: 'endpoint-1', wasReplaced: false });
    expect(recordedProvenanceOf(restored, TOKEN)).toEqual({ region: REGION, versions: [V1] });
  });
});
