/**
 * A template-supplied TYPE name, and a malformed string-form `Fn::GetAtt`
 * operand, cannot put a terminal-rewriting sequence on a resolver message
 * (issue [#3441](https://github.com/go-to-k/cdkd/issues/3441)).
 *
 * go-to-k/cdkd#3435 closed this class for template-supplied IDENTIFIERS
 * (`resolver-logical-id-control-chars.test.ts`) and recorded the TYPE names as
 * the remainder: each such render carried an exclusion note answering the
 * SECRET question ("a TYPE name ..., not a value") while the live question was
 * CONTROL CHARACTERS. A `Resources.X.Type` or a `Parameters.X.Type` is
 * arbitrary JSON to cdkd, and `cdkd import --migrate-from-cloudformation` reads
 * a hand-written template.
 *
 * A type name is NOT the same value class as a logical id: at some sites it is
 * compared against a literal before the render runs. So each site was judged,
 * and this file has two groups that fail differently:
 *
 *  1. SANITIZED sites — the render is reachable with an arbitrary type. Each
 *     case drives a hostile type to exactly that render and reads the emitted
 *     BYTES, with a CONTROL showing an ordinary type still renders verbatim
 *     (so a builder that ate the whole name, or a case that stopped reaching
 *     its arm, cannot pass).
 *  2. CONSTRAINED sites — the render is reached only after an exact equality
 *     against cdkd literals, so raw and sanitized are the same bytes. That is a
 *     claim about CONTROL FLOW, so it is driven: a NEAR-MISS spelling of the
 *     gated literal must NOT reach that render, and whatever it reaches instead
 *     must be sanitized.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

/** STS answer, switchable per case: `{}` is the fabricated-account arm. */
const stsState: { response: Record<string, unknown> } = { response: { Account: '123456789012' } };
const mockSSMSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn(() => Promise.resolve(stsState.response)) },
    ssm: { send: mockSSMSend },
  }),
}));

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
/** U+2028: the character that tells `displaySafe` apart from a bare `stripControlChars`. */
const LS = ' ';
/** U+202E: the Trojan-Source right-to-left override. */
const RLO = '‮';

/** The payload `resolver-logical-id-control-chars.test.ts` uses, and why, is documented there. */
const EVIL = `Prod${ESC}[2K${CR}Ev${LS}il${RLO}X`;
/** A hostile resource TYPE no routing table matches. */
const EVIL_TYPE = `AWS::${EVIL}`;

const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  [ESC, 'ESC'],
  [CR, 'CR'],
  [LS, 'U+2028'],
  [RLO, 'U+202E'],
];

function expectSanitized(text: string, what: string): void {
  for (const [ch, name] of FORBIDDEN) {
    expect(text.includes(ch), `${what} still carries ${name}: ${JSON.stringify(text)}`).toBe(false);
  }
  // Pin the surviving skeleton too: a render that dropped the type entirely
  // would satisfy every negative above.
  expect(text, `${what} lost the type's printable head`).toContain('Prod');
  expect(text, `${what} lost the type's printable tail`).toContain('ilX');
}

/** How many times the sanitized payload's tail appears — one per render of it. */
function renders(text: string): number {
  return text.split('ilX').length - 1;
}

interface Captured {
  readonly lines: string[];
  readonly error?: string;
}

async function capture(body: () => Promise<unknown> | unknown): Promise<Captured> {
  const lines: string[] = [];
  const logger = await import('../../../src/utils/logger.js');
  const got = logger.getLogger() as unknown as Record<string, unknown>;
  const previous = { debug: got['debug'], warn: got['warn'], error: got['error'] };
  got['debug'] = (m: unknown): void => void lines.push(String(m));
  got['warn'] = (m: unknown): void => void lines.push(String(m));
  got['error'] = (m: unknown): void => void lines.push(String(m));
  let error: string | undefined;
  try {
    await body();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    got['debug'] = previous.debug;
    got['warn'] = previous.warn;
    got['error'] = previous.error;
  }
  return error === undefined ? { lines } : { lines, error };
}

type ResourceRecord = ResolverContext['resources'][string];

function record(over: Partial<ResourceRecord> & { resourceType: string }): ResourceRecord {
  return { physicalId: 'p', properties: {}, dependencies: [], ...over };
}

