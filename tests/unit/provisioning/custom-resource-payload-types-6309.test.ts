/**
 * go-to-k/cdkd#6309: the JSON types of a custom resource's `ResourceProperties`.
 *
 * Every expectation below is what CloudFormation delivered to a Python handler
 * that logged `json.dumps(event["ResourceProperties"])` (us-east-1, measured
 * for this issue; the same on `Create`, `Update` (both sides) and `Delete`).
 * `template` is the bag the template spelled, `resolved` what cdkd's resolver
 * makes of it, `delivered` CloudFormation's payload.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  recordedTypedPayloadLeavesOf,
  serializeResourceProperties,
  typedPayloadLeavesOf,
} from '../../../src/provisioning/custom-resource-payload-types.js';

const TYPES: Record<string, string> = {
  Pol: 'AWS::IAM::ManagedPolicy',
  Stream: 'AWS::Kinesis::Stream',
  Src: 'Custom::Echo',
  Nested: 'AWS::CloudFormation::Stack',
  Cfn: 'AWS::CloudFormation::CustomResource',
  Vpc: 'AWS::EC2::VPC',
};
const sources = {
  conditions: { IsOn: true },
  resourceTypeOf: (id: string) => TYPES[id],
};
const WARM = { CurrentMiBps: 0, TargetMiBps: 0 };

/** The measured cases: [name, template, resolved, delivered]. */
const CASES: Array<[string, unknown, unknown, unknown]> = [
  // (a) literals
  ['literal number', 5, 5, '5'],
  ['literal float', 1.5, 1.5, '1.5'],
  ['literal boolean', true, true, 'true'],
  ['literal string', 'hello', 'hello', 'hello'],
  // (b) Fn::GetAtt
  ['GetAtt number', { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] }, 0, 0],
  ['GetAtt boolean', { 'Fn::GetAtt': ['Pol', 'IsAttachable'] }, true, true],
  ['GetAtt object', { 'Fn::GetAtt': ['Stream', 'WarmThroughputObject'] }, WARM, WARM],
  ['GetAtt dotted string form', { 'Fn::GetAtt': 'Pol.AttachmentCount' }, 0, 0],
  ['GetAtt custom-resource number', { 'Fn::GetAtt': ['Src', 'Num'] }, 5, '5'],
  ['GetAtt custom-resource boolean', { 'Fn::GetAtt': ['Src', 'Bool'] }, true, 'true'],
  ['GetAtt custom-resource object', { 'Fn::GetAtt': ['Src', 'Obj'] }, { n: 5 }, { n: 5 }],
  // (c) Ref
  ['Ref Number parameter', { Ref: 'NumParam' }, 7, '7'],
  ['Ref List<Number> parameter', { Ref: 'NumListParam' }, [1, 2], ['1', '2']],
  // (d) Fn::Select / Fn::If / Fn::FindInMap
  ['Select over literals', { 'Fn::Select': [0, [5, 6]] }, 5, '5'],
  ['If over literal numbers', { 'Fn::If': ['IsOn', 5, 6] }, 5, '5'],
  ['If over literal booleans', { 'Fn::If': ['IsOn', true, false] }, true, 'true'],
  ['FindInMap number', { 'Fn::FindInMap': ['M', 'K', 'N'] }, 9, '9'],
  ['FindInMap boolean', { 'Fn::FindInMap': ['M', 'K', 'B'] }, true, 'true'],
  ['Select over a GetAtt', { 'Fn::Select': [0, [{ 'Fn::GetAtt': ['Pol', 'AttachmentCount'] }]] }, 0, 0],
  ['If picking a GetAtt', { 'Fn::If': ['IsOn', { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] }, 6] }, 0, 0],
  ['Join of a number', { 'Fn::Join': ['', [5]] }, '5', '5'],
  // (e) literals nested in literal containers
  [
    'literal object',
    { n: 5, b: true, s: 'x', deep: { n: 6 } },
    { n: 5, b: true, s: 'x', deep: { n: 6 } },
    { n: '5', b: 'true', s: 'x', deep: { n: '6' } },
  ],
  ['literal list', [5, true, 'x'], [5, true, 'x'], ['5', 'true', 'x']],
  ['literal list of objects', [{ n: 5, b: true }], [{ n: 5, b: true }], [{ n: '5', b: 'true' }]],
  // (f) Fn::GetAtt inside literal containers
  [
    'GetAtt in a literal list',
    [{ 'Fn::GetAtt': ['Pol', 'AttachmentCount'] }, { 'Fn::GetAtt': ['Pol', 'IsAttachable'] }, 5],
    [0, true, 5],
    [0, true, '5'],
  ],
  [
    'GetAtt in a literal object',
    {
      n: { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] },
      b: { 'Fn::GetAtt': ['Pol', 'IsAttachable'] },
      lit: 5,
    },
    { n: 0, b: true, lit: 5 },
    { n: 0, b: true, lit: '5' },
  ],
  [
    'GetAtt object in a literal list',
    [{ 'Fn::GetAtt': ['Stream', 'WarmThroughputObject'] }],
    [WARM],
    [WARM],
  ],
];

