/**
 * A template-supplied LOGICAL ID cannot put a terminal-rewriting sequence on a
 * resolver message (issue
 * [#3432](https://github.com/go-to-k/cdkd/issues/3432)).
 *
 * ## The class, and why a source-shape fence alone does not hold it
 *
 * go-to-k/cdkd#3426 closed the control-character class at the MASKER: the
 * display builder sanitizes as well as masks, so any render reaching it is safe
 * by construction. Nineteen `logicalId` renders did not reach it — each carried
 * an exclusion note whose premise answers the SECRET question ("this value can
 * never carry a resolved plaintext"), which is not the control-character
 * question. This file is the behavioural half of closing them.
 *
 * MEASURED BEFORE THE FIX, on this tree, at DEFAULT verbosity. Each row below
 * emitted a live `ESC[2K` + CR:
 *
 *     Resolved Ref to resource: Prod<ESC>[2K<CR>Evil -> b1
 *     Resolved Ref to parameter: Prod<ESC>[2K<CR>Evil -> v
 *     Resolved Fn::GetAtt from attributes: Prod<ESC>[2K<CR>Evil.Arn -> ...
 *     Resource Prod<ESC>[2K<CR>Evil not found for Fn::GetAtt          (THROW)
 *     Fn::GetAtt attribute name for Prod<ESC>[2K<CR>Evil must ...     (THROW)
 *
 * The two throws are the sharp ones: an `IntrinsicResolutionRefusalError` and a
 * plain `Error` both reach the user whatever `--verbose` says.
 *
 * ## What holds these sites: the BYTES, at every site
 *
 * This file drives every render the change touches and reads what comes out.
 * It is deliberately NOT propped up by a source-shape rule: a scan can prove a
 * masker is CALLED and says nothing about what it emits — `maskValueLeaves` was
 * once trusted as one while not sanitizing at all — and a repo that carries a
 * scanner also carries the scanner's own bugs. So the population here is the
 * SITES, one case each, in the shape
 * `importvalue-binding-control-chars.test.ts` and
 * `region-render-control-chars.test.ts` already use.
 *
 * Three groups, because they fail differently:
 *
 *  1. the RENDERS, table-driven below — every `logicalId` interpolation this
 *     change wrapped, driven through the public `resolve` / `resolveParameters`
 *     entry points with a fixture that reaches exactly that arm;
 *  2. the ONE site that is NOT wrapped. `resolvePseudoParameter`'s render is
 *     reached only after that method's `switch` MATCHED, so its id is one of a
 *     handful of cdkd literals rather than template text. That is a claim about
 *     CONTROL FLOW, so it is driven in both directions, with the case labels
 *     read out of the source rather than transcribed;
 *  3. the two `display:` BUILDERS, which are object properties rather than
 *     messages — they reach a `ProvisioningError` one module later.
 *
 * ONE RESIDUAL, stated rather than implied away: `refuseUnservedAttribute` is
 * reached only from a LIVE AWS read, so no unit fixture enters it. Its id is
 * wrapped like its siblings and the wrap is visible in the diff; what is not
 * pinned here is its emitted bytes.
 *
 * That sentence said TWO residuals in its first draft and was wrong about the
 * second: a reviewer found the fabricated-account refusal listed as unreachable
 * when it is reachable offline — `fabricated: true` is set purely from an STS
 * response with no `Account` — and it now has a case of its own below. The
 * lesson is the sentence itself: a residual list is a CLAIM, and the way it
 * goes wrong is by being written from what was easy to drive.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type RedactedAttributeRead,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
/** U+2028: a JSON log viewer and a browser both read it as a line terminator. */
const LS = ' ';
/** U+202E: the Trojan-Source right-to-left override. */
const RLO = '‮';

/**
 * The payload, built from FOUR mechanisms rather than one.
 *
 * `ESC[2K` + CR is what go-to-k/cdkd#3426 measured and is what a terminal acts
 * on. **`U+2028` is the one that DISCRIMINATES** `displayMasked` from a bare
 * `stripControlChars` — the substitution a future simplification would make —
 * because it is outside that helper's class while `displaySafe` maps it to a
 * space. Measured against `src/utils/regexp.ts` rather than assumed: an earlier
 * revision of this comment claimed `U+202E` was in the same position, and it is
 * not — `stripControlChars`'s class includes `\u202a-\u202e`, so BOTH passes
 * remove it. That mattered enough to correct rather than leave: a future author
 * trimming `U+2028` on the strength of the wrong sentence would leave every
 * assertion below satisfiable by the weaker helper (go-to-k/cdkd#3435 review).
 *
 * `U+202E` stays in the needle anyway. It costs nothing, it is the
 * Trojan-Source override this surface is ultimately about, and a render that
 * reached NEITHER helper still fails on it.
 */
