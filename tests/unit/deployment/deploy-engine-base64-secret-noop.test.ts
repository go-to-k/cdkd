import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  REFUSED_FINGERPRINT,
  markWrittenFromDeployedTemplate,
  maskedInputFingerprint,
  maskedPropertyFingerprint,
} from '../../../src/deployment/masked-property-fingerprints.js';
import {
  recordFreshNoEchoValuesIn,
  recordLogOnlyValue,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * A redeploy of an UNCHANGED template whose property is `Fn::Base64` over a
 * `{{resolve:...}}` input sends nothing (go-to-k/cdkd#3662 review round), and
 * an EDIT around that reference is sent (go-to-k/cdkd#4451).
 *
 * `Fn::Base64` registers the encoding of a secret as a MASK-ONLY needle
 * (issue #2759), so the record persists `***`. The diff, which does not
 * resolve dynamic references, compares a WHOLE-leaf encoding as that mask
 * (issue #2909), so it reports NO_CHANGE; a leaf EMBEDDING the encoding still
 * diffs UPDATE, and the engine's no-change skip absorbs that. #3662 stopped the skip trusting a
 * mask for a `NoEcho` value supplied in the same deploy; this is the other
 * mask-only population, a DERIVED needle, which must keep taking the skip, or
 * every deploy re-sends it (a new LaunchTemplate version, an Instance
 * `UserData` update). The resolver and the diff are REAL here.
 *
 * `***` == `***` also hid every edit AROUND the reference (#4451): the record
 * now carries a fingerprint of the UNRESOLVED template value, and both the
 * diff and the skip treat a moved one as a change.
 */
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
// The SecureString value each `GetParameter` returns, by parameter name, so
// a test can rotate one.
const secretValues = new Map<string, string>();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn((command: { input: { Name: string } }) =>
        Promise.resolve({
          Parameter: {
            Value: secretValues.get(command.input.Name) ?? 'pw-secret-value',
            Type: 'SecureString',
          },
        })
      ),
    },
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

beforeEach(() => {
  secretValues.clear();
});

const base64Value = (script: string, reference = '{{resolve:ssm-secure:/app/pw}}'): unknown => ({
  'Fn::Base64': { 'Fn::Join': ['', [script, reference]] },
});
const PROPS = {
  Name: '/app/ud',
  Type: 'String',
  Value: base64Value('pw='),
};
// go-to-k/cdkd#2453: the same encoding EMBEDDED in a longer leaf, which a
// whole-leaf-only mask left decodable in state.
const embedded = (inner: unknown): Record<string, unknown> => ({
  Name: '/app/ud',
  Type: 'String',
  Value: { 'Fn::Join': ['', ['#!/bin/bash\nUD=', inner, '\n']] },
});
const EMBEDDED_PROPS = embedded(PROPS.Value);
/**
 * The layout-2 fingerprint (go-to-k/cdkd#4543) a deploy stamps on a value
 * reading no input: the `Fn::Base64` / `Fn::Join` shape and its text.
 */
const inputFp = (value: unknown): Promise<string | undefined> =>
  maskedInputFingerprint(value, {
    template: { Resources: {} },
    parameterInput: () => ({ kind: 'unknown' }),
    resolve: () => Promise.reject(new Error('no input to resolve')),
  });
const encoded = Buffer.from('pw=pw-secret-value').toString('base64');

describe('DeployEngine - a Base64-encoded secret is not re-sent on an unchanged redeploy', () => {
  it('persists the mask on CREATE, and the redeploy diffs NO_CHANGE (go-to-k/cdkd#2909)', async () => {
    await createThenRedeploy(PROPS, 'NO_CHANGE');
  });

  it('masks WHOLE a leaf EMBEDDING the encoding, and still skips the unchanged redeploy (go-to-k/cdkd#2453)', async () => {
    const { created, provider } = await createThenRedeploy(EMBEDDED_PROPS, 'UPDATE');
    // The value AWS received really did embed the encoding...
    expect(provider.create.mock.calls[0]![2]).toMatchObject({
      Value: `#!/bin/bash\nUD=${encoded}\n`,
    });
    // ...and no state version holds it.
    expect(JSON.stringify(created)).not.toContain(encoded);
  });

  it('records the fingerprint of the UNRESOLVED template value, never of anything resolved (go-to-k/cdkd#4451)', async () => {
    const h = harness();
    const created = await h.deploy(PROPS);
    expect(created.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: await inputFp(PROPS.Value),
    });
    // Only the masked property is fingerprinted.
    expect(Object.keys(created.resources['R']!.maskedPropertyFingerprints!)).toEqual(['Value']);
    const json = JSON.stringify(created);
    expect(json).not.toContain('pw-secret-value');
    expect(json).not.toContain(encoded);
  });

  it('a rotated secret behind an unchanged template sends nothing (CloudFormation parity)', async () => {
    for (const props of [PROPS, EMBEDDED_PROPS]) {
      const h = harness();
      await h.deploy(props);
      secretValues.set('/app/pw', 'rotated-secret-value');
      const after = await h.deploy(props);
      expect(h.provider.update).not.toHaveBeenCalled();
      expect(after.resources['R']!.maskedPropertyFingerprints).toEqual({
        Value: await inputFp(props.Value),
      });
    }
  });
});

describe('DeployEngine - an edit around a secret reference inside Fn::Base64 is sent (go-to-k/cdkd#4451)', () => {
  const cases: Array<{
    name: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    sent: string;
    diff: 'UPDATE';
  }> = [
    {
      name: 'whole-leaf Fn::Base64, text around the reference edited',
      before: PROPS,
      after: { ...PROPS, Value: base64Value('echo B\npw=') },
      sent: Buffer.from('echo B\npw=pw-secret-value').toString('base64'),
      diff: 'UPDATE',
    },
    {
      name: 'whole-leaf Fn::Base64, reference retargeted',
      before: PROPS,
      after: { ...PROPS, Value: base64Value('pw=', '{{resolve:ssm-secure:/app/other}}') },
      sent: Buffer.from('pw=other-secret-value').toString('base64'),
      diff: 'UPDATE',
    },
    {
      name: 'Fn::Base64 EMBEDDED in a longer leaf, text around the reference edited',
      before: EMBEDDED_PROPS,
      after: embedded(base64Value('echo B\npw=')),
      sent: `#!/bin/bash\nUD=${Buffer.from('echo B\npw=pw-secret-value').toString('base64')}\n`,
      diff: 'UPDATE',
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      secretValues.set('/app/other', 'other-secret-value');
      const h = harness();
      await h.deploy(c.before);
      const after = await h.deploy(c.after);
      expect(h.lastChange()?.changeType).toBe(c.diff);
      expect(h.provider.update).toHaveBeenCalledTimes(1);
      // The NEW value reached the provider, resolved.
      const sent = (h.provider.update.mock.calls[0]![3] as Record<string, unknown>)['Value'];
      expect(sent).toBe(c.sent);
      // The record now describes the new template, so a third deploy of it is
      // a no-op again.
      expect(after.resources['R']!.properties['Value']).toBe('***');
      expect(after.resources['R']!.maskedPropertyFingerprints).toEqual({
        Value: await inputFp(c.after['Value']),
      });
      await h.deploy(c.after);
      expect(h.provider.update).toHaveBeenCalledTimes(1);
    });
  }

  it('a record WITHOUT the field (an older cdkd) behaves as before, is backfilled, and the NEXT edit is sent', async () => {
    const h = harness();
    const created = await h.deploy(PROPS);
    // What an older cdkd wrote: the same record without the field.
    const { maskedPropertyFingerprints: _dropped, ...legacy } = created.resources['R']!;
    // With a baseline, so no observed-state refresh saves this run for it.
    h.setState({
      ...created,
      resources: { R: { ...legacy, observedProperties: { Name: '/app/ud', Type: 'String' } } },
    });
    const saves = h.saveCount();

    // The upgrade deploy of an UNCHANGED template sends nothing...
    const upgraded = await h.deploy(PROPS);
    expect(h.provider.update).not.toHaveBeenCalled();
    // ...and saves the backfilled fingerprint (the no-change path's trigger).
    expect(h.lastChange()?.changeType).toBe('NO_CHANGE');
    expect(h.saveCount()).toBeGreaterThan(saves);
    expect(upgraded.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: await inputFp(PROPS.Value),
    });

    // The next edit around the reference reaches AWS.
    await h.deploy({ ...PROPS, Value: base64Value('echo B\npw=') });
    expect(h.provider.update).toHaveBeenCalledTimes(1);
  });

  it('a record WITHOUT the field and an edited template sends nothing, as before the field existed', async () => {
    // No evidence of what AWS holds: the first deploy under this version
    // keeps the old comparison rather than updating every such resource.
    for (const props of [PROPS, EMBEDDED_PROPS]) {
      const h = harness();
      const created = await h.deploy(props);
      const { maskedPropertyFingerprints: _dropped, ...legacy } = created.resources['R']!;
      h.setState({ ...created, resources: { R: legacy } });
      const edited =
        props === PROPS
          ? { ...PROPS, Value: base64Value('echo B\npw=') }
          : embedded(base64Value('echo B\npw='));
      await h.deploy(edited);
      expect(h.provider.update).not.toHaveBeenCalled();
    }
  });

  it('a FAILED update keeps the previous fingerprint, so the retry still sends the edit', async () => {
    const h = harness();
    await h.deploy(PROPS);
    const edited = { ...PROPS, Value: base64Value('echo B\npw=') };
    h.provider.update.mockRejectedValueOnce(new Error('boom'));
    await expect(h.deploy(edited, { noRollback: true })).rejects.toThrow();
    const failed = h.saved();
    expect(failed.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: await inputFp(PROPS.Value),
    });
    expect(h.provider.update).toHaveBeenCalledTimes(1);

    await h.deploy(edited);
    expect(h.provider.update).toHaveBeenCalledTimes(2);
  });
});

describe('DeployEngine - a rollback-orphaned record this deploy created keeps its fingerprints (go-to-k/cdkd#4451)', () => {
  // The rollback moves the in-memory CREATE record into `orphans`, so the
  // save meets the bag this deploy wrote there rather than in `resources`.
  function persistOrphan(
    bag: Record<string, unknown>,
    resolvedType: string,
    templateProps: Record<string, unknown> = PROPS,
    secrets: Map<string, string> = new Map(),
    noEchoValues?: Map<string, string>
  ): StackState {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false },
      'us-east-1'
    );
    engine.perResourceTemplateProps.set('R', templateProps);
    engine.perResourceResolvedType.set('R', resolvedType);
    engine.perResourceSecrets.set('R', secrets);
    engine.fingerprintNoEchoValues = noEchoValues;
    const state: StackState = {
      version: 10,
      stackName: 's',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      orphans: [
        {
          logicalId: 'R',
          orphanedAt: 0,
          state: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: bag },
        },
      ],
      lastModified: 0,
    };
    return (
      engine as unknown as { redactStateForPersist(s: StackState): StackState }
    ).redactStateForPersist(state);
  }

  it('stamps an orphan whose bag this deploy wrote', () => {
    const saved = persistOrphan(
      markWrittenFromDeployedTemplate({ Name: '/app/ud', Type: 'String', Value: '***' }),
      'AWS::SSM::Parameter'
    );
    expect(saved.orphans![0]!.state.maskedPropertyFingerprints).toEqual({
      Value: maskedPropertyFingerprint(PROPS.Value),
    });
  });

  it('refuses a hash to an orphan whose template holds a needle of the resource (R1)', () => {
    const literal = { ...PROPS, Value: base64Value('pw-secret-value;') };
    const saved = persistOrphan(
      markWrittenFromDeployedTemplate({ Name: '/app/ud', Type: 'String', Value: '***' }),
      'AWS::SSM::Parameter',
      literal,
      new Map([['pw-secret-value', '{{resolve:ssm-secure:/app/pw}}']])
    );
    expect(saved.orphans![0]!.state.maskedPropertyFingerprints).toEqual({
      Value: REFUSED_FINGERPRINT,
    });
  });

  it('refuses a hash to an orphan whose template spells a NoEcho parameter value (R4)', () => {
    const noEcho = new Map<string, string>();
    recordLogOnlyValue(noEcho, 'noecho-param-value-42');
    const saved = persistOrphan(
      markWrittenFromDeployedTemplate({ Name: '/app/ud', Type: 'String', Value: '***' }),
      'AWS::SSM::Parameter',
      { ...PROPS, Value: base64Value('p=noecho-param-value-42;') },
      new Map(),
      noEcho
    );
    expect(saved.orphans![0]!.state.maskedPropertyFingerprints).toEqual({
      Value: REFUSED_FINGERPRINT,
    });
  });

  it('leaves an orphan an earlier deploy wrote, or one of another type, alone', () => {
    expect(
      persistOrphan({ Name: '/app/ud', Type: 'String', Value: '***' }, 'AWS::SSM::Parameter')
        .orphans![0]!.state.maskedPropertyFingerprints
    ).toBeUndefined();
    expect(
      persistOrphan(
        markWrittenFromDeployedTemplate({ Name: '/app/ud', Type: 'String', Value: '***' }),
        'AWS::SNS::Topic'
      ).orphans![0]!.state.maskedPropertyFingerprints
    ).toBeUndefined();
  });
});

