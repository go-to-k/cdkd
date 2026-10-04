import { describe, it, expect, vi } from 'vite-plus/test';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  classifyPassedParameters,
  REFUSED_FINGERPRINT,
  inputFingerprinter,
  maskedInputFingerprint,
  maskedPropertyFingerprint,
  maskedPropertyFingerprintsFor,
  maskedPropertyFingerprintsOf,
  maskedPropertyInputFingerprintsOf,
  markWrittenFromDeployedTemplate,
  movedMaskedProperties,
  parameterInputsFor,
  possiblyMaskedKeys,
  withMaskedPropertyFingerprints,
  withRebaselinedFingerprints,
  type MaskedInputSources,
} from '../../../src/deployment/masked-property-fingerprints.js';
import { recordAssumedConditions } from '../../../src/deployment/assumed-conditions.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * The INPUT fingerprint of a masked property (go-to-k/cdkd#4543): the
 * template value with each non-secret input resolved, a `NoEcho` parameter, a
 * `{{resolve:...}}` reference and anything derived from one left as written.
 */
const SECRET = '{{resolve:ssm-secure:/app/pw}}';
const script = (input: unknown): unknown => ({
  'Fn::Base64': { 'Fn::Join': ['', ['b=', input, ';pw=', SECRET]] },
});

interface Fixture {
  template?: CloudFormationTemplate;
  values?: Record<string, unknown>;
  conditions?: Record<string, boolean>;
  resolved?: Record<string, unknown>;
  /** Secrets a node's resolution records into its own bag, by node JSON. */
  recorded?: Record<string, string>;
}

const BASE: CloudFormationTemplate = {
  Parameters: {
    P: { Type: 'String' },
    Hidden: { Type: 'String', NoEcho: true },
    Env: { Type: 'String' },
  },
  Conditions: {
    IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] },
    HiddenSet: { 'Fn::Equals': [{ Ref: 'Hidden' }, 'x'] },
  },
  Resources: {
    Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b' } },
    Named: { Type: 'AWS::S3::Bucket', Properties: { BucketName: '{{resolve:ssm-secure:/n}}' } },
    ByHidden: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { Ref: 'Hidden' } } },
    Chained: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Named' } } },
  },
};

function sources(f: Fixture = {}): MaskedInputSources & { resolve: ReturnType<typeof vi.fn> } {
  const template = f.template ?? BASE;
  const { parameterInput } = parameterInputsFor({
    template,
    values: f.values ?? { P: 'one', Hidden: 'hidden-value-1', Env: 'dev' },
  });
  return {
    template,
    parameterInput,
    conditions: f.conditions ?? { IsProd: false, HiddenSet: false },
    resolve: vi.fn((node: unknown) => {
      const key = JSON.stringify(node);
      const resolved = f.resolved ?? {};
      if (!Object.hasOwn(resolved, key)) return Promise.reject(new Error(`unresolvable ${key}`));
      const secrets = new Map<string, string>();
      const recorded = f.recorded?.[key];
      if (recorded !== undefined) secrets.set(recorded, SECRET);
      return Promise.resolve({ value: resolved[key], secrets });
    }),
  };
}

const ref = (name: string): string => JSON.stringify({ Ref: name });

describe('parameterInputsFor', () => {
  const template: CloudFormationTemplate = {
    Parameters: {
      Plain: { Type: 'String', Default: 'd' },
      Hidden: { Type: 'String', NoEcho: true },
      HiddenString: { Type: 'String', NoEcho: 'true' as unknown as boolean },
      Token: { Type: 'String' },
      Masked: { Type: 'String' },
      Starry: { Type: 'String' },
      Unbound: { Type: 'String' },
    },
    Resources: {},
  };
  const values = {
    Plain: 'd',
    Hidden: 'h',
    HiddenString: 'h2',
    Token: 'x-{{resolve:secretsmanager:s}}',
    Masked: '***',
    Starry: '0 * * * ***',
  };

  it('classifies NoEcho, a reference, the mask and an unbound parameter', () => {
    const { parameterInput, bound } = parameterInputsFor({ template, values });
    expect(parameterInput('Plain')).toEqual({ kind: 'value', value: 'd' });
    expect(parameterInput('Hidden')).toEqual({ kind: 'secret' });
    expect(parameterInput('HiddenString')).toEqual({ kind: 'secret' });
    expect(parameterInput('Token')).toEqual({ kind: 'secret' });
    expect(parameterInput('Masked')).toEqual({ kind: 'secret' });
    // Only a WHOLE leaf is the mask: a cron or glob holding `***` is a value.
    expect(parameterInput('Starry')).toEqual({ kind: 'value', value: '0 * * * ***' });
    expect(parameterInput('Unbound')).toEqual({ kind: 'unknown' });
    expect(parameterInput('Undeclared')).toEqual({ kind: 'unknown' });
    // Only the non-secret values are bound for the resolver.
    expect(bound).toEqual({ Plain: 'd', Starry: '0 * * * ***' });
    expect(
      parameterInputsFor({ template, values, unbound: new Set(['Plain']) }).parameterInput('Plain')
    ).toEqual({ kind: 'unknown' });
  });

  it('in a nested child with no parent class: every supplied value is kept as written, a Default-equal one included', () => {
    const child: CloudFormationTemplate = {
      Parameters: {
        Embeds: { Type: 'String' },
        Supplied: { Type: 'String', Default: 'default' },
        AtDefault: { Type: 'String', Default: 'default' },
        Own: { Type: 'String', Default: 'own' },
      },
      Resources: {},
    };
    const { parameterInput } = parameterInputsFor({
      template: child,
      values: { Embeds: 'xaby', Supplied: 'other', AtDefault: 'default', Own: 'own' },
      nestedChild: true,
      supplied: { Embeds: 'xaby', Supplied: 'other', AtDefault: 'default' },
    });
    // Supplied but never classified (a rollback replay): kept as written,
    // whatever the value.
    expect(parameterInput('Embeds')).toEqual({ kind: 'secret' });
    expect(parameterInput('Supplied')).toEqual({ kind: 'secret' });
    // Equal to the Default, but PASSED: comparing it with the Default would
    // let the hash confirm "the passed value equals the Default".
    expect(parameterInput('AtDefault')).toEqual({ kind: 'secret' });
    // Not supplied at all: the child's Default, template text, is a value.
    expect(parameterInput('Own')).toEqual({ kind: 'value', value: 'own' });
    // A supplied value with no Default to equal is supplied too.
    expect(
      parameterInputsFor({
        template: { Parameters: { NoDefault: { Type: 'String' } }, Resources: {} },
        values: { NoDefault: 'plain' },
        nestedChild: true,
        supplied: { NoDefault: 'plain' },
      }).parameterInput('NoDefault')
    ).toEqual({ kind: 'secret' });
    // A class map that lacks the name is no class either.
    expect(
      parameterInputsFor({
        template: child,
        values: { Supplied: 'other', Own: 'own' },
        nestedChild: true,
        supplied: { Supplied: 'other' },
        passedClasses: new Map([['Other', 'clean']]),
      }).parameterInput('Supplied')
    ).toEqual({ kind: 'secret' });
    // Outside a nested child (`cdkd deploy`'s own parameters) it is an input.
    expect(
      parameterInputsFor({
        template: child,
        values: { Supplied: 'other' },
        supplied: { Supplied: 'other' },
      }).parameterInput('Supplied')
    ).toEqual({ kind: 'value', value: 'other' });
  });
});