const EVIL = `Prod${ESC}[2K${CR}Ev${LS}il${RLO}X`;

/** Every character the builder must not let through, in one place. */
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  [ESC, 'ESC'],
  [CR, 'CR'],
  [LS, 'U+2028'],
  [RLO, 'U+202E'],
];

function expectSanitized(text: string, what: string, tail = 'ilX'): void {
  for (const [ch, name] of FORBIDDEN) {
    expect(text.includes(ch), `${what} still carries ${name}: ${JSON.stringify(text)}`).toBe(false);
  }
  // NOT a bare negative. A render that dropped the id entirely, or one that
  // collapsed to the UNRENDERABLE fallback, would satisfy every line above
  // while saying nothing — so the surviving printable skeleton is pinned too.
  //
  // BOTH halves are distinctive on purpose. The first draft's second needle was
  // `il`, which incidental static text satisfies (`while`, `failed`, `file`) in
  // the `Fn::Sub` case, where the assertion reads a JOINED transcript — so it
  // added nothing there (go-to-k/cdkd#3435 review). `ilX` is the payload's tail
  // as it survives sanitization and appears nowhere else in any message under
  // test, so it fails when the id's tail is lost even though its head survives.
  //
  // `EvilX` would NOT work and the reason is worth recording: `U+2028` sits
  // between `Ev` and `il`, and `displaySafe` maps it to a SPACE rather than
  // deleting it, so the sanitized tail really is `Ev ilX`. A needle assuming
  // the two halves rejoin asserts a strip this surface deliberately does not do.
  //
  // The `tail` PARAMETER exists for the one site rendered by `displayIdent`
  // rather than by the resolver's builder: its `asciiOnly` pass maps EVERY
  // non-ASCII character to a space, so `U+202E` becomes one too and the tail
  // reads `il X`. A caller passing its own needle is stating which renderer it
  // is asserting against, which is better than loosening this one for all.
  expect(text, `${what} lost the id's printable head`).toContain('Prod');
  expect(text, `${what} lost the id's printable tail`).toContain(tail);
}

interface Captured {
  readonly lines: string[];
  readonly error?: string;
}

