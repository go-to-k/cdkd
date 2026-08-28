import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const mockSsmSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ssm: { send: mockSsmSend } }),
}));

/**
 * Issue [#2367](https://github.com/go-to-k/cdkd/issues/2367): `resolveParameters`
 * writes `parameters[name]` at THREE sites and only the user-supplied one asked
 * the type coercion anything. This file covers the other two -- the literal
 * `Default` and the SSM-resolved default -- and it asserts through the
 * CONSUMERS rather than on the bag, because a test that only checks
 * `resolveParameters` returned something passes on the broken code.
 *
 * THE DISCRIMINATORS, all three measured against the pre-fix tree:
 *
 *  - `Fn::Select` over a string THROWS `Fn::Select: list must be an array, got
 *    string` (`resolveSelect`), so a defaulted `CommaDelimitedList` hard-failed
 *    the deploy -- and CloudFormation's own worked example in
 *    `parameters-section-structure.html` is exactly that pairing;
 *  - `Fn::Join` over a string refuses for the same reason;
 *  - a bare `Ref` silently hands the provider a comma-joined SCALAR where the
 *    resource schema declares a list, which is the case with no error at all.
 *
 * Every declared shape the default path can carry is walked, not only the list
 * types: `String`, `Number`, `List<Number>`, `CommaDelimitedList` and the
 * `List<AWS::...>` family. `Number` is the regression risk, because its default
 * may ALREADY be a number in the parsed template -- both polarities are pinned.
 */

/**
 * The parsed `Default` shapes, MEASURED 2026-08-29 rather than assumed, on both
 * parsers cdkd feeds `resolveParameters` from:
 *
 *  - `aws-cdk-lib` 2.244.0 synth (`CfnParameter._toCloudFormation` emits
 *    `Default: this.default` with no conversion): `{type:'Number',default:42}`
 *    -> the JSON number `42`; `{type:'Number',default:'42'}` -> the string
 *    `"42"`; `{type:'CommaDelimitedList',default:['a','b','c']}` -> a JSON
 *    array; `{type:'CommaDelimitedList',default:'a,b,c'}` -> a string.
 *  - `parseCfnTemplate` (`src/cli/yaml-cfn.ts`, the `cdkd import
 *    --migrate-from-cloudformation` / `cdkd export` path): `Default: 42` -> a
 *    number, `Default: "42"` -> a string, a YAML sequence -> an array,
 *    `Default: true` -> a boolean.
 *
 * So `Default` is `unknown` in practice as well as in the type, and the fix's
 * rule -- coerce a STRING, pass anything else through -- is pinned per shape
 * below.
 */
const bucket = { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } };

function templateWith(
  parameters: Record<string, unknown>,
  resources: Record<string, unknown> = bucket
): CloudFormationTemplate {
  return { Parameters: parameters, Resources: resources } as unknown as CloudFormationTemplate;
}

