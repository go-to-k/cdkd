/**
 * `scripts/gen-getatt-attributes.ts` (issue #3735): the derivation rule, the
 * renderer's formatter-stable layout, and the committed module's freshness
 * against the pinned `@aws-cdk/aws-service-spec` devDependency.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import {
  EXCLUDED,
  OUT_FILE,
  SECRET_NAME_ALLOWED,
  deriveWritableGetAttAttributes,
  loadSpec,
  renderGetAttAttributesModule,
  type SecretNameReview,
  type SpecResource,
  type SpecTypeDefinition,
} from '../../../scripts/gen-getatt-attributes.ts';
import { WRITABLE_GETATT_ATTRIBUTES } from '../../../src/provisioning/getatt-attributes.generated.js';

const str = { type: { type: 'string' } };
const int = { type: { type: 'integer' } };
const strArray = { type: { type: 'array', element: { type: 'string' } } };
const refArray = { type: { type: 'array', element: { type: 'ref', reference: { $ref: '1' } } } };
/** No exclusions and no allow-list: synthetic entities exercise neither. */
const bare = {
  excluded: new Map<string, string>(),
  secretNameAllowed: new Map<string, SecretNameReview>(),
  typeDefinitions: new Map<string, SpecTypeDefinition>(),
};

describe('deriveWritableGetAttAttributes', () => {
  it('keeps an attribute only when its whole name is also a property', () => {
    const table = deriveWritableGetAttAttributes(
      [
        {
          cloudFormationType: 'AWS::X::Y',
          properties: { VpcId: str, Name: str, Endpoint: str },
          // `Arn` is read-only (not a property): DescribeType certifies it, so
          // it stays out. A DOTTED attribute never certifies its container:
          // `Endpoint` is a property, but only `Endpoint.Address` is an
          // attribute, and certifying `Endpoint` would persist every sibling.
          attributes: { VpcId: str, Arn: str, 'Endpoint.Address': str, 'Endpoint.Port': str },
        },
      ],
      bare
    );
    expect([...table]).toEqual([['AWS::X::Y', ['VpcId']]]);
  });

  it('leaves out an EXCLUDED name even though it is a writable attribute', () => {
    expect(EXCLUDED.has('AWS::SSM::Parameter.Value')).toBe(true);
    const table = deriveWritableGetAttAttributes(
      [
        {
          cloudFormationType: 'AWS::SSM::Parameter',
          properties: { Type: str, Value: str },
          attributes: { Type: str, Value: str },
        },
      ],
      { ...bare, excluded: EXCLUDED }
    );
    expect([...table]).toEqual([['AWS::SSM::Parameter', ['Type']]]);
  });

  it('omits types with no such attribute and skips malformed entities', () => {
    const table = deriveWritableGetAttAttributes(
      [
        { cloudFormationType: 'AWS::A::B', properties: { P: str }, attributes: { Arn: str } },
        { cloudFormationType: 7, properties: { P: str }, attributes: { P: str } },
        { cloudFormationType: 'AWS::C::D', properties: null, attributes: ['P'] },
      ] as SpecResource[],
      bare
    );
    expect(table.size).toBe(0);
  });

  it('sorts types and names so the output is deterministic', () => {
    const table = deriveWritableGetAttAttributes(
      [
        {
          cloudFormationType: 'AWS::Z::Z',
          properties: { B: str, A: str },
          attributes: { B: str, A: str },
        },
        { cloudFormationType: 'AWS::A::A', properties: { Q: str }, attributes: { Q: str } },
      ],
      bare
    );
    expect([...table]).toEqual([
      ['AWS::A::A', ['Q']],
      ['AWS::Z::Z', ['A', 'B']],
    ]);
  });
});