/** Drive `Fn::GetAtt [Thing, attribute]` against a record of `resourceType`. */
async function getAtt(
  resourceType: string,
  attribute: string,
  opts: {
    readonly over?: Partial<ResourceRecord>;
    readonly strictGetAtt?: boolean;
    readonly context?: Partial<ResolverContext>;
  } = {}
): Promise<Captured> {
  const resolver = new IntrinsicFunctionResolver('us-east-1', {
    cfnFallback: false,
    ...(opts.strictGetAtt === true && { strictGetAtt: true }),
  });
  const template = {
    Resources: { Thing: { Type: resourceType } },
  } as unknown as CloudFormationTemplate;
  return capture(() =>
    resolver.resolve({ 'Fn::GetAtt': ['Thing', attribute] }, {
      template,
      resources: { Thing: record({ resourceType, ...opts.over }) },
      ...opts.context,
    } as ResolverContext)
  );
}

beforeEach(() => {
  resetAccountInfoCache();
  stsState.response = { Account: '123456789012' };
  mockSSMSend.mockReset();
});

describe('a hostile resource TYPE is sanitized where an arbitrary type reaches the render (#3441)', () => {
  it("sanitizes guardedPhysicalIdFallback's ARN-shape refusal AND its unenriched remedy", async () => {
    // Both renders sit in ONE message — `for <type>:` and the remedy's
    // `enrich <type>.<attr>` — so the count pins that NEITHER was dropped and
    // the forbidden-byte scan goes red when EITHER is reverted.
    const got = await getAtt(EVIL_TYPE, 'SomethingArn');
    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain('is not an ARN');
    expect(got.error).toContain('so cdkd can enrich');
    expectSanitized(got.error ?? '', 'the ARN-shape refusal');
    expect(renders(got.error ?? '')).toBe(2);

    // CONTROL: an ordinary type renders verbatim at both places.
    const control = await getAtt('AWS::SQS::Queue', 'SomethingArn');
    expect(control.error).toContain('for AWS::SQS::Queue: ');
    expect(control.error).toContain('so cdkd can enrich AWS::SQS::Queue.SomethingArn.');
  });

  it("sanitizes guardedPhysicalIdFallback's --strict-getatt refusal AND its unenriched remedy", async () => {
    const got = await getAtt(EVIL_TYPE, 'Whatever', { strictGetAtt: true });
    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      '--strict-getatt rejects the physical ID fallback'
    );
    expectSanitized(got.error ?? '', 'the --strict-getatt refusal');
    expect(renders(got.error ?? '')).toBe(2);

    const control = await getAtt('AWS::SQS::Queue', 'Whatever', { strictGetAtt: true });
    expect(control.error).toContain('for AWS::SQS::Queue: ');
    expect(control.error).toContain('so cdkd can enrich AWS::SQS::Queue.Whatever.');
  });

  it("sanitizes guardedPhysicalIdFallback's stale-record WARN, which prints at default verbosity", async () => {
    // A heal that found no resource behind the physical id is what makes the
    // record "may be stale" rather than "not enriched".
    const healer = { attributeHealer: async () => ({ kind: 'not-found' as const }) };
    const got = await getAtt(EVIL_TYPE, 'Whatever', { context: healer });
    const warn = got.lines.find((l) => l.startsWith('The state record for Thing ('));
    expect(warn, `no stale-record warn: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(warn ?? '', 'the stale-record warn');

    const control = await getAtt('AWS::SQS::Queue', 'Whatever', { context: healer });
    expect(control.lines.some((l) => l.startsWith('The state record for Thing (AWS::SQS::Queue) holds no'))).toBe(true);
  });

  it("sanitizes guardedPhysicalIdFallback's unknown-attribute WARN, the most reachable of the four", async () => {
    const got = await getAtt(EVIL_TYPE, 'Whatever');
    const warn = got.lines.find((l) => l.startsWith('Unknown attribute Whatever for resource type '));
    expect(warn, `no unknown-attribute warn: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(warn ?? '', 'the unknown-attribute warn');

    const control = await getAtt('AWS::SQS::Queue', 'Whatever');
    expect(control.lines).toContain(
      'Unknown attribute Whatever for resource type AWS::SQS::Queue, returning physical ID'
    );
  });

  it('sanitizes the FABRICATED-ACCOUNT refusal, which an unknown type reaches through the fallback', async () => {
    // NOT gated on a type: `constructGuardedAttribute` vets whatever
    // `constructAttribute` returned, and for a type no arm matches that is the
    // physical id itself — so a physical id carrying the placeholder account
    // is refused under the template's own type string.
    stsState.response = {};
    const got = await getAtt(EVIL_TYPE, 'Whatever', {
      over: { physicalId: 'thing-123456789012' },
    });
    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      'STS did not report'
    );
    expectSanitized(got.error ?? '', 'the fabricated-account refusal');

    resetAccountInfoCache();
    stsState.response = {};
    const control = await getAtt('AWS::SQS::Queue', 'Whatever', {
      over: { physicalId: 'thing-123456789012' },
    });
    expect(control.error).toContain('for AWS::SQS::Queue: STS did not report');
  });

  it("sanitizes refuseUnservedAttribute's own render, independent of what its callers gate on", async () => {
    // Every CURRENT caller sits behind a `resourceType === '<literal>'` test,
    // so no template reaches this helper with a hostile type today. The helper
    // itself gates on nothing, though, so its safety would otherwise be a
    // property of each future caller. Driven directly for that reason — the
    // public entry points cannot hand it a type its callers did not match.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const call = (resourceType: string): Promise<Captured> =>
      capture(() =>
        (
          resolver as unknown as {
            refuseUnservedAttribute: (site: Record<string, unknown>) => never;
          }
        ).refuseUnservedAttribute({
          logicalId: 'Thing',
          attributeName: 'PrivateIp',
          resourceType,
          physicalId: 'i-0123',
          context: { template: { Resources: {} }, resources: {} },
          observed: 'the instance is pending',
          remedy: 'Deploy again.',
        })
      );

    const got = await call(EVIL_TYPE);
    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      'so cdkd refuses to substitute it'
    );
    expectSanitized(got.error ?? '', "refuseUnservedAttribute's render");

    const control = await call('AWS::EC2::Instance');
    expect(control.error).toContain('for AWS::EC2::Instance: the instance is pending.');
  });
});