async function capture(body: () => Promise<unknown>): Promise<Captured> {
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

function contextOf(
  template: CloudFormationTemplate,
  resources: ResolverContext['resources'] = {},
  extra: Partial<ResolverContext> = {}
): ResolverContext {
  return { template, resources, ...extra } as ResolverContext;
}

describe('a hostile logical id cannot redraw the terminal through a resolver render (#3432)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resetAccountInfoCache();
    resolver = new IntrinsicFunctionResolver('us-east-1');
  });

  it('sanitizes the Ref-to-RESOURCE debug line', async () => {
    const template = {
      Resources: { [EVIL]: { Type: 'AWS::S3::Bucket' } },
    } as unknown as CloudFormationTemplate;
    const got = await capture(() =>
      resolver.resolve(
        { Ref: EVIL },
        contextOf(template, {
          [EVIL]: {
            physicalId: 'bucket-1',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            dependencies: [],
          },
        })
      )
    );

    expect(got.lines).toHaveLength(1);
    expect(got.lines[0]).toContain('Resolved Ref to resource:');
    expectSanitized(got.lines[0] ?? '', 'the Ref-to-resource debug line');
  });

  it('sanitizes the Ref-to-PARAMETER debug line', async () => {
    const template = {
      Parameters: { [EVIL]: { Type: 'String', Default: 'plain-value' } },
      Resources: {},
    } as unknown as CloudFormationTemplate;
    // `context.parameters` is the RESOLVED bag, and it is what selects this
    // arm — the template's `Parameters` block only supplies the definition
    // `stringifyParameterForLog` reads. Driving with the template alone falls
    // through to the not-found arm, which is a different (already-fixed) site.
    const got = await capture(() =>
      resolver.resolve(
        { Ref: EVIL },
        contextOf(template, {}, { parameters: { [EVIL]: 'plain-value' } })
      )
    );

    const line = got.lines.find((l) => l.startsWith('Resolved Ref to parameter:'));
    expect(line, `no parameter line in ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(line ?? '', 'the Ref-to-parameter debug line');
  });

  it('sanitizes the Fn::GetAtt-from-attributes debug line', async () => {
    const template = {
      Resources: { [EVIL]: { Type: 'AWS::S3::Bucket' } },
    } as unknown as CloudFormationTemplate;
    const got = await capture(() =>
      resolver.resolve(
        { 'Fn::GetAtt': [EVIL, 'Arn'] },
        contextOf(template, {
          [EVIL]: {
            physicalId: 'bucket-1',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: { Arn: 'arn:aws:s3:::bucket-1' },
            dependencies: [],
          },
        })
      )
    );

    const line = got.lines.find((l) => l.startsWith('Resolved Fn::GetAtt from attributes:'));
    expect(line, `no attributes line in ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(line ?? '', 'the Fn::GetAtt-from-attributes debug line');
  });

  it('sanitizes the resource-not-found THROW, which reaches the user at any verbosity', async () => {
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    const got = await capture(() =>
      resolver.resolve({ 'Fn::GetAtt': [EVIL, 'Arn'] }, contextOf(template))
    );

    expect(got.error).toContain('not found for Fn::GetAtt');
    expectSanitized(got.error ?? '', 'the resource-not-found throw');
  });

  it('sanitizes the attribute-name-type THROW', async () => {
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    const got = await capture(() =>
      resolver.resolve({ 'Fn::GetAtt': [EVIL, 5] }, contextOf(template))
    );

    expect(got.error).toContain('must resolve to a string');
    expectSanitized(got.error ?? '', 'the attribute-name-type throw');
  });

  it('reaches the hostile id through Fn::Sub, the route the marker premise missed', async () => {
    // The `${...}` text is never validated: `resolveSub` hands whatever sits
    // between the braces to `resolveRef`, then to `resolveGetAtt`. This is the
    // half of the premise that made a "CloudFormation requires a static
    // string" marker wrong even for a CDK-synthesized app, whose Resources keys
    // really are alphanumeric.
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    const got = await capture(() =>
      resolver.resolve({ 'Fn::Sub': `x\${${EVIL}.Arn}` }, contextOf(template))
    );

    const emitted = [...got.lines, got.error ?? ''].join('\n');
    expect(emitted).toContain('not found');
    expectSanitized(emitted, 'the Fn::Sub-routed refusal');
  });
});

/**
 * Every REMAINING site the change wrapped, one row each.
 *
 * The rows above drive the arms an ordinary deploy reaches; these are the
 * REFUSALS and the less-travelled debug lines, which is where a source-shape
 * rule used to be the only thing standing. Each fixture is chosen to reach
 * exactly one arm and to refuse BEFORE any AWS call, so the whole table runs
 * offline — every one of them was confirmed reachable by driving it and reading
 * the emitted bytes before being written down here.
 */
