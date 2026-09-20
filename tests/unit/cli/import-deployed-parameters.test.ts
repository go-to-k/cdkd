/**
 * ARM 4 of `cdkd import`'s observed-baseline refusal — UNVERIFIABLE INPUTS
 * (issue [#2854](https://github.com/go-to-k/cdkd/issues/2854)).
 *
 * Driven end to end through the REAL `resolveImportedProperties` (real
 * resolver) and the REAL `captureObservedForImportedResources`, because the
 * safety property is about what lands in the state record: a resource whose
 * raw bag depends on a parameter deployed with anything other than its bound
 * `Default` must end up with NO `observedProperties`, and no deployed value may
 * reach a log line or the record by any route.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record = (...args: unknown[]): void => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(record),
    info: vi.fn(record),
    warn: vi.fn(record),
    error: vi.fn(record),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// An attribute the import snapshot lacks falls back through the resolver's
// attribute construction, which may ask STS for the account id.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: async () => ({ Account: '123456789012' }) } }),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const { resolveImportedProperties, captureObservedForImportedResources } = await import(
  '../../../src/cli/commands/import.js'
);
const {
  DeployedParameters,
  readDeployedParameters,
  divergentParameterNames,
  collectParameterDependencies,
  reachableDivergentParameters,
  namesAnyDeclaredParameter,
  computeParameterTaint,
} = await import('../../../src/cli/commands/import-deployed-parameters.js');
const { getLogger } = await import('../../../src/utils/logger.js');

/** What AWS holds where the template says `CHANGEME` — must never be persisted. */
const LIVE_PLAINTEXT = 'live-decrypted-2854-value';
/** A deployed parameter VALUE — must never reach a log line or the record. */
const DEPLOYED_SENTINEL = 'deployed-sentinel-2854-{{resolve:secretsmanager:prod/db:SecretString:pw}}';

beforeEach(() => {
  logged.length = 0;
});

type Deployed = Parameters<typeof DeployedParameters.fromDescribeStacks>[0];

function templateWith(
  parameters: Record<string, unknown>,
  extra: Partial<CloudFormationTemplate> = {},
  resource: Record<string, unknown> = {}
): CloudFormationTemplate {
  return {
    Parameters: parameters,
    ...extra,
    Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {}, ...resource } },
  } as CloudFormationTemplate;
}

async function run(args: {
  template: CloudFormationTemplate;
  properties: Record<string, unknown>;
  deployed: Deployed | 'unavailable' | 'none';
  readback?: Record<string, unknown>;
}): Promise<{ refused: boolean; state: StackState }> {
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'arm4-stack',
    region: 'us-east-1',
    resources: {
      Res: {
        physicalId: 'res-phys',
        resourceType: 'AWS::SQS::Queue',
        properties: structuredClone(args.properties),
      },
    },
    outputs: {},
    lastModified: 0,
  };
  const deployed =
    args.deployed === 'none'
      ? undefined
      : args.deployed === 'unavailable'
        ? DeployedParameters.unavailable()
        : DeployedParameters.fromDescribeStacks(args.deployed);
  const refusedIds = await resolveImportedProperties(
    state,
    args.template,
    'us-east-1',
    undefined as never,
    getLogger(),
    deployed
  );
  const provider = {
    readCurrentState: async () => structuredClone(args.readback ?? { Detail: { pw: LIVE_PLAINTEXT } }),
  };
  const registry = {
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
  } as unknown as Parameters<typeof captureObservedForImportedResources>[1];
  await captureObservedForImportedResources(
    state,
    registry,
    getLogger(),
    refusedIds,
    new Set(['Res'])
  );
  return { refused: refusedIds.has('Res'), state };
}

const PW_PARAM = { DbPassword: { Type: 'String', Default: 'CHANGEME', NoEcho: true } };
const PW_PROPS = { Detail: { pw: { Ref: 'DbPassword' } } };