describe('maskedInputFingerprint', () => {
  it('moves with a parameter value, and is no layout-1 entry', async () => {
    const one = await maskedInputFingerprint(script({ Ref: 'P' }), sources());
    const two = await maskedInputFingerprint(
      script({ Ref: 'P' }),
      sources({ values: { P: 'two', Hidden: 'hidden-value-1', Env: 'dev' } })
    );
    // The input half, then the layout-1 text half of the same value.
    expect(one).toBe(
      `${one!.slice(0, 'inputs-sha256:'.length + 64)}+${maskedPropertyFingerprint(script({ Ref: 'P' }))}`
    );
    expect(one).toMatch(/^inputs-sha256:[0-9a-f]{64}\+sha256:[0-9a-f]{64}$/);
    expect(two).not.toBe(one);
    // An older cdkd reads `sha256:` entries only, so it ignores this one.
    expect(one!.startsWith('sha256:')).toBe(false);
    expect(one).not.toBe(maskedPropertyFingerprint(script({ Ref: 'P' })));
  });

  it('keeps a NoEcho parameter as written: its value never moves the hash', async () => {
    const a = await maskedInputFingerprint(script({ Ref: 'Hidden' }), sources());
    const b = await maskedInputFingerprint(
      script({ Ref: 'Hidden' }),
      sources({ values: { P: 'one', Hidden: 'hidden-value-2', Env: 'dev' } })
    );
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });

  it('moves with a text edit and with a retargeted reference, as layout 1 did', async () => {
    const base = await maskedInputFingerprint(script({ Ref: 'P' }), sources());
    const edited = await maskedInputFingerprint(
      { 'Fn::Base64': { 'Fn::Join': ['', ['c=', { Ref: 'P' }, ';pw=', SECRET]] } },
      sources()
    );
    const retargeted = await maskedInputFingerprint(
      { 'Fn::Base64': { 'Fn::Join': ['', ['b=', { Ref: 'P' }, ';pw=', '{{resolve:ssm-secure:/x}}']] } },
      sources()
    );
    expect(new Set([base, edited, retargeted]).size).toBe(3);
  });

  it('resolves a Ref / Fn::GetAtt to a clean resource, and moves when it does', async () => {
    const value = script({ 'Fn::Join': [',', [{ Ref: 'Bucket' }, { 'Fn::GetAtt': ['Bucket', 'Arn'] }]] });
    const at = (id: string) =>
      maskedInputFingerprint(
        value,
        sources({
          resolved: {
            [ref('Bucket')]: id,
            [JSON.stringify({ 'Fn::GetAtt': ['Bucket', 'Arn'] })]: `arn:aws:s3:::${id}`,
          },
        })
      );
    const old = await at('bucket-1');
    expect(old).toBeDefined();
    expect(await at('bucket-1')).toBe(old);
    expect(await at('bucket-2')).not.toBe(old);
  });

  it('keeps a Ref to a resource whose definition reads a secret as written, transitively, without resolving it', async () => {
    for (const target of ['Named', 'ByHidden', 'Chained']) {
      const s = sources();
      const fingerprint = await maskedInputFingerprint(script({ Ref: target }), s);
      expect(fingerprint).toBeDefined();
      expect(s.resolve).not.toHaveBeenCalled();
    }
  });

  it('keeps a resolved value carrying a secret as written: the bag the node itself recorded into (any length), the mask, a reference', async () => {
    const node = ref('Bucket');
    const cases: Fixture[] = [
      { resolved: { [node]: 'bucket-2' }, recorded: { [node]: 'cket-2' } },
      { resolved: { [node]: 'bucket-3' }, recorded: { [node]: 't' } },
      { resolved: { [node]: '***' } },
      { resolved: { [node]: 'a{{resolve:secretsmanager:s}}' } },
    ];
    const asWritten = await maskedInputFingerprint(
      script({ Ref: 'Bucket' }),
      sources({ template: { ...BASE, Resources: { ...BASE.Resources, Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: SECRET } } } } })
    );
    for (const c of cases) {
      expect(await maskedInputFingerprint(script({ Ref: 'Bucket' }), sources(c))).toBe(asWritten);
    }
    // Control: a clean value is hashed resolved.
    expect(
      await maskedInputFingerprint(script({ Ref: 'Bucket' }), sources({ resolved: { [node]: 'bucket-2' } }))
    ).not.toBe(asWritten);
  });

  it('never depends on a NoEcho value the property does not read, even one an input happens to contain', async () => {
    // A stack-wide screen would keep `Bucket` as written for one value and
    // resolve it for the other: the hash would answer "does a secret occur in
    // this physical id?" and move when the secret does.
    const at = (hidden: string) =>
      maskedInputFingerprint(
        script({ Ref: 'Bucket' }),
        sources({
          resolved: { [ref('Bucket')]: 'vpc-0abc1234' },
          values: { P: 'one', Hidden: hidden, Env: 'dev' },
        })
      );
    expect(await at('abc1')).toBe(await at('wxyz'));
  });

  it('keeps a Ref to a resource reading a secret through GetAtt, a cross-stack read, a Sub placeholder or an undeclared name as written', async () => {
    const template: CloudFormationTemplate = {
      ...BASE,
      Resources: {
        ...BASE.Resources,
        ByGetAtt: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { 'Fn::GetAtt': ['Named', 'Arn'] } } },
        ByImport: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { 'Fn::ImportValue': 'x' } } },
        ByOutput: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { 'Fn::GetStackOutput': { StackName: 's', OutputName: 'o' } } },
        },
        BySub: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { 'Fn::Sub': 'n-${Hidden}' } } },
        BySubAttr: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { 'Fn::Sub': 'n-${Named.Arn}' } } },
        ByShellVar: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { 'Fn::Sub': 'n-${HOME}' } } },
      },
    };
    for (const target of ['ByGetAtt', 'ByImport', 'ByOutput', 'BySub', 'BySubAttr', 'ByShellVar']) {
      const s = sources({ template, resolved: { [ref(target)]: 'a' } });
      const a = await maskedInputFingerprint(script({ Ref: target }), s);
      const b = await maskedInputFingerprint(
        script({ Ref: target }),
        sources({ template, resolved: { [ref(target)]: 'b' } })
      );
      expect(a, target).toBeDefined();
      expect(b, target).toBe(a);
      expect(s.resolve, target).not.toHaveBeenCalled();
    }
  });

  it('keeps AWS::NoValue as written and resolves a pseudo parameter', async () => {
    const value = script({ 'Fn::Join': ['-', [{ Ref: 'AWS::Region' }, { Ref: 'AWS::NoValue' }]] });
    const east = await maskedInputFingerprint(
      value,
      sources({ resolved: { [ref('AWS::Region')]: 'us-east-1' } })
    );
    const west = await maskedInputFingerprint(
      value,
      sources({ resolved: { [ref('AWS::Region')]: 'us-west-2' } })
    );
    expect(east).toBeDefined();
    expect(west).not.toBe(east);
  });

  it('takes the branch an evaluated condition selects, and moves when it flips', async () => {
    const value = script({ 'Fn::If': ['IsProd', 'big', 'small'] });
    const dev = await maskedInputFingerprint(value, sources({ conditions: { IsProd: false } }));
    const prod = await maskedInputFingerprint(value, sources({ conditions: { IsProd: true } }));
    // The INPUT half equals the chosen branch's (the text half is the text).
    const inputHalf = (fp: string | undefined) => fp?.split('+')[0];
    expect(inputHalf(dev)).toBe(inputHalf(await maskedInputFingerprint(script('small'), sources())));
    expect(inputHalf(prod)).toBe(inputHalf(await maskedInputFingerprint(script('big'), sources())));
    expect(dev).not.toBe(prod);
  });

  it('keeps an Fn::If on a condition over a secret whole, whichever way the condition reads it: a flip of it is one bit of the secret', async () => {
    const template: CloudFormationTemplate = {
      ...BASE,
      Conditions: {
        ...BASE.Conditions,
        ViaRef: { 'Fn::Equals': [{ Ref: 'Hidden' }, 'x'] },
        ViaChain: { 'Fn::Not': [{ Condition: 'ViaRef' }] },
        ViaReference: { 'Fn::Equals': ['{{resolve:secretsmanager:s}}', 'x'] },
        ViaSub: { 'Fn::Equals': [{ 'Fn::Sub': '${Hidden}' }, 'x'] },
        ViaSubAttr: { 'Fn::Equals': [{ 'Fn::Sub': '${Named.Arn}' }, 'x'] },
        ViaImport: { 'Fn::Equals': [{ 'Fn::ImportValue': 'shared' }, 'x'] },
        ViaOutput: {
          'Fn::Equals': [{ 'Fn::GetStackOutput': { StackName: 's', OutputName: 'o' } }, 'x'],
        },
        ViaGetAtt: { 'Fn::Equals': [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }, 'x'] },
      },
    };
    for (const name of [
      'ViaRef',
      'ViaChain',
      'ViaReference',
      'ViaSub',
      'ViaSubAttr',
      'ViaImport',
      'ViaOutput',
      'ViaGetAtt',
    ]) {
      const value = script({ 'Fn::If': [name, 'big', 'small'] });
      const t = await maskedInputFingerprint(value, sources({ template, conditions: { [name]: true } }));
      const f = await maskedInputFingerprint(value, sources({ template, conditions: { [name]: false } }));
      expect(t, name).toBeDefined();
      expect(f, name).toBe(t);
    }
    // Control: a condition over a plain parameter through Fn::Sub moves.
    const plain: CloudFormationTemplate = {
      ...BASE,
      Conditions: { ViaPlainSub: { 'Fn::Equals': [{ 'Fn::Sub': '${P}' }, 'x'] } },
    };
    const value = script({ 'Fn::If': ['ViaPlainSub', 'big', 'small'] });
    expect(
      await maskedInputFingerprint(value, sources({ template: plain, conditions: { ViaPlainSub: true } }))
    ).not.toBe(
      await maskedInputFingerprint(value, sources({ template: plain, conditions: { ViaPlainSub: false } }))
    );
  });

  it('is undefined for an unknown input: an unbound parameter, a missing or assumed verdict, a failed resolution', async () => {
    const unbound = sources({ values: { Hidden: 'h', Env: 'dev' } });
    expect(await maskedInputFingerprint(script({ Ref: 'P' }), unbound)).toBeUndefined();
    expect(
      await maskedInputFingerprint(script({ 'Fn::If': ['IsProd', 'a', 'b'] }), sources({ conditions: {} }))
    ).toBeUndefined();
    const assumed = { IsProd: false };
    recordAssumedConditions(assumed, new Set(['IsProd']));
    expect(
      await maskedInputFingerprint(script({ 'Fn::If': ['IsProd', 'a', 'b'] }), sources({ conditions: assumed }))
    ).toBeUndefined();
    expect(await maskedInputFingerprint(script({ Ref: 'Bucket' }), sources())).toBeUndefined();
  });

  it('reads an Fn::Sub placeholder as the input it names', async () => {
    const sub = (text: string) => ({ 'Fn::Base64': { 'Fn::Sub': `${text};pw=${SECRET}` } });
    const resolved = { [JSON.stringify({ 'Fn::GetAtt': ['Bucket', 'Arn'] })]: 'arn:1' };
    const one = await maskedInputFingerprint(sub('b=${P} a=${Bucket.Arn} ${!Literal}'), sources({ resolved }));
    const two = await maskedInputFingerprint(
      sub('b=${P} a=${Bucket.Arn} ${!Literal}'),
      sources({ resolved, values: { P: 'two', Hidden: 'h', Env: 'dev' } })
    );
    const moved = await maskedInputFingerprint(
      sub('b=${P} a=${Bucket.Arn} ${!Literal}'),
      sources({ resolved: { [JSON.stringify({ 'Fn::GetAtt': ['Bucket', 'Arn'] })]: 'arn:2' } })
    );
    expect(new Set([one, two, moved]).size).toBe(3);
    const hidden = (v: string) =>
      maskedInputFingerprint(sub('h=${Hidden}'), sources({ values: { P: 'one', Hidden: v, Env: 'dev' } }));
    expect(await hidden('one-value')).toBe(await hidden('two-value'));
  });

  it('resolves a cross-stack read only over known non-secret operands, and keeps a secret result as written', async () => {
    const node = { 'Fn::ImportValue': 'shared-name' };
    const clean = await maskedInputFingerprint(
      script(node),
      sources({ resolved: { [JSON.stringify(node)]: 'v1' } })
    );
    const moved = await maskedInputFingerprint(
      script(node),
      sources({ resolved: { [JSON.stringify(node)]: 'v2' } })
    );
    // A result the node's own resolution recorded as a secret is kept as
    // written: two such results hash alike.
    const secretResult = (value: string) =>
      maskedInputFingerprint(
        script(node),
        sources({ resolved: { [JSON.stringify(node)]: value }, recorded: { [JSON.stringify(node)]: value } })
      );
    expect(clean).not.toBe(moved);
    expect(await secretResult('plain-1')).toBe(await secretResult('plain-2'));
    // An operand reading a NoEcho parameter is never resolved.
    const s = sources();
    await maskedInputFingerprint(script({ 'Fn::ImportValue': { Ref: 'Hidden' } }), s);
    expect(s.resolve).not.toHaveBeenCalled();
  });
});