describe('DeployEngine - review-round pins (go-to-k/cdkd#4451)', () => {
  const EDITED = { ...PROPS, Value: base64Value('echo B\npw=') };

  it('stamps a record whose provider reported effectiveProperties, so the edit is not re-sent (Q7)', async () => {
    const h = harness();
    // A provider that reports what it sent: the resolved bag as written.
    h.provider.create.mockImplementation((_id: string, _type: string, props: object) =>
      Promise.resolve({ physicalId: 'p', effectiveProperties: { ...props } })
    );
    h.provider.update.mockImplementation(
      (_id: string, _pid: string, _type: string, props: object) =>
        Promise.resolve({ physicalId: 'p', wasReplaced: false, effectiveProperties: { ...props } })
    );
    const created = await h.deploy(PROPS);
    expect(created.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: await inputFp(PROPS.Value),
    });
    const edited = await h.deploy(EDITED);
    expect(h.provider.update).toHaveBeenCalledTimes(1);
    expect(edited.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: await inputFp(EDITED.Value),
    });
    await h.deploy(EDITED);
    expect(h.provider.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a hash to a masked property whose template holds the secret it resolves as a literal (R1)', async () => {
    // The script literally spells the plaintext the reference resolves to.
    const literal = { ...PROPS, Value: base64Value('pw-secret-value;') };
    const h = harness();
    const created = await h.deploy(literal);
    expect(created.resources['R']!.properties['Value']).toBe('***');
    expect(created.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: REFUSED_FINGERPRINT,
    });
    // ...and an edit to it is compared as before #4451 (not sent).
    await h.deploy({ ...PROPS, Value: base64Value('echo B;pw-secret-value;') });
    expect(h.provider.update).not.toHaveBeenCalled();
  });

  it('refuses a hash to a masked property whose template spells a NoEcho parameter value, at create and at the backfill (R4)', async () => {
    const NOECHO = 'noecho-param-value-42';
    const template = (value: unknown): CloudFormationTemplate => ({
      Parameters: { P: { Type: 'String', NoEcho: true, Default: NOECHO } },
      Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { ...PROPS, Value: value } } },
    });
    const spelled = base64Value(`p=${NOECHO};pw=`);
    const h = harness();
    const created = await h.deployTemplate(template(spelled));
    expect(created.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: REFUSED_FINGERPRINT,
    });
    // The backfill of a field-less record refuses it as well.
    const { maskedPropertyFingerprints: _dropped, ...legacy } = created.resources['R']!;
    h.setState({ ...created, resources: { R: legacy } });
    const backfilled = await h.deployTemplate(template(spelled));
    expect(backfilled.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: REFUSED_FINGERPRINT,
    });
    // Control: a template not spelling it is hashed.
    const plain = await harness().deployTemplate(template(PROPS.Value));
    expect(plain.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: await inputFp(PROPS.Value),
    });
  });

  it('the AWS-confirmed NoEcho skip does not fire when a masked expression moved (R2)', async () => {
    const FRESH = 'fresh-noecho-token-0001';
    const props = (value: unknown) => ({ ...PROPS, Value: value, Description: FRESH });
    const h = harness();
    // Every provisioning resolution supplies `Description` as a fresh NoEcho
    // value (a handler's `Data`), so the record holds `***` there.
    h.onResolve((resolved, secrets) => {
      if (secrets !== undefined && resolved !== null && typeof resolved === 'object') {
        if ((resolved as Record<string, unknown>)['Description'] === FRESH) {
          recordFreshNoEchoValuesIn(FRESH, secrets);
        }
      }
    });
    await h.deploy(props(PROPS.Value));
    // The fresh value sits on a create-only-shaped path AWS confirms holding,
    // which fills the confirmed-NoEcho skip's path set.
    h.onDiff((changes) => {
      const row = changes.get('R')?.propertyChanges?.find((pc) => pc.path === 'Description');
      if (row) row.requiresReplacement = true;
    });
    h.provider.readCurrentState.mockResolvedValue({ Description: FRESH });
    await h.deploy(props(base64Value('echo B\npw=')));
    expect(h.provider.create).toHaveBeenCalledTimes(1);
    expect(h.provider.update).toHaveBeenCalledTimes(1);
  });

  it('reports one row for an embedded leaf both comparisons see (Q8)', async () => {
    const h = harness();
    await h.deploy(EMBEDDED_PROPS);
    await h.deploy(embedded(base64Value('echo B\npw=')));
    const rows = h.lastChange()?.propertyChanges ?? [];
    expect(rows.filter((pc) => pc.path === 'Value')).toHaveLength(1);
  });

  it('keeps a propagated replacement ceiling on a masked property whose expression moved (Q8)', async () => {
    const h = harness();
    await h.deploy(PROPS);
    // The masked row as a CEILING (an attribute it reads may move): only the
    // fingerprint says the value moved, so the ceiling must stand.
    h.onDiff((changes) => {
      const row = changes.get('R')?.propertyChanges?.find((pc) => pc.path === 'Value');
      if (row) Object.assign(row, { requiresReplacement: true, inPlacePropagated: true });
    });
    // The replacement stands, so the engine's stateful guard refuses it; the
    // lowered in-place update it would otherwise send never happens.
    await expect(h.deploy(EDITED)).rejects.toMatchObject({
      cause: { code: 'STATEFUL_REPLACE_BLOCKED' },
    });
    expect(h.provider.update).not.toHaveBeenCalled();
  });

  it('backfills a field-less record a rollback left as an orphan once it is adopted (Q8)', async () => {
    // No explicit Name: adoption takes only a resource cdkd names itself.
    const unnamed = { Type: 'String', Value: PROPS.Value };
    const h = harness();
    const created = await h.deploy(unnamed);
    const { maskedPropertyFingerprints: _dropped, ...legacy } = created.resources['R']!;
    h.setState({
      ...created,
      resources: {},
      orphans: [{ logicalId: 'R', orphanedAt: 0, state: legacy }],
    });
    const adopted = await h.deploy(unnamed);
    expect(h.provider.import).toHaveBeenCalled();
    expect(adopted.orphans ?? []).toHaveLength(0);
    expect(adopted.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: await inputFp(PROPS.Value),
    });
  });
});