describe('a malformed string-form Fn::GetAtt operand is sanitized (#3441)', () => {
  it('sanitizes the "Invalid Fn::GetAtt format" throw, which echoes raw template text', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    const drive = (operand: string): Promise<Captured> =>
      capture(() =>
        resolver.resolve({ 'Fn::GetAtt': operand }, { template, resources: {} } as ResolverContext)
      );

    // `EVIL` carries no dot, so the string form cannot be split.
    const got = await drive(EVIL);
    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      'Invalid Fn::GetAtt format: '
    );
    expectSanitized(got.error ?? '', 'the invalid-format throw');

    const control = await drive('NoDotHere');
    expect(control.error).toBe('Invalid Fn::GetAtt format: NoDotHere');
  });

  it("sanitizes Fn::GetStackOutput's non-literal RoleArn echo, the same pre-resolution note one intrinsic over", async () => {
    // `JSON.stringify` escapes ESC and CR on its own, so those two could never
    // fail here; what it passes through as written is `U+2028` and the bidi
    // override, which is what this case discriminates on.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    const drive = (roleArn: unknown): Promise<Captured> =>
      capture(() =>
        resolver.resolve(
          { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out', RoleArn: roleArn } },
          { template, resources: {} } as ResolverContext
        )
      );

    const got = await drive({ Ref: EVIL });
    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      '(intrinsic shape: '
    );
    expectSanitized(got.error ?? '', 'the RoleArn shape echo');

    const control = await drive({ Ref: 'RoleParam' });
    expect(control.error).toContain('Got object (intrinsic shape: {"Ref":"RoleParam"}).');
  });
});

describe('a hostile PARAMETER type is sanitized on the nested-stack secret-coercion refusal (#3441)', () => {
  // Same exclusion note, one declaration over: `Parameters.X.Type`. The arm is
  // reached by any type `coerceParameterValue` SPLITS, and `isListParameterType`
  // accepts every `List<...>` spelling, so the inner text is arbitrary.
  const JSON_SECRET = '{"user":"root","pass":"hunter2"}';
  const JSON_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:::}}';

  async function refuse(type: string): Promise<Captured> {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const template = {
      Parameters: { Stage: { Type: type } },
      Resources: {},
    } as unknown as CloudFormationTemplate;
    return capture(() =>
      resolver.resolveParameters(template, { Stage: JSON_SECRET }, {
        inheritedSecrets: new Map([[JSON_SECRET, JSON_EXPR]]),
      })
    );
  }

  it('renders the declared type sanitized at BOTH places it appears', async () => {
    const got = await refuse(`List<${EVIL}>`);
    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      'but the parent stack resolved a SECRET dynamic reference into it'
    );
    expectSanitized(got.error ?? '', 'the coercion refusal');
    expect(renders(got.error ?? '')).toBe(2);
    // The refusal must still never quote the secret itself.
    expect(got.error).not.toContain('hunter2');

    const control = await refuse('CommaDelimitedList');
    expect(control.error).toContain("is declared 'Type: CommaDelimitedList', but the");
    expect(control.error).toContain("coercing this value to 'CommaDelimitedList' destroys");
  });
});