describe('ARM 4: a parameter whose deployed value is not provably the bound Default (issue #2854)', () => {
  it("the issue's shape: NoEcho placeholder Default, deployed value masked — REFUSED, plaintext not persisted, one warn", async () => {
    const { refused, state } = await run({
      template: templateWith(PW_PARAM),
      properties: PW_PROPS,
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect(refused).toBe(true);
    expect(state.resources['Res']!.properties).toEqual({ Detail: { pw: 'CHANGEME' } });
    expect(state.resources['Res']!.observedProperties).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(LIVE_PLAINTEXT);
    const warns = logged.filter((line) => line.includes('could not be proven'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('1 resource(s)');
    expect(warns[0]).toContain('(DbPassword)');
    // No unclassifiable share here, so the clause must be absent.
    expect(warns[0]).not.toContain('of them because');
  });

  it('WITHOUT the deployed parameters the same shape is captured — the pre-fix behaviour this arm exists for', async () => {
    const { refused, state } = await run({
      template: templateWith(PW_PARAM),
      properties: PW_PROPS,
      deployed: 'none',
    });
    expect(refused).toBe(false);
    expect(JSON.stringify(state.resources['Res']!.observedProperties)).toContain(LIVE_PLAINTEXT);
  });

  it('a literal-reference deployed value REFUSES, and the value reaches neither a log line nor the record', async () => {
    const { refused, state } = await run({
      template: templateWith({ DbPassword: { Type: 'String', Default: 'CHANGEME' } }),
      properties: PW_PROPS,
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: DEPLOYED_SENTINEL }],
    });
    expect(refused).toBe(true);
    expect(JSON.stringify(state)).not.toContain('deployed-sentinel-2854');
    expect(logged.join('\n')).not.toContain('deployed-sentinel-2854');
  });

  it('deployed value EQUAL to the Default keeps the baseline (ordinary placeholder import)', async () => {
    const { refused, state } = await run({
      template: templateWith({ Stage: { Type: 'String', Default: 'dev' } }),
      properties: { Detail: { name: { 'Fn::Sub': 'app-${Stage}' } } },
      deployed: [{ ParameterKey: 'Stage', ParameterValue: 'dev' }],
      readback: { Detail: { name: 'app-dev' } },
    });
    expect(refused).toBe(false);
    expect(state.resources['Res']!.observedProperties).toEqual({ Detail: { name: 'app-dev' } });
    expect(logged.filter((l) => l.includes('could not be proven'))).toHaveLength(0);
  });

  it('a resource that depends on NO divergent parameter keeps its baseline beside one that does', async () => {
    const { refused } = await run({
      template: templateWith({
        ...PW_PARAM,
        Stage: { Type: 'String', Default: 'dev' },
      }),
      properties: { Detail: { name: { Ref: 'Stage' } } },
      deployed: [
        { ParameterKey: 'DbPassword', ParameterValue: '****' },
        { ParameterKey: 'Stage', ParameterValue: 'dev' },
      ],
      readback: { Detail: { name: 'dev' } },
    });
    expect(refused).toBe(false);
  });

  it.each<[string, Deployed | 'unavailable']>([
    ['a plain deployed value that differs', [{ ParameterKey: 'DbPassword', ParameterValue: 'other' }]],
    ['the parameter ABSENT from the response', []],
    ['an entry with no ParameterValue', [{ ParameterKey: 'DbPassword' }]],
    ['DescribeStacks unavailable', 'unavailable'],
  ])('%s REFUSES', async (_name, deployed) => {
    const { refused, state } = await run({
      template: templateWith(PW_PARAM),
      properties: PW_PROPS,
      deployed,
    });
    expect(refused).toBe(true);
    expect(JSON.stringify(state)).not.toContain(LIVE_PLAINTEXT);
  });

  describe('every route a raw bag can depend on the parameter', () => {
    const conditions = {
      Plain: { 'Fn::Equals': ['a', 'a'] },
      IsProd: { 'Fn::Equals': [{ Ref: 'DbPassword' }, 'x'] },
      Outer: { 'Fn::And': [{ Condition: 'Mid' }, { 'Fn::Equals': ['a', 'a'] }] },
      Mid: { 'Fn::Or': [{ 'Fn::Not': [{ Condition: 'IsProd' }] }, { 'Fn::Equals': ['a', 'b'] }] },
    };
    const mappings = { M: { k: { v: 'literal' } } };
    const cases: [string, Record<string, unknown>, Record<string, unknown>?][] = [
      ['Ref', { Detail: { pw: { Ref: 'DbPassword' } } }],
      ['Fn::Sub string', { Detail: { pw: { 'Fn::Sub': 'x-${DbPassword}' } } }],
      [
        'Fn::Sub variable-map value',
        { Detail: { pw: { 'Fn::Sub': ['x-${V}', { V: { 'Fn::Sub': '${DbPassword}' } }] } } },
      ],
      ['Fn::Join operand', { Detail: { pw: { 'Fn::Join': ['', ['a', { Ref: 'DbPassword' }]] } } }],
      [
        'Fn::Select over Fn::Split',
        { Detail: { pw: { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'DbPassword' }] }] } } },
      ],
      [
        'Fn::FindInMap key',
        { Detail: { pw: { 'Fn::FindInMap': ['M', { Ref: 'DbPassword' }, 'v', { DefaultValue: 'd' }] } } },
      ],
      ['Fn::If through transitive Conditions', { Detail: { pw: { 'Fn::If': ['Outer', 'a', 'b'] } } }],
      // The Fn::If arm `continue`s, so the generic recursion never sees the
      // branches: each needs its own walk, under a condition that reaches
      // NO parameter, or the condition would carry the refusal instead.
      // The Fn::GetAtt arm `continue`s too: an attribute NAMED by a Ref.
      ['Fn::GetAtt attribute name', { Detail: { pw: { 'Fn::GetAtt': ['Other', { Ref: 'DbPassword' }] } } }],
      ['Fn::If TRUE branch', { Detail: { pw: { 'Fn::If': ['Plain', { Ref: 'DbPassword' }, 'b'] } } }],
      ['Fn::If FALSE branch', { Detail: { pw: { 'Fn::If': ['Plain', 'a', { Ref: 'DbPassword' }] } } }],
      ['resource-level Condition', { Detail: { pw: 'literal' } }, { Condition: 'Outer' }],
    ];
    it.each(cases)('%s REFUSES', async (_name, properties, resource) => {
      const { refused } = await run({
        template: templateWith(PW_PARAM, { Conditions: conditions, Mappings: mappings }, resource),
        properties,
        deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
      });
      expect(refused).toBe(true);
    });

    it('the same Fn::If shape over a condition that reaches NO divergent parameter is kept', async () => {
      const { refused } = await run({
        template: templateWith(PW_PARAM, { Conditions: { Plain: { 'Fn::Equals': ['a', 'a'] } } }),
        properties: { Detail: { pw: { 'Fn::If': ['Plain', 'a', 'b'] } } },
        deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
        readback: { Detail: { pw: 'a' } },
      });
      expect(refused).toBe(false);
    });
  });

  it('a no-Default parameter the throw arm already refuses STAYS refused, with or without deployed values', async () => {
    const template = templateWith({ VpcId: { Type: 'String' } });
    const properties = { Detail: { name: { 'Fn::Sub': 'x-${VpcId}' } } };
    for (const deployed of ['none', [{ ParameterKey: 'VpcId', ParameterValue: 'vpc-1' }]] as const) {
      const { refused } = await run({ template, properties, deployed: deployed as never });
      expect(refused).toBe(true);
    }
  });
});