describe('every remaining sanitized logicalId render, by its emitted bytes (#3432)', () => {
  interface Row {
    readonly label: string;
    readonly attribute: string;
    readonly record: ResolverContext['resources'][string];
    /** A fragment of the message this row must reach — BOUNDS the arm. */
    readonly reaches: string;
    /** `throw` rows assert on the error; `log` rows on the captured line. */
    readonly kind: 'throw' | 'log';
    readonly strictGetAtt?: boolean;
  }

  const record = (
    over: Partial<ResolverContext['resources'][string]> & { resourceType: string }
  ): ResolverContext['resources'][string] => ({
    physicalId: 'p',
    properties: {},
    dependencies: [],
    ...over,
  });

  const ROWS: readonly Row[] = [
    {
      label: 'the nested-stack no-output refusal (renders the id TWICE)',
      attribute: 'Outputs.Missing',
      record: record({
        resourceType: 'AWS::CloudFormation::Stack',
        attributes: { 'Outputs.Known': 'v' },
      }),
      reaches: 'declares no output named',
      kind: 'throw',
    },
    {
      label: 'the legacy NameServers normalization debug line',
      attribute: 'NameServers',
      record: record({
        resourceType: 'AWS::Route53::HostedZone',
        attributes: { NameServers: 'a,b' },
      }),
      reaches: 'Normalized legacy Fn::GetAtt attribute:',
      kind: 'log',
    },
    {
      label: 'the NESTED-attribute walk debug line',
      attribute: 'Endpoint.Port',
      record: record({
        resourceType: 'AWS::RDS::DBInstance',
        attributes: { Endpoint: { Port: '3306' } },
      }),
      reaches: 'Resolved Fn::GetAtt from nested attributes:',
      kind: 'log',
    },
    {
      label: 'the general Resolved Fn::GetAtt debug line',
      attribute: 'TotallyUnknown',
      record: record({ resourceType: 'AWS::S3::Bucket' }),
      reaches: 'Resolved Fn::GetAtt:',
      kind: 'log',
    },
    {
      label: "the VPC DefaultSecurityGroup id-shape refusal",
      attribute: 'DefaultSecurityGroup',
      record: record({ resourceType: 'AWS::EC2::VPC', physicalId: 'not-a-vpc' }),
      reaches: 'is not a VPC id',
      kind: 'throw',
    },
    {
      label: 'the security-group VpcId id-shape refusal',
      attribute: 'VpcId',
      record: record({ resourceType: 'AWS::EC2::SecurityGroup', physicalId: 'nope' }),
      reaches: 'is not a security group id',
      kind: 'throw',
    },
    {
      label: 'the CloudFront DomainName id-shape refusal',
      attribute: 'DomainName',
      record: record({
        resourceType: 'AWS::CloudFront::Distribution',
        physicalId: 'lower-case',
      }),
      reaches: 'is not a distribution id',
      kind: 'throw',
    },
    {
      label: 'the RDS DBProxy VpcId refusal',
      attribute: 'VpcId',
      record: record({ resourceType: 'AWS::RDS::DBProxy', physicalId: 'a-name' }),
      reaches: 'the state record holds no VpcId for it',
      kind: 'throw',
    },
    {
      label: 'the pre-#1681 placeholder-ARN refusal',
      attribute: 'DataSourceArn',
      record: record({
        resourceType: 'AWS::AppSync::DataSource',
        attributes: { DataSourceArn: 'arn:aws:appsync:*:*:apis/x/datasources/y' },
      }),
      reaches: 'is a placeholder',
      kind: 'throw',
    },
    {
      label: "guardedPhysicalIdFallback's ARN-shape refusal",
      attribute: 'SomethingArn',
      record: record({ resourceType: 'AWS::SQS::Queue' }),
      reaches: 'is not an ARN',
      kind: 'throw',
    },
    {
      label: "guardedPhysicalIdFallback's --strict-getatt refusal",
      attribute: 'Whatever',
      record: record({ resourceType: 'AWS::SQS::Queue' }),
      reaches: '--strict-getatt rejects the physical ID fallback',
      kind: 'throw',
      strictGetAtt: true,
    },
  ];

  for (const row of ROWS) {
    it(`sanitizes ${row.label}`, async () => {
      resetAccountInfoCache();
      const resolver = new IntrinsicFunctionResolver('us-east-1', {
        cfnFallback: false,
        ...(row.strictGetAtt === true && { strictGetAtt: true }),
      });
      const template = {
        Resources: { [EVIL]: { Type: row.record.resourceType } },
      } as unknown as CloudFormationTemplate;
      const got = await capture(() =>
        resolver.resolve(
          { 'Fn::GetAtt': [EVIL, row.attribute] },
          contextOf(template, { [EVIL]: row.record })
        )
      );

      // BOUND THE ARM before reading what it emitted. Without this a fixture
      // that stopped reaching its arm passes on whatever else the resolver
      // said — the failure mode that makes a table like this look thorough
      // while asserting nothing.
      const text =
        row.kind === 'throw'
          ? (got.error ?? '')
          : (got.lines.find((l) => l.includes(row.reaches)) ?? '');
      expect(text, `did not reach the arm: ${JSON.stringify(got)}`).toContain(row.reaches);
      expectSanitized(text, row.label);
    });
  }

  it('sanitizes the FABRICATED-ACCOUNT refusal, which STS reachability hid', async () => {
    // FOUND BY REVIEW, not by the table above (go-to-k/cdkd#3435 round 2). This
    // site was wrapped by the same sweep and then listed as unreachable offline
    // — wrongly: `accountInfo.fabricated` is set from an STS response that
    // simply carries no `Account`, which the suite's own mock can produce. The
    // row needs its own case rather than a table entry because it is the only
    // one that has to change the STS answer.
    vi.resetModules();
    vi.doMock('../../../src/utils/aws-clients.js', () => ({
      getAwsClients: () => ({ sts: { send: vi.fn().mockResolvedValue({}) } }),
    }));
    try {
      const mod = await import('../../../src/deployment/intrinsic-function-resolver.js');
      mod.resetAccountInfoCache();
      const resolver = new mod.IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      const template = {
        Resources: { [EVIL]: { Type: 'AWS::SQS::Queue' } },
      } as unknown as CloudFormationTemplate;

      const got = await capture(() =>
        resolver.resolve({ 'Fn::GetAtt': [EVIL, 'Arn'] }, {
          template,
          resources: {
            [EVIL]: {
              physicalId: 'p',
              resourceType: 'AWS::SQS::Queue',
              properties: {},
              dependencies: [],
            },
          },
        } as unknown as ResolverContext)
      );

      expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
        'STS did not report'
      );
      expectSanitized(got.error ?? '', 'the fabricated-account refusal');
    } finally {
      vi.doUnmock('../../../src/utils/aws-clients.js');
      vi.resetModules();
    }
  });

  it('sanitizes the unbound-parameter refusal, reached through resolveParameters', async () => {
    // NOT an `Fn::GetAtt` site, and not in go-to-k/cdkd#3432's own grep either
    // — that population was defined by the marker naming `logicalId`, and this
    // one names `name`. Same class one expression name over: a `Parameters` KEY
    // is arbitrary JSON just as a `Resources` key is, and a reviewer measured
    // this throw emitting a live ESC + CR.
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = {
      Parameters: { [EVIL]: { Type: 'String' } },
      Resources: {},
    } as unknown as CloudFormationTemplate;

    const got = await capture(() => resolver.resolveParameters(template, {}));

    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      'is required but no value was provided'
    );
    expectSanitized(got.error ?? '', 'the unbound-parameter refusal');
  });
});