describe('an SSM-reported Type is sanitized on the unrecognized-Type WARN (#3441)', () => {
  it('sanitizes the reported type, and a hostile one cannot reach the String/StringList refusal', async () => {
    // TWO sites in one drive. The warn quotes whatever `Type` the response
    // carried, which cdkd does not control. The ssm-secure refusal beside it
    // renders `param.type` raw, and that one is CONSTRAINED: `secure` is false
    // only for the exact strings `String` / `StringList`, so a near-miss
    // spelling is classified secret and never reaches that throw.
    mockSSMSend.mockResolvedValue({
      Parameter: { Value: 'unclassified-value', Type: `String${EVIL}` },
    });
    const resolver = new IntrinsicFunctionResolver();
    const got = await capture(() =>
      resolver.resolveDynamicReferences('{{resolve:ssm-secure:/prod/db/password}}', {
        template: { Resources: {} },
        resources: {},
      } as ResolverContext)
    );

    expect(got.error, `the near-miss type reached a refusal: ${JSON.stringify(got)}`).toBeUndefined();
    const warn = got.lines.find((l) => l.includes('reported an unrecognized Type'));
    expect(warn, `no unrecognized-Type warn: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(warn ?? '', 'the unrecognized-Type warn');

    // CONTROL for both: a real public type DOES reach the constrained refusal
    // and renders there verbatim; a plain unknown type renders verbatim in the
    // warn.
    mockSSMSend.mockResolvedValue({ Parameter: { Value: 'v', Type: 'StringList' } });
    const refused = await capture(() =>
      new IntrinsicFunctionResolver().resolveDynamicReferences(
        '{{resolve:ssm-secure:/prod/db/other}}',
        { template: { Resources: {} }, resources: {} } as ResolverContext
      )
    );
    expect(refused.error).toContain('the parameter is a StringList parameter');

    mockSSMSend.mockResolvedValue({ Parameter: { Value: 'w', Type: 'FutureSecretType' } });
    const plain = await capture(() =>
      new IntrinsicFunctionResolver().resolveDynamicReferences(
        '{{resolve:ssm-secure:/prod/db/third}}',
        { template: { Resources: {} }, resources: {} } as ResolverContext
      )
    );
    expect(plain.lines.some((l) => l.includes("unrecognized Type 'FutureSecretType' — treating"))).toBe(
      true
    );
  });
});

describe('a CONSTRAINED type render is reached only by an exact literal — driven, not asserted (#3441)', () => {
  it('the pre-#1681 placeholder-ARN refusal: a near-miss type misses the map and never reaches it', async () => {
    const placeholder = { attributes: { DataSourceArn: 'arn:aws:appsync:*:*:apis/x/datasources/y' } };

    // CONTROL: the exact type reaches the refusal and renders verbatim there.
    const exact = await getAtt('AWS::AppSync::DataSource', 'DataSourceArn', { over: placeholder });
    expect(exact.error).toContain('for AWS::AppSync::DataSource: the recorded value');

    // The near miss: `REF_RETURNS_ARN_FROM_STATE` is a `Map` keyed by whole
    // type strings, so the hostile spelling is not a key and the refusal is
    // never raised.
    const near = await getAtt(`AWS::AppSync::DataSource${EVIL}`, 'DataSourceArn', {
      over: placeholder,
    });
    expect(near.error ?? '', `a near-miss type reached the placeholder refusal`).not.toContain(
      'is a placeholder'
    );
    const emitted = [...near.lines, near.error ?? ''].join('\n');
    for (const [ch, name] of FORBIDDEN) {
      expect(emitted.includes(ch), `the near-miss path let ${name} through`).toBe(false);
    }
  });

  it('the RDS DBProxy VpcId refusal: a near-miss type lands on the sanitizing fallback instead', async () => {
    const exact = await getAtt('AWS::RDS::DBProxy', 'VpcId', { over: { physicalId: 'a-name' } });
    expect(exact.error).toContain('for AWS::RDS::DBProxy: the state record holds no VpcId');

    const near = await getAtt(`AWS::RDS::DBProxy${EVIL}`, 'VpcId', {
      over: { physicalId: 'a-name' },
    });
    const emitted = [...near.lines, near.error ?? ''].join('\n');
    expect(emitted, 'a near-miss type reached the DBProxy refusal').not.toContain(
      'the state record holds no VpcId'
    );
    // It reached the shared fallback's warn, which this change sanitizes.
    const warn = near.lines.find((l) => l.startsWith('Unknown attribute VpcId for resource type '));
    expect(warn, `did not land on the fallback: ${JSON.stringify(near)}`).toBeDefined();
    expectSanitized(warn ?? '', 'the fallback warn a near-miss DBProxy type lands on');
  });
});
