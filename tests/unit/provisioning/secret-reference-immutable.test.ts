/**
 * go-to-k/cdkd#4275 -- `unchangedBehindSecretReference` /
 * `onlySecretReferencesDiffer`, the predicate every provider's immutable-name
 * guard consults before refusing. The record keeps a secret-derived value as
 * its `{{resolve:...}}` reference (or `***`) while `update()` is handed the
 * resolved plaintext, so the two sides never compare equal.
 *
 * Cases use the deploy's REAL masker (`createSecretMasker`) over the real bag
 * shape, so the masker arm is exercised the way the engine drives it. The
 * create-only lookup is the ENGINE's (`getCreateOnlyPropertyPaths`), stubbed to
 * the committed snapshot so no case reaches DescribeType; single cases override
 * it to show the helper follows the lookup rather than the snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../../../src/provisioning/create-only-properties.js', () => ({
  getCreateOnlyPropertyPaths: lookup,
}));

import {
  onlySecretReferencesDiffer,
  unchangedBehindSecretReference,
} from '../../../src/provisioning/secret-reference-immutable.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';

beforeEach(() => {
  lookup.mockReset();
  lookup.mockImplementation(async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? []);
});

const NAME = 'resolved-secret-name';
const REF = '{{resolve:secretsmanager:name-secret:SecretString:name}}';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const mask = createSecretMasker(bagOf(NAME));

describe('unchangedBehindSecretReference: the physical-id arm', () => {
  const base = { resourceType: 'AWS::ApiGatewayV2::Stage', key: 'StageName' } as const;

  it('a recorded reference whose resolved value is the name the physical id carries is unchanged', async () => {
    expect(
      await unchangedBehindSecretReference({ ...base, desired: NAME, previous: REF, physicalName: NAME })
    ).toBe(true);
  });

  it('a recorded *** is judged by the physical id too', async () => {
    expect(
      await unchangedBehindSecretReference({
        ...base,
        desired: NAME,
        previous: SECRET_MASK,
        physicalName: NAME,
      })
    ).toBe(true);
  });

  it('a desired value naming ANOTHER resource (a rename, or a rotated secret) is a change', async () => {
    expect(
      await unchangedBehindSecretReference({
        ...base,
        desired: 'another-name',
        previous: REF,
        physicalName: NAME,
        maskSecrets: createSecretMasker(bagOf('another-name')),
      })
    ).toBe(false);
  });

  it('an ordinary recorded value never takes the arm, even when the desired side matches the id', async () => {
    expect(
      await unchangedBehindSecretReference({
        ...base,
        desired: NAME,
        previous: 'recorded-plain-name',
        physicalName: NAME,
      })
    ).toBe(false);
  });

  it('an empty physical name falls through to the masker arm', async () => {
    // StageName is create-only, so the masker arm decides, and it matches.
    expect(
      await unchangedBehindSecretReference({
        ...base,
        desired: NAME,
        previous: REF,
        physicalName: '',
        maskSecrets: mask,
      })
    ).toBe(true);
    expect(
      await unchangedBehindSecretReference({ ...base, desired: NAME, previous: REF, physicalName: '' })
    ).toBe(false);
  });
});

describe('unchangedBehindSecretReference: the masker arm (no physical name)', () => {
  const emr = { resourceType: 'AWS::EMR::Cluster', key: 'Name' } as const;

  it('a recorded reference whose desired value the masker recognises is unchanged', async () => {
    expect(
      await unchangedBehindSecretReference({ ...emr, desired: NAME, previous: REF, maskSecrets: mask })
    ).toBe(true);
  });

  it('no masker (identity): the desired value cannot be shown secret-derived, so it is a change', async () => {
    expect(await unchangedBehindSecretReference({ ...emr, desired: NAME, previous: REF })).toBe(false);
  });

  it('a desired LITERAL the masker does not know (the template dropped the reference) is a change', async () => {
    expect(
      await unchangedBehindSecretReference({
        ...emr,
        desired: 'a-literal-name',
        previous: REF,
        maskSecrets: mask,
      })
    ).toBe(false);
  });

  it('a recorded *** is never enough without the physical id', async () => {
    expect(
      await unchangedBehindSecretReference({
        ...emr,
        desired: NAME,
        previous: SECRET_MASK,
        maskSecrets: mask,
      })
    ).toBe(false);
  });

  it('a key the schema does not mark create-only as a whole never takes the arm', async () => {
    // `AWS::Scheduler::Schedule`'s `GroupName` is updatable in the schema, so a
    // re-pointed reference there reaches `update()` and the masker cannot see it.
    expect(
      await unchangedBehindSecretReference({
        resourceType: 'AWS::Scheduler::Schedule',
        key: 'GroupName',
        desired: NAME,
        previous: REF,
        maskSecrets: mask,
      })
    ).toBe(false);
    // A key create-only only at a NESTED path (`ConnectionInput/Name`): a
    // re-pointed reference elsewhere in it is an in-place change.
    expect(
      await unchangedBehindSecretReference({
        resourceType: 'AWS::Glue::Connection',
        key: 'ConnectionInput',
        desired: { Name: 'conn', Description: NAME },
        previous: { Name: 'conn', Description: REF },
        maskSecrets: mask,
      })
    ).toBe(false);
    // And an unknown type has no create-only list at all.
    expect(
      await unchangedBehindSecretReference({
        resourceType: 'AWS::Nope::Nothing',
        key: 'Name',
        desired: NAME,
        previous: REF,
        maskSecrets: mask,
      })
    ).toBe(false);
  });

  it('a nested reference (a Kerberos password) is unchanged when every other leaf is', async () => {
    const previous = { Realm: 'EC2.INTERNAL', KdcAdminPassword: REF };
    const desired = { Realm: 'EC2.INTERNAL', KdcAdminPassword: NAME };
    const kerberos = { resourceType: 'AWS::EMR::Cluster', key: 'KerberosAttributes' } as const;
    expect(await unchangedBehindSecretReference({ ...kerberos, desired, previous, maskSecrets: mask })).toBe(
      true
    );
    expect(
      await unchangedBehindSecretReference({
        ...kerberos,
        desired: { ...desired, Realm: 'OTHER.REALM' },
        previous,
        maskSecrets: mask,
      })
    ).toBe(false);
  });
});

describe('unchangedBehindSecretReference: the gate follows the ENGINE, not the snapshot', () => {
  const emr = { resourceType: 'AWS::EMR::Cluster', key: 'Name' } as const;

  it("the live lookup's answer wins: a key it does not call create-only never takes the arm", async () => {
    lookup.mockResolvedValue([]);
    expect(
      await unchangedBehindSecretReference({ ...emr, desired: NAME, previous: REF, maskSecrets: mask })
    ).toBe(false);
    expect(lookup).toHaveBeenCalledWith('AWS::EMR::Cluster');
  });

  it('an explicit replacement rule qualifies without the schema', async () => {
    // `ReplacementRulesRegistry` lists DBProxyTargetGroup's DBProxyName.
    lookup.mockResolvedValue([]);
    expect(
      await unchangedBehindSecretReference({
        resourceType: 'AWS::RDS::DBProxyTargetGroup',
        key: 'DBProxyName',
        desired: NAME,
        previous: REF,
        maskSecrets: mask,
      })
    ).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('an explicit UPDATABLE classification wins over a schema that calls the key create-only', async () => {
    // The registry marks an EC2 Subnet's MapPublicIpOnLaunch updatable, and
    // the diff never consults the schema for a classified key.
    lookup.mockResolvedValue([['MapPublicIpOnLaunch']]);
    expect(
      await unchangedBehindSecretReference({
        resourceType: 'AWS::EC2::Subnet',
        key: 'MapPublicIpOnLaunch',
        desired: NAME,
        previous: REF,
        maskSecrets: mask,
      })
    ).toBe(false);
  });

  it('a CONDITIONALLY classified key never takes the arm, even when its predicate reads true', async () => {
    // `AWS::Lambda::EventInvokeConfig`'s `FunctionName` replaces only when the
    // function really changes, and its predicate answers true for two absent
    // values: only the registry's classification kind can refuse it here.
    lookup.mockResolvedValue([['FunctionName']]);
    expect(
      await unchangedBehindSecretReference({
        resourceType: 'AWS::Lambda::EventInvokeConfig',
        key: 'FunctionName',
        desired: NAME,
        previous: REF,
        maskSecrets: mask,
      })
    ).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('the lookup is not paid when the values differ by more than a reference', async () => {
    expect(
      await unchangedBehindSecretReference({
        ...emr,
        desired: 'a-literal-name',
        previous: REF,
        maskSecrets: mask,
      })
    ).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('onlySecretReferencesDiffer', () => {
  it('equal values are not "references only": there is nothing to exempt', async () => {
    expect(onlySecretReferencesDiffer(REF, REF, mask)).toBe(false);
    expect(onlySecretReferencesDiffer({ a: 1 }, { a: 1 }, mask)).toBe(false);
  });

  it('keeps the literal text around an embedded reference', async () => {
    const previous = `prefix-${REF}-suffix`;
    expect(onlySecretReferencesDiffer(`prefix-${NAME}-suffix`, previous, mask)).toBe(true);
    expect(onlySecretReferencesDiffer(`other-${NAME}-suffix`, previous, mask)).toBe(false);
    expect(onlySecretReferencesDiffer(`prefix-${NAME}-other`, previous, mask)).toBe(false);
    // Anchored at both ends: text added before or after the literals is a change.
    expect(onlySecretReferencesDiffer(`xprefix-${NAME}`, `prefix-${REF}`, mask)).toBe(false);
    expect(onlySecretReferencesDiffer(`${NAME}-suffix-x`, `${REF}-suffix`, mask)).toBe(false);
  });

  it('reads literal text around the reference literally, not as a pattern', async () => {
    const previous = `a.b-${REF}`;
    expect(onlySecretReferencesDiffer(`a.b-${NAME}`, previous, mask)).toBe(true);
    expect(onlySecretReferencesDiffer(`aXb-${NAME}`, previous, mask)).toBe(false);
  });

  it('a shape change is a change', async () => {
    expect(onlySecretReferencesDiffer([NAME, 'x'], [REF], mask)).toBe(false);
    expect(onlySecretReferencesDiffer({ a: NAME, b: 1 }, { a: REF }, mask)).toBe(false);
    expect(onlySecretReferencesDiffer({ a: NAME }, { a: REF, b: 1 }, mask)).toBe(false);
    expect(onlySecretReferencesDiffer({ b: NAME }, { a: REF }, mask)).toBe(false);
    expect(onlySecretReferencesDiffer(NAME, { a: REF }, mask)).toBe(false);
    expect(onlySecretReferencesDiffer([NAME], { 0: REF }, mask)).toBe(false);
    expect(onlySecretReferencesDiffer(42, REF, mask)).toBe(false);
    expect(onlySecretReferencesDiffer('', REF, mask)).toBe(false);
  });

  it('two references in one string: each resolves in place, the literal between them kept', async () => {
    const REF2 = '{{resolve:secretsmanager:other-secret:SecretString:x}}';
    const two = createSecretMasker(bagOf(NAME, 'second-value'));
    // `::` occurs in neither value, so only the literal between them can supply it.
    expect(onlySecretReferencesDiffer(`${NAME}::second-value`, `${REF}::${REF2}`, two)).toBe(true);
    expect(onlySecretReferencesDiffer(`${NAME}--second-value`, `${REF}::${REF2}`, two)).toBe(false);
  });

  it('arrays compare position by position', async () => {
    expect(onlySecretReferencesDiffer(['s1', NAME], ['s1', REF], mask)).toBe(true);
    expect(onlySecretReferencesDiffer([NAME, 's1'], ['s1', REF], mask)).toBe(false);
  });

  it('a differing non-secret leaf beside a resolved reference is a change', async () => {
    expect(onlySecretReferencesDiffer(['s2', NAME], ['s1', REF], mask)).toBe(false);
  });
});
