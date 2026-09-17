/**
 * Issue [#3150](https://github.com/go-to-k/cdkd/issues/3150): the resolver
 * masked the NAME arguments of its intrinsics (map keys, stack / output /
 * export names and listed output keys, regions, attribute names, and the
 * secret id / JSON key / parameter name of a dynamic reference) with the
 * needle mask alone. A needle
 * shorter than `MIN_NEEDLE_LENGTH` (4) matches only the WHOLE text, so a 1-3
 * character secret an `Fn::Sub` assembled into a longer name printed in the
 * clear, although the same pass had registered the name's log twin
 * (go-to-k/cdkd#3100). The resolver's log masker (`maskSecretsForLog`) now looks
 * that twin up centrally: a name with a registered twin prints the twin, or
 * `***` when the needle mask also changes the raw name, and a name with none
 * takes the needle mask as before.
 *
 * Most cases assemble the name with an `Fn::Sub` over a recorded secret
 * shorter than `MIN_NEEDLE_LENGTH` (`q7` for the ordinary shapes; `1`, `Ip`,
 * `Id`, `Ser`, `Arn` and `Num` where the secret must be a fragment of the
 * literal a guard compares against; `Out` for a mask over PART of the
 * `Outputs.` prefix). The exceptions are named where they occur: the `Outputs`
 * case, whose 7-character secret the needle mask catches; the attribute name
 * that IS a secret (`Outputs.q7`, resolved directly); `q:7` and `{{`, whose
 * masks cover a `:` or a token opener so no name pairs with its twin; and
 * `q7ab` / `st-1`, 4+ character secrets recorded beside the pin so they
 * straddle its mask. Each asserts the sentence WHOLE (or the whole line
 * prefix) with `***` at the secret's position; the controls carry an
 * unrecorded value in the same shape and print it verbatim, and each
 * `Fn::Base64` persistence pin sits beside a positive control.
 *
 * Three names are TRANSFORMED before they are printed, and a lookup of the
 * transformed text finds no twin, so each has its own case:
 *   - a region is lowercased by `canonicalizeRegion` (`US-EAST-q7`),
 *   - a nested stack's output name is the attribute name minus `Outputs.`,
 *   - an invalid region is stripped and cut to 64 characters.
 * And one name is COMPOSED: `reresolveCrossStackValue`'s `origin` is built from
 * the resolved names, so its components are twinned before assembly.
 *
 * A literal attribute-name check does not keep an assembled name out: it
 * compares the RESOLVED name, and an `Fn::Sub` can spell `PrivateIp` as
 * `Private` + a secret `Ip`. So the sites behind such a check (the legacy
 * `NameServers` normalization, the placeholder-ARN refusal, the EC2 instance
 * and launch-template reads, the DBProxy refusal) are cased too, and so is the
 * own-stack refusal, whose region can be `us-east-` + a secret `1`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { StateError } from '../../../src/utils/error-handler.js';
import { isThrottlingError } from '../../../src/deployment/retryable-errors.js';
import { displaySafe } from '../../../src/utils/display-safe.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const SECRET_ID = 'cdkd-name-argument-log-twin-probe';

/** The same secret by ARN: a region-stating reference the ambiguity refusal passes. */
const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:210987654321:secret:${SECRET_ID}`;

/** The sub-floor secret: two characters, below `MIN_NEEDLE_LENGTH`. */
const PIN = 'q7';

/** Never recorded: the CONTROL value. */
const UNRECORDED = 'k9';

/** The PUBLIC ssm value a re-resolved `{{resolve:ssm:host}}` becomes. */
const PUBLIC_HOST = 'pb';

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: logSpies.debug,
    info: logSpies.info,
    warn: logSpies.warn,
    error: logSpies.error,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** The CloudFormation fallback builds its OWN client; answer empty, or refuse. */
const cfnBehaviour = vi.hoisted(() => ({
  mode: 'empty' as 'empty' | 'throw' | 'found',
  /** What `found` answers: one export, and one stack's outputs. */
  exportName: '',
  outputKey: '',
  /**
   * When set, `throw` mode QUOTES this text back the way a real AccessDenied
   * names the resource ARN it refused (issue #3234). Empty leaves the original
   * message, so every pre-existing case is unaffected.
   */
  deniedQuotes: '',
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        if (cfnBehaviour.mode === 'throw') {
          const denied = new Error(
            cfnBehaviour.deniedQuotes === ''
              ? 'not authorized to perform this CloudFormation action'
              : `not authorized to perform cloudformation:DescribeStacks on ` +
                `arn:aws:cloudformation:us-east-1:210987654321:stack/${cfnBehaviour.deniedQuotes}/*`
          );
          denied.name = 'AccessDeniedException';
          throw denied;
        }
        const found = cfnBehaviour.mode === 'found';
        if (command.constructor.name === 'ListExportsCommand') {
          return {
            Exports: found
              ? [
                  {
                    Name: cfnBehaviour.exportName,
                    Value: 'v',
                    ExportingStackId: 'arn:aws:cloudformation:us-east-1:210987654321:stack/Cfn/1',
                  },
                ]
              : [],
          };
        }
        if (command.constructor.name === 'DescribeStacksCommand') {
          return {
            Stacks: found
              ? [{ Outputs: [{ OutputKey: cfnBehaviour.outputKey, OutputValue: 'v' }] }]
              : [],
          };
        }
        throw new Error(`unexpected CloudFormation command: ${command.constructor.name}`);
      }),
      destroy: vi.fn(),
    })),
  };
});

/** EC2 `DescribeAvailabilityZones`: a zone, none, or a rejection. */
const ec2Behaviour = vi.hoisted(() => ({ mode: 'empty' as 'ok' | 'empty' | 'throw' }));
/** STS: the real account, or an answer with no account (a FABRICATED id). */
const stsBehaviour = vi.hoisted(() => ({ fabricated: false }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => withRegionOf({
    sts: {
      send: vi.fn(async () => (stsBehaviour.fabricated ? {} : { Account: '210987654321' })),
    },
    ec2: {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        // A pending instance with no address yet: the refusal that names the
        // attribute it could not read.
        if (command.constructor.name === 'DescribeInstancesCommand') {
          return { Reservations: [{ Instances: [{ State: { Name: 'pending' } }] }] };
        }
        if (command.constructor.name === 'DescribeLaunchTemplatesCommand') {
          throw new Error('launch template read refused');
        }
        if (ec2Behaviour.mode === 'throw') throw new Error('The region is not subscribed');
        if (ec2Behaviour.mode === 'empty') return { AvailabilityZones: [] };
        return { AvailabilityZones: [{ ZoneName: 'zone-a' }] };
      }),
    },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        if (command.input?.Name === 'host') {
          return { Parameter: { Value: PUBLIC_HOST, Type: 'String' } };
        }
        if (command.input?.Name?.startsWith('param-')) return { Parameter: {} };
        if (command.input?.Name?.startsWith('pub-') || command.input?.Name?.includes(':parameter/pub-')) {
          return { Parameter: { Value: PUBLIC_HOST, Type: 'String' } };
        }
        const notFound = new Error(`ParameterNotFound: ${String(command.input?.Name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        if (command.input?.SecretId === SECRET_ID || command.input?.SecretId === SECRET_ARN) {
          // `pin` for ordinary assembly; the rest are FRAGMENTS of the literal a
          // guard compares against (`Private` + `Ip`, `us-east-` + `1`).
          return {
            SecretString: JSON.stringify({
              pin: PIN,
              word: 'Outputs',
              ser: 'Ser',
              arn: 'Arn',
              ip: 'Ip',
              num: 'Num',
              id: 'Id',
              one: '1',
              out3: 'Out',
              col: 'q:7',
              br: '{{',
              whole: `Outputs.${PIN}`,
              stone: 'st-1',
              // A 4-character secret HOLDING a control character, which only
              // a mask taken before the strip can see.
              ctl: `x${String.fromCharCode(1)}y7`,
              pinab: `${PIN}ab`,
            }),
          };
        }
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

/**
 * The mocked clients with a `withRegion` that returns them, so the resolver's
 * region-scoped clients line is reached; the clients answer the same in any
 * region.
 */
function withRegionOf<T extends object>(clients: T): T & { withRegion: () => T } {
  const out = clients as T & { withRegion: () => T };
  out.withRegion = () => out;
  return out;
}

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const ref = (jsonKey: string): string =>
  `{{resolve:secretsmanager:${SECRET_ID}:SecretString:${jsonKey}}}`;

/** An `Fn::Sub` putting the secret at `${P}` in `template`; fresh per call. */
const sub = (template: string, jsonKey = 'pin'): unknown => ({
  'Fn::Sub': [template, { P: ref(jsonKey) }],
});

/** The CONTROL twin of `sub`: the same text with an unrecorded value. */
const plain = (template: string): string => template.replace('${P}', UNRECORDED);

const NESTED_ARN = 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child';

interface ContextOverrides {
  template?: CloudFormationTemplate;
  resources?: Record<string, ResourceState>;
  stackName?: string;
  stateBackend?: S3StateBackend;
  exportIndex?: ExportIndexStore;
  redactedAttributeReads?: unknown[];
  producerRegions?: readonly string[];
}

function makeContext(overrides: ContextOverrides = {}) {
  return {
    template: overrides.template ?? { Resources: {} },
    resources: overrides.resources ?? {},
    stackName: overrides.stackName ?? 'Consumer',
    recordedSecretValues: new Map<string, string>(),
    ...(overrides.stateBackend && { stateBackend: overrides.stateBackend }),
    ...(overrides.exportIndex && { exportIndex: overrides.exportIndex }),
    ...(overrides.redactedAttributeReads && {
      redactedAttributeReads: overrides.redactedAttributeReads,
    }),
    ...(overrides.producerRegions && { producerRegions: overrides.producerRegions }),
  };
}

type Ctx = ReturnType<typeof makeContext>;

async function messageOf(
  value: unknown,
  context: Ctx,
  resolver = new IntrinsicFunctionResolver('us-east-1')
): Promise<string> {
  const outcome = await resolver.resolve(value, context as never).then(
    (resolved) => ({ resolvedInstead: JSON.stringify(resolved) }),
    (reason: unknown) => reason
  );
  if (outcome && typeof outcome === 'object' && 'resolvedInstead' in outcome) {
    throw new Error(`the site must throw; it resolved to ${String(outcome.resolvedInstead)}`);
  }
  expect(outcome).toBeInstanceOf(Error);
  return (outcome as Error).message;
}

function everyLine(): string[] {
  return [logSpies.debug, logSpies.info, logSpies.warn, logSpies.error].flatMap((spy) =>
    spy.mock.calls.map((c) => String(c[0]))
  );
}

/** No line of the pass, and no given message, carries `text`. */
function expectNowhere(text: string, ...messages: string[]): void {
  expect([...messages, ...everyLine()].filter((l) => l.includes(text))).toEqual([]);
}

function emptyBackend(): S3StateBackend {
  return {
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
  } as unknown as S3StateBackend;
}

/** A backend holding one stack whose `outputs` bag is `outputs`. */
function backendWith(
  stackName: string,
  outputs: Record<string, unknown>,
  region = 'us-east-1'
): S3StateBackend {
  return {
    listStacks: vi.fn(async () => [{ stackName, region }]),
    getState: vi.fn(async (name: string, lookupRegion?: string) =>
      name === stackName && (lookupRegion === undefined || lookupRegion === region)
        ? {
            state: { version: 8, stackName, region, resources: {}, outputs, lastModified: 1 },
            etag: 'e',
          }
        : null
    ),
  } as unknown as S3StateBackend;
}

const MAPPINGS: CloudFormationTemplate = {
  Mappings: { Envs: { prod: { Size: '1' } } },
  Resources: {},
} as CloudFormationTemplate;

beforeEach(() => {
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  cfnBehaviour.mode = 'empty';
  cfnBehaviour.deniedQuotes = '';
  cfnBehaviour.exportName = '';
  cfnBehaviour.outputKey = '';
  ec2Behaviour.mode = 'empty';
  stsBehaviour.fabricated = false;
  resetAccountInfoCache();
});

describe('issue #3150: Fn::FindInMap keys', () => {
  it('the mapping name', async () => {
    const message = await messageOf(
      { 'Fn::FindInMap': [sub('map-${P}'), 'prod', 'Size'] },
      makeContext({ template: MAPPINGS })
    );
    expect(message).toBe("Fn::FindInMap: mapping 'map-***' not found in Mappings section");
  });

  it('the top-level key refusal: key and mapping name', async () => {
    const template = { Mappings: { [`map-${PIN}`]: { prod: { Size: '1' } } }, Resources: {} };
    const message = await messageOf(
      { 'Fn::FindInMap': [sub('map-${P}'), sub('env-${P}'), 'Size'] },
      makeContext({ template: template as CloudFormationTemplate })
    );
    expect(message).toBe("Fn::FindInMap: top-level key 'env-***' not found in mapping 'map-***'");
  });

  it('the second-level key refusal: key, mapping name and top-level key', async () => {
    const template = {
      Mappings: { [`map-${PIN}`]: { [`env-${PIN}`]: { Size: '1' } } },
      Resources: {},
    };
    const message = await messageOf(
      { 'Fn::FindInMap': [sub('map-${P}'), sub('env-${P}'), sub('size-${P}')] },
      makeContext({ template: template as CloudFormationTemplate })
    );
    expect(message).toBe(
      "Fn::FindInMap: second-level key 'size-***' not found in mapping 'map-***' -> 'env-***'"
    );
  });

  it('CONTROL: unrecorded keys print verbatim', async () => {
    const message = await messageOf(
      { 'Fn::FindInMap': ['Envs', plain('env-${P}'), 'Size'] },
      makeContext({ template: MAPPINGS })
    );
    expect(message).toBe(
      `Fn::FindInMap: top-level key 'env-${UNRECORDED}' not found in mapping 'Envs'`
    );
  });

  it('the Resolved Fn::FindInMap success line, all three keys', async () => {
    const template = {
      Mappings: { [`map-${PIN}`]: { [`env-${PIN}`]: { [`size-${PIN}`]: '1' } } },
      Resources: {},
    };
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      { 'Fn::FindInMap': [sub('map-${P}'), sub('env-${P}'), sub('size-${P}')] },
      makeContext({ template: template as CloudFormationTemplate }) as never
    );
    const lines = everyLine().filter((l) => l.startsWith('Resolved Fn::FindInMap: '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Resolved Fn::FindInMap: map-\*\*\*\.env-\*\*\*\.size-\*\*\* -> /);
  });

  it("the condition warning that renders the key's refusal (the go-to-k/cdkd#3154 review addendum)", async () => {
    const template = {
      ...MAPPINGS,
      Conditions: {
        Probe: { 'Fn::Equals': [{ 'Fn::FindInMap': ['Envs', sub('env-${P}'), 'Size'] }, '1'] },
      },
    } as CloudFormationTemplate;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const conditions = await resolver.evaluateConditions(makeContext({ template }) as never);

    expect(conditions['Probe']).toBe(false);
    expect(logSpies.warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "Failed to evaluate condition Probe: Fn::FindInMap: top-level key 'env-***' not found in mapping 'Envs', assuming false",
    ]);
  });
});

describe('issue #3150: Fn::GetAtt attribute names', () => {
  const queue = (overrides: Partial<ResourceState> = {}): Record<string, ResourceState> => ({
    Res: {
      physicalId: 'phys-1',
      resourceType: 'AWS::SQS::Queue',
      properties: {},
      attributes: {},
      ...overrides,
    },
  });

  it('the physical-id fallback warning and the final debug line', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      { 'Fn::GetAtt': ['Res', sub('Attr${P}')] },
      makeContext({ resources: queue() }) as never
    );
    expect(everyLine()).toContain(
      'Unknown attribute Attr*** for resource type AWS::SQS::Queue, returning physical ID'
    );
    expect(everyLine().some((l) => l.startsWith('Resolved Fn::GetAtt: Res.Attr*** -> '))).toBe(
      true
    );
    expectNowhere(`Attr${PIN}`);
  });

  it('the flat attributes line', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      { 'Fn::GetAtt': ['Res', sub('Attr${P}')] },
      makeContext({ resources: queue({ attributes: { [`Attr${PIN}`]: 'v' } }) }) as never
    );
    expect(everyLine()).toContain('Resolved Fn::GetAtt from attributes: Res.Attr*** -> v');
  });

  it('CONTROL: an unrecorded attribute name prints verbatim', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      { 'Fn::GetAtt': ['Res', plain('Attr${P}')] },
      makeContext({ resources: queue({ attributes: { [`Attr${UNRECORDED}`]: 'v' } }) }) as never
    );
    expect(everyLine()).toContain(`Resolved Fn::GetAtt from attributes: Res.Attr${UNRECORDED} -> v`);
  });

  it('the nested attributes line', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      { 'Fn::GetAtt': ['Res', sub('Endpoint.Port${P}')] },
      makeContext({ resources: queue({ attributes: { Endpoint: { [`Port${PIN}`]: 'v' } } }) }) as never
    );
    expect(everyLine()).toContain('Resolved Fn::GetAtt from nested attributes: Res.Endpoint.Port*** -> v');
  });

  it("a masked read's pushed display (the refusal the deploy engine throws at default verbosity)", async () => {
    const reads: Array<{ display: string }> = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      { 'Fn::GetAtt': ['Res', sub('Attr${P}')] },
      makeContext({
        resources: queue({ attributes: { [`Attr${PIN}`]: '***' } }),
        redactedAttributeReads: reads,
      }) as never
    );
    expect(reads.map((r) => r.display)).toEqual(['Res.Attr***']);
  });

  it('the *Arn shape refusal names the attribute twice', async () => {
    const message = await messageOf(
      { 'Fn::GetAtt': ['Res', sub('Name${P}Arn')] },
      makeContext({ resources: queue() })
    );
    expect(message).toMatch(/^Cannot resolve Fn::GetAtt \[Res, Name\*\*\*Arn\] for AWS::SQS::Queue: /);
    expect(message).toMatch(/so cdkd can enrich AWS::SQS::Queue\.Name\*\*\*Arn\.$/);
    expect(message).not.toContain(PIN);
  });

  it('the --strict-getatt refusal names the attribute twice', async () => {
    const message = await messageOf(
      { 'Fn::GetAtt': ['Res', sub('Attr${P}')] },
      makeContext({ resources: queue() }),
      new IntrinsicFunctionResolver('us-east-1', { strictGetAtt: true })
    );
    expect(message).toMatch(/^Cannot resolve Fn::GetAtt \[Res, Attr\*\*\*\] for AWS::SQS::Queue: /);
    expect(message).toMatch(/so cdkd can enrich AWS::SQS::Queue\.Attr\*\*\*\.$/);
    expect(message).not.toContain(PIN);
  });

  it('the fabricated-account refusal', async () => {
    stsBehaviour.fabricated = true;
    const message = await messageOf(
      { 'Fn::GetAtt': ['Res', sub('Attr${P}')] },
      makeContext({ resources: queue({ physicalId: 'queue-123456789012-x' }) })
    );
    expect(message).toMatch(
      /^Cannot resolve Fn::GetAtt \[Res, Attr\*\*\*\] for AWS::SQS::Queue: STS did not report/
    );
    expect(message).not.toContain(PIN);
  });

  describe('behind a literal attribute-name check, reached by assembling the literal', () => {
    it('the legacy Route 53 NameServers normalization line', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      await resolver.resolve(
        { 'Fn::GetAtt': ['Zone', sub('Name${P}vers', 'ser')] },
        makeContext({
          resources: {
            Zone: {
              physicalId: 'Z0000000000',
              resourceType: 'AWS::Route53::HostedZone',
              properties: {},
              attributes: { NameServers: 'ns-1.example,ns-2.example' },
            },
          },
        }) as never
      );
      expect(everyLine().some((l) => l.startsWith('Normalized legacy Fn::GetAtt attribute: Zone.Name***vers -> '))).toBe(true);
      expectNowhere('NameServers');
    });

    it('the placeholder-ARN refusal', async () => {
      const message = await messageOf(
        { 'Fn::GetAtt': ['Ds', sub('DataSource${P}', 'arn')] },
        makeContext({
          resources: {
            Ds: {
              physicalId: 'ds-1',
              resourceType: 'AWS::AppSync::DataSource',
              properties: {},
              attributes: { DataSourceArn: 'arn:aws:appsync:*:*:apis/api/datasources/ds' },
            },
          },
        })
      );
      expect(message).toMatch(/^Cannot resolve Fn::GetAtt \[Ds, DataSource\*\*\*\] for AWS::AppSync::DataSource: /);
      expect(message).not.toContain('DataSourceArn');
    });

    it('the EC2 instance refusal names the attribute in its observation and its sentence', async () => {
      const message = await messageOf(
        { 'Fn::GetAtt': ['Box', sub('Private${P}', 'ip')] },
        makeContext({
          resources: {
            Box: {
              physicalId: 'i-0123456789abcdef0',
              resourceType: 'AWS::EC2::Instance',
              properties: {},
              attributes: {},
            },
          },
        })
      );
      expect(message).toMatch(/^Cannot resolve Fn::GetAtt \[Box, Private\*\*\*\] for AWS::EC2::Instance: /);
      // `refuseUnservedAttribute` names it twice: in the observation and in
      // its own sentence.
      expect(message).toContain('DescribeInstances reports no Private*** yet (state pending).');
      expect(message).toContain('is not a usable Private***, so cdkd refuses to substitute it.');
      expect(message).not.toContain('PrivateIp');
    });

    it('the launch-template read failure line', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const value = await resolver.resolve(
        { 'Fn::GetAtt': ['Lt', sub('LatestVersion${P}ber', 'num')] },
        makeContext({
          resources: {
            Lt: {
              physicalId: 'lt-0123456789abcdef0',
              resourceType: 'AWS::EC2::LaunchTemplate',
              properties: {},
              attributes: {},
            },
          },
        }) as never
      );
      expect(value).toBe('$Latest');
      expect(
        everyLine().some((l) =>
          l.startsWith('DescribeLaunchTemplates(lt-0123456789abcdef0) failed for LatestVersion***ber: ')
        )
      ).toBe(true);
      expectNowhere('LatestVersionNumber');
    });

    it('the DBProxy VpcId refusal', async () => {
      const message = await messageOf(
        { 'Fn::GetAtt': ['Proxy', sub('Vpc${P}', 'id')] },
        makeContext({
          resources: {
            Proxy: {
              physicalId: 'my-proxy',
              resourceType: 'AWS::RDS::DBProxy',
              properties: {},
              attributes: {},
            },
          },
        })
      );
      expect(message).toMatch(/^Cannot resolve Fn::GetAtt \[Proxy, Vpc\*\*\*\] for AWS::RDS::DBProxy: /);
      // The refusal's own prose says `VpcId`; the attribute it names must not.
      expect(message).not.toContain('[Proxy, VpcId]');
    });
  });

  describe('a nested stack output', () => {
    const child = (attributes: Record<string, unknown>): Record<string, ResourceState> => ({
      Child: {
        physicalId: NESTED_ARN,
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes,
      },
    });

    it('whole refusal: the name AND its sliced suffix', async () => {
      const message = await messageOf(
        { 'Fn::GetAtt': ['Child', sub('Outputs.env-${P}')] },
        makeContext({ resources: child({ 'Outputs.Real': 'x' }) })
      );
      expect(message).toBe(
        "Cannot resolve Fn::GetAtt [Child, Outputs.env-***]: the nested stack 'Child' declares no " +
          "output named 'env-***'. Its outputs are Real. Check the output name in the nested stack's " +
          'template, and deploy the child stack again if you have just added it.'
      );
    });

    it('an attribute name that IS the secret: the whole refusal', async () => {
      const message = await messageOf(
        { 'Fn::GetAtt': ['Child', ref('whole')] },
        makeContext({ resources: child({ 'Outputs.Real': 'x' }) })
      );
      expect(message).toBe(
        "Cannot resolve Fn::GetAtt [Child, ***]: the nested stack 'Child' declares no " +
          "output named '***'. Its outputs are Real. Check the output name in the nested stack's " +
          'template, and deploy the child stack again if you have just added it.'
      );
    });

    it("the sliced output name leaves what Fn::Base64 persists for an equal literal unchanged", async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const context = makeContext({ resources: child({ 'Outputs.Real': 'x' }) });
      await messageOf({ 'Fn::GetAtt': ['Child', sub('Outputs.env-${P}')] }, context, resolver);
      await resolver.resolve({ 'Fn::Base64': `env-${PIN}` }, context as never);
      expect(context.recordedSecretValues.has(Buffer.from(`env-${PIN}`).toString('base64'))).toBe(false);
      // CONTROL: the WHOLE name the Fn::Sub wrote is registered, so the detector is live.
      await resolver.resolve({ 'Fn::Base64': `Outputs.env-${PIN}` }, context as never);
      expect(context.recordedSecretValues.has(Buffer.from(`Outputs.env-${PIN}`).toString('base64'))).toBe(true);
    });

    it('a mask covering the WHOLE Outputs prefix prints the suffix as ***', async () => {
      const message = await messageOf(
        { 'Fn::GetAtt': ['Child', sub('${P}.env', 'word')] },
        makeContext({ resources: child({ 'Outputs.Real': 'x' }) })
      );
      expect(message).toBe(
        "Cannot resolve Fn::GetAtt [Child, ***]: the nested stack 'Child' declares no output " +
          "named '***'. Its outputs are Real. Check the output name in the nested stack's " +
          'template, and deploy the child stack again if you have just added it.'
      );
    });

    it('a mask covering PART of the Outputs prefix prints the suffix as ***', async () => {
      // `Out` + `puts.env`: the twin is `***puts.env`, which neither starts
      // with the prefix nor equals the whole mask.
      const message = await messageOf(
        { 'Fn::GetAtt': ['Child', sub('${P}puts.env', 'out3')] },
        makeContext({ resources: child({ 'Outputs.Real': 'x' }) })
      );
      expect(message).toBe(
        "Cannot resolve Fn::GetAtt [Child, ***puts.env]: the nested stack 'Child' declares no " +
          "output named '***'. Its outputs are Real. Check the output name in the nested stack's " +
          'template, and deploy the child stack again if you have just added it.'
      );
    });

    it("the refusal's list of declared outputs names a key the pass assembled through its twin", async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const context = makeContext({ resources: child({ [`Outputs.env-${PIN}`]: 'x' }) });
      // The first read registers `Outputs.env-q7`; the second asks for a name
      // the child does not declare, and the refusal lists the first.
      await resolver.resolve({ 'Fn::GetAtt': ['Child', sub('Outputs.env-${P}')] }, context as never);
      const message = await messageOf(
        { 'Fn::GetAtt': ['Child', 'Outputs.Missing'] },
        context,
        resolver
      );
      expect(message).toContain("declares no output named 'Missing'. Its outputs are env-***. ");
      expectNowhere(`env-${PIN}`, message);
    });

    it('the composed origin of its re-resolution', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const value = await resolver.resolve(
        { 'Fn::GetAtt': ['Child', sub('Outputs.env-${P}')] },
        makeContext({ resources: child({ [`Outputs.env-${PIN}`]: '{{resolve:ssm:host}}' }) }) as never
      );
      expect(value).toBe(PUBLIC_HOST);
      expect(everyLine()).toContain(
        'Re-resolving dynamic reference(s) in nested stack Child Outputs.env-***'
      );
      expectNowhere(`env-${PIN}`);
    });
  });
});

describe('issue #3150: Fn::GetAZs region, transformed by canonicalizeRegion', () => {
  it('the no-zones refusal lowercases the raw value’s twin', async () => {
    const message = await messageOf({ 'Fn::GetAZs': sub('US-EAST-${P}') }, makeContext());
    expect(message).toContain("no availability zones returned for region 'us-east-***'.");
    expect(message).not.toContain(PIN);
  });

  it('the region-scoped clients line', async () => {
    await messageOf({ 'Fn::GetAZs': sub('US-WEST-${P}') }, makeContext());
    expect(everyLine()).toContain('Using region-scoped AWS clients for us-west-***');
    expectNowhere(`us-west-${PIN}`);
  });

  it('a recorded needle that only lowercasing forms, overlapping the mask, masks the whole region', async () => {
    // `US-WEST-` + a secret `1`: the twin is `US-WEST-***`, and the recorded
    // `st-1` appears only in the lowercased `us-west-1`, across the mask.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('stone'), context as never);
    const message = await messageOf({ 'Fn::GetAZs': sub('US-WEST-${P}', 'one') }, context, resolver);
    expect(message).toContain("no availability zones returned for region '***'.");
    expect(message).not.toContain('us-we');
  });

  it('CONTROL: an unrecorded region prints verbatim, lowercased', async () => {
    const message = await messageOf({ 'Fn::GetAZs': plain('US-EAST-${P}') }, makeContext());
    expect(message).toContain(`no availability zones returned for region 'us-east-${UNRECORDED}'.`);
  });

  it('the describe-failure refusal', async () => {
    ec2Behaviour.mode = 'throw';
    const message = await messageOf({ 'Fn::GetAZs': sub('US-NORTH-${P}') }, makeContext());
    expect(message).toMatch(
      /^Fn::GetAZs: failed to describe availability zones for region 'us-north-\*\*\*': /
    );
  });

  it('the success line, then the cache-hit line', async () => {
    ec2Behaviour.mode = 'ok';
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve({ 'Fn::GetAZs': sub('US-SOUTH-${P}') }, makeContext() as never);
    await resolver.resolve({ 'Fn::GetAZs': sub('US-SOUTH-${P}') }, makeContext() as never);
    expect(everyLine()).toEqual(
      expect.arrayContaining([
        'Resolved Fn::GetAZs: us-south-*** -> ["zone-a"]',
        'Resolved Fn::GetAZs from cache: us-south-*** -> ["zone-a"]',
      ])
    );
    expectNowhere(`us-south-${PIN}`);
  });

  it('an invalid region carrying a twin prints as ***', async () => {
    const message = await messageOf({ 'Fn::GetAZs': sub('BAD_${P}') }, makeContext());
    expect(message).toMatch(/^Fn::GetAZs: '\*\*\*' is not a valid AWS region name/);
  });

  it('CONTROL: an invalid unrecorded region prints verbatim', async () => {
    const message = await messageOf({ 'Fn::GetAZs': plain('BAD_${P}') }, makeContext());
    expect(message).toMatch(
      new RegExp(`^Fn::GetAZs: 'BAD_${UNRECORDED}' is not a valid AWS region name`)
    );
  });
});

describe('issue #3150: Fn::GetStackOutput names and region', () => {
  it('the region: Resolving line, not-found throw and DescribeStacks warning', async () => {
    cfnBehaviour.mode = 'throw';
    const message = await messageOf(
      {
        'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out', Region: sub('US-WEST-${P}') },
      },
      makeContext({ stateBackend: emptyBackend() })
    );
    expect(message).toContain("not found in region 'us-west-***'");
    expect(everyLine()).toContain(
      'Resolving Fn::GetStackOutput: StackName=Producer, Region=us-west-***, OutputName=Out'
    );
    expect(everyLine().some((l) => l.includes("fallback failed for stack 'Producer' (us-west-***)"))).toBe(true);
    expectNowhere(`us-west-${PIN}`, message);
  });

  it('an invalid region carrying a twin prints as ***', async () => {
    const message = await messageOf(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out', Region: sub('BAD_${P}') } },
      makeContext({ stateBackend: emptyBackend() })
    );
    expect(message).toMatch(/^Fn::GetStackOutput: '\*\*\*' is not a valid AWS region name/);
  });

  it('CONTROL: an invalid unrecorded region prints verbatim', async () => {
    const message = await messageOf(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out', Region: plain('BAD_${P}') } },
      makeContext({ stateBackend: emptyBackend() })
    );
    expect(message).toMatch(
      new RegExp(`^Fn::GetStackOutput: 'BAD_${UNRECORDED}' is not a valid AWS region name`)
    );
  });

  it("the not-found error's available output keys", async () => {
    const message = await messageOf(
      { 'Fn::GetStackOutput': { StackName: sub('out-${P}'), OutputName: 'Missing' } },
      makeContext({ stateBackend: backendWith(`out-${PIN}`, { [`out-${PIN}`]: 'v' }) })
    );
    expect(message).toContain('Available outputs: out-***');
    expect(message).not.toContain(`out-${PIN}`);
  });

  it('the CloudFormation-fallback success line', async () => {
    cfnBehaviour.mode = 'found';
    cfnBehaviour.outputKey = `out-${PIN}`;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: sub('stack-${P}'), OutputName: sub('out-${P}') } },
      makeContext({ stateBackend: emptyBackend() }) as never
    );
    expect(value).toBe('v');
    expect(
      logSpies.info.mock.calls
        .map((c) => String(c[0]))
        .some((l) =>
          l.startsWith('Resolved Fn::GetStackOutput: StackName=stack-***, Region=us-east-1, OutputName=out-*** (from CloudFormation')
        )
    ).toBe(true);
    expectNowhere(`-${PIN}`);
  });

  it("a masked output's deferred refusal shows the composed origin", async () => {
    const reads: Array<{ display: string }> = [];
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: sub('stack-${P}'), OutputName: sub('out-${P}') } },
      makeContext({
        stateBackend: backendWith(`stack-${PIN}`, { [`out-${PIN}`]: '***' }),
        redactedAttributeReads: reads,
      }) as never
    );
    expect(reads.map((r) => r.display)).toEqual([
      "Fn::GetStackOutput 'out-***' (producer stack-*** / us-east-1)",
    ]);
  });

  it('the stack and output names, including the DescribeStacks warning', async () => {
    cfnBehaviour.mode = 'throw';
    const message = await messageOf(
      { 'Fn::GetStackOutput': { StackName: sub('stack-${P}'), OutputName: sub('out-${P}') } },
      makeContext({ stateBackend: emptyBackend() })
    );
    expect(message).toContain("stack 'stack-***' not found in region");
    expect(everyLine()).toContain(
      'Resolving Fn::GetStackOutput: StackName=stack-***, Region=us-east-1, OutputName=out-***'
    );
    expect(everyLine().some((l) => l.includes("fallback failed for stack 'stack-***' (us-east-1)"))).toBe(true);
    expectNowhere(`stack-${PIN}`, message);
  });

  it('the own-stack refusal', async () => {
    const message = await messageOf(
      { 'Fn::GetStackOutput': { StackName: sub('stack-${P}'), OutputName: 'Out' } },
      makeContext({ stackName: `stack-${PIN}`, stateBackend: emptyBackend() })
    );
    expect(message).toBe(
      "Fn::GetStackOutput: cannot reference own stack 'stack-***' in the same region 'us-east-1'"
    );
  });

  it("the own-stack refusal's region, assembled to equal the resolver's own", async () => {
    const message = await messageOf(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out', Region: sub('US-EAST-${P}', 'one') } },
      makeContext({ stackName: 'Producer', stateBackend: emptyBackend() })
    );
    expect(message).toBe(
      "Fn::GetStackOutput: cannot reference own stack 'Producer' in the same region 'us-east-***'"
    );
  });

  it('the composed origin of its re-resolution', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: sub('stack-${P}'),
          OutputName: sub('out-${P}'),
          Region: sub('US-EAST-${P}', 'one'),
        },
      },
      makeContext({
        stateBackend: backendWith(`stack-${PIN}`, { [`out-${PIN}`]: '{{resolve:ssm:host}}' }),
      }) as never
    );
    expect(value).toBe(PUBLIC_HOST);
    expect(
      logSpies.info.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.startsWith('Resolved Fn::GetStackOutput: StackName=stack-***, Region=us-east-***, OutputName=out-***'))
    ).toBe(true);
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::GetStackOutput 'out-***' (producer stack-*** / us-east-***)"
    );
    expectNowhere(`-${PIN}`);
  });

  it('a canonical region leaves what Fn::Base64 persists for an equal literal unchanged', async () => {
    // The region's log text lowercases the RAW value's twin without registering
    // one for `us-east-1`: the registry also decides what `Fn::Base64` records.
    cfnBehaviour.mode = 'throw';
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext({ stateBackend: emptyBackend() });
    await resolver
      .resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out', Region: sub('US-EAST-${P}', 'one') } },
        context as never
      )
      .catch(() => undefined);
    expect(everyLine().some((l) => l.includes('Region=us-east-***')), 'premise: the region was printed masked').toBe(true);
    await resolver.resolve({ 'Fn::Base64': 'us-east-1' }, context as never);
    expect(context.recordedSecretValues.has(Buffer.from('us-east-1').toString('base64'))).toBe(false);
    // CONTROL: the RAW region the Fn::Sub wrote is registered, so the detector is live.
    await resolver.resolve({ 'Fn::Base64': 'US-EAST-1' }, context as never);
    expect(context.recordedSecretValues.has(Buffer.from('US-EAST-1').toString('base64'))).toBe(true);
  });

  it("the composed origin's region when it is the resolver's own, equal to a string the pass assembled", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext({
      stateBackend: backendWith('Producer', { Out: '{{resolve:ssm:host}}' }),
    });
    await resolver.resolve(sub('us-east-${P}', 'one'), context as never);
    const value = await resolver.resolve(
      { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out' } },
      context as never
    );
    expect(value).toBe(PUBLIC_HOST);
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::GetStackOutput 'Out' (producer Producer / us-east-***)"
    );
  });

  it("the producer-region resolver line, for a region assembled to name another region", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver
      .resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'Out',
            Region: sub('US-WEST-${P}', 'one'),
          },
        },
        makeContext({
          stateBackend: backendWith('Producer', { Out: '{{resolve:ssm:host}}' }, 'us-west-1'),
        }) as never
      )
      .catch(() => undefined);
    const lines = everyLine().filter((l) => l.startsWith('Using a producer-region resolver for '));
    expect(lines).toEqual(['Using a producer-region resolver for us-west-***']);
    expect(everyLine()).toContain('Using region-scoped AWS clients for us-west-***');
    expectNowhere('us-west-1');
  });
});

describe('issue #3150: Fn::ImportValue export name', () => {
  it('the not-found throw and the ListExports warning', async () => {
    cfnBehaviour.mode = 'throw';
    const message = await messageOf(
      { 'Fn::ImportValue': sub('exp-${P}') },
      makeContext({ stateBackend: emptyBackend() })
    );
    expect(message).toContain("export 'exp-***' not found in any stack");
    expect(
      everyLine().some((l) => l.includes("ListExports fallback failed for export 'exp-***'"))
    ).toBe(true);
    expectNowhere(`exp-${PIN}`, message);
  });

  it('CONTROL: an unrecorded export name prints verbatim', async () => {
    const message = await messageOf(
      { 'Fn::ImportValue': plain('exp-${P}') },
      makeContext({ stateBackend: emptyBackend() })
    );
    expect(message).toContain(`export 'exp-${UNRECORDED}' not found in any stack`);
  });

  it('the state-scan arm: its origin and the index patch failure', async () => {
    const exportIndex = {
      lookup: vi.fn(async () => undefined),
      patchEntry: vi.fn(async () => {
        throw new Error('index write refused');
      }),
    } as unknown as ExportIndexStore;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      { 'Fn::ImportValue': sub('exp-${P}') },
      makeContext({
        stateBackend: backendWith('Producer', { [`exp-${PIN}`]: '{{resolve:ssm:host}}' }),
        exportIndex,
      }) as never
    );
    expect(value).toBe(PUBLIC_HOST);
    await vi.waitFor(() => {
      expect(
        everyLine().some((l) => l.startsWith("Failed to patch exports index for 'exp-***': "))
      ).toBe(true);
    });
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::ImportValue 'exp-***' (producer Producer / us-east-1)"
    );
    expectNowhere(`exp-${PIN}`);
  });

  it('the state-scan arm: a producer stack named like the export prints through its twin', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      { 'Fn::ImportValue': sub('exp-${P}') },
      makeContext({
        stateBackend: backendWith(`exp-${PIN}`, { [`exp-${PIN}`]: '{{resolve:ssm:host}}' }),
      }) as never
    );
    expect(value).toBe(PUBLIC_HOST);
    expect(
      logSpies.info.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.startsWith('Resolved Fn::ImportValue: exp-*** (from stack: exp-*** / us-east-1; '))
    ).toBe(true);
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::ImportValue 'exp-***' (producer exp-*** / us-east-1)"
    );
    expectNowhere(`exp-${PIN}`);
  });

  it('the index-hit arm: a producer stack named like the export prints through its twin', async () => {
    const exportIndex = {
      lookup: vi.fn(async () => ({
        value: '{{resolve:ssm:host}}',
        producerStack: `exp-${PIN}`,
        producerRegion: 'us-east-1',
      })),
      patchEntry: vi.fn(async () => undefined),
    } as unknown as ExportIndexStore;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      { 'Fn::ImportValue': sub('exp-${P}') },
      makeContext({ stateBackend: emptyBackend(), exportIndex }) as never
    );
    expect(value).toBe(PUBLIC_HOST);
    expect(
      logSpies.info.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.startsWith('Resolved Fn::ImportValue: exp-*** (from index: exp-*** / us-east-1; '))
    ).toBe(true);
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::ImportValue 'exp-***' (producer exp-*** / us-east-1)"
    );
    expectNowhere(`exp-${PIN}`);
  });

  it('the index-hit arm: a producer region equal to a name the pass assembled', async () => {
    const exportIndex = {
      lookup: vi.fn(async () => ({
        value: '{{resolve:ssm:host}}',
        producerStack: 'Producer',
        producerRegion: 'us-west-1',
      })),
      patchEntry: vi.fn(async () => undefined),
    } as unknown as ExportIndexStore;
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        { 'Fn::ImportValue': sub('us-west-${P}', 'one') },
        makeContext({ stateBackend: emptyBackend(), exportIndex }) as never
      )
      .catch(() => undefined);
    expect(
      logSpies.info.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.startsWith('Resolved Fn::ImportValue: us-west-*** (from index: Producer / us-west-***; '))
    ).toBe(true);
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::ImportValue 'us-west-***' (producer Producer / us-west-***)"
    );
    expectNowhere('us-west-1');
  });

  it('the state-scan arm: a producer region equal to a name the pass assembled', async () => {
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        { 'Fn::ImportValue': sub('us-west-${P}', 'one') },
        makeContext({
          stateBackend: backendWith('Producer', { 'us-west-1': '{{resolve:ssm:host}}' }, 'us-west-1'),
        }) as never
      )
      .catch(() => undefined);
    expect(
      logSpies.info.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.startsWith('Resolved Fn::ImportValue: us-west-*** (from stack: Producer / us-west-***; '))
    ).toBe(true);
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::ImportValue 'us-west-***' (producer Producer / us-west-***)"
    );
    expectNowhere('us-west-1');
  });

  it("the state-scan arm: a stack with no state, in a region equal to a name the pass assembled", async () => {
    const backend = {
      listStacks: vi.fn(async () => [{ stackName: 'Producer', region: 'us-west-1' }]),
      getState: vi.fn(async () => null),
    } as unknown as S3StateBackend;
    await messageOf({ 'Fn::ImportValue': sub('us-west-${P}', 'one') }, makeContext({ stateBackend: backend }));
    expect(everyLine()).toContain('No state found for stack: Producer (us-west-***)');
    expectNowhere('us-west-1');
  });

  it("the producer-region resolver line for an UPPERCASE state region equal to a string the pass assembled", async () => {
    // The raw region's twin is looked up before `canonicalizeRegion`
    // lowercases it; a lookup of the lowercased form finds nothing.
    const exportIndex = {
      lookup: vi.fn(async () => ({
        value: '{{resolve:ssm:host}}',
        producerStack: 'Producer',
        producerRegion: 'US-WEST-1',
      })),
      patchEntry: vi.fn(async () => undefined),
    } as unknown as ExportIndexStore;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext({ stateBackend: emptyBackend(), exportIndex });
    await resolver.resolve(sub('US-WEST-${P}', 'one'), context as never);
    await resolver.resolve({ 'Fn::ImportValue': 'exp' }, context as never).catch(() => undefined);
    expect(everyLine().filter((l) => l.startsWith('Using a producer-region resolver for '))).toEqual([
      'Using a producer-region resolver for us-west-***',
    ]);
  });

  it("the index-hit arm: a masked export's deferred refusal display", async () => {
    const reads: Array<{ display: string }> = [];
    const exportIndex = {
      lookup: vi.fn(async () => ({ value: '***', producerStack: 'Producer', producerRegion: 'us-east-1' })),
      patchEntry: vi.fn(async () => undefined),
    } as unknown as ExportIndexStore;
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        { 'Fn::ImportValue': sub('exp-${P}') },
        makeContext({ stateBackend: emptyBackend(), exportIndex, redactedAttributeReads: reads }) as never
      )
      .catch(() => undefined);
    expect(reads.map((r) => r.display)).toEqual(["Fn::ImportValue 'exp-***' (producer Producer / us-east-1)"]);
  });

  it("the state-scan arm: a masked export's deferred refusal display", async () => {
    const reads: Array<{ display: string }> = [];
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        { 'Fn::ImportValue': sub('exp-${P}') },
        makeContext({
          stateBackend: backendWith('Producer', { [`exp-${PIN}`]: '***' }),
          redactedAttributeReads: reads,
        }) as never
      )
      .catch(() => undefined);
    expect(reads.map((r) => r.display)).toEqual(["Fn::ImportValue 'exp-***' (producer Producer / us-east-1)"]);
  });

  it('the index-hit arm: its origin', async () => {
    const exportIndex = {
      lookup: vi.fn(async () => ({
        value: '{{resolve:ssm:host}}',
        producerStack: 'Producer',
        producerRegion: 'us-east-1',
      })),
      patchEntry: vi.fn(async () => undefined),
    } as unknown as ExportIndexStore;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      { 'Fn::ImportValue': sub('exp-${P}') },
      makeContext({ stateBackend: emptyBackend(), exportIndex }) as never
    );
    expect(value).toBe(PUBLIC_HOST);
    expect(everyLine()).toContain(
      "Re-resolving dynamic reference(s) in Fn::ImportValue 'exp-***' (producer Producer / us-east-1)"
    );
    expectNowhere(`exp-${PIN}`);
  });
});

describe('issue #3150: the CloudFormation-fallback export success line', () => {
  it('Fn::ImportValue', async () => {
    cfnBehaviour.mode = 'found';
    cfnBehaviour.exportName = `exp-${PIN}`;
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const value = await resolver.resolve(
      { 'Fn::ImportValue': sub('exp-${P}') },
      makeContext({ stateBackend: emptyBackend() }) as never
    );
    expect(value).toBe('v');
    expect(
      logSpies.info.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.startsWith('Resolved Fn::ImportValue: exp-*** '))
    ).toBe(true);
    expectNowhere(`exp-${PIN}`);
  });
});

describe('issue #3150: names parsed out of an assembled dynamic reference', () => {
  it('a JSON key an inner Fn::Sub built', async () => {
    const message = await messageOf(
      {
        'Fn::Sub': [
          `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${K}}}`,
          { K: sub('pw-${P}') },
        ],
      },
      makeContext()
    );
    expect(message).toBe(`Dynamic reference: key 'pw-***' not found in secret '${SECRET_ID}'`);
    expectNowhere(`pw-${PIN}`, message);
  });

  it('a secret id an inner Fn::Sub built: the lookup debug line', async () => {
    const outcome = await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        {
          'Fn::Sub': ['{{resolve:secretsmanager:\${K}:SecretString:pin}}', { K: sub('sec-${P}') }],
        },
        makeContext() as never
      )
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
    expect(outcome, 'the lookup of an unknown secret must fail').toBeDefined();
    const lookups = everyLine().filter((l) => l.startsWith('Resolving dynamic reference: secretsmanager:'));
    expect(lookups.some((l) => l.includes('secretsmanager:sec-***:SecretString:pin')), JSON.stringify(lookups)).toBe(true);
    expectNowhere(`sec-${PIN}`, String(outcome));
  });

  it('CONTROL: a JSON key an inner Fn::Sub built from an unrecorded value prints verbatim', async () => {
    const message = await messageOf(
      {
        'Fn::Sub': [
          `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${K}}}`,
          { K: plain('pw-${P}') },
        ],
      },
      makeContext()
    );
    expect(message).toBe(`Dynamic reference: key 'pw-${UNRECORDED}' not found in secret '${SECRET_ID}'`);
  });

  it('an SSM parameter name an inner Fn::Sub built', async () => {
    const message = await messageOf(
      { 'Fn::Sub': ['{{resolve:ssm:\${K}}}', { K: sub('param-${P}') }] },
      makeContext()
    );
    expect(message).toBe("Dynamic reference: SSM parameter 'param-***' not found or has no value");
    expectNowhere(`param-${PIN}`, message);
  });

  it('a version stage and version id inner Fn::Subs built', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      {
        'Fn::Sub': [
          `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin:\${S}:\${V}}}`,
          { S: sub('stage-${P}'), V: sub('version-${P}') },
        ],
      },
      makeContext() as never
    );
    expect(everyLine()).toContain(
      `Resolving dynamic reference: secretsmanager:${SECRET_ID}:SecretString:pin:stage-***:version-***`
    );
    expectNowhere(`stage-${PIN}`);
    expectNowhere(`version-${PIN}`);
  });

  it('CONTROL: a version stage and version id substituted from unrecorded values print verbatim', async () => {
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        {
          'Fn::Sub': [
            `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin:\${S}:\${V}}}`,
            { S: plain('stage-${P}'), V: plain('version-${P}') },
          ],
        },
        makeContext() as never
      )
      .catch(() => undefined);
    expect(everyLine()).toContain(
      `Resolving dynamic reference: secretsmanager:${SECRET_ID}:SecretString:pin:stage-${UNRECORDED}:version-${UNRECORDED}`
    );
  });
});

describe('issue #3150: names assembled inside the SAME Fn::Sub as their dynamic reference', () => {
  /** One `Fn::Sub` whose body is the reference, with the secret at `${P}`. */
  const inline = (template: string, jsonKey = 'pin'): unknown => ({
    'Fn::Sub': [template, { P: ref(jsonKey) }],
  });

  it('a secret id: the lookup debug line', async () => {
    const outcome = await new IntrinsicFunctionResolver('us-east-1')
      .resolve(inline('{{resolve:secretsmanager:sec-${P}:SecretString:pin}}'), makeContext() as never)
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
    expect(outcome, 'the lookup of an unknown secret must fail').toBeDefined();
    expect(everyLine()).toContain(
      'Resolving dynamic reference: secretsmanager:sec-***:SecretString:pin:AWSCURRENT:'
    );
    expectNowhere(`sec-${PIN}`, String(outcome));
  });

  it('CONTROL: a secret id assembled from an unrecorded value prints verbatim', async () => {
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        { 'Fn::Sub': ['{{resolve:secretsmanager:sec-${P}:SecretString:pin}}', { P: UNRECORDED }] },
        makeContext() as never
      )
      .catch(() => undefined);
    expect(everyLine()).toContain(
      `Resolving dynamic reference: secretsmanager:sec-${UNRECORDED}:SecretString:pin:AWSCURRENT:`
    );
  });

  it('CONTROL: an SSM parameter name assembled from an unrecorded value prints verbatim', async () => {
    const message = await messageOf(
      { 'Fn::Sub': ['{{resolve:ssm:param-${P}}}', { P: UNRECORDED }] },
      makeContext()
    );
    expect(message).toBe(`Dynamic reference: SSM parameter 'param-${UNRECORDED}' not found or has no value`);
    expect(everyLine()).toContain(`Resolving dynamic reference: ssm:param-${UNRECORDED}`);
  });

  it('the region-scoped clients refusal of an invalid secret ARN region prints the region masked', async () => {
    // No `isClientSafeRegion` gate sits in front of the `named-region` arm, so
    // the guest built for `us-west-2_q7` reaches `clientsForRegion`'s backstop.
    const message = await messageOf(
      inline('{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2_${P}:210987654321:secret:x:SecretString:k}}'),
      makeContext()
    );
    expect(message).toBe(
      "Refusing to build AWS clients for the region 'us-west-2_***': it is not a valid AWS " +
        'region name, and a region is substituted into the AWS service hostname.'
    );
    expectNowhere(`us-west-2_${PIN}`, message);
  });

  it('CONTROL: the region-scoped clients refusal of an unrecorded invalid region prints it verbatim', async () => {
    const message = await messageOf(
      {
        'Fn::Sub': [
          '{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2_${P}:210987654321:secret:x:SecretString:k}}',
          { P: UNRECORDED },
        ],
      },
      makeContext()
    );
    expect(message).toBe(
      `Refusing to build AWS clients for the region 'us-west-2_${UNRECORDED}': it is not a valid AWS ` +
        'region name, and a region is substituted into the AWS service hostname.'
    );
  });

  it("CONTROL: the region-scoped clients refusal prints an ordinary resolver's own invalid region verbatim", async () => {
    // No guest and no caller text: the region the command built the resolver with.
    const message = await messageOf(
      `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin}}`,
      makeContext(),
      new IntrinsicFunctionResolver(`us-west-2_${UNRECORDED}`)
    );
    expect(message).toBe(
      `Refusing to build AWS clients for the region 'us-west-2_${UNRECORDED}': it is not a valid AWS ` +
        'region name, and a region is substituted into the AWS service hostname.'
    );
  });

  it('the region-scoped clients refusal masks a recorded secret the control-character strip rejoins', async () => {
    // `s` + U+0001 + `t-1` holds no recorded needle until the refusal strips
    // the control character, and `st-1` is recorded: the guest's region text is
    // masked, stripped and masked again.
    const { maskSecretsInText } = await import('../../../src/deployment/secret-redaction.js');
    const { stripControlChars } = await import('../../../src/utils/regexp.js');
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('stone'), context as never);
    const region = `us-west-2_s${String.fromCharCode(1)}t-1`;
    expect(maskSecretsInText(region, context.recordedSecretValues), 'premise: the raw region holds no needle').toBe(region);
    expect(
      maskSecretsInText(stripControlChars(region), context.recordedSecretValues),
      'premise: the stripped region does'
    ).toBe('us-west-2_***');
    const message = await messageOf(
      `{{resolve:secretsmanager:arn:aws:secretsmanager:${region}:210987654321:secret:x:SecretString:k}}`,
      context,
      resolver
    );
    expect(message).toBe(
      "Refusing to build AWS clients for the region 'us-west-2_***': it is not a valid AWS " +
        'region name, and a region is substituted into the AWS service hostname.'
    );
    expect(
      everyLine().filter((l) => l.startsWith('Using a producer-region resolver for ')),
      'the creation line masks the same text'
    ).toEqual(['Using a producer-region resolver for us-west-2_***']);
  });

  it('the region-scoped clients refusal masks a recorded secret holding a control character before the strip', async () => {
    // The mirror case: `x` + U+0001 + `y7` is recorded whole, so only the mask
    // taken BEFORE the strip sees it; stripping first would print `xy7`.
    const { maskSecretsInText } = await import('../../../src/deployment/secret-redaction.js');
    const { stripControlChars } = await import('../../../src/utils/regexp.js');
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('ctl'), context as never);
    const region = `us-west-2_x${String.fromCharCode(1)}y7`;
    expect(maskSecretsInText(region, context.recordedSecretValues), 'premise: the raw region holds a needle').toBe(
      'us-west-2_***'
    );
    expect(
      maskSecretsInText(stripControlChars(region), context.recordedSecretValues),
      'premise: the stripped region does not'
    ).toBe('us-west-2_xy7');
    const message = await messageOf(
      `{{resolve:secretsmanager:arn:aws:secretsmanager:${region}:210987654321:secret:x:SecretString:k}}`,
      context,
      resolver
    );
    expect(message).toBe(
      "Refusing to build AWS clients for the region 'us-west-2_***': it is not a valid AWS " +
        'region name, and a region is substituted into the AWS service hostname.'
    );
    expect(
      everyLine().filter((l) => l.startsWith('Using a producer-region resolver for ')),
      'the creation line masks the same text'
    ).toEqual(['Using a producer-region resolver for us-west-2_***']);
  });

  it('both lookup helpers REQUIRE the name mapping (a compile-time pin, checked by typecheck:test)', () => {
    // Never called: the pin is the two `@ts-expect-error` lines, which fail
    // `vp run typecheck:test` as unused should either parameter regain a
    // default that prints the names raw.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const omitted = (): void => {
      // @ts-expect-error -- `nameLogText` is required
      void resolver['resolveSecretsManagerReference'](`secretsmanager:${SECRET_ID}:SecretString:pin`, undefined);
      // @ts-expect-error -- `nameLogText` is required
      void resolver['resolveSSMReference'](['ssm', 'host'], true, 'ssm', undefined);
    };
    expect(typeof omitted).toBe('function');
  });

  it('a producer-region resolver reused for the same spelling of its region keeps its masked text', async () => {
    // The same literal region twice, splitting the recorded `st-1` with U+0001:
    // the cache hit masks, strips and masks this call's text before comparing,
    // so it agrees with the stored text and the second refusal is unchanged.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('stone'), context as never);
    const token = `{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2_s${String.fromCharCode(1)}t-1:210987654321:secret:x:SecretString:k}}`;
    const expected =
      "Refusing to build AWS clients for the region 'us-west-2_***': it is not a valid AWS " +
      'region name, and a region is substituted into the AWS service hostname.';
    expect(await messageOf(token, context, resolver), 'premise: the first refusal').toBe(expected);
    expect(await messageOf(token, context, resolver)).toBe(expected);
  });

  it('a producer-region resolver reused for a second spelling of its region prints *** once the spellings mask differently', async () => {
    // A literal region spelled as the template writes it creates the guest;
    // an Fn::Sub assembling the same region around a recorded secret reuses it.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    const literal = await messageOf(
      `{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2_${PIN}:210987654321:secret:x:SecretString:k}}`,
      context,
      resolver
    );
    expect(literal, 'premise: the literal region prints as the template spells it').toBe(
      `Refusing to build AWS clients for the region 'us-west-2_${PIN}': it is not a valid AWS ` +
        'region name, and a region is substituted into the AWS service hostname.'
    );
    const assembled = await messageOf(
      inline('{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2_${P}:210987654321:secret:x:SecretString:k}}'),
      context,
      resolver
    );
    expect(assembled).toBe(
      "Refusing to build AWS clients for the region '***': it is not a valid AWS " +
        'region name, and a region is substituted into the AWS service hostname.'
    );
  });

  it('a synthesized version stage the token spells as part of a longer name prints as ***', async () => {
    // `AWSCURRENT` is the default for the empty stage, so it is not a run of
    // the token; the token still spells it inside `x-AWSCURRENT-q7`, so the
    // name fails closed. The empty version id beside it still prints empty.
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(inline('{{resolve:secretsmanager:x-AWSCURRENT-${P}:SecretString:pin}}'), makeContext() as never)
      .catch(() => undefined);
    expect(everyLine()).toContain(
      'Resolving dynamic reference: secretsmanager:x-AWSCURRENT-***:SecretString:pin:***:'
    );
  });

  it('a parsed name leaves what Fn::Base64 persists for an equal literal unchanged', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await messageOf(inline('{{resolve:ssm:param-${P}}}'), context, resolver);
    expect(everyLine(), 'premise: the name was printed masked').toContain('Resolving dynamic reference: ssm:param-***');
    await resolver.resolve({ 'Fn::Base64': `param-${PIN}` }, context as never);
    expect(context.recordedSecretValues.has(Buffer.from(`param-${PIN}`).toString('base64'))).toBe(false);
    // CONTROL: once an Fn::Sub WRITES that exact string, the detector records it.
    await resolver.resolve(sub('param-${P}'), context as never);
    await resolver.resolve({ 'Fn::Base64': `param-${PIN}` }, context as never);
    expect(context.recordedSecretValues.has(Buffer.from(`param-${PIN}`).toString('base64'))).toBe(true);
  });

  it('a token delegated to a region-pinned sibling: its names stay masked, and Fn::Base64 records nothing new', async () => {
    // The sibling prints the parameter name through the parent's pairing, while
    // the twin it registers for its public result stays the result itself. The
    // `prefix:` keeps the outer Fn::Sub's own product (`prefix:pb`) apart from
    // the sibling's (`pb`), so only a sibling registration can reach `pb`.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    const value = await resolver.resolve(
      inline('prefix:{{resolve:ssm:arn:aws:ssm:us-west-2:210987654321:parameter/pub-${P}}}'),
      context as never
    );
    expect(value).toBe(`prefix:${PUBLIC_HOST}`);
    expect(everyLine()).toContain(
      'Resolving dynamic reference: ssm:arn:aws:ssm:us-west-2:210987654321:parameter/pub-***'
    );
    expectNowhere(`pub-${PIN}`);
    await resolver.resolve({ 'Fn::Base64': PUBLIC_HOST }, context as never);
    expect(context.recordedSecretValues.has(Buffer.from(PUBLIC_HOST).toString('base64'))).toBe(false);
    // CONTROL: the outer Fn::Sub's own product IS registered, so the detector is live.
    await resolver.resolve({ 'Fn::Base64': `prefix:${PUBLIC_HOST}` }, context as never);
    expect(context.recordedSecretValues.has(Buffer.from(`prefix:${PUBLIC_HOST}`).toString('base64'))).toBe(true);
  });

  it("a region-pinned sibling's ssm-secure refusal prints the parent's token twin", async () => {
    const message = await messageOf(
      inline('{{resolve:ssm-secure:arn:aws:ssm:us-west-2:210987654321:parameter/pub-${P}}}'),
      makeContext()
    );
    expect(message).toMatch(
      /^Refusing to resolve \{\{resolve:ssm-secure:arn:aws:ssm:us-west-2:210987654321:parameter\/pub-\*\*\*\}\}: the parameter is a String parameter/
    );
    expectNowhere(`pub-${PIN}`, message);
  });

  it('a name spelled by two runs with the SAME twin keeps that partial mask', async () => {
    // Pairs with the case below: only DIFFERENT twins give up the partial mask.
    const outcome = await new IntrinsicFunctionResolver('us-east-1')
      .resolve(inline('{{resolve:secretsmanager:x-${P}:SecretString:x-${P}}}'), makeContext() as never)
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
    expect(outcome, 'the lookup of an unknown secret must fail').toBeDefined();
    expect(everyLine()).toContain('Resolving dynamic reference: secretsmanager:x-***:SecretString:x-***:AWSCURRENT:');
  });

  it('two tokens, one lost from the twin: neither is paired with the other token\'s twin', async () => {
    // `{{` + `resolve:...` forms a token the twin (`***resolve:...`) does not
    // hold, so the twin has one token for the value's two. Pairing them by
    // position anyway would print the first name through the second's twin.
    await new IntrinsicFunctionResolver('us-east-1').resolve(
      {
        'Fn::Sub': [
          '${B}resolve:ssm:pub-a-${P}}} {{resolve:ssm:pub-b-${Q}}}',
          { B: ref('br'), P: ref('pin'), Q: ref('pin') },
        ],
      },
      makeContext() as never
    );
    expect(everyLine().filter((l) => l.startsWith('Resolving dynamic reference: ssm:'))).toEqual([
      'Resolving dynamic reference: ssm:***',
      'Resolving dynamic reference: ssm:***',
    ]);
    expectNowhere(`pub-a-${PIN}`);
    expectNowhere(`pub-b-${PIN}`);
  });

  it('a token lost from the twin: the ssm-secure refusal prints the whole token as ***', async () => {
    // `{{` + `resolve:...`: the twin holds no token to pair, so the refusal's
    // own token text falls back to `***` rather than to the raw token.
    const message = await messageOf(
      {
        'Fn::Sub': ['${B}resolve:ssm-secure:pub-${P}}}', { B: ref('br'), P: ref('pin') }],
      },
      makeContext()
    );
    expect(message).toMatch(/^Refusing to resolve \*\*\*: the parameter is a String parameter/);
    expectNowhere(`pub-${PIN}`, message);
  });

  it('a parsed name whose raw text holds a 4+ character recorded secret straddling the mask prints as ***', async () => {
    // The twin run `id-***ab` splits the recorded `q7ab`, so only the RAW name's
    // needle mask sees it: printing the run as it is would show `ab`.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('pinab'), context as never);
    expect(context.recordedSecretValues.has(`${PIN}ab`), 'premise: q7ab is recorded').toBe(true);
    await resolver
      .resolve(inline('{{resolve:secretsmanager:id-${P}ab:SecretString:k}}'), context as never)
      .catch(() => undefined);
    expect(everyLine()).toContain('Resolving dynamic reference: secretsmanager:***:SecretString:k:AWSCURRENT:');
    expectNowhere('***ab');
  });

  it('a refusal whose token holds a 4+ character recorded secret straddling the mask prints the token as ***', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('pinab'), context as never);
    const message = await messageOf(inline('{{resolve:ssm-secure:pub-${P}ab}}'), context, resolver);
    expect(message).toMatch(/^Refusing to resolve \*\*\*: the parameter is a String parameter/);
    expect(message).not.toContain('***ab');
  });

  it("a region-pinned sibling's refusal: a 4+ character secret straddling the mask prints the token as ***", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('pinab'), context as never);
    const message = await messageOf(
      inline('{{resolve:ssm-secure:arn:aws:ssm:us-west-2:210987654321:parameter/pub-${P}ab}}'),
      context,
      resolver
    );
    expect(message).toMatch(/^Refusing to resolve \*\*\*: the parameter is a String parameter/);
    expect(message).not.toContain('***ab');
  });

  it('a literal token naming a 4+ character recorded secret with no mask of its own keeps the needle mask', async () => {
    // No write positioned anything in this token, so its twin IS the token and
    // the needle mask alone decides, as before issue #3150: `/probe/***`, not `***`.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();
    await resolver.resolve(ref('pinab'), context as never);
    await resolver
      .resolve(`{{resolve:ssm:/probe/${PIN}ab}}`, context as never)
      .catch(() => undefined);
    expect(everyLine()).toContain('Resolving dynamic reference: ssm:/probe/***');
  });

  it('a name spelled by two runs of the token with different twins prints as ***', async () => {
    // `x-q7` is the secret id (a run whose twin is `x-***`) and, literally, the
    // JSON key (a run whose twin is itself).
    const outcome = await new IntrinsicFunctionResolver('us-east-1')
      .resolve(inline('{{resolve:secretsmanager:x-${P}:SecretString:x-q7}}'), makeContext() as never)
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
    expect(outcome, 'the lookup of an unknown secret must fail').toBeDefined();
    expect(everyLine()).toContain('Resolving dynamic reference: secretsmanager:***:SecretString:***:AWSCURRENT:');
  });

  it('an SSM parameter name', async () => {
    const message = await messageOf(inline('{{resolve:ssm:param-${P}}}'), makeContext());
    expect(message).toBe("Dynamic reference: SSM parameter 'param-***' not found or has no value");
    expect(everyLine()).toContain('Resolving dynamic reference: ssm:param-***');
    expectNowhere(`param-${PIN}`, message);
  });

  it('an unsupported service name', async () => {
    await new IntrinsicFunctionResolver('us-east-1').resolve(
      inline('{{resolve:svc-${P}:x}}'),
      makeContext() as never
    );
    expect(logSpies.warn.mock.calls.map((c) => String(c[0]))).toContain(
      'Unsupported dynamic reference service: svc-***'
    );
    expectNowhere(`svc-${PIN}`);
  });

  it('the ssm-secure refusal of a public parameter', async () => {
    const message = await messageOf(inline('{{resolve:ssm-secure:pub-${P}}}'), makeContext());
    expect(message).toBe(
      'Refusing to resolve {{resolve:ssm-secure:pub-***}}: the parameter is a String parameter, ' +
        'and the ssm-secure spelling is defined for SecureString parameters only. ' +
        'Reference it as {{resolve:ssm:...}} if it is public configuration.'
    );
    expectNowhere(`pub-${PIN}`, message);
  });

  it('the ambiguous-region refusal names the token and the secret name', async () => {
    const message = await messageOf(
      {
        'Fn::Sub': [
          '{{resolve:secretsmanager:sec-${P}:SecretString:pin}}',
          { P: `{{resolve:secretsmanager:${SECRET_ARN}:SecretString:pin}}` },
        ],
      },
      makeContext({ producerRegions: ['us-west-2'] })
    );
    expect(message).toMatch(
      /^Refusing to resolve the secret reference \{\{resolve:secretsmanager:sec-\*\*\*:SecretString:pin\}\}: it names 'sec-\*\*\*' without a region/
    );
    expectNowhere(`sec-${PIN}`, message);
  });

  it('the producer-region resolver line for a secret ARN whose region was assembled', async () => {
    // `classifyReplaySecretRegion` hands back the ARN's region as written, so
    // the line lowercases the RAW region's twin.
    await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        inline(
          `{{resolve:secretsmanager:arn:aws:secretsmanager:US-WEST-\${P}:210987654321:secret:${SECRET_ID}:SecretString:pin}}`,
          'one'
        ),
        makeContext() as never
      )
      .catch(() => undefined);
    expect(everyLine().filter((l) => l.startsWith('Using a producer-region resolver for '))).toEqual([
      'Using a producer-region resolver for us-west-***',
    ]);
  });

  it('a mask covering a brace leaves no token to pair, so every parsed name prints as ***', async () => {
    // `{{` + `resolve:...`: the twin reads `***resolve:...`, which holds no
    // token at all.
    const outcome = await new IntrinsicFunctionResolver('us-east-1')
      .resolve(
        {
          'Fn::Sub': [
            '${B}resolve:secretsmanager:sec-${P}:SecretString:pin}}',
            { B: ref('br'), P: ref('pin') },
          ],
        },
        makeContext() as never
      )
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
    expect(outcome, 'the lookup of an unknown secret must fail').toBeDefined();
    expect(everyLine()).toContain('Resolving dynamic reference: secretsmanager:***:SecretString:***:***:***');
    expectNowhere(`sec-${PIN}`, String(outcome));
  });

  it('a secret carrying a ":" prints every parsed name as ***', async () => {
    // `q:7` splits the reference at a colon the twin does not have, so no
    // name can be paired with its twin piece by piece.
    const outcome = await new IntrinsicFunctionResolver('us-east-1')
      .resolve(inline('{{resolve:secretsmanager:sec-${P}:SecretString:pin}}', 'col'), makeContext() as never)
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
    expect(outcome, 'the lookup of an unknown secret must fail').toBeDefined();
    expect(everyLine()).toContain('Resolving dynamic reference: secretsmanager:***:SecretString:***:***:***');
    expectNowhere('sec-q', String(outcome));
  });

  it("the ambiguous-region refusal's producer regions, equal to a string the pass assembled", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    // Two regions: the joined list equals no registered string, so each region
    // must be masked on its own.
    const context = makeContext({ producerRegions: ['us-west-1', 'eu-west-2'] });
    await resolver.resolve(
      { 'Fn::Sub': ['us-west-${P}', { P: `{{resolve:secretsmanager:${SECRET_ARN}:SecretString:one}}` }] },
      context as never
    );
    const message = await messageOf(
      `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin}}`,
      context,
      resolver
    );
    expect(message).toContain('this stack reads from us-west-***, eu-west-2 as well as its own region');
    expect(message).not.toContain('us-west-1');
  });

  describe('a secret carrying a ":" (the pieces cannot be paired)', () => {
    it('a secret ARN whose region was assembled too: the producer-region line prints ***', async () => {
      await new IntrinsicFunctionResolver('us-east-1')
        .resolve(
          {
            'Fn::Sub': [
              '{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-${P}:210987654321:secret:sec-${C}:SecretString:pin}}',
              { P: ref('one'), C: ref('col') },
            ],
          },
          makeContext() as never
        )
        .catch(() => undefined);
      expect(everyLine().filter((l) => l.startsWith('Using a producer-region resolver for '))).toEqual([
        'Using a producer-region resolver for ***',
      ]);
    });

    it('a secret ARN in another region: the sibling resolver keeps every name masked', async () => {
      await new IntrinsicFunctionResolver('us-east-1')
        .resolve(
          inline(
            '{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:210987654321:secret:sec-${P}:SecretString:pin}}',
            'col'
          ),
          makeContext() as never
        )
        .catch(() => undefined);
      expect(everyLine()).toContain('Resolving dynamic reference: secretsmanager:***:SecretString:***:***:***');
      expectNowhere('sec-q');
    });

    it('an SSM parameter name', async () => {
      const message = await messageOf(inline('{{resolve:ssm:param-${P}}}', 'col'), makeContext());
      expect(message).toBe("Dynamic reference: SSM parameter '***' not found or has no value");
      expect(everyLine()).toContain('Resolving dynamic reference: ssm:***');
      expectNowhere('param-q', message);
    });

    it('CONTROL: an unrecorded value carrying a ":" prints the parameter name verbatim', async () => {
      const message = await messageOf(
        { 'Fn::Sub': ['{{resolve:ssm:param-${P}}}', { P: 'k:9' }] },
        makeContext()
      );
      expect(message).toBe("Dynamic reference: SSM parameter 'param-k:9' not found or has no value");
      expect(everyLine()).toContain('Resolving dynamic reference: ssm:param-k:9');
    });

    it('an ssm-secure parameter name: the lookup line and the refusal', async () => {
      const message = await messageOf(inline('{{resolve:ssm-secure:pub-${P}}}', 'col'), makeContext());
      expect(message).toMatch(
        /^Refusing to resolve \{\{resolve:ssm-secure:pub-\*\*\*\}\}: the parameter is a String parameter/
      );
      expect(everyLine()).toContain('Resolving dynamic reference: ssm-secure:***');
      expectNowhere('pub-q', message);
    });

    it('an unsupported service name', async () => {
      await new IntrinsicFunctionResolver('us-east-1').resolve(
        inline('{{resolve:svc-${P}:x}}', 'col'),
        makeContext() as never
      );
      expect(logSpies.warn.mock.calls.map((c) => String(c[0]))).toContain(
        'Unsupported dynamic reference service: ***'
      );
      expectNowhere('svc-q');
    });

    it('the ambiguous-region refusal', async () => {
      const message = await messageOf(
        {
          'Fn::Sub': [
            '{{resolve:secretsmanager:sec-${P}:SecretString:pin}}',
            { P: `{{resolve:secretsmanager:${SECRET_ARN}:SecretString:col}}` },
          ],
        },
        makeContext({ producerRegions: ['us-west-2'] })
      );
      expect(message).toMatch(
        /^Refusing to resolve the secret reference \{\{resolve:secretsmanager:sec-\*\*\*:SecretString:pin\}\}: it names '\*\*\*' without a region/
      );
      expectNowhere('sec-q', message);
    });
  });
});

/**
 * Issue [#3234](https://github.com/go-to-k/cdkd/issues/3234): `resolveGetStackOutput`
 * masks every name it prints ITSELF, then hands the RAW `StackName` and
 * `Region` to the state read — they are state-KEY segments, so they have to be
 * raw — and `S3StateBackend` quotes them back through `displaySafe`, an ASCII
 * sanitizer rather than a masker. The read was uncaught, so that sentence
 * reached `evaluateConditions`' warn and every other caller with a sub-floor
 * secret in the clear.
 *
 * Two halves are pinned here, and the SECOND is the one the issue's own
 * proposed remedy ("keep the cause unmasked so the retry classifiers still see
 * `$metadata`") would have left open: `formatError` renders
 * `Caused by: <cause>`, so masking only a fresh top-level message prints the
 * original one link down. The fix therefore re-throws a masked CLONE of the
 * whole chain rather than a new wrapper — which is also what keeps the
 * classifiers working, since the clone carries every own descriptor.
 */
describe('issue #3234: the Fn::GetStackOutput state read', () => {
  /**
   * The sink's character class, TRANSCRIBED from `sanitizeAsciiOnly` in
   * `src/utils/display-safe.ts` rather than imported: an expected value must
   * stay an INDEPENDENT variable from the one under test, or the property
   * asserts only that the subject agrees with itself.
   *
   * ONE constant, used by the fake sink, by THE INVARIANT and by the PAIR
   * FENCE below. Three separate literals is what the fence was written to stop
   * and then reintroduced: the fence pairs whatever class IT holds, so a copy
   * it does not read can be narrowed back — which is exactly PR
   * go-to-k/cdkd#3275's round-4 defect — while the fence stays green.
   */
  const SINK_CLASS = /[^ -~]/;
  /** What the sink replaces a rejected character WITH, and the trim it ends in. */
  const SINK_REPLACEMENT = ' ';
  /**
   * `SINK_CLASS` with its POSITIONAL flags stripped. No reader in this block
   * wants a POSITION: two ask "does this text contain a rejected character"
   * and the fake sink replaces EVERY one (re-appending its own `g`). `g` and
   * `y` are part of neither question, while both silently change the answer:
   *
   *   - `g` makes `.test` advance `lastIndex`, so over single-character probes
   *     it reports every OTHER rejected character as ACCEPTED (measured:
   *     `true false true false`).
   *   - `y` anchors at `lastIndex`, so `String.match` -- which is what
   *     `expect().not.toMatch` calls -- returns `null` for any message whose
   *     rejected character is not at index 0. THE INVARIANT then passes for
   *     every message, and the fake sink sanitizes nothing (measured).
   *
   * Both fail in the safe-looking direction, and nothing requires `SINK_CLASS`
   * to stay bare -- so no reader here may assume it is.
   */
  const SINK_CLASS_FLAGS = SINK_CLASS.flags.replace(/[gy]/g, '');
  const SINK_CLASS_ANYWHERE = new RegExp(SINK_CLASS.source, SINK_CLASS_FLAGS);
  /** `SINK_CLASS.test`, made position-independent. */
  const rejects = (ch: string): boolean => SINK_CLASS_ANYWHERE.test(ch);

  /** The realistic failure: cdkd's own wrapper over an AWS rejection, both quoting the key. */
  function rejectingBackend(stackName: string, region = 'us-east-1'): S3StateBackend {
    return {
      listStacks: vi.fn(async () => []),
      getState: vi.fn(async () => {
        const aws = new Error(
          `Access Denied: s3:GetObject on cdkd/${stackName}/${region}/state.json`
        );
        (aws as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 403 };
        (aws as unknown as { Code: string }).Code = 'AccessDenied';
        const wrapped = new StateError(
          `Failed to get state for stack '${stackName}' (${region}): ${aws.message}`,
          aws
        );
        throw wrapped;
      }),
    } as unknown as S3StateBackend;
  }

  /** The same shape, but the AWS link is a THROTTLE the classifiers must still see. */
  function throttlingBackend(stackName: string, region = 'us-east-1'): S3StateBackend {
    return {
      listStacks: vi.fn(async () => []),
      getState: vi.fn(async () => {
        const aws = new Error(`Rate exceeded reading cdkd/${stackName}/${region}/state.json`);
        aws.name = 'ThrottlingException';
        throw new StateError(
          `Failed to get state for stack '${stackName}' (${region}): ${aws.message}`,
          aws
        );
      }),
    } as unknown as S3StateBackend;
  }

  /**
   * What PRODUCTION prints: `S3StateBackend` puts both names through
   * `displaySafe(..., { asciiOnly: true })` before quoting them, so a secret
   * carrying a non-printable character is a DIFFERENT string in the message
   * than the one the resolver resolved.
   */
  function sanitizingBackend(stackName: string, region = 'us-east-1'): S3StateBackend {
    // `SINK_CLASS.flags`, not just its source: copying the pattern alone would
    // silently drop a `u` or `i` added later, leaving this reader on the old
    // semantics while the other two took the new one -- the copies-diverge
    // defect this constant exists to close, one level down. DEFENSIVE and
    // recorded as such: adding `u` to `SINK_CLASS` leaves this suite green
    // either way (measured), so no case here distinguishes it.
    //
    // The POSITIONAL flags are stripped first (`SINK_CLASS_FLAGS`, whose doc
    // carries the two measurements): `new RegExp(re, 'gg')` throws
    // `SyntaxError: Invalid flags supplied`, and a `y` would make this sink
    // replace only a rejected character sitting at index 0 -- so it would
    // sanitize nothing for the realistic message and the case would still read
    // as exercising the sink.
    const shown = (t: string): string =>
      t.replace(new RegExp(SINK_CLASS.source, `${SINK_CLASS_FLAGS}g`), SINK_REPLACEMENT).trim();
    return {
      listStacks: vi.fn(async () => []),
      getState: vi.fn(async () => {
        throw new StateError(
          `Failed to get state for stack '${shown(stackName)}' (${shown(region)}): Access Denied`
        );
      }),
    } as unknown as S3StateBackend;
  }

  /** The thrown value itself, so the CAUSE chain can be read. */
  async function errorOf(value: unknown, context: Ctx): Promise<Error> {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const outcome = await resolver
      .resolve(value, context as never)
      .then((resolved) => ({ resolvedInstead: JSON.stringify(resolved) }), (reason: unknown) => reason);
    if (outcome && typeof outcome === 'object' && 'resolvedInstead' in outcome) {
      throw new Error(`the site must throw; it resolved to ${String(outcome.resolvedInstead)}`);
    }
    expect(outcome).toBeInstanceOf(Error);
    return outcome as Error;
  }

  /** Every message in the chain, top link first — what `formatError` can reach. */
  function chainMessages(error: Error): string[] {
    const out: string[] = [];
    let link: unknown = error;
    const seen = new Set<unknown>();
    while (link instanceof Error && !seen.has(link)) {
      seen.add(link);
      out.push(link.message);
      link = (link as { cause?: unknown }).cause;
    }
    return out;
  }

  const producer = (name: unknown, region: unknown = 'us-east-1'): unknown => ({
    'Fn::GetStackOutput': { StackName: name, OutputName: 'Out', Region: region },
  });

  it('the thrown message masks a sub-floor secret assembled into the stack name', async () => {
    const error = await errorOf(
      producer(sub('prod-${P}')),
      makeContext({ stateBackend: rejectingBackend(`prod-${PIN}`) })
    );
    expect(error.message).toBe(
      "Failed to get state for stack 'prod-***' (us-east-1): " +
        'Access Denied: s3:GetObject on cdkd/prod-***/us-east-1/state.json'
    );
    expectNowhere(`prod-${PIN}`, error.message);
  });

  it('the CAUSE chain is masked too, which a fresh top-level wrapper would not have been', async () => {
    const error = await errorOf(
      producer(sub('prod-${P}')),
      makeContext({ stateBackend: rejectingBackend(`prod-${PIN}`) })
    );
    const messages = chainMessages(error);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(
      'Access Denied: s3:GetObject on cdkd/prod-***/us-east-1/state.json'
    );
    expectNowhere(`prod-${PIN}`, ...messages);
  });

  it('the STACK text is masked as well, since its first line embeds the message', async () => {
    const error = await errorOf(
      producer(sub('prod-${P}')),
      makeContext({ stateBackend: rejectingBackend(`prod-${PIN}`) })
    );
    expect(typeof error.stack).toBe('string');
    expect(error.stack).not.toContain(`prod-${PIN}`);
    expect(error.stack).toContain('prod-***');
  });

  it('CONTROL: an unrecorded name in the same shape prints verbatim', async () => {
    const error = await errorOf(
      producer(plain('prod-${P}')),
      makeContext({ stateBackend: rejectingBackend(`prod-${UNRECORDED}`) })
    );
    expect(error.message).toContain(`prod-${UNRECORDED}`);
    expect(error.message).not.toContain('***');
  });

  it('the REGION is masked by the same substitution', async () => {
    const error = await errorOf(
      producer('Producer', sub('us-west-${P}')),
      makeContext({ stateBackend: rejectingBackend('Producer', `us-west-${PIN}`) })
    );
    expect(error.message).toBe(
      "Failed to get state for stack 'Producer' (us-west-***): " +
        'Access Denied: s3:GetObject on cdkd/Producer/us-west-***/state.json'
    );
    expectNowhere(`us-west-${PIN}`, error.message);
  });

  it('the clone keeps the descriptors the retry classifiers read', async () => {
    const error = await errorOf(
      producer(sub('prod-${P}')),
      makeContext({ stateBackend: rejectingBackend(`prod-${PIN}`) })
    );
    expect(error).toBeInstanceOf(StateError);
    expect(error.name).toBe('StateError');
    const cause = (error as { cause?: unknown }).cause as Record<string, unknown>;
    expect(cause['$metadata']).toEqual({ httpStatusCode: 403 });
    expect(cause['Code']).toBe('AccessDenied');
  });

  it('a THROTTLE down the chain still classifies as one through the clone', async () => {
    // The positive half, and the one that discriminates: `isThrottlingError`
    // answers `false` for an error carrying no `$metadata` and no name too, so
    // asserting `false` above would pass just as well if the clone had dropped
    // every descriptor. This asserts `true`, which only survives if the walk
    // still reaches the cause's name through the clone.
    const error = await errorOf(
      producer(sub('prod-${P}')),
      makeContext({ stateBackend: throttlingBackend(`prod-${PIN}`) })
    );
    expect(isThrottlingError(error)).toBe(true);
    expectNowhere(`prod-${PIN}`, error.message);
  });

  it('the positional pass runs BEFORE the bag pass, or a 4+ char secret beside the pin defeats it', async () => {
    // `pinab` is `q7ab`, long enough for the needle mask to reach it as a
    // SUBSTRING. Run the bag pass first and it rewrites the name to
    // `svc-***-q7`, after which the raw `svc-q7ab-q7` no longer matches and the
    // sub-floor `q7` — the half this issue is about — survives. This is the
    // case probe 6 needed: with the order swapped, the tail reads `-q7`.
    // The name's own log text is the WHOLE `***` here, not `svc-***-***`:
    // `maskSecretsForLog` collapses to `***` when the needle mask also changes
    // the raw text, which the 4-character half makes it do.
    const name = { 'Fn::Sub': ['svc-${A}-${B}', { A: ref('pinab'), B: ref('pin') }] };
    const error = await errorOf(
      producer(name),
      makeContext({ stateBackend: rejectingBackend(`svc-${PIN}ab-${PIN}`) })
    );
    expect(error.message).toBe(
      "Failed to get state for stack '***' (us-east-1): " +
        'Access Denied: s3:GetObject on cdkd/***/us-east-1/state.json'
    );
    // The discriminator: with the passes swapped the bag rewrites `q7ab` first,
    // the raw name stops matching, and the tail survives as `svc-***-q7`.
    expectNowhere(PIN, error.message);
  });

  it('BOTH names masked at once, so the sort and the substitution loop run with two entries', async () => {
    // Every other case here drops one pair (the other name carries no mask),
    // leaving a single substitution that no ordering can get wrong. This is the
    // only case where the loop iterates twice.
    const error = await errorOf(
      producer(sub('prod-${P}'), sub('us-west-${P}')),
      makeContext({ stateBackend: rejectingBackend(`prod-${PIN}`, `us-west-${PIN}`) })
    );
    expect(error.message).toBe(
      "Failed to get state for stack 'prod-***' (us-west-***): " +
        'Access Denied: s3:GetObject on cdkd/prod-***/us-west-***/state.json'
    );
    expectNowhere(PIN, error.message);
  });

  it('the SANITIZED spelling is substituted too, since that is what the reader sees', async () => {
    // `ctl` is `x` + U+0001 + `y7`. `S3StateBackend` prints the name through
    // `displaySafe(..., { asciiOnly: true })`, which replaces the control
    // character with a space — so the message holds `svc-x y7`, not the raw
    // name. Matching the raw spelling alone would miss it and report success.
    const raw = `svc-x${String.fromCharCode(1)}y7`;
    const error = await errorOf(
      producer(sub('svc-${P}', 'ctl')),
      makeContext({ stateBackend: sanitizingBackend(raw) })
    );
    expect(error.message).toBe(
      "Failed to get state for stack '***' (us-east-1): Access Denied"
    );
    expect(error.message).not.toContain('y7');
  });

  it('THE INVARIANT: nothing this masker prints is less sanitized than what the sink printed', async () => {
    // Asserted as the PROPERTY rather than as another example, because three
    // rounds of adding examples each missed the next shape. The sink sanitizes
    // (`displaySafe`), so whatever comes back out must still be sanitized,
    // wherever the offending character sits and whichever character it is.
    // Every shape here carries a mask; the UNMASKED half is the control case
    // below, which is where that arm is pinned.
    //
    // This shape is the one an example-by-example fix kept missing: the name
    // DOES carry a mask, and the log twin keeps the template's literal parts
    // verbatim, so substituting the sanitized key for the raw twin put the
    // control character back.
    // Scoped to what THIS masker produces — the thrown chain. The resolver's
    // own debug lines print the log twin, which keeps the template's literal
    // parts verbatim and so can carry a control character of its own; that is
    // `maskSecretsForLog`'s pre-existing behaviour at a different site, not
    // something this catch owns.
    // Interior, trailing, TAB and NEWLINE — the last two because the sink
    // strips them exactly as it strips `\x01`, so a whitelist for either is a
    // hole. `plain-${P}` carries no offending character on purpose: it is the
    // `shown === raw` single-entry branch, where the pair must still mask.
    const ctl = String.fromCharCode(1);
    for (const name of [
      `pro${ctl}d-\${P}`,
      `svc-\${P}${ctl}`,
      'pro\td-${P}',
      'pro\nd-${P}',
      'plain-${P}',
    ]) {
      const raw = name.replace('${P}', PIN);
      const error = await errorOf(
        producer(sub(name)),
        makeContext({ stateBackend: sanitizingBackend(raw) })
      );
      // PER MESSAGE, so the assertion carries NO whitelist at all. Joining and
      // then exempting the separator reopens the hole for exactly that
      // character: the sink's class is `/[^ -~]/`, which strips `\n` as
      // readily as `\t`, so a `\n`-bearing name added later would slip through
      // an exemption defending the join. The class here is the sink's own,
      // through the SHARED constant, so the PAIR FENCE below watches this line
      // rather than a copy of it -- via `SINK_CLASS_ANYWHERE`, since a `y` on
      // the constant would make `toMatch`'s `String.match` answer `null` for
      // every message whose rejected character is not at index 0, and this
      // assertion would pass universally (measured).
      for (const message of chainMessages(error)) {
        expect(message, `for ${JSON.stringify(name)}`).not.toMatch(SINK_CLASS_ANYWHERE);
        expect(message).not.toContain(PIN);
      }
    }
  });

  it('CONTROL: an UNMASKED name is never de-sanitized back to its raw spelling', async () => {
    // The regression this pins: expanding a pair into its sanitized spelling
    // BEFORE dropping the unmasked ones leaves `[shown, raw]` alive, and the
    // transform then rewrites the sanitized text back to the raw one — undoing
    // the printing module's own `displaySafe` and putting a live escape
    // sequence back on the terminal. A trailing space is enough to reach it,
    // because `trim()` is part of that transform.
    const raw = 'prod ';
    const error = await errorOf(
      producer(raw),
      makeContext({ stateBackend: sanitizingBackend(raw) })
    );
    expect(error.message).toBe(
      "Failed to get state for stack 'prod' (us-east-1): Access Denied"
    );
    // The raw spelling must not come back. A trailing space is the cheapest
    // shape that shows it; the same entry restores a control character just as
    // readily, since `displaySafe` maps both.
    expect(error.message).not.toContain("'prod '");
  });

  it('the CloudFormation fallback warn masks the name the AWS text quotes back', async () => {
    // Same frame, same class, DEFAULT verbosity: this method hands `stackName`
    // to `DescribeStacks` raw, and a real AccessDenied names the stack ARN it
    // refused. `maskSecretsForLog` over that sentence finds no twin and falls
    // to the needle pass, which cannot see a sub-floor secret in the name.
    cfnBehaviour.mode = 'throw';
    cfnBehaviour.deniedQuotes = `prod-${PIN}`;
    await messageOf(
      producer(sub('prod-${P}')),
      makeContext({ stateBackend: emptyBackend() })
    );
    const warn = everyLine().find((l) => l.includes('DescribeStacks fallback failed'));
    expect(warn).toBeDefined();
    expect(warn).toContain('stack/prod-***/*');
    expectNowhere(`prod-${PIN}`);
  });

  it('the CROSS-ACCOUNT arm is masked by the same catch', async () => {
    // `RoleArn` routes through `getCrossAccountStackState`, which refuses a
    // non-ARN before any STS call — and that refusal is raised INSIDE the try,
    // so it takes the same masking path. The issue's plan named this arm.
    const error = await errorOf(
      {
        'Fn::GetStackOutput': {
          StackName: sub('prod-${P}'),
          OutputName: 'Out',
          Region: 'us-east-1',
          RoleArn: 'not-an-arn',
        },
      },
      makeContext({ stateBackend: emptyBackend() })
    );
    expect(error.message).toMatch(/^Fn::GetStackOutput: RoleArn 'not-an-arn' is not a valid/);
    expectNowhere(`prod-${PIN}`, error.message);
  });

  it('a stack name that EMBEDS the region still masks only its own secret', async () => {
    // Deliberately NOT a fence on the longest-raw-first sort: the region here
    // carries no mask, so `maskStateReadError` drops that pair and one
    // substitution is left, which no ordering can get wrong. Reversing the sort
    // leaves this suite green (measured) — see the note at that sort.
    const error = await errorOf(
      producer(sub('us-east-1-app-${P}')),
      makeContext({ stateBackend: rejectingBackend(`us-east-1-app-${PIN}`) })
    );
    expect(error.message).toContain("stack 'us-east-1-app-***'");
    expect(error.message).toContain('(us-east-1)');
    expectNowhere(`us-east-1-app-${PIN}`, error.message);
  });

  it('PAIR FENCE: the transcribed sink class still matches displaySafe', () => {
    // `sanitizingBackend`'s `shown` and THE INVARIANT's assertion both read
    // `SINK_CLASS`. That constant is a TRANSCRIPTION of
    // `sanitizeAsciiOnly` in `src/utils/display-safe.ts`, deliberately not an
    // import: an expected value must stay an INDEPENDENT variable from the one
    // under test, or the property asserts only that the subject agrees with
    // itself. The cost of independence is silent drift -- widen `displaySafe`'s
    // class and the transcription keeps passing while no longer describing the
    // sink -- so the two are paired here by BEHAVIOUR rather than by sharing a
    // regex with `src/`.
    //
    // It pairs `SINK_CLASS`, the ONE constant the fake sink and THE INVARIANT
    // both use. A fence holding its own copy pairs only that copy: the two in
    // use could then be narrowed back with this green, which is the defect it
    // exists to stop rather than a variant of it.
    //
    // It lives beside those two rather than in `display-safe.ts`'s own suite
    // because the subject here is the TRANSCRIPTION, which is local to this
    // file; `tests/unit/utils/display-safe.test.ts` owns the sink's behaviour
    // on its own terms.
    // The VALUE, never `sanitized === probe`: identity is blind wherever the
    // sink maps a character to ITSELF, and asserting the value is what pins
    // the replacement character at all.
    //
    // One narrowing is deliberately NOT chased. `/[^!-~]/` also rejects
    // `U+0020` and replaces it WITH `U+0020`, so it is an EQUIVALENT MUTANT,
    // not a gap: measured over all 1,114,112 code points in four positions
    // (interior, both ends, alone), the two classes differ on ZERO inputs.
    // No assertion can separate them and none should try.
    //
    // Asserting the value pins all THREE facts the fake sink transcribes --
    // the class, the replacement character, and the trim -- where the previous
    // shape pinned only the class. Other cases here depend on the other two
    // (the `'prod '` control on the trim; the replacement is pinned HERE and
    // nowhere else, since the masking cases substitute whatever the sink
    // produced and stay green whatever it is), so
    // leaving them unpaired left those reading a sink that could have moved.
    //
    // EVERY code point, not a prefix of them. The earlier bound stopped at
    // U+2FFF with no reason given, which left `U+FEFF` and everything above
    // U+3000 free to be exempted -- an "allow BOM" or "allow CJK" edit to
    // `sanitizeAsciiOnly` would have left this green. The sweep collects
    // rather than asserting per iteration, so the full range costs a fraction
    // of a second; `expect` per code point does not.
    const mismatches: string[] = [];
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      const probe = `a${ch}b`;
      // An astral code point is TWO UTF-16 units and the class carries no `u`
      // flag, so the sink replaces each half — two spaces, not one. A lone
      // surrogate is one unit and takes one.
      const expected = rejects(ch)
        ? `a${SINK_REPLACEMENT.repeat(ch.length)}b`
        : probe;
      if (displaySafe(probe, { asciiOnly: true }) !== expected) {
        mismatches.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      }
      checked++;
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    // The TRIM, which an interior probe cannot reach: a rejected character at
    // either end is removed for a second reason, so the sweep above cannot
    // tell the class apart from the trim there.
    // Two separate facts, and the first version conflated them by feeding the
    // REPLACEMENT in as input, where the class never fires: that asserted
    // plain whitespace trimming and would have reddened for the wrong reason
    // had the replacement changed in step everywhere.
    expect(displaySafe(' x ', { asciiOnly: true })).toBe('x');
    // And the COMPOSITION: a REJECTED character at an edge becomes the
    // replacement and is then trimmed away, which is exactly why an edge
    // position cannot tell the class apart from the trim.
    //
    // The edge character is DERIVED rather than hand-picked, because picking
    // one by hand is what has now gone vacuous twice in a row here: the
    // replacement itself (the class never fires on it), then `U+00A0`, which
    // is ECMAScript `WhiteSpace` -- so native `.trim()` removes it unaided and
    // the case passed with the class deleted entirely. A hand-picked constant
    // cannot state the two properties this case needs, so it states them:
    // REJECTED by the class, and not already trimmable.
    //
    // Three conditions, all three in the PREDICATE rather than in the bound,
    // because a bound cannot enforce what it only gestures at. Twice now:
    // first a scan starting at U+0021 "to skip the C0 controls, whose
    // rendering in a failure message is its own hazard" selected U+007F, which
    // is DEL -- a control, with exactly that hazard; then a hand-rolled
    // `cp <= 0x1f || (0x7f..0x9f)` was called RENDERABLE while admitting
    // U+00AD, U+200B and U+202E, the last being the Trojan-Source bidi
    // override `src/utils/display-safe.ts` names as a rendering hazard in its
    // own docstring. The predicate uses the Unicode classes the repo already
    // spells for this question: `src/utils/display-safe.ts:33-35` states them
    // in prose and `src/deployment/outputs-export-alias.ts:313`
    // (`SECRET_SCAN_INVISIBLES`) is the live regex, which carries one MORE
    // (`\p{Me}`) and the `g` this use has no need of. Five rather than six is
    // deliberate and inert: measured, `\p{Me}` adds 13 code points, all at or
    // above U+0488, so the pick is unchanged.
    //
    // The range really is only a termination bound now: it starts at 0 --
    // measured, the pick is U+00A1 either way -- and stops at the BMP because
    // a qualifying character certainly exists below it. The sweep above is
    // what covers the whole domain.
    //
    // The `throw` keeps the bound honest: if a future class accepts everything
    // in this range, the case REFUSES rather than silently fencing the trim
    // alone -- which is what both hand-picked spellings did.
    // Named `..._CLASS`: `display-safe.ts` EXPORTS an `UNRENDERABLE` string
    // constant and this file already imports from that module, so the bare
    // name would be silently shadowed the day someone adds it to that import.
    const UNRENDERABLE_CLASS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
    // The `u` is LOAD-BEARING and therefore asserted, not assumed. Without it
    // `\p{...}` is not a property escape at all -- it reads as the literal
    // letters -- so the class matches almost nothing, the loop picks U+0000,
    // and the assertion below STILL PASSES because the sink replaces NUL like
    // any other rejected character. That silently restores the
    // control-character-as-edge hazard this predicate was rewritten twice to
    // remove, which is the same flag-drift `SINK_CLASS_FLAGS` above is guarded
    // against. U+200B is the probe -- spelled as an ESCAPE, since a literal
    // zero-width character in source is invisible to the next reader.
    expect(UNRENDERABLE_CLASS.test('\u200B')).toBe(true);
    const edge = (() => {
      for (let cp = 0; cp <= 0xffff; cp++) {
        const ch = String.fromCodePoint(cp);
        if (rejects(ch) && ch.trim() !== '' && !UNRENDERABLE_CLASS.test(ch)) return ch;
      }
      throw new Error('no rejected, non-trimmable, renderable character exists -- this case cannot fence anything');
    })();
    expect(displaySafe(`${edge}x${edge}`, { asciiOnly: true })).toBe('x');
    // Floor against an early exit or a `continue` that skips the range -- NOT
    // against deleting the assertions above, which no counter in the same loop
    // can see. Probed by widening `sanitizeAsciiOnly` to `/[^\t -~]/`: this
    // case reds at `U+0009`, the character round 4 of PR go-to-k/cdkd#3275
    // exempted here to defend the JOIN it performed — an exemption that only
    // holds if the sink keeps the character, which it does not.
    expect(checked).toBe(0x110000);
  });
});