describe('movedMaskedProperties - the two fields', () => {
  const props = { Value: script({ Ref: 'P' }) };
  const TEXT = maskedPropertyFingerprint(props.Value);
  const record = (input?: string, text: string = TEXT) => ({
    properties: { Value: '***' },
    maskedPropertyFingerprints: { Value: text },
    ...(input !== undefined && { maskedPropertyInputFingerprints: { Value: input } }),
  });

  it("compares a bound input fingerprint against today's inputs", async () => {
    const stamped = (await maskedInputFingerprint(props.Value, sources()))!;
    const same = inputFingerprinter(props, sources());
    expect(await movedMaskedProperties(record(stamped), props, same)).toEqual([]);
    const changed = inputFingerprinter(
      props,
      sources({ values: { P: 'two', Hidden: 'h', Env: 'dev' } })
    );
    expect(await movedMaskedProperties(record(stamped), props, changed)).toEqual(['Value']);
    // No sources, or an unknown input: unmoved.
    expect(await movedMaskedProperties(record(stamped), props)).toEqual([]);
    const unknown = inputFingerprinter(props, sources({ values: {} }));
    expect(await movedMaskedProperties(record(stamped), props, unknown)).toEqual([]);
    // ...but the text field still sees a template edit there.
    const edited = { Value: script({ 'Fn::Join': ['-', [{ Ref: 'P' }]] }) };
    expect(await movedMaskedProperties(record(stamped), edited)).toEqual(['Value']);
  });

  it('compares a record with no input field as text, and re-baselines an unchanged one', async () => {
    const legacy = record();
    const rebaselined: Array<[string, string]> = [];
    const moved = await movedMaskedProperties(
      legacy,
      props,
      inputFingerprinter(props, sources()),
      (k, f) => rebaselined.push([k, f])
    );
    expect(moved).toEqual([]);
    expect(rebaselined).toEqual([['Value', await maskedInputFingerprint(props.Value, sources())]]);
    // A moved text is moved, and is not re-baselined.
    rebaselined.length = 0;
    const edited = { Value: script({ 'Fn::Join': ['-', [{ Ref: 'P' }]] }) };
    expect(
      await movedMaskedProperties(legacy, edited, inputFingerprinter(edited, sources()), (k, f) =>
        rebaselined.push([k, f])
      )
    ).toEqual(['Value']);
    expect(rebaselined).toEqual([]);
  });

  it('treats an input fingerprint bound to another text as absent (an older cdkd rewrote the text)', async () => {
    const stale = (await maskedInputFingerprint(props.Value, sources()))!;
    // The text field an older binary rewrote for an edited template; the input
    // field it carried untouched still names the previous text.
    const edited = { Value: script({ 'Fn::Join': ['-', [{ Ref: 'P' }]] }) };
    const rewritten = record(stale, maskedPropertyFingerprint(edited.Value));
    expect([...maskedPropertyInputFingerprintsOf(rewritten).keys()]).toEqual([]);
    const rebaselined: Array<[string, string]> = [];
    // Inputs changed since, but nothing compares the stale entry: re-baselined.
    const moved = await movedMaskedProperties(
      rewritten,
      edited,
      inputFingerprinter(edited, sources({ values: { P: 'two', Hidden: 'h', Env: 'dev' } })),
      (k, f) => rebaselined.push([k, f])
    );
    expect(moved).toEqual([]);
    expect(rebaselined.map(([k]) => k)).toEqual(['Value']);
  });

  it('reads only sha256: in the text field, and only bound inputs-sha256: in the input field', () => {
    const rec = {
      maskedPropertyFingerprints: {
        A: 'sha256:aa',
        B: 'inputs-sha256:bb',
        C: REFUSED_FINGERPRINT,
        D: 'md5:dd',
      },
      maskedPropertyInputFingerprints: {
        A: 'inputs-sha256:x+sha256:aa',
        C: 'inputs-sha256:y+refused:secret-in-template',
        E: 'inputs-sha256:z+sha256:ee',
      },
    };
    expect([...maskedPropertyFingerprintsOf(rec).keys()]).toEqual(['A']);
    expect([...maskedPropertyInputFingerprintsOf(rec).entries()]).toEqual([
      ['A', 'inputs-sha256:x+sha256:aa'],
    ]);
  });

  it('re-baselines into the input field, only an entry bound to the text the record holds', () => {
    const rec = { maskedPropertyFingerprints: { A: 'sha256:aa', C: REFUSED_FINGERPRINT } };
    const next = withRebaselinedFingerprints(rec, {
      A: 'inputs-sha256:new+sha256:aa',
      C: 'inputs-sha256:y+sha256:cc',
    }) as typeof rec & { maskedPropertyInputFingerprints?: Record<string, string> };
    expect(next.maskedPropertyFingerprints).toEqual(rec.maskedPropertyFingerprints);
    expect(next.maskedPropertyInputFingerprints).toEqual({ A: 'inputs-sha256:new+sha256:aa' });
  });

  it('an older cdkd reading a new record still compares the text exactly as #4451 did', async () => {
    const stamped = withMaskedPropertyFingerprints(
      { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: { Value: '***' } },
      markWrittenFromDeployedTemplate({ Value: '***' }),
      props,
      undefined,
      undefined,
      { Value: (await maskedInputFingerprint(props.Value, sources()))! }
    );
    // #4451's reader: `sha256:` entries of `maskedPropertyFingerprints`,
    // compared with the template text's hash. It still finds exactly that.
    expect(stamped.maskedPropertyFingerprints).toEqual({ Value: TEXT });
    expect(stamped.maskedPropertyInputFingerprints!['Value']).toMatch(
      /^inputs-sha256:[0-9a-f]{64}\+sha256:/
    );
  });
});