describe('divergentParameterNames: the comparison mirrors what the resolver BOUND', () => {
  const template = (parameters: Record<string, unknown>): CloudFormationTemplate =>
    ({ Parameters: parameters, Resources: {} }) as CloudFormationTemplate;
  const names = (
    parameters: Record<string, unknown>,
    bound: Record<string, unknown>,
    deployed: Deployed
  ): string[] => [
    ...divergentParameterNames(
      template(parameters),
      bound,
      DeployedParameters.fromDescribeStacks(deployed)
    ),
  ];

  it('Number compares numerically, and an unparseable pair never proves equality', () => {
    const p = { N: { Type: 'Number', Default: 5 } };
    expect(names(p, { N: 5 }, [{ ParameterKey: 'N', ParameterValue: '5' }])).toEqual([]);
    expect(names(p, { N: 5 }, [{ ParameterKey: 'N', ParameterValue: '6' }])).toEqual(['N']);
    expect(names(p, { N: NaN }, [{ ParameterKey: 'N', ParameterValue: '****' }])).toEqual(['N']);
  });

  it('CommaDelimitedList / List<> compare element-wise after the same trim the resolver applies', () => {
    const p = {
      L: { Type: 'CommaDelimitedList', Default: 'a,b' },
      S: { Type: 'List<AWS::EC2::Subnet::Id>', Default: 's-1,s-2' },
      LN: { Type: 'List<Number>', Default: '1,2' },
    };
    const bound = { L: ['a', 'b'], S: ['s-1', 's-2'], LN: [1, 2] };
    expect(
      names(p, bound, [
        { ParameterKey: 'L', ParameterValue: 'a, b' },
        { ParameterKey: 'S', ParameterValue: 's-1,s-2' },
        { ParameterKey: 'LN', ParameterValue: '1,2' },
      ])
    ).toEqual([]);
    expect(
      names(p, bound, [
        { ParameterKey: 'L', ParameterValue: 'a,b,c' },
        { ParameterKey: 'S', ParameterValue: 's-2,s-1' },
        { ParameterKey: 'LN', ParameterValue: '1,3' },
      ])
    ).toEqual(['L', 'S', 'LN']);
  });

  it('an SSM-typed parameter compares ResolvedValue — the resolver binds the VALUE, not the key', () => {
    const p = { P: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/path/key' } };
    expect(
      names(p, { P: 'v1' }, [{ ParameterKey: 'P', ParameterValue: '/path/key', ResolvedValue: 'v1' }])
    ).toEqual([]);
    // Same KEY, different resolved value (the SSM parameter moved since deploy).
    expect(
      names(p, { P: 'v2' }, [{ ParameterKey: 'P', ParameterValue: '/path/key', ResolvedValue: 'v1' }])
    ).toEqual(['P']);
    // The key must never stand in for the value.
    expect(names(p, { P: '/path/key' }, [{ ParameterKey: 'P', ParameterValue: '/path/key' }])).toEqual([
      'P',
    ]);
  });

  it('an SSM-typed LIST compares through the RESOLVED type, not the declared one', () => {
    const p = { L: { Type: 'AWS::SSM::Parameter::Value<List<String>>', Default: '/p' } };
    const deployed = [{ ParameterKey: 'L', ParameterValue: '/p', ResolvedValue: 'a,b' }];
    expect(names(p, { L: ['a', 'b'] }, deployed)).toEqual([]);
    expect(names(p, { L: ['a', 'c'] }, deployed)).toEqual(['L']);
  });

  it('a declared parameter the import could not BIND is divergent, and UsePreviousValue is irrelevant', () => {
    const p = { A: { Type: 'String', Default: 'a' }, B: { Type: 'String' } };
    expect(
      names(p, { A: 'a' }, [
        { ParameterKey: 'A', ParameterValue: 'a', UsePreviousValue: true } as never,
        { ParameterKey: 'B', ParameterValue: 'b' },
      ])
    ).toEqual(['B']);
  });

  it('a NoEcho parameter is NEVER provable, even when its Default is literally the mask', () => {
    for (const noEcho of [true, 'true', 'TRUE']) {
      const p = { Pw: { Type: 'String', Default: '****', NoEcho: noEcho } };
      expect(names(p, { Pw: '****' }, [{ ParameterKey: 'Pw', ParameterValue: '****' }])).toEqual(['Pw']);
    }
    const plain = { Pw: { Type: 'String', Default: '****', NoEcho: false } };
    expect(names(plain, { Pw: '****' }, [{ ParameterKey: 'Pw', ParameterValue: '****' }])).toEqual([]);
  });

  it('a non-string scalar Default on a String parameter compares by its string form', () => {
    const p = { N: { Type: 'String', Default: 42 }, B: { Type: 'String', Default: true } };
    const bound = { N: 42, B: true };
    expect(
      names(p, bound, [
        { ParameterKey: 'N', ParameterValue: '42' },
        { ParameterKey: 'B', ParameterValue: 'true' },
      ])
    ).toEqual([]);
    expect(
      names({ N: { Type: 'String', Default: NaN } }, { N: NaN }, [
        { ParameterKey: 'N', ParameterValue: 'NaN' },
      ])
    ).toEqual(['N']);
    expect(
      names(p, bound, [
        { ParameterKey: 'N', ParameterValue: '43' },
        { ParameterKey: 'B', ParameterValue: 'false' },
      ])
    ).toEqual(['N', 'B']);
  });

  // NOT a fence on import.ts's own `catch` around `divergentParameterNames`:
  // the resolver reads the same definition first and its failure refuses the
  // resource through ARM 1, so emptying that catch's fallback set stays green
  // (measured). A JSON-parsed template cannot throw on read at all; what this
  // pins is that an exotic one refuses and the import SURVIVES.
  it('a Parameters section that throws on read refuses, and the import does not abort', async () => {
    const parameters = new Proxy(
      { DbPassword: { Type: 'String', Default: 'CHANGEME' } },
      {
        ownKeys: () => ['DbPassword'],
        getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
        get: (target, key, receiver) => {
          const definition = Reflect.get(target, key, receiver) as object;
          return typeof key === 'string' && key === 'DbPassword'
            ? new Proxy(definition, {
                get: (d, k, r) => {
                  if (k === 'NoEcho') throw new Error('boom');
                  return Reflect.get(d, k, r) as unknown;
                },
              })
            : definition;
        },
      }
    );
    const { refused } = await run({
      template: templateWith(parameters),
      properties: PW_PROPS,
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: 'CHANGEME' }],
    });
    expect(refused).toBe(true);
  });

  it('a malformed definition (no string Type) is divergent', () => {
    expect(names({ X: null, Y: { Default: 'y' } }, { X: 'x', Y: 'y' }, [
      { ParameterKey: 'X', ParameterValue: 'x' },
      { ParameterKey: 'Y', ParameterValue: 'y' },
    ])).toEqual(['X', 'Y']);
  });
});