describe('custom resource payload types (#6309, measured against CloudFormation)', () => {
  it.each(CASES)('%s', (_name, template, resolved, delivered) => {
    const leaves = typedPayloadLeavesOf({ P: template }, { P: resolved }, sources);
    expect(serializeResourceProperties({ P: resolved }, leaves)).toStrictEqual({ P: delivered });
  });

  it('positions only what stringifying would change', () => {
    const template = {
      Arn: { 'Fn::GetAtt': ['Pol', 'PolicyArn'] },
      Count: { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] },
      Lit: 5,
    };
    const resolved = { Arn: 'arn:aws:iam::111122223333:policy/p', Count: 0, Lit: 5 };
    expect(typedPayloadLeavesOf(template, resolved, sources)).toStrictEqual([['Count']]);
    expect(typedPayloadLeavesOf({ Lit: 5 }, { Lit: 5 }, sources)).toStrictEqual([]);
  });

  it('an AWS::CloudFormation::CustomResource scalar attribute is a string, its object typed', () => {
    const num = { P: { 'Fn::GetAtt': ['Cfn', 'Num'] } };
    expect(serializeResourceProperties({ P: 5 }, typedPayloadLeavesOf(num, { P: 5 }, sources))).toStrictEqual({ P: '5' });
    const obj = { P: { 'Fn::GetAtt': ['Cfn', 'Obj'] } };
    expect(typedPayloadLeavesOf(obj, { P: { n: 5 } }, sources)).toStrictEqual([['P']]);
  });

  it('Fn::If with a FALSE verdict walks the else branch', () => {
    const getAtt = { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] };
    const off = { ...sources, conditions: { IsOn: false } };
    const typed = (template: unknown, resolved: unknown): unknown =>
      serializeResourceProperties({ P: resolved }, typedPayloadLeavesOf({ P: template }, { P: resolved }, off))['P'];
    expect(typed({ 'Fn::If': ['IsOn', 6, getAtt] }, 0)).toBe(0);
    expect(typed({ 'Fn::If': ['IsOn', getAtt, 6] }, 6)).toBe('6');
  });

  it('Fn::Select over a list attribute keeps the element type; a string index counts', () => {
    const list = { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlockCounts'] };
    for (const index of [0, '0']) {
      const template = { P: { 'Fn::Select': [index, list] } };
      expect(typedPayloadLeavesOf(template, { P: 3 }, sources)).toStrictEqual([['P']]);
    }
    const literal = { P: { 'Fn::Select': ['1', [5, { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] }]] } };
    expect(typedPayloadLeavesOf(literal, { P: 0 }, sources)).toStrictEqual([['P']]);
  });

  it("an element of a custom resource's list attribute follows its scalar rule", () => {
    const template = { P: { 'Fn::Select': [0, { 'Fn::GetAtt': ['Src', 'List'] }] } };
    expect(typedPayloadLeavesOf(template, { P: 5 }, sources)).toStrictEqual([]);
  });

  it('keys with dots, slashes and digits, and a GetAtt in a nested list, round-trip', () => {
    const getAtt = { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] };
    const template = { 'a.b': getAtt, 'x/y': { '0': getAtt, lit: 1 }, L: [[getAtt, 2]] };
    const resolved = { 'a.b': 0, 'x/y': { '0': 0, lit: 1 }, L: [[0, 2]] };
    const leaves = typedPayloadLeavesOf(template, resolved, sources);
    expect(leaves).toStrictEqual([['a.b'], ['x/y', '0'], ['L', 0, 0]]);
    expect(serializeResourceProperties(resolved, leaves)).toStrictEqual({
      'a.b': 0,
      'x/y': { '0': 0, lit: '1' },
      L: [[0, '2']],
    });
  });

  it('a literal __proto__ key is kept as a payload key, on both rules', () => {
    const bag = JSON.parse('{"__proto__": {"n": 1}, "k": 2}') as Record<string, unknown>;
    for (const leaves of [undefined, []]) {
      const out = serializeResourceProperties(bag, leaves);
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.hasOwn(out, '__proto__')).toBe(true);
      expect(JSON.parse(JSON.stringify(out))).toStrictEqual(
        JSON.parse('{"__proto__": {"n": "1"}, "k": "2"}')
      );
    }
  });

  it("a nested stack's scalar output is a string", () => {
    const template = { O: { 'Fn::GetAtt': ['Nested', 'Outputs.Count'] } };
    expect(typedPayloadLeavesOf(template, { O: 3 }, sources)).toStrictEqual([]);
  });

  it('an Fn::If of unknown verdict, or one picking a literal, stringifies', () => {
    const getAtt = { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] };
    expect(
      typedPayloadLeavesOf({ P: { 'Fn::If': ['Unknown', getAtt, 6] } }, { P: 0 }, sources)
    ).toStrictEqual([]);
    expect(
      typedPayloadLeavesOf(
        { P: { 'Fn::If': ['IsOn', 6, getAtt] } },
        { P: 6 },
        { ...sources, conditions: { IsOn: true } }
      )
    ).toStrictEqual([]);
  });

  it('a bare AWS::NoValue element still pairs the list', () => {
    const template = [{ Ref: 'AWS::NoValue' }, { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] }, 5];
    const leaves = typedPayloadLeavesOf({ L: template }, { L: [0, 5] }, sources);
    expect(serializeResourceProperties({ L: [0, 5] }, leaves)).toStrictEqual({ L: [0, '5'] });
  });

  it('a list whose length the resolution changed otherwise stringifies whole', () => {
    const template = [
      { 'Fn::If': ['IsOn', { Ref: 'AWS::NoValue' }, 1] },
      { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] },
    ];
    const leaves = typedPayloadLeavesOf({ L: template }, { L: [0] }, sources);
    expect(serializeResourceProperties({ L: [0] }, leaves)).toStrictEqual({ L: ['0'] });
  });

  it('a key the template does not name is stringified', () => {
    expect(serializeResourceProperties({ Extra: 1, Keep: 0 }, [['Keep']])).toStrictEqual({
      Extra: '1',
      Keep: 0,
    });
  });

  it('a numeric segment addresses a list index, never a key spelled the same', () => {
    expect(serializeResourceProperties({ O: { '0': 1 }, L: [1] }, [['O', 0], ['L', '0']])).toStrictEqual(
      { O: { '0': '1' }, L: ['1'] }
    );
  });

  describe('unknown positions keep the pre-#6309 rule exactly', () => {
    const bag = { N: 5, B: true, S: 'x', O: { n: 0, deep: { b: false } }, L: [5, true], Z: null };
    const legacy = {
      N: '5',
      B: 'true',
      S: 'x',
      O: { n: '0', deep: { b: 'false' } },
      L: [5, true],
      Z: null,
    };

    it('undefined leaves', () => {
      expect(serializeResourceProperties(bag, undefined)).toStrictEqual(legacy);
    });

    it('malformed leaves (hand-edited state) read as unknown', () => {
      for (const malformed of [{}, 'x', [['ok'], 'bad'], [[{ k: 1 }]]]) {
        expect(serializeResourceProperties(bag, malformed as never)).toStrictEqual(legacy);
      }
    });
  });

  it('the record reader reads a malformed field as absent', () => {
    expect(recordedTypedPayloadLeavesOf({})).toBeUndefined();
    expect(recordedTypedPayloadLeavesOf({ typedPayloadLeaves: 'x' })).toBeUndefined();
    expect(recordedTypedPayloadLeavesOf({ typedPayloadLeaves: [[true]] })).toBeUndefined();
    expect(recordedTypedPayloadLeavesOf({ typedPayloadLeaves: [] })).toStrictEqual([]);
    expect(recordedTypedPayloadLeavesOf({ typedPayloadLeaves: [['a', 0]] })).toStrictEqual([
      ['a', 0],
    ]);
  });
});