describe('the save-time stamp', () => {
  it('stamps the text fingerprint always, and an input fingerprint only bound to it', () => {
    const template = { Value: script({ Ref: 'P' }), Other: script('x'), Stale: script('y') };
    const stamped = withMaskedPropertyFingerprints(
      {
        physicalId: 'p',
        resourceType: 'T',
        properties: { Value: '***', Other: '***', Stale: '***' },
      },
      markWrittenFromDeployedTemplate({}),
      template,
      undefined,
      undefined,
      {
        Value: `inputs-sha256:v+${maskedPropertyFingerprint(template.Value)}`,
        Stale: 'inputs-sha256:s+sha256:not-this-text',
      }
    );
    expect(stamped.maskedPropertyFingerprints).toEqual({
      Value: maskedPropertyFingerprint(template.Value),
      Other: maskedPropertyFingerprint(template.Other),
      Stale: maskedPropertyFingerprint(template.Stale),
    });
    expect(stamped.maskedPropertyInputFingerprints).toEqual({
      Value: `inputs-sha256:v+${maskedPropertyFingerprint(template.Value)}`,
    });
    expect(maskedPropertyFingerprintsFor({ Value: '***' }, template)).toEqual({
      Value: maskedPropertyFingerprint(template.Value),
    });
  });

  it('names as possibly masked each key holding the mask, a long needle, or a short one as a WHOLE leaf', () => {
    const bag = new Map([
      ['pw', SECRET],
      ['long-secret-value', SECRET],
    ]);
    expect(
      possiblyMaskedKeys(
        {
          A: 'x-pw',
          B: '***',
          C: 'clean',
          D: ['a', 'pw'],
          E: 'pre-long-secret-value-post',
          F: { n: 'pw' },
        },
        [bag, undefined]
      )
    ).toEqual(['B', 'D', 'E', 'F']);
  });
});