/**
 * The same class one EXPRESSION NAME over: a template-declared `Parameters` /
 * `Conditions` KEY.
 *
 * go-to-k/cdkd#3432's population was defined by grepping the exclusion note
 * that names `logicalId`, so these sites were outside it — while carrying the
 * IDENTICAL premise ("a template-DECLARED identifier, which CloudFormation
 * requires to be a literal"), which is false for the same reason: cdkd reads
 * the template as JSON and `cdkd import --migrate-from-cloudformation` reads a
 * hand-written one. Two of them are DEFAULT-verbosity — an unbound-condition
 * warn and a nested-stack parameter throw.
 *
 * Swept in review round 2 (go-to-k/cdkd#3435) after the first round fixed only
 * the one throw a reviewer measured and left five siblings in the same loop
 * body on the refuted premise.
 */
describe('a template-declared PARAMETER or CONDITION name is sanitized too (#3432)', () => {
  it('sanitizes the parameter debug lines, both the user-value and default arms', async () => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = {
      Parameters: { [EVIL]: { Type: 'String', Default: 'the-default' } },
      Resources: {},
    } as unknown as CloudFormationTemplate;

    const fromDefault = await capture(() => resolver.resolveParameters(template, {}));
    const defaultLine = fromDefault.lines.find((l) => l.includes('using default value'));
    expect(defaultLine, `no default line: ${JSON.stringify(fromDefault)}`).toBeDefined();
    expectSanitized(defaultLine ?? '', 'the parameter default-value debug line');

    const fromUser = await capture(() =>
      resolver.resolveParameters(template, { [EVIL]: 'supplied' })
    );
    const userLine = fromUser.lines.find((l) => l.includes('using user-provided value'));
    expect(userLine, `no user-value line: ${JSON.stringify(fromUser)}`).toBeDefined();
    expectSanitized(userLine ?? '', 'the parameter user-value debug line');
  });

  it('sanitizes the undeclared-condition WARN, which prints at default verbosity', async () => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    // A `{Condition: X}` reference to a condition the template does not
    // declare: warn-and-treat-as-false, so the NAME reaches a default-verbosity
    // line on an otherwise successful run.
    const template = {
      Conditions: { Declared: { Condition: EVIL } },
      Resources: {},
    } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.evaluateConditions({ template, resources: {} } as unknown as ResolverContext)
    );

    const warn = got.lines.find((l) => l.includes('not found in template'));
    expect(warn, `no undeclared-condition warn: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(warn ?? '', 'the undeclared-condition warn');
  });

  it('sanitizes the condition-evaluated debug line', async () => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = {
      Conditions: { [EVIL]: { 'Fn::Equals': ['a', 'a'] } },
      Resources: {},
    } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.evaluateConditions({ template, resources: {} } as unknown as ResolverContext)
    );

    const line = got.lines.find((l) => l.startsWith('Evaluated condition'));
    expect(line, `no evaluated-condition line: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(line ?? '', 'the condition-evaluated debug line');
  });

  it("sanitizes Fn::If's not-in-context WARN, which prints at default verbosity", async () => {
    // FOUND BY DRIVING, not by reading (go-to-k/cdkd#3435 review round 2). The
    // `Fn::If` path does NOT reach `evaluateByName` -- it reads
    // `context.conditions` and warns when the name is absent -- so it has its
    // own render, which the sweep of `evaluateConditions` had missed. Measured
    // emitting a raw ESC + CR before this change.
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = { Conditions: {}, Resources: {} } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.resolve({ 'Fn::If': [EVIL, 'a', 'b'] }, {
        template,
        resources: {},
      } as unknown as ResolverContext)
    );

    const warn = got.lines.find((l) => l.includes('not found in context'));
    expect(warn, `no not-in-context warn: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(warn ?? '', "Fn::If's not-in-context warn");
  });

  it("sanitizes Fn::If's selected-branch debug line", async () => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = { Conditions: {}, Resources: {} } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.resolve({ 'Fn::If': [EVIL, 'a', 'b'] }, {
        template,
        resources: {},
        conditions: { [EVIL]: true },
      } as unknown as ResolverContext)
    );

    const line = got.lines.find((l) => l.startsWith('Resolved Fn::If:'));
    expect(line, `no selected-branch line: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(line ?? '', "Fn::If's selected-branch debug line");
  });

  it('sanitizes the unsupported-intrinsic THROW, whose id is the template key itself', async () => {
    // `key` here is the template's OWN object key. Same class as a `Resources`
    // key and reached with no bag at all, so it takes `displayIdent` rather
    // than the resolver's masking builder.
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = { Resources: {} } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.resolve({ [`Fn::${EVIL}`]: 'x' }, {
        template,
        resources: {},
      } as unknown as ResolverContext)
    );

    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      'Unsupported CloudFormation intrinsic function'
    );
    // `il X`, not `ilX`: see `expectSanitized`'s note -- this is the one site
    // rendered by `displayIdent`, whose ASCII pass turns `U+202E` into a space
    // as well.
    expectSanitized(got.error ?? '', 'the unsupported-intrinsic throw', 'il X');
    // ...and the BOUNDARY is visible. The needle is `""Fn::Prod`, a DOUBLE
    // quote character, not a single `"`: the sentence carries hand-written
    // quotes around the call, so `toContain('"')` could not fail (measured in
    // review round 3 -- it passed against a bare render). What the doubled
    // needle asserts is `displayIdent`'s OWN JSON quoting, which fires here
    // precisely because sanitization altered this id, and which is ABSENT for
    // the ordinary `Fn::Length` keys seven cases in
    // `intrinsic-functions.test.ts` pin.
    expect(got.error).toContain(`""Fn::Prod`);
  });

  it("sanitizes Fn::Split's source clause, which two THROWS carry", async () => {
    // FOUND BY THE SECURITY ROUND, and it is the one this PR's own close
    // condition missed: `describeSplitValueSource` builds `Ref <args>` /
    // `Fn::GetAtt [<arg>]` out of RAW template text, and two
    // `IntrinsicResolutionRefusalError` throws interpolate the clause. Nothing
    // re-masks that class downstream. The three exclusion notes that used to
    // exempt it said "assembled from literals here", contradicted by the
    // builder's own doc comment one method up.
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const template = {
      Parameters: { [EVIL]: { Type: 'CommaDelimitedList', Default: 'a,b' } },
      Resources: {},
    } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.resolve({ 'Fn::Split': [',', { Ref: EVIL }] }, {
        template,
        resources: {},
        parameters: { [EVIL]: ['a', 'b'] },
      } as unknown as ResolverContext)
    );

    expect(got.error, `did not reach the arm: ${JSON.stringify(got)}`).toContain(
      'is ALREADY a list'
    );
    // The clause is what carries the id -- assert it is present, or the case
    // would pass on a refusal that dropped the source entirely.
    expect(got.error).toContain('(from Ref ');
    expectSanitized(got.error ?? '', "Fn::Split's source clause");
  });

  it('does not CRASH on a non-string Fn::If condition name', async () => {
    // A REGRESSION THIS PR ALMOST SHIPPED (review round 3, measured).
    // `resolveIf`'s arguments arrive through an unchecked cast, so element 0
    // can be an object; the bare interpolation this change replaced coerced it,
    // while `displayMasked` -> `stripControlChars` calls `.replace` and threw a
    // TypeError. A template that used to warn-and-assume-false would have
    // failed the resource with an opaque error.
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const template = { Conditions: {}, Resources: {} } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.resolve({ 'Fn::If': [{ Ref: 'E' }, 'a', 'b'] }, {
        template,
        resources: {},
      } as unknown as ResolverContext)
    );

    // The pre-existing behaviour, restored: warn and take the FALSE branch.
    expect(got.error, `it threw: ${JSON.stringify(got)}`).toBeUndefined();
    expect(got.lines.some((l) => l.includes('not found in context'))).toBe(true);
    // ...and no TypeError text leaked into the line either.
    expect(got.lines.join('\n')).not.toContain('is not a function');
  });

  it('sanitizes the AWS::NoValue property-omission debug line', async () => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const template = { Resources: {} } as unknown as CloudFormationTemplate;

    const got = await capture(() =>
      resolver.resolve({ [EVIL]: { Ref: 'AWS::NoValue' } }, {
        template,
        resources: {},
      } as unknown as ResolverContext)
    );

    const line = got.lines.find((l) => l.includes('resolved to AWS::NoValue'));
    expect(line, `no NoValue line: ${JSON.stringify(got)}`).toBeDefined();
    expectSanitized(line ?? '', 'the AWS::NoValue omission debug line');
  });
});