describe('deriveWritableGetAttAttributes — value shape', () => {
  it('leaves out a name whose attribute type differs from the property type', () => {
    // The import records the MODEL value (the property's shape); Fn::GetAtt
    // returns the attribute's. MediaLive `Sources` is structs vs strings.
    const table = deriveWritableGetAttAttributes(
      [
        {
          cloudFormationType: 'AWS::X::Y',
          properties: { Sources: refArray, Port: int, Name: str },
          attributes: { Sources: strArray, Port: str, Name: str },
        },
      ],
      bare
    );
    expect([...table]).toEqual([['AWS::X::Y', ['Name']]]);
  });

  it('keeps a name whose types differ only in validation keys such as allowedValues', () => {
    const table = deriveWritableGetAttAttributes(
      [
        {
          cloudFormationType: 'AWS::X::Y',
          properties: { Kind: { type: { type: 'string', allowedValues: ['A', 'B'] } } },
          attributes: { Kind: str },
        },
      ],
      bare
    );
    expect([...table]).toEqual([['AWS::X::Y', ['Kind']]]);
  });

  it('tells apart two refs to different structs, and two unions of different members', () => {
    const refTo = (id: string) => ({ type: { type: 'ref', reference: { $ref: id } } });
    const unionOf = (...names: string[]) => ({
      type: { type: 'union', types: names.map((type) => ({ type })) },
    });
    const table = deriveWritableGetAttAttributes(
      [
        {
          cloudFormationType: 'AWS::X::Y',
          properties: { A: refTo('1'), B: unionOf('json', 'string'), C: refTo('3') },
          attributes: { A: refTo('2'), B: unionOf('json', 'integer'), C: refTo('3') },
        },
      ],
      {
        ...bare,
        typeDefinitions: new Map([['3', { $id: '3', properties: { Region: str } }]]),
      }
    );
    expect([...table]).toEqual([['AWS::X::Y', ['C']]]);
  });

  it('leaves out a json-or-string union property read as a string attribute', () => {
    const union = { type: { type: 'union', types: [{ type: 'json' }, { type: 'string' }] } };
    const table = deriveWritableGetAttAttributes(
      [
        {
          cloudFormationType: 'AWS::X::Y',
          properties: { Policy: union },
          attributes: { Policy: str },
        },
      ],
      bare
    );
    expect(table.size).toBe(0);
  });
});