describe('resolveParameters: the literal Default path coerces by declared Type (issue #2367)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    mockSsmSend.mockReset();
  });

  it('binds a defaulted CommaDelimitedList as an ARRAY, space-trimmed like CloudFormation', async () => {
    // CloudFormation: "each member string is space trimmed. For example, users
    // could specify "test,dev,prod", and a Ref would result in
    // ["test","dev","prod"]" (parameters-section-structure.html).
    const template = templateWith({
      VpcAzs: { Type: 'CommaDelimitedList', Default: 'us-west-2a, us-west-2b, us-west-2c' },
    });

    const parameters = await resolver.resolveParameters(template);

    expect(parameters['VpcAzs']).toEqual(['us-west-2a', 'us-west-2b', 'us-west-2c']);
    expect(typeof parameters['VpcAzs']).not.toBe('string');
  });

  it('DISCRIMINATOR: Fn::Select over a defaulted CommaDelimitedList resolves instead of throwing', async () => {
    // The pre-fix tree threw `Fn::Select: list must be an array, got string`
    // here (resolveSelect), i.e. the deploy hard-failed. This is the shape of
    // CloudFormation's own documented example.
    const template = templateWith({
      VpcAzs: { Type: 'CommaDelimitedList', Default: 'us-west-2a, us-west-2b, us-west-2c' },
    });
    const parameters = await resolver.resolveParameters(template);

    const selected = await resolver.resolve(
      { 'Fn::Select': ['1', { Ref: 'VpcAzs' }] },
      { template, parameters, resources: {}, region: 'us-east-1' } as never
    );

    expect(selected).toBe('us-west-2b');
  });

  it('DISCRIMINATOR: Fn::Join over a defaulted CommaDelimitedList joins the members', async () => {
    const template = templateWith({
      Names: { Type: 'CommaDelimitedList', Default: 'a,b,c' },
    });
    const parameters = await resolver.resolveParameters(template);

    const joined = await resolver.resolve(
      { 'Fn::Join': ['-', { Ref: 'Names' }] },
      { template, parameters, resources: {}, region: 'us-east-1' } as never
    );

    expect(joined).toBe('a-b-c');
  });

  it('DISCRIMINATOR: a bare Ref hands a provider an ARRAY, not a comma-joined scalar', async () => {
    // The silent half of the defect: no error, a wrongly-created resource.
    const template = templateWith({
      Subnets: { Type: 'List<AWS::EC2::Subnet::Id>', Default: 'subnet-a,subnet-b' },
    });
    const parameters = await resolver.resolveParameters(template);

    const refd = await resolver.resolve({ Ref: 'Subnets' }, {
      template,
      parameters,
      resources: {},
      region: 'us-east-1',
    } as never);

    expect(refd).toEqual(['subnet-a', 'subnet-b']);
    expect(refd).not.toBe('subnet-a,subnet-b');
  });

  it('binds every List<AWS::...> spelling from a string default as an array', async () => {
    for (const type of [
      'List<AWS::EC2::AvailabilityZone::Name>',
      'List<AWS::EC2::Image::Id>',
      'List<AWS::EC2::Instance::Id>',
      'List<AWS::EC2::SecurityGroup::GroupName>',
      'List<AWS::EC2::SecurityGroup::Id>',
      'List<AWS::EC2::Subnet::Id>',
      'List<AWS::EC2::Volume::Id>',
      'List<AWS::EC2::VPC::Id>',
      'List<AWS::Route53::HostedZone::Id>',
      'List<String>',
    ]) {
      const parameters = await resolver.resolveParameters(
        templateWith({ P: { Type: type, Default: 'x, y' } })
      );
      expect(parameters['P'], type).toEqual(['x', 'y']);
    }
  });

  it('binds a defaulted List<Number> as numbers', async () => {
    const parameters = await resolver.resolveParameters(
      templateWith({ Ports: { Type: 'List<Number>', Default: '80, 443' } })
    );
    expect(parameters['Ports']).toEqual([80, 443]);
  });

  // --- the non-list half of the type space: the regression surface ---

  it('Number: a STRING default becomes a number, matching the user-supplied path', async () => {
    const parameters = await resolver.resolveParameters(
      templateWith({ Size: { Type: 'Number', Default: '42' } })
    );
    expect(parameters['Size']).toBe(42);

    // Parity with the site that was already correct: the same declaration fed
    // the same text as a USER value binds identically.
    const viaUser = await resolver.resolveParameters(
      templateWith({ Size: { Type: 'Number', Default: '0' } }),
      { Size: '42' }
    );
    expect(viaUser['Size']).toBe(42);
  });

  it('Number: a NUMERIC default stays a number (DOCUMENTS the CDK-emitted shape; not a fence)', async () => {
    // The shape a CDK synth actually emits for `{type:'Number',default:42}`.
    //
    // NON-DISCRIMINATING BY CONSTRUCTION, and labelled so rather than left to
    // read as a fence: `Number(String(42)) === 42`, so this case stays green
    // under every mutation of this change -- including dropping the string
    // guard entirely. The `Number` polarity that DOES discriminate is the
    // STRING-default case above; the one that fences the guard is the
    // comma-bearing array below. Keeping it is worth a regression guard on the
    // shape CDK actually emits, but claiming it pins both polarities would be
    // asserting a fence that cannot fail.
    const parameters = await resolver.resolveParameters(
      templateWith({ Size: { Type: 'Number', Default: 42 } })
    );
    expect(parameters['Size']).toBe(42);
    expect(typeof parameters['Size']).toBe('number');
  });

  it('DISCRIMINATOR: Fn::Split over a defaulted list parameter is REFUSED, naming the Ref remedy', async () => {
    // NEWLY REACHABLE. A template that wrote `Fn::Split` over a defaulted
    // list-typed parameter was working around this very bug and SUCCEEDED
    // pre-fix (the parameter was a string, so there was something to split).
    // Now the parameter is already a list and `resolveSplit`'s `ALREADY a list`
    // arm refuses it -- matching CloudFormation, which rejects Fn::Split over a
    // list too. Pinning the refusal AND its per-source remedy, because the
    // remedy text is the only thing telling that user what to do instead.
    const template = templateWith({
      Azs: { Type: 'CommaDelimitedList', Default: 'us-west-2a,us-west-2b' },
    });
    const parameters = await resolver.resolveParameters(template);

    await expect(
      resolver.resolve({ 'Fn::Split': [',', { Ref: 'Azs' }] }, {
        template,
        parameters,
        resources: {},
        region: 'us-east-1',
      } as never)
    ).rejects.toThrow(/Fn::Split: the value to split.*is ALREADY a list/s);

    // The `source.kind === 'ref'` remedy, not the Fn::GetAtt / neutral one.
    await expect(
      resolver.resolve({ 'Fn::Split': [',', { Ref: 'Azs' }] }, {
        template,
        parameters,
        resources: {},
        region: 'us-east-1',
      } as never)
    ).rejects.toThrow(/A list-typed parameter .* is already a list\./s);
  });

  it('String: the default is untouched, commas and all', async () => {
    const parameters = await resolver.resolveParameters(
      templateWith({ Csv: { Type: 'String', Default: 'a,b,c' } })
    );
    expect(parameters['Csv']).toBe('a,b,c');
  });

  it('the AWS-specific SCALAR types keep their string default', async () => {
    const parameters = await resolver.resolveParameters(
      templateWith({ Sg: { Type: 'AWS::EC2::SecurityGroup::Id', Default: 'sg-a,sg-b' } })
    );
    expect(parameters['Sg']).toBe('sg-a,sg-b');
  });

  it('a NON-STRING default is passed through untouched for every shape a parser can produce', async () => {
    // Each is already in the shape its declared type calls for; String()-ing it
    // into the coercion would damage it. `['a,b','c']` is the load-bearing one:
    // stringify-then-split yields THREE elements.
    const parameters = await resolver.resolveParameters(
      templateWith({
        ArrayDefault: { Type: 'CommaDelimitedList', Default: ['a', 'b', 'c'] },
        CommaBearingArray: { Type: 'CommaDelimitedList', Default: ['a,b', 'c'] },
        NumericArray: { Type: 'List<Number>', Default: [80, 443] },
        BoolDefault: { Type: 'String', Default: true },
        NullDefault: { Type: 'String', Default: null },
      })
    );

    expect(parameters['ArrayDefault']).toEqual(['a', 'b', 'c']);
    expect(parameters['CommaBearingArray']).toEqual(['a,b', 'c']);
    expect(parameters['NumericArray']).toEqual([80, 443]);
    expect(parameters['BoolDefault']).toBe(true);
    expect(parameters['NullDefault']).toBeNull();
  });

  it('an EMPTY-STRING default still binds the declared shape', async () => {
    const parameters = await resolver.resolveParameters(
      templateWith({
        Empty: { Type: 'CommaDelimitedList', Default: '' },
        EmptyString: { Type: 'String', Default: '' },
      })
    );
    expect(parameters['Empty']).toEqual(['']);
    expect(parameters['EmptyString']).toBe('');
  });

  it('a user-supplied value still wins over a coerced default', async () => {
    const parameters = await resolver.resolveParameters(
      templateWith({ Azs: { Type: 'CommaDelimitedList', Default: 'a,b' } }),
      { Azs: 'x,y,z' }
    );
    expect(parameters['Azs']).toEqual(['x', 'y', 'z']);
  });
});