describe('DiffCalculator - a masked property whose resolved input moved (go-to-k/cdkd#4543)', () => {
  const template: CloudFormationTemplate = {
    Parameters: { P: { Type: 'String' } },
    Resources: {
      R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Value: script({ Ref: 'P' }) } },
    },
  };
  const diffWith = async (
    input: string | undefined,
    maskedInputs?: Parameters<DiffCalculator['calculateDiff']>[8]
  ) => {
    const state = {
      version: 10 as const,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        R: {
          physicalId: 'p',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: 'n', Value: '***' },
          maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(script({ Ref: 'P' })) },
          ...(input !== undefined && { maskedPropertyInputFingerprints: { Value: input } }),
        },
      },
      outputs: {},
      lastModified: 0,
    };
    // The diff resolver answers a Base64 over a secret as the mask (#2909).
    const resolveFn = (value: unknown): Promise<unknown> =>
      Promise.resolve(
        value !== null && typeof value === 'object' && 'Fn::Base64' in value ? '***' : value
      );
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      resolveFn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maskedInputs
    );
    return changes.get('R')!;
  };
  const at = (p: string) =>
    sources({ template, values: { P: p }, conditions: {} });

  it('reports UPDATE when a parameter moved, NO_CHANGE when it did not, and nothing without sources', async () => {
    const stamped = (await maskedInputFingerprint(script({ Ref: 'P' }), at('one')))!;
    expect((await diffWith(stamped, { sources: at('one') })).changeType).toBe('NO_CHANGE');
    const moved = await diffWith(stamped, { sources: at('two') });
    expect(moved.changeType).toBe('UPDATE');
    expect(moved.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', maskedExpressionChanged: true }),
    ]);
    expect((await diffWith(stamped)).changeType).toBe('NO_CHANGE');
  });

  it('re-baselines an unchanged layout-1 entry into the caller\'s map', async () => {
    const rebaselined = new Map<string, Record<string, string>>();
    const change = await diffWith(undefined, {
      sources: at('one'),
      rebaselined,
    });
    expect(change.changeType).toBe('NO_CHANGE');
    expect(rebaselined).toEqual(
      new Map([['R', { Value: await maskedInputFingerprint(script({ Ref: 'P' }), at('one')) }]])
    );
  });
});

