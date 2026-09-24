/**
 * The resolver's `Fn::Select` index, `Fn::Split` delimiter and state-record
 * PHYSICAL ID renders cannot put a terminal-rewriting sequence on a log line
 * (issue [#3479](https://github.com/go-to-k/cdkd/issues/3479)).
 *
 * Each of these sites carried an exclusion note that answered the SECRET
 * question — "a structural operand", "an AWS-assigned PHYSICAL ID" — while the
 * live question was CONTROL CHARACTERS:
 *
 *  - The `Fn::Split` delimiter is the RAW template operand, never resolved and
 *    never type-checked, so a string reaches the render verbatim. The
 *    `Fn::Select` index is validated since issue #3574, so a hostile one now
 *    reaches only the REFUSAL, which renders it.
 *  - A physical id is read off the STATE RECORD, which is not always
 *    AWS-assigned (`cdkd import --resource <id>=<physicalId>`, a record another
 *    binary or a hand edit wrote). Where the AWS SDK message is rendered beside
 *    it, that message ECHOES the id, so it is sanitized too.
 *
 * Each case drives a hostile value to exactly one render and reads the emitted
 * BYTES, with a CONTROL showing an ordinary value still renders verbatim — so a
 * builder that ate the whole value, or a case that stopped reaching its arm,
 * cannot pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** Per-case answers of the two clients the physical-id arms call. */
const aws = vi.hoisted(() => ({
  ec2: (async () => ({})) as (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }) => Promise<unknown>,
  sd: (async () => ({})) as (command: { input?: Record<string, unknown> }) => Promise<unknown>,
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn(async () => ({ Account: '123456789012' })) },
    ec2: { send: (command: never) => aws.ec2(command) },
  }),
}));

vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-servicediscovery')>();
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(function () {
      return { send: (command: never) => aws.sd(command) };
    }),
  };
});

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
/** U+2028: tells `displaySafe` apart from a bare `stripControlChars`. */
const LS = String.fromCharCode(0x2028);
/** U+202E: the Trojan-Source right-to-left override. */
const RLO = String.fromCharCode(0x202e);

/** The payload `resolver-logical-id-control-chars.test.ts` documents. */
const EVIL = `Prod${ESC}[2K${CR}Ev${LS}il${RLO}X`;
const EVIL_ID = `vpc-${EVIL}`;

const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  [ESC, 'ESC'],
  [CR, 'CR'],
  [LS, 'U+2028'],
  [RLO, 'U+202E'],
];

function expectClean(text: string, what: string): void {
  for (const [ch, name] of FORBIDDEN) {
    expect(text.includes(ch), `${what} still carries ${name}: ${JSON.stringify(text)}`).toBe(false);
  }
}

function expectSanitized(text: string, what: string): void {
  expectClean(text, what);
  // Pin the surviving skeleton too: a render that dropped the value entirely
  // would satisfy every negative above.
  expect(text, `${what} lost the value's printable head`).toContain('Prod');
  expect(text, `${what} lost the value's printable tail`).toContain('ilX');
}

/** How many times the sanitized payload's tail appears — one per render of it. */
function renders(text: string): number {
  return text.split('ilX').length - 1;
}

async function capture(body: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const logger = await import('../../../src/utils/logger.js');
  const got = logger.getLogger() as unknown as Record<string, unknown>;
  const previous = { debug: got['debug'], warn: got['warn'], error: got['error'] };
  got['debug'] = (m: unknown): void => void lines.push(String(m));
  got['warn'] = (m: unknown): void => void lines.push(String(m));
  got['error'] = (m: unknown): void => void lines.push(String(m));
  try {
    await body();
  } finally {
    got['debug'] = previous.debug;
    got['warn'] = previous.warn;
    got['error'] = previous.error;
  }
  return lines;
}

function resolver(): IntrinsicFunctionResolver {
  return new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
}

/** Resolve a bare intrinsic with no resources in play. */
function resolveValue(value: unknown): Promise<string[]> {
  return capture(() =>
    resolver().resolve(value, {
      template: { Resources: {} } as unknown as CloudFormationTemplate,
      resources: {},
    } as ResolverContext)
  );
}