describe('collectParameterDependencies fails CLOSED on what it cannot classify', () => {
  const t = { Resources: {}, Conditions: { C: { 'Fn::Equals': ['a', 'a'] } } } as CloudFormationTemplate;
  it.each<[string, unknown, unknown]>([
    ['a non-string Ref', { a: { Ref: { x: 1 } } }, undefined],
    ['a malformed Fn::Sub', { a: { 'Fn::Sub': [{ Ref: 'P' }, {}] } }, undefined],
    ['a three-element Fn::Sub', { a: { 'Fn::Sub': ['${P}', {}, {}] } }, undefined],
    ['a malformed Fn::If', { a: { 'Fn::If': ['C', 'a'] } }, undefined],
    ['a non-string Fn::GetAtt target', { a: { 'Fn::GetAtt': [{ x: 1 }, 'a'] } }, undefined],
    ['an Fn::If naming an unknown condition', { a: { 'Fn::If': ['Nope', 'a', 'b'] } }, undefined],
    ['an unknown Fn:: intrinsic', { a: { 'Fn::Transform': { Name: 'M' } } }, undefined],
    ['a resource Condition naming an unknown condition', {}, 'Nope'],
    ['a non-string resource Condition', {}, { x: 1 }],
  ])('%s', (_name, properties, condition) => {
    expect(collectParameterDependencies(properties, condition, t).unclassifiable).toBe(true);
  });

  it.each([
    'Fn::GetAtt',
    'Fn::Join',
    'Fn::Select',
    'Fn::Split',
    'Fn::Equals',
    'Fn::And',
    'Fn::Or',
    'Fn::Not',
    'Fn::ImportValue',
    'Fn::GetStackOutput',
    'Fn::FindInMap',
    'Fn::Base64',
    'Fn::GetAZs',
    'Fn::Cidr',
  ])('%s is a KNOWN intrinsic, not an over-refusal', (key) => {
    expect(collectParameterDependencies({ a: { [key]: ['x', 'y'] } }, undefined, t).unclassifiable).toBe(
      false
    );
  });

  it('classifies an ordinary bag, skips the ${!Literal} escape, and survives a condition cycle', () => {
    const cyc = {
      Resources: {},
      Conditions: { A: { 'Fn::Not': [{ Condition: 'B' }] }, B: { 'Fn::Not': [{ Condition: 'A' }] } },
    } as CloudFormationTemplate;
    const deps = collectParameterDependencies(
      {
        a: { 'Fn::Sub': '${!NotAVar}-${Real}-${Res.Arn}' },
        b: { 'Fn::If': ['A', { 'Fn::GetAtt': ['Other', 'Arn'] }, { Ref: 'AWS::NoValue' }] },
        // An IAM-style `Condition` KEY in a property bag is data, not a reference.
        c: { Condition: { StringEquals: { k: 'v' } } },
      },
      undefined,
      cyc
    );
    expect(deps.unclassifiable).toBe(false);
    expect([...deps.names].sort()).toEqual(['AWS::NoValue', 'Other', 'Real', 'Res', 'Res.Arn']);
    // Attribute READS only — the plain `Ref` of `AWS::NoValue` / `Real` is absent.
    expect([...deps.attributeTargets].sort()).toEqual(['Other', 'Res']);
    expect(
      [...collectParameterDependencies({ a: { 'Fn::GetAtt': 'Dotted.Attr.Sub' } }, undefined, cyc).attributeTargets]
    ).toEqual(['Dotted']);
  });

  it('an unclassifiable bag refuses ONLY when a divergent parameter is NAMED somewhere in the template', async () => {
    const properties = { Detail: { pw: { 'Fn::Transform': { Name: 'M' } } } };
    const named = await run({
      template: templateWith(PW_PARAM, { Outputs: { O: { Value: { Ref: 'DbPassword' } } } } as never),
      properties,
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect(named.refused).toBe(true);
    // Divergent, but nothing names it: it cannot have shaped any resource.
    const unnamed = await run({
      template: templateWith(PW_PARAM),
      properties,
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect(unnamed.refused).toBe(false);
    const proven = await run({
      template: templateWith({ Stage: { Type: 'String', Default: 'dev' } }),
      properties: { Detail: { n: 'plain' }, Other: { 'Fn::Sub': ['${V}', { V: 'x' }] } },
      deployed: [{ ParameterKey: 'Stage', ParameterValue: 'dev' }],
      readback: { Detail: { n: 'plain' } },
    });
    expect(proven.refused).toBe(false);
  });
});

describe('readDeployedParameters never throws and never echoes', () => {
  const clientWith = (send: (command: unknown) => Promise<unknown>): CloudFormationClient =>
    ({ send }) as unknown as CloudFormationClient;

  it('reads Parameters from the stack addressed by the name it was given', async () => {
    const send = vi.fn(async (_command: unknown) => ({
      Stacks: [{ Parameters: [{ ParameterKey: 'A', ParameterValue: 'a' }] }],
    }));
    const deployed = await readDeployedParameters('arn:child', clientWith(send), getLogger(), 'Child');
    expect((send.mock.calls[0]![0] as { input: unknown }).input).toEqual({ StackName: 'arn:child' });
    expect(deployed.provablyEquals('A', 'String', 'a')).toBe(true);
    expect(logged).toEqual([]);
  });

  it('AccessDenied: fail-closed, ONE warn naming the action and the error NAME, never the message', async () => {
    const err = new Error(`User is not authorized ... ${DEPLOYED_SENTINEL}`);
    err.name = 'AccessDenied';
    const deployed = await readDeployedParameters(
      'S',
      clientWith(async () => {
        throw err;
      }),
      getLogger(),
      'S'
    );
    expect(deployed.provablyEquals('A', 'String', 'a')).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('cloudformation:DescribeStacks');
    expect(logged[0]).toContain('AccessDenied');
    expect(logged[0]).not.toContain('deployed-sentinel-2854');
  });

  it('an error NAME that is not a plain identifier is not rendered either', async () => {
    const err = new Error('m');
    err.name = `weird ${DEPLOYED_SENTINEL}`;
    await readDeployedParameters(
      'S',
      clientWith(async () => {
        throw err;
      }),
      getLogger(),
      'S'
    );
    expect(logged.join('\n')).not.toContain('deployed-sentinel-2854');
  });

  it('an empty Stacks answer is unavailable, not "no parameters"', async () => {
    const deployed = await readDeployedParameters(
      'S',
      clientWith(async () => ({ Stacks: [] })),
      getLogger(),
      'S'
    );
    expect(deployed.provablyEquals('A', 'String', 'a')).toBe(false);
    expect(logged).toHaveLength(1);
    // The arm's OWN reason — a TypeError on `stack.Parameters` would also warn once.
    expect(logged[0]).toContain('the stack was not returned');
  });

  it('absentStackIsNoSource: "does not exist" is undefined and SILENT; anything else still fails closed', async () => {
    const absent = new Error('Stack with id S does not exist');
    absent.name = 'ValidationError';
    const other = new Error('1 validation error detected');
    other.name = 'ValidationError';
    const reject = (err: Error): CloudFormationClient =>
      clientWith(async () => {
        throw err;
      });
    const opt = { absentStackIsNoSource: true } as const;
    expect(await readDeployedParameters('S', reject(absent), getLogger(), 'S', opt)).toBeUndefined();
    expect(logged).toEqual([]);
    const failed = await readDeployedParameters('S', reject(other), getLogger(), 'S', opt);
    expect(failed?.provablyEquals('A', 'String', 'a')).toBe(false);
    expect(logged).toHaveLength(1);
    // The NAME gates it, not the phrase: an AccessDenied echoing the phrase fails closed.
    const denied = new Error('role X does not exist or is not authorized');
    denied.name = 'AccessDenied';
    logged.length = 0;
    const closed = await readDeployedParameters('S', reject(denied), getLogger(), 'S', opt);
    expect(closed?.provablyEquals('A', 'String', 'a')).toBe(false);
    expect(logged).toHaveLength(1);
    // Without the option a missing stack IS a failure (a migrate source must exist).
    const strict = await readDeployedParameters('S', reject(absent), getLogger(), 'S');
    expect(strict.provablyEquals('A', 'String', 'a')).toBe(false);
  });

  it('the holder renders nothing under JSON.stringify, String or inspect', async () => {
    const { inspect } = await import('node:util');
    const deployed = DeployedParameters.fromDescribeStacks([
      { ParameterKey: 'A', ParameterValue: DEPLOYED_SENTINEL, ResolvedValue: DEPLOYED_SENTINEL },
    ]);
    for (const rendered of [JSON.stringify(deployed), String(deployed), inspect(deployed, { depth: 9, showHidden: true })]) {
      expect(rendered).not.toContain('deployed-sentinel-2854');
    }
  });
});

describe('ARM 4 across SEVERAL resources in one stack', () => {
  async function runMany(args: {
    template: CloudFormationTemplate;
    resources: Record<string, Record<string, unknown>>;
    deployed: Deployed;
    stackName?: string;
  }): Promise<Set<string>> {
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      stackName: args.stackName ?? 'arm4-many',
      region: 'us-east-1',
      resources: Object.fromEntries(
        Object.entries(args.resources).map(([id, properties]) => [
          id,
          { physicalId: `${id}-phys`, resourceType: 'AWS::SQS::Queue', properties, attributes: {} },
        ])
      ),
      outputs: {},
      lastModified: 0,
    };
    return resolveImportedProperties(
      state,
      args.template,
      'us-east-1',
      undefined as never,
      getLogger(),
      DeployedParameters.fromDescribeStacks(args.deployed)
    );
  }
  const many = (
    parameters: Record<string, unknown>,
    ids: string[],
    extra: Partial<CloudFormationTemplate> = {}
  ): CloudFormationTemplate =>
    ({
      Parameters: parameters,
      ...extra,
      Resources: Object.fromEntries(ids.map((id) => [id, { Type: 'AWS::SQS::Queue', Properties: {} }])),
    }) as CloudFormationTemplate;

  it('a refusal does not end the loop: the control after it keeps its baseline, the next dependent is counted', async () => {
    const refused = await runMany({
      template: many({ ...PW_PARAM, Stage: { Type: 'String', Default: 'dev' } }, ['A', 'B', 'C']),
      resources: {
        A: { pw: { Ref: 'DbPassword' } },
        B: { name: { Ref: 'Stage' } },
        C: { pw: { 'Fn::Sub': '${DbPassword}' } },
      },
      deployed: [
        { ParameterKey: 'DbPassword', ParameterValue: '****' },
        { ParameterKey: 'Stage', ParameterValue: 'dev' },
      ],
    });
    expect([...refused].sort()).toEqual(['A', 'C']);
    const warns = logged.filter((l) => l.includes('could not be proven equal to the template'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('2 resource(s)');
  });

  it('taint follows an ATTRIBUTE read of a refused resource, transitively — and not a plain Ref', async () => {
    const refused = await runMany({
      // Reader-of-reader FIRST: a single pass in insertion order would miss it,
      // so this order is what pins the fixpoint.
      template: many(PW_PARAM, ['Reader2', 'Reader', 'Secret', 'Pointer', 'Bystander']),
      resources: {
        Reader2: { env: { 'Fn::Sub': 'x-${Reader.Custom}' } },
        // What CDK's `param.stringValue` emits; resolves WITHOUT throwing.
        Reader: { env: { 'Fn::GetAtt': ['Secret', 'Value'] } },
        Secret: { Value: { Ref: 'DbPassword' } },
        Pointer: { target: { Ref: 'Secret' } },
        Bystander: { name: 'literal' },
      },
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect([...refused].sort()).toEqual(['Reader', 'Reader2', 'Secret']);
    const warns = logged.filter((l) => l.includes('could not be proven equal to the template'));
    expect(warns[0]).toContain('3 resource(s)');
  });

  it("CDK's never-bound BootstrapVersion arms NOTHING: an unclassifiable bag keeps its baseline", async () => {
    const refused = await runMany({
      template: many(
        {
          BootstrapVersion: {
            Type: 'AWS::SSM::Parameter::Value<String>',
            Default: '/cdk-bootstrap/hnb659fds/version',
          },
        },
        ['A']
      ),
      resources: { A: { odd: { 'Fn::Transform': { Name: 'M' } } } },
      deployed: [
        { ParameterKey: 'BootstrapVersion', ParameterValue: '/cdk-bootstrap/hnb659fds/version', ResolvedValue: '21' },
      ],
    });
    expect([...refused]).toEqual([]);
    expect(logged.filter((l) => l.includes('No observed drift baseline'))).toEqual([]);
  });

  it('ONE warning per stack: the unclassifiable share is stated, nothing is double-counted, no empty name list', async () => {
    const refused = await runMany({
      template: many(PW_PARAM, ['A', 'B']),
      resources: { A: { odd: { 'Fn::Transform': { Name: 'M' } } }, B: { pw: { Ref: 'DbPassword' } } },
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect([...refused].sort()).toEqual(['A', 'B']);
    const warns = logged.filter((l) => l.includes('could not be proven equal to the template'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('2 resource(s)');
    expect(warns[0]).toContain('(DbPassword)');
    expect(warns[0]).toContain('1 of them because their properties could not be checked');
    expect(logged.join('\n')).not.toContain(' ()');
  });

  it('a reader of an UNCLASSIFIABLE resource is refused too, and an unclassifiable-only stack names no parameter', async () => {
    const refused = await runMany({
      template: many(PW_PARAM, ['Odd', 'Reader'], { Outputs: { O: { Value: { Ref: 'DbPassword' } } } } as never),
      resources: {
        Odd: { odd: { 'Fn::Transform': { Name: 'M' } } },
        Reader: { env: { 'Fn::GetAtt': ['Odd', 'Custom'] } },
      },
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect([...refused].sort()).toEqual(['Odd', 'Reader']);
    const warn = logged.find((l) => l.includes('could not be proven equal to the template'))!;
    expect(warn).toContain('2 resource(s)');
    expect(warn).not.toContain('DbPassword');
    expect(warn).toContain('1 of them because');
  });

  it('the seed comes from the TEMPLATE: a PRESERVED record holding the resolved literal still taints its reader', async () => {
    // A selective merge keeps A as a previous run resolved it — `CHANGEME`,
    // naming no parameter — while the template still says {Ref: DbPassword}.
    const template = many(PW_PARAM, ['A', 'B']);
    (template.Resources['A'] as { Properties: unknown }).Properties = { Value: { Ref: 'DbPassword' } };
    const refused = await runMany({
      template,
      resources: { A: { Value: 'CHANGEME' }, B: { env: { 'Fn::GetAtt': ['A', 'Value'] } } },
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect([...refused].sort()).toEqual(['A', 'B']);
  });

  it('the Fn::GetAtt arm still walks its operands: an attribute NAMED by a Ref names the parameter', () => {
    // Asserted on the walk itself — through the resolver a GetAtt of an absent
    // resource throws, and ARM 1 would carry the refusal whatever the walk did.
    const deps = collectParameterDependencies(
      { pw: { 'Fn::GetAtt': ['Other', { Ref: 'DbPassword' }] } },
      undefined,
      many(PW_PARAM, [])
    );
    expect([...deps.names].sort()).toEqual(['DbPassword', 'Other']);
  });

  it('the warning counts only records this import HOLDS, not tainted template resources outside state', async () => {
    const template = many(PW_PARAM, ['NotImported', 'A']);
    (template.Resources['NotImported'] as { Properties: unknown }).Properties = {
      Value: { Ref: 'DbPassword' },
    };
    await runMany({
      template,
      resources: { A: { pw: { Ref: 'DbPassword' } } },
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    const warn = logged.find((l) => l.includes('could not be proven equal to the template'))!;
    expect(warn).toContain('1 resource(s)');
  });

  /** A bag deep enough that the synchronous walk overflows the call stack. */
  const deepBag = (): unknown => {
    let node: unknown = 'leaf';
    for (let i = 0; i < 200_000; i++) node = { n: node };
    return node;
  };

  it('a bag the walk cannot TRAVERSE fails closed at every level that catches it', () => {
    const template = many(PW_PARAM, ['A', 'B']);
    // reachableDivergentParameters: keeps the WHOLE divergent set.
    expect([...reachableDivergentParameters(template, new Set(['DbPassword']), [deepBag()])]).toEqual([
      'DbPassword',
    ]);
    // computeParameterTaint: refuses the unreadable resource AND the reader of
    // its attributes — through the resolver ARM 1 covers A itself, never B.
    const taint = computeParameterTaint(
      template,
      new Map<string, unknown>([
        ['A', deepBag()],
        ['B', { x: { 'Fn::GetAtt': ['A', 'V'] } }],
      ]),
      new Set(['DbPassword'])
    );
    expect([...taint.refused].sort()).toEqual(['A', 'B']);
    expect([...taint.unclassifiable]).toEqual(['A']);
  });

  it('NO warning when the only tainted resource is outside state', async () => {
    const template = many(PW_PARAM, ['NotImported', 'A']);
    (template.Resources['NotImported'] as { Properties: unknown }).Properties = {
      Value: { Ref: 'DbPassword' },
    };
    const refused = await runMany({
      template,
      resources: { A: { name: 'literal' } },
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect([...refused]).toEqual([]);
    expect(logged.filter((l) => l.includes('could not be proven equal to the template'))).toEqual([]);
  });

  it('computeParameterTaint: a tainted template resource NOT in state still taints its reader', () => {
    // Called directly: through the resolver, B's GetAtt of an absent resource
    // THROWS and ARM 1 would carry the refusal instead.
    const template = many(PW_PARAM, ['Absent', 'B']);
    (template.Resources['Absent'] as { Properties: unknown }).Properties = { Value: { Ref: 'DbPassword' } };
    const taint = computeParameterTaint(
      template,
      new Map([['B', { env: { 'Fn::GetAtt': ['Absent', 'Value'] } }]]),
      new Set(['DbPassword'])
    );
    expect([...taint.refused].sort()).toEqual(['Absent', 'B']);
    expect([...taint.unclassifiable]).toEqual([]);
    expect(computeParameterTaint(template, new Map(), new Set()).refused.size).toBe(0);
  });

  it('a resource that THROWS and depends on a divergent parameter is still counted in the warning', async () => {
    const refused = await runMany({
      template: many(PW_PARAM, ['A']),
      resources: { A: { pw: { Ref: 'DbPassword' }, other: { Ref: 'NoSuchResource' } } },
      deployed: [{ ParameterKey: 'DbPassword', ParameterValue: '****' }],
    });
    expect([...refused]).toEqual(['A']);
    expect(
      logged.filter((l) => l.includes('could not be proven equal to the template'))
    ).toHaveLength(1);
  });

  it('parameter and stack NAMES are rendered display-safe', async () => {
    const evil = 'Pw\u001b[2K\rEvil';
    await runMany({
      template: many({ [evil]: { Type: 'String', Default: 'CHANGEME' } }, ['A']),
      resources: { A: { pw: { Ref: evil } } },
      deployed: [{ ParameterKey: evil, ParameterValue: 'other' }],
      stackName: 'Stack\u001b[2K\rEvil',
    });
    const warn = logged.find((l) => l.includes('could not be proven equal to the template'))!;
    expect(warn).toBeDefined();
    expect(warn).not.toContain('\u001b');
    expect(warn).not.toContain('\r');
  });
});

describe('reachableDivergentParameters / namesAnyDeclaredParameter', () => {
  it('a reference that exists ONLY in template.Resources (a resource not in state) keeps the parameter', () => {
    const template = {
      Parameters: PW_PARAM,
      Resources: { Elsewhere: { Type: 'AWS::SQS::Queue', Properties: { q: { Ref: 'DbPassword' } } } },
    } as unknown as CloudFormationTemplate;
    expect([...reachableDivergentParameters(template, new Set(['DbPassword']), [])]).toEqual(['DbPassword']);
    expect(namesAnyDeclaredParameter(template)).toBe(true);
  });

  it("CDK's Rules-only BootstrapVersion names nothing, so no DescribeStacks is owed", () => {
    const template = {
      Parameters: { BootstrapVersion: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/p' } },
      Rules: { Check: { Assertions: [{ Assert: { 'Fn::Not': [{ Ref: 'BootstrapVersion' }] } }] } },
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: {} } },
    } as unknown as CloudFormationTemplate;
    expect(namesAnyDeclaredParameter(template)).toBe(false);
    expect(namesAnyDeclaredParameter({ Resources: {} } as CloudFormationTemplate)).toBe(false);
  });
});