describe('review-round pins (go-to-k/cdkd#4543)', () => {
  it('a reference cycle fails closed: the input stays as written', async () => {
    const template: CloudFormationTemplate = {
      ...BASE,
      Resources: {
        // A reads a secret; B reads only A. Walking A meets B, which meets A
        // in progress: B must not be settled as clean on that partial answer.
        A: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { 'Fn::Join': ['', [{ Ref: 'B' }, { Ref: 'Hidden' }]] } },
        },
        B: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'A' } } },
      },
    };
    const s = sources({ template, resolved: { [ref('A')]: 'a', [ref('B')]: 'b' } });
    expect(
      await maskedInputFingerprint(script({ 'Fn::Join': ['', [{ Ref: 'A' }, { Ref: 'B' }]] }), s)
    ).toBeDefined();
    expect(s.resolve).not.toHaveBeenCalled();
  });

  it('an Fn::Sub explicit variable shadows the placeholder of the same name', async () => {
    // `${P}` names the explicit variable, a literal: the template parameter P
    // is not read, so its value must not move the hash.
    const sub = { 'Fn::Base64': { 'Fn::Sub': [`p=\${P};pw=${SECRET}`, { P: 'literal' }] } };
    const a = await maskedInputFingerprint(sub, sources());
    const b = await maskedInputFingerprint(
      sub,
      sources({ values: { P: 'two', Hidden: 'h', Env: 'dev' } })
    );
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });

  it('a parent-supplied "null" for a parameter with no Default is supplied too', () => {
    expect(
      parameterInputsFor({
        template: { Parameters: { NoDefault: { Type: 'String' } }, Resources: {} },
        values: { NoDefault: 'null' },
        nestedChild: true,
        supplied: { NoDefault: 'null' },
      }).parameterInput('NoDefault')
    ).toEqual({ kind: 'secret' });
  });
});