describe('DeployEngine - a resolved input behind unchanged template text is sent (go-to-k/cdkd#4543)', () => {
  const SECRET = '{{resolve:ssm-secure:/app/pw}}';
  /** `Fn::Base64` over a script reading `input`, then the secret reference. */
  const script = (input: unknown): unknown => ({
    'Fn::Base64': { 'Fn::Join': ['', ['b=', input, ';pw=', SECRET]] },
  });
  const withParameter = (
    value: string,
    extra: Record<string, unknown> = {}
  ): CloudFormationTemplate => ({
    Parameters: { P: { Type: 'String', Default: value, ...extra } },
    Resources: {
      R: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/app/ud', Type: 'String', Value: script({ Ref: 'P' }) },
      },
    },
  });
  const sentValue = (h: Harness, call: number): unknown =>
    (h.provider.update.mock.calls[call]![3] as Record<string, unknown>)['Value'];

  it('a parameter value change is sent, and the redeploy after it is a no-op', async () => {
    const h = harness();
    await h.deployTemplate(withParameter('one'));
    const after = await h.deployTemplate(withParameter('two'));
    expect(h.lastChange()?.changeType).toBe('UPDATE');
    expect(h.provider.update).toHaveBeenCalledTimes(1);
    expect(sentValue(h, 0)).toBe(Buffer.from('b=two;pw=pw-secret-value').toString('base64'));
    expect(after.resources['R']!.properties['Value']).toBe('***');
    // The hash holds the parameter's value, never the secret's.
    expect(JSON.stringify(after)).not.toContain('pw-secret-value');
    await h.deployTemplate(withParameter('two'));
    expect(h.provider.update).toHaveBeenCalledTimes(1);
  });

  it('a condition flip is sent, the property text reading only the condition', async () => {
    const template = (env: string): CloudFormationTemplate => ({
      Parameters: { Env: { Type: 'String', Default: env } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
      Resources: {
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/ud',
            Type: 'String',
            Value: script({ 'Fn::If': ['IsProd', 'big', 'small'] }),
          },
        },
      },
    });
    const h = harness();
    await h.deployTemplate(template('dev'));
    await h.deployTemplate(template('prod'));
    expect(h.provider.update).toHaveBeenCalledTimes(1);
    expect(sentValue(h, 0)).toBe(Buffer.from('b=big;pw=pw-secret-value').toString('base64'));
    // An input that moves nothing the property reads is no change.
    await h.deployTemplate(template('prod'));
    expect(h.provider.update).toHaveBeenCalledTimes(1);
  });

  it('a Ref to a resource this deploy replaces is sent, though the diff saw the old id', async () => {
    const template = (name: string): CloudFormationTemplate => ({
      Resources: {
        A: { Type: 'AWS::SNS::Topic', Properties: { TopicName: name } },
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/ud', Type: 'String', Value: script({ Ref: 'A' }) },
        },
      },
    });
    const h = harness({ levels: [['A'], ['R']], deps: { R: ['A'] }, physicalIdFromName: true });
    // No other resource holds the topic names this test creates.
    h.provider.import.mockResolvedValue(null);
    await h.deployTemplate(template('a-one'));
    // `TopicName` is create-only: A is replaced under a new physical id.
    const after = await h.deployTemplate(template('a-two'));
    const sentToR = h.provider.update.mock.calls.filter((c) => c[0] === 'R');
    const createdA = h.provider.create.mock.calls.filter((c) => c[0] === 'A');
    expect(createdA).toHaveLength(2);
    expect(sentToR).toHaveLength(1);
    expect((sentToR[0]![3] as Record<string, unknown>)['Value']).toBe(
      Buffer.from('b=a-two;pw=pw-secret-value').toString('base64')
    );
    expect(after.resources['A']!.physicalId).toBe('a-two');
    await h.deployTemplate(template('a-two'));
    expect(h.provider.update.mock.calls.filter((c) => c[0] === 'R')).toHaveLength(1);
  });

  it('a NoEcho parameter stays out of the hash: its change is not sent (documented)', async () => {
    const h = harness();
    const first = await h.deployTemplate(withParameter('noecho-one-value', { NoEcho: true }));
    const second = await h.deployTemplate(withParameter('noecho-two-value', { NoEcho: true }));
    expect(h.provider.update).not.toHaveBeenCalled();
    // The same entry for both values: `{Ref: P}` is hashed, never the value.
    expect(second.resources['R']!.maskedPropertyFingerprints).toEqual(
      first.resources['R']!.maskedPropertyFingerprints
    );
    expect(first.resources['R']!.maskedPropertyFingerprints!['Value']).toMatch(
      /^inputs-sha256:/
    );
  });

  it('a rotated secret behind unchanged inputs sends nothing', async () => {
    const h = harness();
    await h.deployTemplate(withParameter('one'));
    secretValues.set('/app/pw', 'rotated-secret-value');
    await h.deployTemplate(withParameter('one'));
    expect(h.provider.update).not.toHaveBeenCalled();
  });

  it('a layout-1 (#4451) fingerprint re-baselines without sending, then moves with the next input', async () => {
    const h = harness();
    const created = await h.deployTemplate(withParameter('one'));
    const value = (withParameter('one').Resources['R']!.Properties as Record<string, unknown>)[
      'Value'
    ];
    // What #4451 wrote: the text hash, with a baseline so no observed refresh saves.
    h.setState({
      ...created,
      resources: {
        R: {
          ...created.resources['R']!,
          observedProperties: { Name: '/app/ud', Type: 'String' },
          maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(value) },
        },
      },
    });
    const saves = h.saveCount();
    const upgraded = await h.deployTemplate(withParameter('one'));
    expect(h.provider.update).not.toHaveBeenCalled();
    expect(h.saveCount()).toBeGreaterThan(saves);
    expect(upgraded.resources['R']!.maskedPropertyFingerprints).toEqual(
      created.resources['R']!.maskedPropertyFingerprints
    );
    await h.deployTemplate(withParameter('two'));
    expect(h.provider.update).toHaveBeenCalledTimes(1);
  });

  it('in a nested child, a value the parent supplied stays out of the hash (the deploy wires it)', async () => {
    const child = (supplied: string) =>
      harness({
        engineOptions: {
          parameters: { P: supplied },
          parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
        },
      });
    // Two engines, one state: the second deploy is the parent passing a new value.
    const h1 = child('one');
    const first = await h1.deployTemplate(withParameter('d'));
    const h2 = child('two');
    h2.setState(first);
    const second = await h2.deployTemplate(withParameter('d'));
    expect(h2.provider.update).not.toHaveBeenCalled();
    expect(second.resources['R']!.maskedPropertyFingerprints).toEqual(
      first.resources['R']!.maskedPropertyFingerprints
    );
    // Control: the same supplied values on a top-level stack are inputs.
    const top1 = harness({ engineOptions: { parameters: { P: 'one' } } });
    const topFirst = await top1.deployTemplate(withParameter('d'));
    const top2 = harness({ engineOptions: { parameters: { P: 'two' } } });
    top2.setState(topFirst);
    await top2.deployTemplate(withParameter('d'));
    expect(top2.provider.update).toHaveBeenCalledTimes(1);
  });

  it('cdkd diff recomputes exactly what the deploy stamped (Number parameter, Ref to a clean resource)', async () => {
    const template: CloudFormationTemplate = {
      Parameters: { Port: { Type: 'Number', Default: '8080' } },
      Resources: {
        A: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'a-topic' } },
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/ud',
            Type: 'String',
            Value: script({ 'Fn::Join': [':', [{ Ref: 'Port' }, { Ref: 'A' }]] }),
          },
        },
      },
    };
    const h = harness({ levels: [['A'], ['R']], deps: { R: ['A'] }, physicalIdFromName: true });
    h.provider.import.mockResolvedValue(null);
    const deployed = await h.deployTemplate(template);
    expect(deployed.resources['R']!.maskedPropertyFingerprints!['Value']).toMatch(/^inputs-sha256:/);
    const { computeStackDiff } = await import('../../../src/cli/commands/diff-recursive.js');
    const backend = { getState: async () => null } as never;
    const diffOf = async (t: CloudFormationTemplate) =>
      (
        await computeStackDiff(deployed, t, 'us-east-1', 's', backend, new DiffCalculator(), {
          previewMaskedInputs: true,
        })
      ).changes.get('R')!.changeType;
    expect(await diffOf(template)).toBe('NO_CHANGE');
    // Control: the same comparison sees a new Default.
    expect(
      await diffOf({ ...template, Parameters: { Port: { Type: 'Number', Default: '9090' } } })
    ).toBe('UPDATE');
  });

  it('a layout-1 fingerprint whose TEXT moved is still sent, as #4451 sent it', async () => {
    const h = harness();
    const created = await h.deployTemplate(withParameter('one'));
    const value = (withParameter('one').Resources['R']!.Properties as Record<string, unknown>)[
      'Value'
    ];
    h.setState({
      ...created,
      resources: {
        R: {
          ...created.resources['R']!,
          maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(value) },
        },
      },
    });
    const edited = withParameter('one');
    (edited.Resources['R']!.Properties as Record<string, unknown>)['Value'] = script({
      'Fn::Join': ['-', [{ Ref: 'P' }, 'x']],
    });
    const after = await h.deployTemplate(edited);
    expect(h.provider.update).toHaveBeenCalledTimes(1);
    // ...and the write stamps the input form.
    expect(after.resources['R']!.maskedPropertyFingerprints!['Value']).toMatch(/^inputs-sha256:/);
  });
});