describe('the pseudo-parameter render keeps its marker, and the premise is driven (#3432)', () => {
  /**
   * The case labels, READ OUT OF THE SOURCE rather than transcribed.
   *
   * A transcribed list is a second copy of the decision and goes stale the
   * moment another pseudo parameter is added — at which point this file would
   * still pass while saying nothing about the new arm. Deriving them from the
   * `switch` means a new `case` is either covered or trips the floor.
   *
   * It also caught a transcription error while this file was being written:
   * the first draft of both this test and the marker it fences said NINE, and
   * the walk reported EIGHT.
   */
  function pseudoParameterCases(): string[] {
    // `fileURLToPath`, not a cwd-relative path (go-to-k/cdkd#3435 review): this
    // was the only cwd-relative `src/` read under `tests/unit`, and it reads as
    // a "source file missing" failure from any other working directory. The
    // sibling suite added in the same PR already spells it this way.
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/deployment/intrinsic-function-resolver.ts', import.meta.url)),
      'utf8'
    );
    const start = source.indexOf('private async resolvePseudoParameter(');
    expect(start, 'resolvePseudoParameter was renamed or removed').toBeGreaterThan(-1);
    // Brace-match the method body rather than scanning a fixed window: the
    // method is long, carries several multi-line comments, and a window is
    // exactly the instrument a comment-bearing method defeats — the window
    // would have to guess where the method ends.
    const open = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = source.slice(open, end);
    // THE WALK MUST HAVE REACHED THE END OF THE METHOD, asserted from the body
    // rather than from the count (go-to-k/cdkd#3435 review). The matcher counts
    // braces inside strings and comments, so an unbalanced one added to a
    // comment truncates the slice — and a truncation that still yields the
    // current number of labels would clear a floor equal to that number, which
    // is what the floor alone was worth. The method's LAST arm is its
    // `default`, so a body missing it is a body that was cut short.
    expect(body, 'the brace walk did not reach resolvePseudoParameter\'s end').toContain(
      'default:'
    );
    expect(body).toContain('return undefined;');
    return [...body.matchAll(/case '([^']+)':/g)].map((m) => m[1] as string);
  }

  it('drives EVERY case label the switch carries, and each renders byte-identically', async () => {
    const names = pseudoParameterCases();
    // A FLOOR on a population the test does not itself produce. Without it a
    // brace scan that matched nothing would report "all zero names passed".
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toContain('AWS::Region');
    expect(names).toContain('AWS::NoValue');

    for (const name of names) {
      resetAccountInfoCache();
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const template = { Resources: {} } as unknown as CloudFormationTemplate;
      const got = await capture(() => resolver.resolve({ Ref: name }, contextOf(template)));

      const line = got.lines.find((l) => l.startsWith('Resolved Ref to pseudo parameter:'));
      expect(line, `${name} did not reach the pseudo-parameter render: ${JSON.stringify(got)}`)
        .toBeDefined();
      // The id is rendered RAW at this site, and that is the marker's claim:
      // it is one of these literals, so raw and sanitized are the same bytes.
      expect(line).toContain(`Resolved Ref to pseudo parameter: ${name} -> `);
    }
  });

  it('a NEAR-MISS spelling misses every case and lands on the sanitizing not-found arm', async () => {
    // The other direction, and the one that makes the marker checkable rather
    // than asserted: if a template-supplied name COULD reach that render, the
    // marker would be false. It cannot, because the `switch` compares whole
    // strings — so the hostile spelling falls through to the not-found arm,
    // which go-to-k/cdkd#3426 already routed through the builder.
    for (const name of ['AWS::Region', 'AWS::AccountId', 'AWS::NoValue']) {
      resetAccountInfoCache();
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const template = { Resources: {} } as unknown as CloudFormationTemplate;
      const hostile = `${name}${ESC}[2K${CR}`;
      const got = await capture(() => resolver.resolve({ Ref: hostile }, contextOf(template)));

      expect(
        got.lines.some((l) => l.startsWith('Resolved Ref to pseudo parameter:')),
        `${JSON.stringify(hostile)} reached the pseudo-parameter render`
      ).toBe(false);
      const emitted = [...got.lines, got.error ?? ''].join('\n');
      expect(emitted).toContain('not found');
      for (const [ch, label] of FORBIDDEN) {
        if (!hostile.includes(ch)) continue;
        expect(emitted.includes(ch), `the not-found arm let ${label} through`).toBe(false);
      }
    }
  });
});