describe('classifyPassedParameters (go-to-k/cdkd#4543)', () => {
  it('classifies each passed expression by the parent-side rules', async () => {
    const node = ref('Bucket');
    const classes = await classifyPassedParameters(
      {
        Clean: { Ref: 'Bucket' },
        Literal: 'v',
        Plain: { Ref: 'P' },
        Joined: { 'Fn::Join': ['-', [{ Ref: 'P' }, { Ref: 'AWS::Region' }]] },
        NoEcho: { Ref: 'Hidden' },
        Reference: '{{resolve:secretsmanager:s}}',
        Tainted: { Ref: 'Named' },
        Imported: { 'Fn::ImportValue': { Ref: 'Hidden' } },
        Unknown: { Ref: 'Unresolvable' },
        UnboundParam: { 'Fn::Join': ['', [{ Ref: 'Missing' }]] },
        Opaque: { 'Fn::GetAtt': ['Cr', 'Out'] },
      },
      sources({
        template: {
          ...BASE,
          Resources: {
            ...BASE.Resources,
            Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn' } },
            Unresolvable: { Type: 'AWS::SNS::Topic', Properties: {} },
          },
          Parameters: { ...BASE.Parameters, Missing: { Type: 'String' } },
        },
        resolved: { [node]: 'bucket-1', [ref('AWS::Region')]: 'us-east-1' },
      })
    );
    expect(Object.fromEntries(classes)).toEqual({
      Clean: 'clean',
      Literal: 'clean',
      Plain: 'clean',
      Joined: 'clean',
      NoEcho: 'secret',
      Reference: 'secret',
      Tainted: 'secret',
      Imported: 'secret',
      // Could not be read this time: neither vouched for nor withheld.
      Unknown: 'unknown',
      UnboundParam: 'unknown',
      Opaque: 'secret',
    });
    expect(Object.fromEntries(await classifyPassedParameters(undefined, sources()))).toEqual({});
  });

  it('a child honours the parent class for a supplied value, a Default-equal one included', () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        A: { Type: 'String' },
        B: { Type: 'String' },
        C: { Type: 'String' },
        Pw: { Type: 'String', Default: 'changeme' },
        AtDefault: { Type: 'String', Default: 'd' },
        Unread: { Type: 'String' },
        Own: { Type: 'String', Default: 'own' },
      },
      Resources: {},
    };
    const supplied = { A: 'a', B: 'b', C: 'c', Pw: 'changeme', AtDefault: 'd', Unread: 'u' };
    const { parameterInput } = parameterInputsFor({
      template,
      values: { ...supplied, Own: 'own' },
      nestedChild: true,
      supplied,
      passedClasses: new Map([
        ['A', 'clean'],
        ['B', 'secret'],
        // The parent passed a secret that happens to equal the Default: still
        // secret, or the hash would confirm the equality.
        ['Pw', 'secret'],
        ['Unread', 'unknown'],
      ]),
    });
    expect(parameterInput('A')).toEqual({ kind: 'value', value: 'a' });
    expect(parameterInput('B')).toEqual({ kind: 'secret' });
    // Passed but missing from the parent's classes: kept as written.
    expect(parameterInput('C')).toEqual({ kind: 'secret' });
    expect(parameterInput('Pw')).toEqual({ kind: 'secret' });
    // Passed equal to the Default but not classified: kept as written as well.
    expect(parameterInput('AtDefault')).toEqual({ kind: 'secret' });
    // Classified unknown: not compared.
    expect(parameterInput('Unread')).toEqual({ kind: 'unknown' });
    // Not passed: the Default, template text, is a value.
    expect(parameterInput('Own')).toEqual({ kind: 'value', value: 'own' });
  });
});

describe('pins on the concrete check (go-to-k/cdkd#4543 review)', () => {
  it('never resolves a cross-stack read whose operand text holds a reference, in either spelling', async () => {
    for (const operand of [
      'shared-{{resolve:secretsmanager:s}}',
      { 'Fn::Sub': 'shared-{{resolve:secretsmanager:s}}' },
    ]) {
      const s = sources({ resolved: {} });
      const fingerprint = await maskedInputFingerprint(script({ 'Fn::ImportValue': operand }), s);
      expect(fingerprint).toBeDefined();
      expect(s.resolve).not.toHaveBeenCalled();
    }
  });

  it('a resource whose GetAtt operand is malformed counts as reading a secret', async () => {
    const template: CloudFormationTemplate = {
      ...BASE,
      Resources: {
        ...BASE.Resources,
        Odd: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { 'Fn::GetAtt': 5 } } },
      },
    };
    const s = sources({ template, resolved: { [ref('Odd')]: 'odd' } });
    expect(await maskedInputFingerprint(script({ Ref: 'Odd' }), s)).toBeDefined();
    expect(s.resolve).not.toHaveBeenCalled();
  });

  it('an attribute name built from an intrinsic is an input: resolved only when known non-secret', async () => {
    const node = (attr: unknown) => ({ 'Fn::GetAtt': ['Bucket', attr] });
    // A NoEcho parameter as the attribute name: kept as written, never resolved.
    const s = sources({ resolved: {} });
    expect(await maskedInputFingerprint(script(node({ Ref: 'Hidden' })), s)).toBeDefined();
    expect(s.resolve).not.toHaveBeenCalled();
    // A plain one: resolved.
    const plain = sources({ resolved: { [JSON.stringify(node({ Ref: 'P' }))]: 'arn:x' } });
    expect(await maskedInputFingerprint(script(node({ Ref: 'P' })), plain)).toBeDefined();
    expect(plain.resolve).toHaveBeenCalledTimes(1);
  });

  it('an attribute of a custom resource or a nested stack is kept as written (it may be NoEcho)', async () => {
    const template: CloudFormationTemplate = {
      ...BASE,
      Resources: {
        ...BASE.Resources,
        Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn' } },
        Cr2: { Type: 'AWS::CloudFormation::CustomResource', Properties: { ServiceToken: 'arn' } },
        Nested: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } },
        ReadsCr: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { 'Fn::GetAtt': ['Cr', 'Out'] } },
        },
        ReadsCrSub: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { 'Fn::Sub': 'n-${Cr.Out}' } },
        },
      },
    };
    for (const value of [
      { 'Fn::GetAtt': ['Cr', 'Out'] },
      { 'Fn::GetAtt': ['Cr2', 'Out'] },
      { 'Fn::GetAtt': ['Nested', 'Outputs.X'] },
      { 'Fn::Sub': '${Cr.Out}' },
      { Ref: 'ReadsCr' },
      { Ref: 'ReadsCrSub' },
    ]) {
      const s = sources({ template, resolved: {} });
      expect(await maskedInputFingerprint(script(value), s), JSON.stringify(value)).toBeDefined();
      expect(s.resolve, JSON.stringify(value)).not.toHaveBeenCalled();
    }
    // Its physical id is no attribute: resolved.
    const s = sources({ template, resolved: { [ref('Cr')]: 'cr-id' } });
    await maskedInputFingerprint(script({ Ref: 'Cr' }), s);
    expect(s.resolve).toHaveBeenCalledTimes(1);
  });
});