interface Harness {
  deploy(props: Record<string, unknown>, options?: { noRollback?: boolean }): Promise<StackState>;
  saved(): StackState;
  saveCount(): number;
  deployTemplate(template: CloudFormationTemplate): Promise<StackState>;
  /** Runs on every REAL diff result before the engine reads it. */
  onDiff(hook: (changes: Map<string, ResourceChange>) => void): void;
  /** Runs on every PROVISIONING resolution, with the pass's secrets bag. */
  onResolve(hook: (resolved: unknown, secrets: Map<string, string> | undefined) => void): void;
  setState(state: StackState): void;
  lastChange(): ResourceChange | undefined;
  provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    import: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
}

/**
 * The real resolver and diff, with the state backend, lock and provider
 * doubled. Each `deploy` reads the state the previous one saved.
 */
function harness(
  options: {
    levels?: string[][];
    deps?: Record<string, string[]>;
    physicalIdFromName?: boolean;
    engineOptions?: Record<string, unknown>;
  } = {}
): Harness {
  const provider = {
    create: options.physicalIdFromName
      ? vi.fn((_id: string, _type: string, props: Record<string, unknown>) =>
          Promise.resolve({ physicalId: String(props['Name'] ?? props['TopicName'] ?? 'p') })
        )
      : vi.fn().mockResolvedValue({ physicalId: 'p' }),
    update: vi.fn().mockResolvedValue({ physicalId: 'p', wasReplaced: false }),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
    import: vi.fn().mockResolvedValue({ physicalId: 'p', attributes: {} }),
  };
  let state: StackState | null = null;
  const saveState = vi.fn((_stack: string, _region: string, saved: StackState) => {
    state = saved;
    return Promise.resolve('etag');
  });
  const getState = vi.fn(() =>
    Promise.resolve({ state, etag: state === null ? undefined : 'e' })
  );
  const real = new DiffCalculator();
  let last: Map<string, ResourceChange> | undefined;
  let onDiff: ((changes: Map<string, ResourceChange>) => void) | undefined;
  let onResolve:
    | ((resolved: unknown, secrets: Map<string, string> | undefined) => void)
    | undefined;
  const diff = {
    calculateDiff: vi.fn(async (...args: unknown[]) => {
      last = await (
        real.calculateDiff as (...x: unknown[]) => Promise<Map<string, ResourceChange>>
      ).apply(real, args);
      onDiff?.(last);
      return last;
    }),
    hasChanges: vi.fn((c: unknown) => real.hasChanges(c as never)),
    filterByType: vi
      .fn()
      .mockImplementation((c: Map<string, ResourceChange>, t: string) =>
        [...c.values()].filter((x) => x.changeType === t)
      ),
  };
  const makeEngine = (noRollback: boolean): DeployEngine => {
    const engine = buildEngine(noRollback);
    // The PROVISIONING resolutions only: the diff pass binds
    // `skipDynamicReferences`.
    const resolver = (engine as unknown as { resolver: { resolve: Function } }).resolver;
    const resolve = resolver.resolve.bind(resolver) as (v: unknown, c: unknown) => Promise<unknown>;
    resolver.resolve = async (value: unknown, context: Record<string, unknown>) => {
      const resolved = await resolve(value, context);
      if (context['skipDynamicReferences'] !== true) {
        onResolve?.(resolved, context['recordedSecretValues'] as Map<string, string> | undefined);
      }
      return resolved;
    };
    return engine;
  };
  const buildEngine = (noRollback: boolean): DeployEngine =>
    new DeployEngine(
      {
        getState,
        saveState,
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        appendRollbackJournalSegment: vi.fn(),
        popRollbackJournalSegment: vi.fn(),
        deleteRollbackJournal: vi.fn(),
      } as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue(options.levels ?? [['R']]),
        getDirectDependencies: vi.fn((_dag: unknown, id: string) => options.deps?.[id] ?? []),
      } as never,
      diff as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false, noRollback, ...options.engineOptions },
      'us-east-1'
    );
  return {
    async deploy(props, options) {
      const template: CloudFormationTemplate = {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
      };
      await makeEngine(options?.noRollback ?? false).deploy('s', template);
      return state!;
    },
    async deployTemplate(template) {
      await makeEngine(false).deploy('s', template);
      return state!;
    },
    onDiff(hook) {
      onDiff = hook;
    },
    onResolve(hook) {
      onResolve = hook;
    },
    saved: () => state!,
    saveCount: () => saveState.mock.calls.length,
    setState(next) {
      state = next;
    },
    lastChange: () => last?.get('R'),
    provider,
  };
}

async function createThenRedeploy(
  props: Record<string, unknown>,
  redeployChange: 'NO_CHANGE' | 'UPDATE'
): Promise<{ created: StackState; provider: Harness['provider'] }> {
  const h = harness();
  const created = await h.deploy(props);
  expect(created.resources['R']!.properties['Value']).toBe('***');

  // The redeploy runs the REAL diff over the record the create wrote.
  await h.deploy(props);

  // Which gate kept the provider from being called: the diff itself
  // (NO_CHANGE), or the engine's no-change skip over an UPDATE.
  expect(h.lastChange()?.changeType).toBe(redeployChange);
  expect(h.provider.update).not.toHaveBeenCalled();
  return { created, provider: h.provider };
}