describe('the two redacted-read DISPLAY builders sanitize their logical id (#3432)', () => {
  // Neither of these is a message: they are object properties that reach the
  // user through `DeployEngine`'s refusal, which joins `display` into a
  // `ProvisioningError` at default verbosity — one module and one data
  // structure away from the renders above, which is why they get their own
  // cases rather than riding on those.
  const TABLE_TYPE = 'AWS::S3Tables::Table';
  const TABLE_ARN =
    'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/6f1f5a90-2847-4b1a-9d6f-zz2847zz';

  it('sanitizes noteRefStateMask\'s `Ref <id> (state key <Key>)` display', async () => {
    const redactedAttributeReads: RedactedAttributeRead[] = [];
    const template = {
      Resources: { [EVIL]: { Type: TABLE_TYPE, Properties: {} } },
    } as unknown as CloudFormationTemplate;
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    await resolver.resolve(
      { Ref: EVIL },
      contextOf(
        template,
        {
          [EVIL]: {
            physicalId: TABLE_ARN,
            resourceType: TABLE_TYPE,
            properties: { TableName: SECRET_MASK },
            dependencies: [],
          },
        },
        { redactedAttributeReads }
      )
    );

    expect(redactedAttributeReads).toHaveLength(1);
    const read = redactedAttributeReads[0]!;
    expectSanitized(read.display, 'the ref-state-key display');
    // The SENTENCE `DeployEngine`'s `hasRefStateRead` arm points the reader at
    // must survive the sanitization, or that advice stops matching anything.
    expect(read.display.startsWith('Ref ')).toBe(true);
    expect(read.display).toContain('(state key TableName)');
    // The FIELD stays raw: it is the routing key `maskedRecordRemedyFor`
    // partitions on and the id its `--resource <id>=` command interpolates, so
    // a sanitized copy there would name a resource that does not exist.
    expect(read.logicalId).toBe(EVIL);
  });

  it('sanitizes noteAttributeSecrecy\'s `<id>.<attr>` display', async () => {
    const redactedAttributeReads: RedactedAttributeRead[] = [];
    const template = {
      Resources: { [EVIL]: { Type: 'Custom::Thing', Properties: {} } },
    } as unknown as CloudFormationTemplate;
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    await resolver.resolve(
      { 'Fn::GetAtt': [EVIL, 'Secret'] },
      contextOf(
        template,
        {
          [EVIL]: {
            physicalId: 'cr-phys',
            resourceType: 'Custom::Thing',
            properties: {},
            attributes: { Secret: SECRET_MASK },
            dependencies: [],
          },
        },
        { redactedAttributeReads }
      )
    );

    expect(redactedAttributeReads).toHaveLength(1);
    const read = redactedAttributeReads[0]!;
    expectSanitized(read.display, 'the attribute display');
    expect(read.display.endsWith('.Secret')).toBe(true);
    expect(read.logicalId).toBe(EVIL);
  });
});