/** The message of the refusal an `Fn::Select` over `index` throws. */
async function selectRefusal(index: unknown): Promise<string> {
  let message = '';
  await capture(async () => {
    try {
      await resolver().resolve({ 'Fn::Select': [index, ['a', 'b']] }, {
        template: { Resources: {} } as unknown as CloudFormationTemplate,
        resources: {},
      } as ResolverContext);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  });
  expect(message, 'the Fn::Select did not refuse').toMatch(/^Fn::Select: the index /);
  return message;
}

/** Drive `Fn::GetAtt [Thing, attribute]` against a record of `resourceType`. */
function getAtt(resourceType: string, attribute: string, physicalId: string): Promise<string[]> {
  const template = {
    Resources: { Thing: { Type: resourceType } },
  } as unknown as CloudFormationTemplate;
  return capture(() =>
    resolver().resolve({ 'Fn::GetAtt': ['Thing', attribute] }, {
      template,
      resources: {
        Thing: { physicalId, resourceType, properties: {}, dependencies: [] },
      },
    } as unknown as ResolverContext)
  );
}

function line(lines: string[], prefix: string): string {
  const found = lines.find((l) => l.startsWith(prefix));
  expect(found, `no line starting ${JSON.stringify(prefix)}: ${JSON.stringify(lines)}`).toBeDefined();
  return found ?? '';
}

/** An SDK failure whose message ECHOES the requested id, as EC2's `*.NotFound` does. */
function echoing(id: unknown): Error {
  return new Error(`The ID '${String(id)}' does not exist`);
}

beforeEach(() => {
  resetAccountInfoCache();
  aws.ec2 = async () => ({});
  aws.sd = async () => ({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Fn::Select index and Fn::Split delimiter are sanitized (#3479)', () => {
  it('sanitizes the index REFUSAL, reached by an index carrying a line terminator (#3574)', async () => {
    // `Number()` trims whitespace, `U+2028` and CR included, so before #3574
    // this compared as 9 and reached the out-of-bounds warn; the digit-only
    // rule now refuses it, and the refusal renders the value.
    const error = await selectRefusal(`${CR}9${LS}`);
    expectClean(error, 'the index refusal');
    expect(error).toContain('got string "9"');

    // CONTROL: an ordinary out-of-range index still reaches the warn.
    const control = await resolveValue({ 'Fn::Select': [9, ['a', 'b']] });
    expect(control).toContain('Fn::Select: index 9 out of bounds (array length: 2)');
  });

  it('sanitizes the index REFUSAL, reached by an index that is not a number (#3574)', async () => {
    const error = await selectRefusal(EVIL);
    expectSanitized(error, 'the index refusal');
    expect(renders(error)).toBe(1);

    const control = await resolveValue({ 'Fn::Select': [1, ['a', 'b']] });
    expect(control).toContain('Resolved Fn::Select: index 1 -> "b"');
  });

  it('sanitizes the Fn::Split delimiter on its DEBUG line', async () => {
    const got = await resolveValue({ 'Fn::Split': [EVIL, `a${EVIL}b`] });
    const debug = line(got, 'Resolved Fn::Split: split by "');
    expectClean(debug, 'the Fn::Split debug line');
    // The delimiter render itself, between the quotes, carries the skeleton.
    const rendered = debug.slice('Resolved Fn::Split: split by "'.length).split('" -> ')[0] ?? '';
    expectSanitized(rendered, 'the rendered delimiter');

    const control = await resolveValue({ 'Fn::Split': [',', 'a,b'] });
    expect(control).toContain('Resolved Fn::Split: split by "," -> ["a","b"]');
  });
});

describe('a state-record PHYSICAL ID is sanitized at every resolver render (#3479)', () => {
  describe('AWS::EC2::VPC Ipv6CidrBlocks', () => {
    it('sanitizes the resolved DEBUG line', async () => {
      aws.ec2 = async () => ({
        Vpcs: [
          {
            Ipv6CidrBlockAssociationSet: [
              { Ipv6CidrBlock: '2001:db8::/56', Ipv6CidrBlockState: { State: 'associated' } },
            ],
          },
        ],
      });
      const got = await getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', EVIL_ID);
      expectSanitized(line(got, 'Resolved VPC Ipv6CidrBlocks for '), 'the resolved debug line');

      const control = await getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', 'vpc-0abc');
      expect(control.some((l) => l.startsWith('Resolved VPC Ipv6CidrBlocks for vpc-0abc: '))).toBe(
        true
      );
    });

    it('sanitizes the no-associations DEBUG line', async () => {
      aws.ec2 = async () => ({ Vpcs: [{ Ipv6CidrBlockAssociationSet: [] }] });
      const got = await getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', EVIL_ID);
      expectSanitized(
        line(got, 'No IPv6 CIDR associations found for VPC '),
        'the no-associations line'
      );

      const control = await getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', 'vpc-0abc');
      expect(control).toContain('No IPv6 CIDR associations found for VPC vpc-0abc');
    });

    it('sanitizes the still-associating DEBUG line and the gave-up WARN', async () => {
      aws.ec2 = async () => ({
        Vpcs: [
          {
            Ipv6CidrBlockAssociationSet: [
              { Ipv6CidrBlock: '2001:db8::/56', Ipv6CidrBlockState: { State: 'associating' } },
            ],
          },
        ],
      });
      const run = async (id: string): Promise<string[]> => {
        vi.useFakeTimers();
        const pending = getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', id);
        await vi.runAllTimersAsync();
        const lines = await pending;
        vi.useRealTimers();
        return lines;
      };
      const got = await run(EVIL_ID);
      expectSanitized(line(got, 'VPC vpc-Prod'), 'the still-associating line');
      const gaveUp = got.find((l) => l.includes("IPv6 CIDR did not reach 'associated' state"));
      expect(gaveUp, JSON.stringify(got)).toBeDefined();
      expectSanitized(gaveUp ?? '', 'the gave-up warn');

      const control = await run('vpc-0abc');
      expect(control).toContain(
        'VPC vpc-0abc IPv6 CIDR still associating (attempt 1/15), waiting...'
      );
      expect(control).toContain(
        "VPC vpc-0abc IPv6 CIDR did not reach 'associated' state after 15 attempts"
      );
    });

    it('sanitizes the failure WARN: the id AND the SDK message that echoes it', async () => {
      aws.ec2 = async (command) => {
        throw echoing((command.input?.['VpcIds'] as string[] | undefined)?.[0]);
      };
      const got = await getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', EVIL_ID);
      const warn = line(got, 'Failed to fetch VPC Ipv6CidrBlocks for ');
      expectSanitized(warn, 'the failure warn');
      // Both renders survived — the id and its echo — so reverting EITHER
      // leaves a forbidden byte, and dropping either fails the count.
      expect(renders(warn)).toBe(2);

      const control = await getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', 'vpc-0abc');
      expect(control).toContain(
        "Failed to fetch VPC Ipv6CidrBlocks for vpc-0abc: The ID 'vpc-0abc' does not exist"
      );
    });
  });

  it("sanitizes ServiceDiscovery HostedZoneId's failure WARN: the id AND its echo", async () => {
    aws.sd = async (command) => {
      throw echoing(command.input?.['Id']);
    };
    const type = 'AWS::ServiceDiscovery::PrivateDnsNamespace';
    const got = await getAtt(type, 'HostedZoneId', `ns-${EVIL}`);
    const warn = line(got, 'Failed to fetch HostedZoneId for namespace ');
    expectSanitized(warn, 'the HostedZoneId warn');
    expect(renders(warn)).toBe(2);

    const control = await getAtt(type, 'HostedZoneId', 'ns-0abc');
    expect(control).toContain(
      "Failed to fetch HostedZoneId for namespace ns-0abc: The ID 'ns-0abc' does not exist"
    );
  });

  it("sanitizes LaunchTemplate's DescribeLaunchTemplates failure WARN", async () => {
    aws.ec2 = async (command) => {
      throw echoing((command.input?.['LaunchTemplateIds'] as string[] | undefined)?.[0]);
    };
    const type = 'AWS::EC2::LaunchTemplate';
    const got = await getAtt(type, 'LatestVersionNumber', `lt-${EVIL}`);
    const warn = line(got, 'DescribeLaunchTemplates(');
    expectSanitized(warn, 'the DescribeLaunchTemplates warn');
    expect(renders(warn)).toBe(2);

    const control = await getAtt(type, 'LatestVersionNumber', 'lt-0abc');
    expect(control).toContain(
      "DescribeLaunchTemplates(lt-0abc) failed for LatestVersionNumber: The ID 'lt-0abc' does not exist"
    );
  });
});

describe('the Ref renders of a state-record id and a pseudo-parameter value are sanitized (#3479, PR #3575 review)', () => {
  function ref(name: string, over: Partial<ResolverContext> = {}): Promise<string[]> {
    return capture(() =>
      resolver().resolve({ Ref: name }, {
        template: { Resources: { Thing: { Type: 'AWS::EC2::VPC' } } } as unknown as CloudFormationTemplate,
        resources: {
          Thing: { physicalId: EVIL_ID, resourceType: 'AWS::EC2::VPC', properties: {}, dependencies: [] },
        },
        ...over,
      } as unknown as ResolverContext)
    );
  }

  it('sanitizes the resource Ref DEBUG line, which renders the physical id from state', async () => {
    const got = await ref('Thing');
    expectSanitized(line(got, 'Resolved Ref to resource: Thing -> '), 'the resource Ref line');

    const control = await capture(() =>
      resolver().resolve({ Ref: 'Thing' }, {
        template: { Resources: { Thing: { Type: 'AWS::EC2::VPC' } } } as unknown as CloudFormationTemplate,
        resources: {
          Thing: { physicalId: 'vpc-0abc', resourceType: 'AWS::EC2::VPC', properties: {}, dependencies: [] },
        },
      } as unknown as ResolverContext)
    );
    expect(control).toContain('Resolved Ref to resource: Thing -> vpc-0abc');
  });

  it('sanitizes the pseudo-parameter DEBUG line, whose AWS::StackName value is manifest-derived', async () => {
    const got = await ref('AWS::StackName', { stackName: EVIL } as Partial<ResolverContext>);
    expectSanitized(
      line(got, 'Resolved Ref to pseudo parameter: AWS::StackName -> '),
      'the pseudo-parameter line'
    );

    const control = await ref('AWS::StackName', { stackName: 'MyStack' } as Partial<ResolverContext>);
    expect(control).toContain('Resolved Ref to pseudo parameter: AWS::StackName -> MyStack');
  });
});