describe('resolveParameters: the SSM-resolved default path coerces by the INNER type (issue #2367)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    mockSsmSend.mockReset();
  });

  /**
   * The wire shape, per the SSM service model's own `Parameter` doc: "If type
   * is `StringList`, the system returns a comma-separated string with no spaces
   * between commas in the `Value` field." `Parameter.Value` is typed `string`,
   * so `GetParameter` NEVER returns an array and a split is the only way to a
   * list.
   */
  const STRINGLIST_WIRE_VALUE = 'subnet-a,subnet-b,subnet-c';

  it('binds a Value<List<String>> parameter as an ARRAY, not the raw comma-separated string', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: STRINGLIST_WIRE_VALUE } });
    const template = templateWith(
      { Subnets: { Type: 'AWS::SSM::Parameter::Value<List<String>>', Default: '/app/subnets' } },
      { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'Subnets' } } } }
    );

    const parameters = await resolver.resolveParameters(template);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(parameters['Subnets']).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);
  });

  it('DISCRIMINATOR: Fn::Select over a Value<List<String>> parameter resolves instead of throwing', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: STRINGLIST_WIRE_VALUE } });
    const template = templateWith(
      { Subnets: { Type: 'AWS::SSM::Parameter::Value<List<String>>', Default: '/app/subnets' } },
      { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'Subnets' } } } }
    );
    const parameters = await resolver.resolveParameters(template);

    const selected = await resolver.resolve(
      { 'Fn::Select': ['2', { Ref: 'Subnets' }] },
      { template, parameters, resources: {}, region: 'us-east-1' } as never
    );

    expect(selected).toBe('subnet-c');
  });

  it('binds Value<CommaDelimitedList> and the Value<List<AWS::...>> forms as arrays too', async () => {
    for (const type of [
      'AWS::SSM::Parameter::Value<CommaDelimitedList>',
      'AWS::SSM::Parameter::Value<List<AWS::EC2::Subnet::Id>>',
      'AWS::SSM::Parameter::Value<List<AWS::EC2::KeyPair::KeyName>>',
    ]) {
      mockSsmSend.mockReset();
      mockSsmSend.mockResolvedValue({ Parameter: { Value: STRINGLIST_WIRE_VALUE } });
      const parameters = await resolver.resolveParameters(
        templateWith(
          { P: { Type: type, Default: '/app/list' } },
          { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'P' } } } }
        )
      );
      expect(parameters['P'], type).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);
    }
  });

  it('leaves the SCALAR Value<...> forms as the resolved string', async () => {
    for (const type of [
      'AWS::SSM::Parameter::Value<String>',
      'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
    ]) {
      mockSsmSend.mockReset();
      mockSsmSend.mockResolvedValue({ Parameter: { Value: 'ami-0ff8a91507f77f867' } });
      const parameters = await resolver.resolveParameters(
        templateWith(
          { P: { Type: type, Default: '/app/ami' } },
          { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'P' } } } }
        )
      );
      expect(parameters['P'], type).toBe('ami-0ff8a91507f77f867');
    }
  });

  it('the DEFAULT is still ONE Parameter Store key: exactly one GetParameter, never split', async () => {
    // AWS: "you must specify a Parameter Store key as the value of the Systems
    // Manager parameter type" / "you must provide the parameter name"
    // (cloudformation-supplied-parameter-types.html) -- singular, even for the
    // `Value<List<...>>` forms. The KEY must not be split; only the RESOLVED
    // value is.
    mockSsmSend.mockResolvedValue({ Parameter: { Value: STRINGLIST_WIRE_VALUE } });
    const parameters = await resolver.resolveParameters(
      templateWith(
        {
          Subnets: {
            Type: 'AWS::SSM::Parameter::Value<List<String>>',
            Default: '/app/subnets',
          },
        },
        { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'Subnets' } } } }
      )
    );

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    const sent = mockSsmSend.mock.calls[0]![0] as { input: { Name: string } };
    expect(sent.input.Name).toBe('/app/subnets');
    expect(parameters['Subnets']).toEqual(['subnet-a', 'subnet-b', 'subnet-c']);
  });

  it('the issue #1002 BootstrapVersion carve-out is untouched: no GetParameter, no binding', async () => {
    // The coercion sits STRICTLY AFTER the `referencedNames` skip, which
    // `continue`s. Nothing in this fix can make an unreferenced parameter
    // resolvable again.
    mockSsmSend.mockResolvedValue({ Parameter: { Value: '20' } });
    const parameters = await resolver.resolveParameters(
      templateWith({
        BootstrapVersion: {
          Type: 'AWS::SSM::Parameter::Value<String>',
          Default: '/cdk-bootstrap/hnb659fds/version',
        },
      })
    );

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(parameters).not.toHaveProperty('BootstrapVersion');
  });

  it('CARVE-OUT: a USER-SUPPLIED value for an SSM-typed parameter keeps the OUTER type and is NOT split', async () => {
    // The user-supplied site binds a Parameter Store KEY, not a resolved value,
    // so it must keep asking the OUTER type -- for which `isListParameterType`
    // answers `false` by design. If the inner peel ever leaked into that site,
    // a key would be split on `,` and shredded. A key legitimately contains no
    // comma, so the discriminating input is one that DOES: this asserts the
    // whole string survives.
    const parameters = await resolver.resolveParameters(
      templateWith(
        {
          Subnets: {
            Type: 'AWS::SSM::Parameter::Value<List<String>>',
            Default: '/app/subnets',
          },
        },
        { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'Subnets' } } } }
      ),
      { Subnets: '/app/a,/app/b' }
    );

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(parameters['Subnets']).toBe('/app/a,/app/b');
  });

  it('a GetParameter response carrying no Value binds the empty-string coercion, not undefined', async () => {
    // `resolveSSMParameter` returns `response.Parameter?.Value ?? ''`, so the
    // coercion is fed `''`. The list inner type makes that `['']` and the
    // scalar one leaves `''` -- the same split the literal-default path takes
    // for an empty default, which has its own case above.
    mockSsmSend.mockResolvedValue({ Parameter: {} });
    const listParams = await resolver.resolveParameters(
      templateWith(
        { P: { Type: 'AWS::SSM::Parameter::Value<List<String>>', Default: '/app/x' } },
        { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'P' } } } }
      )
    );
    expect(listParams['P']).toEqual(['']);

    mockSsmSend.mockReset();
    mockSsmSend.mockResolvedValue({ Parameter: {} });
    const scalarParams = await resolver.resolveParameters(
      templateWith(
        { P: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/x' } },
        { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'P' } } } }
      )
    );
    expect(scalarParams['P']).toBe('');
  });

  it('an unreferenced Value<List<String>> parameter is skipped too — the widening did not narrow the skip', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: STRINGLIST_WIRE_VALUE } });
    const parameters = await resolver.resolveParameters(
      templateWith({
        UnusedSubnets: {
          Type: 'AWS::SSM::Parameter::Value<List<String>>',
          Default: '/app/subnets',
        },
      })
    );

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(parameters).not.toHaveProperty('UnusedSubnets');
  });

  it('a malformed AWS::SSM::Parameter::Value spelling keeps the resolved string (DOCUMENTS intent; not a fence)', async () => {
    // NON-DISCRIMINATING BY CONSTRUCTION, labelled rather than implied. Both
    // strictness checks in the shared `ssmResolvedValueType` are unreddenable
    // from here: `Value` (no bracket) fails `startsWith` whatever the rest
    // does, and for `Value<>` the peeled inner is `''`, which is not
    // list-shaped, so dropping the non-empty check reaches the SAME
    // passthrough. It documents the decided answer for a spelling nobody
    // wrote, which is worth recording on a path that writes state -- but it
    // cannot fail, so it is not counted as coverage.
    mockSsmSend.mockResolvedValue({ Parameter: { Value: 'a,b' } });
    for (const type of ['AWS::SSM::Parameter::Value', 'AWS::SSM::Parameter::Value<>']) {
      mockSsmSend.mockClear();
      const parameters = await resolver.resolveParameters(
        templateWith(
          { P: { Type: type, Default: '/app/x' } },
          { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { Ref: 'P' } } } }
        )
      );
      expect(parameters['P'], type).toBe('a,b');
    }
  });
});