describe('a nested child with no parent class (go-to-k/cdkd#4543 review n1/N4)', () => {
  // The child declares `Passed` (the parent supplies it) and `Own` (it does
  // not, so the child binds its Default). `Reader` is a resource whose own
  // definition reads `Passed`.
  const child: CloudFormationTemplate = {
    Parameters: {
      Passed: { Type: 'String', Default: 'same-as-default' },
      Own: { Type: 'String', Default: 'own-default' },
    },
    Resources: {
      Reader: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Passed' } } },
    },
  };
  const childSources = (
    passed: string,
    passedClasses: ReadonlyMap<string, 'clean' | 'secret' | 'unknown'> | undefined
  ): MaskedInputSources & { resolve: ReturnType<typeof vi.fn> } => {
    const { parameterInput } = parameterInputsFor({
      template: child,
      values: { Passed: passed, Own: 'own-default' },
      nestedChild: true,
      supplied: { Passed: passed },
      passedClasses,
    });
    return {
      template: child,
      parameterInput,
      conditions: {},
      resolve: vi.fn((node: unknown) =>
        JSON.stringify(node) === ref('Reader')
          ? Promise.resolve({ value: 'topic-arn', secrets: new Map<string, string>() })
          : Promise.reject(new Error('unresolvable'))
      ),
    };
  };

  it('a passed value it cannot vouch for is hashed only as written, a Default-equal one included', async () => {
    for (const node of [{ Ref: 'Passed' }, { Ref: 'Reader' }]) {
      const forms = new Set<string | undefined>();
      for (const passed of ['other-value', 'same-as-default']) {
        for (const classes of [undefined, new Map([['Passed', 'secret' as const]])]) {
          const s = childSources(passed, classes);
          forms.add(await maskedInputFingerprint(script(node), s));
          // Nothing derived from the value was resolved.
          expect(s.resolve).not.toHaveBeenCalled();
        }
      }
      // One template-form hash whatever the value or the class: no oracle for
      // "the passed value equals the Default".
      expect(forms.size).toBe(1);
      expect([...forms][0]).toMatch(/^inputs-sha256:/);
    }
  });

  it('a parameter the parent did not pass binds the Default and is hashed', async () => {
    const own = await maskedInputFingerprint(script({ Ref: 'Own' }), childSources('x', undefined));
    expect(own).toMatch(/^inputs-sha256:[0-9a-f]{64}\+sha256:/);
    // And it is the Default's hash: the same as a clean `{ Ref }` in a
    // stack that binds the same value from its own parameters.
    const { parameterInput } = parameterInputsFor({
      template: child,
      values: { Passed: 'x', Own: 'own-default' },
    });
    expect(own).toBe(
      await maskedInputFingerprint(script({ Ref: 'Own' }), {
        template: child,
        parameterInput,
        conditions: {},
        resolve: vi.fn(() => Promise.reject(new Error('unused'))),
      })
    );
  });

  it('classified, then a no-class rollback replay, then classified: the replay and the next classified deploy each move once, then it settles', async () => {
    const value = script({ Ref: 'Passed' });
    const text = maskedPropertyFingerprint(value);
    const fingerprintWith = (passed: string, classes: ReadonlyMap<string, 'clean'> | undefined) =>
      inputFingerprinter({ Value: value }, childSources(passed, classes));
    const CLEAN = new Map([['Passed', 'clean' as const]]);
    const record = (input: string) => ({
      properties: { Value: '***' },
      maskedPropertyFingerprints: { Value: text },
      maskedPropertyInputFingerprints: { Value: input },
    });
    // Deploy N: classified clean at v1, stamped.
    const stampedN = (await fingerprintWith('v1', CLEAN)('Value'))!;
    // The replay (no class, rolling back to v0): the template form differs
    // from the stamped value, so the replay sends what it rolls back to.
    const replayForm = (await fingerprintWith('v0', undefined)('Value'))!;
    expect(replayForm).not.toBe(stampedN);
    expect(await movedMaskedProperties(record(stampedN), { Value: value }, fingerprintWith('v0', undefined))).toEqual(['Value']);
    // The next classified deploy (v1 again): moved once, so AWS gets v1 back.
    expect(await movedMaskedProperties(record(replayForm), { Value: value }, fingerprintWith('v1', CLEAN))).toEqual(['Value']);
    // Stamped v1 again: no further send.
    expect(await movedMaskedProperties(record(stampedN), { Value: value }, fingerprintWith('v1', CLEAN))).toEqual([]);
    // A second no-class replay over a no-class stamp does not loop either.
    expect(await movedMaskedProperties(record(replayForm), { Value: value }, fingerprintWith('v9', undefined))).toEqual([]);
  });
});