describe('deriveWritableGetAttAttributes — guards', () => {
  const secretish: SpecResource[] = [
    {
      cloudFormationType: 'AWS::X::Y',
      properties: { ApiToken: str },
      attributes: { ApiToken: str },
    },
  ];

  it('throws on a kept name that reads like a secret and has no allow-list reason', () => {
    expect(() => deriveWritableGetAttAttributes(secretish, bare)).toThrow(
      /AWS::X::Y\.ApiToken \[ApiToken\] \(or a member of its value\) reads like a secret/
    );
  });

  it('keeps such a name once the allow-list carries it', () => {
    const table = deriveWritableGetAttAttributes(secretish, {
      ...bare,
      secretNameAllowed: new Map([
        ['AWS::X::Y.ApiToken', { matched: ['ApiToken'], reason: 'an id, not a token' }],
      ]),
    });
    expect([...table]).toEqual([['AWS::X::Y', ['ApiToken']]]);
  });

  it('leaves out such a name when EXCLUDED carries it, without throwing', () => {
    const table = deriveWritableGetAttAttributes(secretish, {
      ...bare,
      excluded: new Map([['AWS::X::Y.ApiToken', 'a token']]),
    });
    expect(table.size).toBe(0);
  });

  it('throws on an EXCLUDED entry the spec no longer exercises', () => {
    expect(() =>
      deriveWritableGetAttAttributes([], {
        ...bare,
        excluded: new Map([['AWS::Gone::Type.Value', 'r']]),
      })
    ).toThrow(/EXCLUDED entry AWS::Gone::Type\.Value no longer names/);
  });

  it('throws on an allow-list entry no longer in the table', () => {
    expect(() =>
      deriveWritableGetAttAttributes([], {
        ...bare,
        secretNameAllowed: new Map([['AWS::Gone::Type.Key', { matched: ['Key'], reason: 'r' }]]),
      })
    ).toThrow(/SECRET_NAME_ALLOWED entry AWS::Gone::Type\.Key is no longer in the table/);
  });

  it('throws on an innocently named struct whose MEMBERS read like a secret', () => {
    // Certifying `Settings` persists its whole subtree, so the guard walks
    // array elements and `ref` structs, nested.
    const refTo = (id: string) => ({ type: 'ref', reference: { $ref: id } });
    const settings = { type: { type: 'array', element: refTo('7') } };
    const typeDefinitions = new Map<string, SpecTypeDefinition>([
      ['7', { $id: '7', properties: { Inner: { type: refTo('8') } } }],
      ['8', { $id: '8', properties: { MasterPassword: str } }],
    ]);
    const resources: SpecResource[] = [
      {
        cloudFormationType: 'AWS::X::Y',
        properties: { Settings: settings },
        attributes: { Settings: settings },
      },
    ];
    expect(() =>
      deriveWritableGetAttAttributes(resources, { ...bare, typeDefinitions })
    ).toThrow('AWS::X::Y.Settings [Settings[].Inner.MasterPassword] (or a member of its value)');
    // The same struct with a harmless member passes.
    typeDefinitions.set('8', { $id: '8', properties: { Region: str } });
    expect([
      ...deriveWritableGetAttAttributes(resources, { ...bare, typeDefinitions }),
    ]).toEqual([['AWS::X::Y', ['Settings']]]);
  });

  it('walks union members, and a self-referencing struct terminates', () => {
    const refTo = (id: string) => ({ type: 'ref', reference: { $ref: id } });
    const value = { type: { type: 'union', types: [{ type: 'string' }, refTo('9')] } };
    const typeDefinitions = new Map<string, SpecTypeDefinition>([
      ['9', { $id: '9', properties: { Next: { type: refTo('9') }, ClientSecret: str } }],
    ]);
    expect(() =>
      deriveWritableGetAttAttributes(
        [{ cloudFormationType: 'AWS::X::Y', properties: { V: value }, attributes: { V: value } }],
        { ...bare, typeDefinitions }
      )
    ).toThrow(/AWS::X::Y\.V \[V\.ClientSecret\] \(or a member of its value\) reads like a secret/);
  });

  it('throws on a ref with no type definition rather than checking nothing', () => {
    const value = { type: { type: 'ref', reference: { $ref: '404' } } };
    expect(() =>
      deriveWritableGetAttAttributes(
        [{ cloudFormationType: 'AWS::X::Y', properties: { V: value }, attributes: { V: value } }],
        bare
      )
    ).toThrow(/AWS::X::Y\.V \(\$ref 404\) has no type definition/);
  });

  it.each([
    ['map', { type: { type: 'map', element: { type: 'string' } } }],
    ['json', { type: { type: 'json' } }],
  ])('requires an allow-list reason for a free-form %s value, whatever its name', (kind, value) => {
    const resources: SpecResource[] = [
      {
        cloudFormationType: 'AWS::X::Y',
        properties: { Labels: value },
        attributes: { Labels: value },
      },
    ];
    expect(() => deriveWritableGetAttAttributes(resources, bare)).toThrow(
      new RegExp(`AWS::X::Y\\.Labels \\[<${kind}>@Labels\\] .*free-form map / json`)
    );
    expect([
      ...deriveWritableGetAttAttributes(resources, {
        ...bare,
        secretNameAllowed: new Map([
          ['AWS::X::Y.Labels', { matched: [`<${kind}>@Labels`], reason: 'tag-like labels' }],
        ]),
      }),
    ]).toEqual([['AWS::X::Y', ['Labels']]]);
  });

  describe('an allow-list entry pins the exact set it was reviewed for', () => {
    const refTo = (id: string) => ({ type: 'ref', reference: { $ref: id } });
    const value = { type: refTo('5') };
    const resources: SpecResource[] = [
      {
        cloudFormationType: 'AWS::X::Y',
        properties: { Group: value },
        attributes: { Group: value },
      },
    ];
    const reviewed = {
      ...bare,
      secretNameAllowed: new Map([
        [
          'AWS::X::Y.Group',
          { matched: ['Group.ParameterKey', 'Group.ParameterValue'], reason: 'session settings' },
        ],
      ]),
    };

    it('passes while the spec yields exactly the reviewed set', () => {
      const typeDefinitions = new Map<string, SpecTypeDefinition>([
        [
          '5',
          { $id: '5', properties: { ParameterKey: str, ParameterValue: str, Region: str } },
        ],
      ]);
      const table = deriveWritableGetAttAttributes(resources, { ...reviewed, typeDefinitions });
      expect([...table]).toEqual([['AWS::X::Y', ['Group']]]);
    });

    it('throws when a spec bump adds an unreviewed matching member', () => {
      const typeDefinitions = new Map<string, SpecTypeDefinition>([
        [
          '5',
          {
            $id: '5',
            properties: { ParameterKey: str, ParameterValue: str, AdminUserPassword: str },
          },
        ],
      ]);
      expect(() =>
        deriveWritableGetAttAttributes(resources, { ...reviewed, typeDefinitions })
      ).toThrow(
        'AWS::X::Y.Group was reviewed for [Group.ParameterKey, Group.ParameterValue] but the ' +
          'spec now yields [Group.AdminUserPassword, Group.ParameterKey, Group.ParameterValue]'
      );
    });

    it('throws when a free-form value appears under a reviewed entry', () => {
      const typeDefinitions = new Map<string, SpecTypeDefinition>([
        [
          '5',
          {
            $id: '5',
            properties: {
              ParameterKey: str,
              ParameterValue: str,
              Extra: { type: { type: 'json' } },
            },
          },
        ],
      ]);
      expect(() =>
        deriveWritableGetAttAttributes(resources, { ...reviewed, typeDefinitions })
      ).toThrow('now yields [<json>@Group.Extra, Group.ParameterKey, Group.ParameterValue]');
    });

    it('throws when a reviewed member disappears from the spec', () => {
      const typeDefinitions = new Map<string, SpecTypeDefinition>([
        ['5', { $id: '5', properties: { ParameterKey: str } }],
      ]);
      expect(() =>
        deriveWritableGetAttAttributes(resources, { ...reviewed, typeDefinitions })
      ).toThrow('now yields [Group.ParameterKey]');
    });

    it('throws when a reviewed name appears at a SECOND place, through another struct', () => {
      const typeDefinitions = new Map<string, SpecTypeDefinition>([
        [
          '5',
          {
            $id: '5',
            properties: { ParameterKey: str, ParameterValue: str, Nested: { type: refTo('6') } },
          },
        ],
        ['6', { $id: '6', properties: { ParameterValue: str } }],
      ]);
      expect(() =>
        deriveWritableGetAttAttributes(resources, { ...reviewed, typeDefinitions })
      ).toThrow('Group.Nested.ParameterValue');
    });

    it('spells a map value step as {} and matches on the LAST path segment only', () => {
      const typeDefinitions = new Map<string, SpecTypeDefinition>([
        [
          '5',
          {
            $id: '5',
            properties: {
              ParameterKey: str,
              ParameterValue: str,
              // An ANCESTOR named like a secret with a harmless leaf: only
              // `ApiKeyConfig` itself matches, never `ApiKeyConfig.Region`.
              ApiKeyConfig: { type: refTo('6') },
              ByName: { type: { type: 'map', element: refTo('7') } },
            },
          },
        ],
        ['6', { $id: '6', properties: { Region: str } }],
        ['7', { $id: '7', properties: { SessionToken: str } }],
      ]);
      expect(() =>
        deriveWritableGetAttAttributes(resources, { ...reviewed, typeDefinitions })
      ).toThrow(
        'now yields [<map>@Group.ByName, Group.ApiKeyConfig, Group.ByName{}.SessionToken, ' +
          'Group.ParameterKey, Group.ParameterValue]'
      );
    });

    it('lists a struct reached at two places at BOTH paths', () => {
      // A visited-once walk would report `Shared` only under `First`, so a
      // second, unreviewed placement of the same struct would pass silently.
      const typeDefinitions = new Map<string, SpecTypeDefinition>([
        [
          '5',
          {
            $id: '5',
            properties: {
              ParameterKey: str,
              First: { type: refTo('6') },
              Second: { type: refTo('6') },
            },
          },
        ],
        ['6', { $id: '6', properties: { ParameterValue: str } }],
      ]);
      expect(() =>
        deriveWritableGetAttAttributes(resources, { ...reviewed, typeDefinitions })
      ).toThrow('[Group.First.ParameterValue, Group.ParameterKey, Group.Second.ParameterValue]');
    });
  });

  it('the shipped allow-list is exactly the two reviewed entries', () => {
    expect([...SECRET_NAME_ALLOWED].map(([key, review]) => [key, review.matched])).toEqual([
      ['AWS::CodeArtifact::Domain.EncryptionKey', ['EncryptionKey']],
      [
        'AWS::RedshiftServerless::Workgroup.Workgroup',
        [
          'Workgroup.ConfigParameters[].ParameterKey',
          'Workgroup.ConfigParameters[].ParameterValue',
          'Workgroup.Endpoint.VpcEndpoints[].NetworkInterfaces[].PrivateIpAddress',
        ],
      ],
    ]);
  });
});

describe('renderGetAttAttributesModule', () => {
  it('puts an entry on one line when it fits the print width, else one name per line', () => {
    const long = Array.from({ length: 8 }, (_, i) => `SomeRatherLongPropertyName${i}`);
    const out = renderGetAttAttributesModule(
      new Map([
        ['AWS::A::A', ['Q']],
        ['AWS::B::B', long],
      ]),
      '9.9.9'
    );
    expect(out).toContain("  'AWS::A::A': ['Q'],\n");
    expect(out).toContain(`  'AWS::B::B': [\n    '${long[0]}',\n`);
    expect(out).toContain('@aws-cdk/aws-service-spec 9.9.9');
    expect(out.endsWith('};\n')).toBe(true);
  });
});

describe('committed getatt-attributes.generated.ts', () => {
  it('equals a fresh generation from the installed spec (the `--check` predicate)', () => {
    const { resources, typeDefinitions, version } = loadSpec();
    const rendered = renderGetAttAttributesModule(
      deriveWritableGetAttAttributes(resources, { typeDefinitions }),
      version
    );
    expect(readFileSync(OUT_FILE, 'utf8')).toBe(rendered);
  });

  it('carries the names the issue measured CDK apps reading', () => {
    // Anchors, not a count: an empty or truncated table would re-open #3735.
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::EC2::Subnet']).toEqual(
      expect.arrayContaining(['AvailabilityZone', 'CidrBlock', 'VpcId'])
    );
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::SQS::Queue']).toContain('QueueName');
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::SNS::Topic']).toContain('TopicName');
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::StepFunctions::Activity']).toEqual(['Name']);
    // The exclusion and the dotted-attribute rule, read off the real table.
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::SSM::Parameter']).toEqual(['Type']);
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::Events::Connection']).toBeUndefined();
    // The type rule: structs-vs-strings, and json-or-string vs string.
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::MediaLive::Input']).toBeUndefined();
    expect(WRITABLE_GETATT_ATTRIBUTES['AWS::Events::EventBus']).toEqual(['Name']);
  });
});
