/**
 * The resolver's `--verbose` `Resolved …` lines run nothing when pasted into a
 * shell (issue [#4161](https://github.com/go-to-k/cdkd/issues/4161)).
 *
 * Each line used to put cdkd's own ` -> ` right before a BARE render of the
 * resolved value. Pasted, `->` is `-` plus a `>` redirect whose target is the
 * render, so a template value chose a file to truncate: `Resolved Ref to
 * resource: Thing -> bucket` truncates `./bucket`. The line now says
 * `resolved to`, which carries no shell operator.
 *
 * The render after the joiner, and every name before it, was bare too, so a
 * value or name chosen by a template or a state record ran or redirected on
 * its own (`resolved to x>OWNED`). Each value and name now prints only when it
 * is shell-inert with its quotes stripped (`isInertUnquoted`, with the `***`
 * mask allowed) and is not a shell assignment word (`HISTFILE=~/victim` or
 * `PATH+=:.` as a clause's first word assigns); anything else is DESCRIBED as
 * `UNSHOWABLE_VALUE`, never JSON-quoted (the go-to-k/cdkd#4229 decision: a
 * double quote still expands `$( )`, a backtick and `!`, and an unpaired `"`
 * above the selection turns a JSON boundary inside out). cdkd's own
 * `<redacted>` token stays bare when the caller says it produced it; a JSON
 * render (a list or object, a `Fn::Select` / `Fn::Split` / `Fn::Equals` /
 * `Fn::FindInMap` / `Fn::GetAZs` result) stays while it parses and every key
 * and string leaf is inert, since a flipped quote leaves each leaf bare. A
 * `***` still globs: harmless as an argument, go-to-k/cdkd#4249's class as a
 * clause's first word, as is a plain name that is itself a command word.
 * A value holding a clause break (go-to-k/cdkd#4089) holds a space, so it is
 * described too; the payload table drives that family.
 *
 * Every paste below runs twice: as printed (the harness adds its `'` flip,
 * `OPERATOR_FLIP`), and below {@link DQ_FLIP}, a line holding an unpaired
 * `"`. The harness has no `"` variant yet (go-to-k/cdkd#4229 adds one), so
 * this file measures it locally.
 *
 * Two tables. The first resolves a value that NAMES one of the paste
 * harness's decoys (or renders to a filename the sweep sees as created), so
 * the old joiner's redirect shows. The second drives every payload family
 * through each site class, the value and each name on the line: NOTHING may
 * run, `$( )` and a backtick included, since nothing is displayed in quotes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { UNSHOWABLE_VALUE } from '../../../src/utils/pasteable-command.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/**
 * Terminal output above the line holding one unpaired `"` (an AWS error such
 * as `Invalid value "prod`): the go-to-k/cdkd#4229 measurement that turns every
 * JSON boundary inside out.
 */
const DQ_FLIP = 'Invalid value "prod';

/**
 * Nothing runs when `line` is pasted: as printed, below {@link DQ_FLIP}, and
 * between two such lines. One unpaired `"` above leaves the rest of the paste
 * inside a quote that the line's own even count of `"` cannot close, so most
 * of it is refused as unterminated; a second one below closes it and leaves
 * the line's quoted parts bare.
 */
function expectPastesNothing(line: string, dir: string, label = line): void {
  expect(spansThatRun(line, dir), label).toEqual([]);
  expect(spansThatRun(`${DQ_FLIP}\n${line}`, dir), `under a \" flip: ${label}`).toEqual([]);
  expect(
    spansThatRun(`${DQ_FLIP}\n${line}\n${DQ_FLIP}`, dir),
    `between two \" flips: ${label}`
  ).toEqual([]);
}

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

/** The zone `DescribeAvailabilityZones` answers: a decoy, or a payload. */
const zone = vi.hoisted(() => ({ name: 'region' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn(async () => ({ Account: '123456789012' })) },
    ec2: { send: vi.fn(async () => ({ AvailabilityZones: [{ ZoneName: zone.name }] })) },
  }),
}));

async function debugLinesOf(body: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const logger = await import('../../../src/utils/logger.js');
  const got = logger.getLogger() as unknown as Record<string, unknown>;
  const previous = got['debug'];
  got['debug'] = (m: unknown): void => void lines.push(String(m));
  try {
    await body();
  } finally {
    got['debug'] = previous;
  }
  return lines;
}

const TEMPLATE = {
  Parameters: { Plain: { Type: 'String' } },
  Mappings: { M: { a: { b: 'profile' } } },
  Resources: {
    Thing: { Type: 'AWS::S3::Bucket' },
    Queue: { Type: 'AWS::SQS::Queue' },
    Zone: { Type: 'AWS::Route53::HostedZone' },
    Param: { Type: 'AWS::SSM::Parameter' },
  },
} as unknown as CloudFormationTemplate;

function context(): ResolverContext {
  const record = (resourceType: string, physicalId: string, attributes: Record<string, unknown>) => ({
    physicalId,
    resourceType,
    properties: {},
    attributes,
    dependencies: [],
  });
  return {
    template: TEMPLATE,
    resources: {
      Thing: record('AWS::S3::Bucket', 'bucket', { Arn: 'id', Endpoint: { Port: 'prefix' } }),
      // No `Attr` recorded: the unknown attribute falls back to the physical id.
      Queue: record('AWS::SQS::Queue', 'physicalId', {}),
      Zone: record('AWS::Route53::HostedZone', 'Z0000000000', { NameServers: 'name,id' }),
      // A record lacking `Arn`: the #1852 healer re-reads it from AWS.
      Param: record('AWS::SSM::Parameter', '/app/config', { Type: 'String', Value: 'v' }),
    },
    parameters: { Plain: 'name' },
    stackName: 'stack',
    attributeHealer: vi.fn().mockResolvedValue({ kind: 'read', attributes: { Arn: 'runId' } }),
  } as unknown as ResolverContext;
}

/**
 * One row per `Resolved …` family reachable without AWS: the intrinsic, the
 * line's fixed prefix, and the target the pre-fix ` -> ` redirected onto (a
 * decoy, or the filename the render becomes once the shell strips its quotes).
 */
const ROWS: ReadonlyArray<{
  intrinsic: unknown;
  prefix: string;
  target: string;
  /** Resolve twice, for the line only a second, cached resolution prints. */
  twice?: boolean;
}> = [
  { intrinsic: { Ref: 'Thing' }, prefix: 'Resolved Ref to resource: ', target: 'bucket' },
  { intrinsic: { Ref: 'Plain' }, prefix: 'Resolved Ref to parameter: ', target: 'name' },
  { intrinsic: { Ref: 'AWS::StackName' }, prefix: 'Resolved Ref to pseudo parameter: ', target: 'stack' },
  {
    intrinsic: { 'Fn::GetAtt': ['Thing', 'Arn'] },
    prefix: 'Resolved Fn::GetAtt from attributes: ',
    target: 'id',
  },
  {
    intrinsic: { 'Fn::GetAtt': ['Thing', 'Endpoint.Port'] },
    prefix: 'Resolved Fn::GetAtt from nested attributes: ',
    target: 'prefix',
  },
  { intrinsic: { 'Fn::GetAtt': ['Queue', 'Attr'] }, prefix: 'Resolved Fn::GetAtt: ', target: 'physicalId' },
  {
    intrinsic: { 'Fn::GetAtt': ['Zone', 'NameServers'] },
    prefix: 'Normalized legacy Fn::GetAtt attribute: ',
    target: '[name,id]',
  },
  {
    intrinsic: { 'Fn::GetAtt': ['Param', 'Arn'] },
    prefix: 'Resolved Fn::GetAtt from a re-read of AWS (the state record lacked it): ',
    target: 'runId',
  },
  { intrinsic: { 'Fn::FindInMap': ['M', 'a', 'b'] }, prefix: 'Resolved Fn::FindInMap: ', target: 'profile' },
  { intrinsic: { 'Fn::Select': [0, ['region', 'x']] }, prefix: 'Resolved Fn::Select: ', target: 'region' },
  { intrinsic: { 'Fn::Split': [',', 'region,id'] }, prefix: 'Resolved Fn::Split: ', target: '[region,id]' },
  { intrinsic: { 'Fn::Base64': 'prefix' }, prefix: 'Resolved Fn::Base64: ', target: 'cHJlZml4' },
  { intrinsic: { 'Fn::Equals': ['a', 'b'] }, prefix: 'Resolved Fn::Equals: ', target: 'false' },
  {
    intrinsic: { 'Fn::And': [{ 'Fn::Equals': ['a', 'a'] }, { 'Fn::Equals': ['a', 'a'] }] },
    prefix: 'Resolved Fn::And: ',
    target: 'true',
  },
  {
    intrinsic: { 'Fn::Or': [{ 'Fn::Equals': ['a', 'b'] }, { 'Fn::Equals': ['a', 'b'] }] },
    prefix: 'Resolved Fn::Or: ',
    target: 'false',
  },
  { intrinsic: { 'Fn::Not': [{ 'Fn::Equals': ['a', 'b'] }] }, prefix: 'Resolved Fn::Not: ', target: 'true' },
  { intrinsic: { 'Fn::GetAZs': '' }, prefix: 'Resolved Fn::GetAZs: ', target: '[region]' },
  {
    intrinsic: { 'Fn::GetAZs': '' },
    prefix: 'Resolved Fn::GetAZs from cache: ',
    target: '[region]',
    twice: true,
  },
];

describe('a pasted `Resolved …` debug line redirects nothing (#4161)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(ROWS)('$prefix line', async ({ intrinsic, prefix, target, twice }) => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const lines = await debugLinesOf(async () => {
      await resolver.resolve(intrinsic, context());
      if (twice) await resolver.resolve(intrinsic, context());
    });
    const line = lines.find((l) => l.startsWith(prefix));
    expect(line, `no ${JSON.stringify(prefix)} line among ${JSON.stringify(lines)}`).toBeDefined();
    // The render the pre-fix ` -> ` pointed at is still on the line, AFTER
    // the joiner, so the case reaches the shape it guards rather than a line
    // without a value (an operand before the joiner, `[true, true]`, does not
    // count). Split on the OLD joiner too, so a revert passes this premise and
    // reds at the paste below, which is the property.
    const joiner = prefix.startsWith('Normalized') ? ' normalized to ' : ' resolved to ';
    const tail = line!.split(/ (?:resolved|normalized) to | -> /).slice(1).join(' ');
    expect(tail.replace(/"/g, '')).toContain(target);
    // The paste first: it is the property, and the spelling pin below would
    // otherwise be the assertion that reds a revert.
    withPasteDir((dir) => {
      expectPastesNothing(line!, dir);
    });
    // Each line's own joiner: only the legacy attribute line says `normalized to`.
    expect(line).toContain(joiner);
  }, 60_000);
});

/**
 * The families a value or name can carry: the harness's four, its clause-break
 * family (go-to-k/cdkd#4089: a selection starting inside the value), plus a
 * bare `|` and `>`, which the old bare render ran or redirected on even
 * without a joiner in front of them.
 */
const PAYLOADS: readonly string[] = [
  ...PASTE_PAYLOADS.map((p) => p.value),
  CLAUSE_BREAK_PAYLOAD.value,
  'x|touch OWNED',
  'x>OWNED',
];

/** A context whose every template- or state-chosen slot holds `v`. */
function hostileContext(v: string, over: Record<string, unknown> = {}): ResolverContext {
  const record = (resourceType: string, physicalId: string, attributes: Record<string, unknown>) => ({
    physicalId,
    resourceType,
    properties: {},
    attributes,
    dependencies: [],
  });
  return {
    template: {
      Parameters: { Plain: { Type: 'String' }, [`P${v}`]: { Type: 'String' } },
      Mappings: { M: { a: { b: v, [v]: 'profile' }, [v]: { b: 'profile' } }, [v]: { a: { b: 'profile' } } },
      Resources: {
        Thing: { Type: 'AWS::S3::Bucket' },
        [v]: { Type: 'AWS::S3::Bucket' },
        Queue: { Type: 'AWS::SQS::Queue' },
        Zone: { Type: 'AWS::Route53::HostedZone' },
        Param: { Type: 'AWS::SSM::Parameter' },
      },
    } as unknown as CloudFormationTemplate,
    resources: {
      Thing: record('AWS::S3::Bucket', v, { Arn: v, [v]: 'id', Endpoint: { Port: v, [v]: 'id' } }),
      [v]: record('AWS::S3::Bucket', 'bucket', {}),
      Queue: record('AWS::SQS::Queue', v, {}),
      Zone: record('AWS::Route53::HostedZone', 'Z0000000000', { NameServers: v }),
      Param: record('AWS::SSM::Parameter', '/app/config', { Type: 'String', Value: 'v' }),
    },
    parameters: { Plain: v, [`P${v}`]: 'name' },
    conditions: { [v]: true },
    stackName: v,
    attributeHealer: vi.fn().mockResolvedValue({ kind: 'read', attributes: { Arn: v } }),
    ...over,
  } as unknown as ResolverContext;
}

/** One row per site class: the intrinsic, given the payload, and its line. */
const SITES: ReadonlyArray<{ site: string; intrinsic: (v: string) => unknown; prefix: string }> = [
  { site: 'Ref resource value', intrinsic: () => ({ Ref: 'Thing' }), prefix: 'Resolved Ref to resource: ' },
  { site: 'Ref resource logical id', intrinsic: (v) => ({ Ref: v }), prefix: 'Resolved Ref to resource: ' },
  { site: 'Ref parameter value', intrinsic: () => ({ Ref: 'Plain' }), prefix: 'Resolved Ref to parameter: ' },
  { site: 'Ref parameter name', intrinsic: (v) => ({ Ref: `P${v}` }), prefix: 'Resolved Ref to parameter: ' },
  {
    site: 'Ref pseudo parameter value',
    intrinsic: () => ({ Ref: 'AWS::StackName' }),
    prefix: 'Resolved Ref to pseudo parameter: ',
  },
  {
    site: 'GetAtt attribute value',
    intrinsic: () => ({ 'Fn::GetAtt': ['Thing', 'Arn'] }),
    prefix: 'Resolved Fn::GetAtt from attributes: ',
  },
  {
    site: 'GetAtt attribute name',
    intrinsic: (v) => ({ 'Fn::GetAtt': ['Thing', v] }),
    prefix: 'Resolved Fn::GetAtt from attributes: ',
  },
  {
    site: 'GetAtt logical id (the physical-id fallback line)',
    intrinsic: (v) => ({ 'Fn::GetAtt': [v, 'Attr'] }),
    prefix: 'Resolved Fn::GetAtt: ',
  },
  {
    site: 'GetAtt nested attribute name',
    intrinsic: (v) => ({ 'Fn::GetAtt': ['Thing', `Endpoint.${v}`] }),
    prefix: 'Resolved Fn::GetAtt from nested attributes: ',
  },
  {
    site: 'GetAtt nested attribute value',
    intrinsic: () => ({ 'Fn::GetAtt': ['Thing', 'Endpoint.Port'] }),
    prefix: 'Resolved Fn::GetAtt from nested attributes: ',
  },
  {
    site: 'GetAtt physical-id fallback',
    intrinsic: () => ({ 'Fn::GetAtt': ['Queue', 'Attr'] }),
    prefix: 'Resolved Fn::GetAtt: ',
  },
  {
    site: 'GetAtt legacy NameServers value',
    intrinsic: () => ({ 'Fn::GetAtt': ['Zone', 'NameServers'] }),
    prefix: 'Normalized legacy Fn::GetAtt attribute: ',
  },
  {
    site: 'GetAtt re-read value',
    intrinsic: () => ({ 'Fn::GetAtt': ['Param', 'Arn'] }),
    prefix: 'Resolved Fn::GetAtt from a re-read of AWS (the state record lacked it): ',
  },
  {
    site: 'FindInMap value',
    intrinsic: () => ({ 'Fn::FindInMap': ['M', 'a', 'b'] }),
    prefix: 'Resolved Fn::FindInMap: ',
  },
  {
    site: 'FindInMap key',
    intrinsic: (v) => ({ 'Fn::FindInMap': ['M', v, 'b'] }),
    prefix: 'Resolved Fn::FindInMap: ',
  },
  {
    site: 'FindInMap map name',
    intrinsic: (v) => ({ 'Fn::FindInMap': [v, 'a', 'b'] }),
    prefix: 'Resolved Fn::FindInMap: ',
  },
  {
    site: 'FindInMap second-level key',
    intrinsic: (v) => ({ 'Fn::FindInMap': ['M', 'a', v] }),
    prefix: 'Resolved Fn::FindInMap: ',
  },
  { site: 'Select value', intrinsic: (v) => ({ 'Fn::Select': [0, [v]] }), prefix: 'Resolved Fn::Select: ' },
  { site: 'Split value', intrinsic: (v) => ({ 'Fn::Split': [',', v] }), prefix: 'Resolved Fn::Split: ' },
  // The delimiter sits inside cdkd's own `"…"`, where `quotedRender` admits a
  // `>`; a flipped quote leaves it bare.
  { site: 'Split delimiter', intrinsic: (v) => ({ 'Fn::Split': [v, 'a'] }), prefix: 'Resolved Fn::Split: ' },
  { site: 'Base64 input', intrinsic: (v) => ({ 'Fn::Base64': v }), prefix: 'Resolved Fn::Base64: ' },
  { site: 'Equals operand', intrinsic: (v) => ({ 'Fn::Equals': [v, 'b'] }), prefix: 'Resolved Fn::Equals: ' },
  // The GetAZs REGION is not a row: a payload fails `isClientSafeRegion` and
  // is refused before the line is printed.
  { site: 'GetAZs zone', intrinsic: () => ({ 'Fn::GetAZs': '' }), prefix: 'Resolved Fn::GetAZs: ' },
  // The `Resolved …` lines with no joiner, and the `AWS::NoValue` line: the
  // same bare render, swept with the rest.
  { site: 'Join result', intrinsic: (v) => ({ 'Fn::Join': ['', [v]] }), prefix: 'Resolved Fn::Join: ' },
  { site: 'Sub result', intrinsic: (v) => ({ 'Fn::Sub': v }), prefix: 'Resolved Fn::Sub: ' },
  {
    site: 'If condition name',
    intrinsic: (v) => ({ 'Fn::If': [v, 'a', 'b'] }),
    prefix: 'Resolved Fn::If: condition ',
  },
  {
    site: 'AWS::NoValue property key',
    intrinsic: (v) => ({ [v]: { Ref: 'AWS::NoValue' }, kept: 'k' }),
    prefix: 'Property ',
  },
];

describe('a value or name on a `Resolved …` line runs nothing when pasted (#4161)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
  });
  afterEach(() => {
    zone.name = 'region';
    vi.clearAllMocks();
  });

  it.each(SITES)('$site', async ({ intrinsic, prefix }) => {
    const rendered: Array<{ payload: string; line: string }> = [];
    for (const payload of PAYLOADS) {
      resetAccountInfoCache();
      zone.name = payload;
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      const lines = await debugLinesOf(() => resolver.resolve(intrinsic(payload), hostileContext(payload)));
      const line = lines.find((l) => l.startsWith(prefix));
      expect(line, `${payload}: no ${JSON.stringify(prefix)} line among ${JSON.stringify(lines)}`).toBeDefined();
      rendered.push({ payload, line: line! });
    }
    // The paste first: it is the property, so a revert reds HERE.
    withPasteDir((dir) => {
      for (const { payload, line } of rendered) {
        expectPastesNothing(line, dir, `${payload} on ${JSON.stringify(line)}`);
      }
    });
    // Then the shape: the payload reached THIS line and was described there,
    // no part of it printed and a description in its slot.
    for (const { payload, line } of rendered) {
      expect(line, payload).toMatch(/a value that cannot be shown safely here|a delimiter \(not shown/);
      expect(line, payload).not.toContain('OWNED');
    }
  }, 180_000);
});

describe('only cdkd\'s own tokens pass bare (#4243 review)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
  });

  async function lineOf(intrinsic: unknown, context: ResolverContext, prefix: string): Promise<string> {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const lines = await debugLinesOf(() => resolver.resolve(intrinsic, context));
    const line = lines.find((l) => l.startsWith(prefix));
    expect(line, `no ${JSON.stringify(prefix)} line among ${JSON.stringify(lines)}`).toBeDefined();
    return line!;
  }

  it('describes a template-chosen `<redacted>`, which bare is a `<` and a `>` redirect', async () => {
    const v = '<redacted>';
    const lines = [
      // A plain physical id, so the attribute name is the only `<redacted>`
      // and sits mid-line, where its redirect has a target.
      await lineOf(
        { 'Fn::GetAtt': ['Queue', v] },
        (() => {
          const context = hostileContext(v);
          (context.resources['Queue'] as { physicalId: string }).physicalId = 'physicalId';
          return context;
        })(),
        'Resolved Fn::GetAtt: '
      ),
      await lineOf({ 'Fn::FindInMap': ['M', v, 'b'] }, hostileContext(v), 'Resolved Fn::FindInMap: '),
      await lineOf({ 'Fn::Base64': v }, hostileContext(v), 'Resolved Fn::Base64: '),
      await lineOf({ 'Fn::Join': ['', [v]] }, hostileContext(v), 'Resolved Fn::Join: '),
      await lineOf({ Ref: 'Plain' }, hostileContext(v), 'Resolved Ref to parameter: '),
    ];
    withPasteDir((dir) => {
      // The input side of the redirect needs the file to exist; with it, a
      // bare mid-line render truncated `resolved` (GetAtt, Base64) or `.b`
      // (FindInMap). A bare `<redacted>` at a line's END (Join, the Ref value)
      // is a syntax error that runs nothing, so for those two the description
      // pin below is the only guard.
      writeFileSync(join(dir, 'redacted'), 'decoy\n', 'utf8');
      for (const line of lines) expectPastesNothing(line, dir);
    });
    for (const line of lines) {
      expect(line).not.toContain('<redacted>');
      expect(line).toContain(UNSHOWABLE_VALUE);
    }
  }, 60_000);

  it("CONTROL: a NoEcho parameter's own `<redacted>` still prints bare", async () => {
    const context = {
      ...hostileContext('v'),
      template: {
        Parameters: { Secret: { Type: 'String', NoEcho: true } },
        Resources: {},
      } as unknown as CloudFormationTemplate,
      parameters: { Secret: 'hunter2-value' },
    } as unknown as ResolverContext;
    expect(await lineOf({ Ref: 'Secret' }, context, 'Resolved Ref to parameter: ')).toBe(
      'Resolved Ref to parameter: Secret resolved to <redacted>'
    );
  });

  it.each([
    { site: 'Ref parameter value', intrinsic: { Ref: 'L' }, prefix: 'Resolved Ref to parameter: ' },
    {
      site: 'FindInMap value',
      intrinsic: { 'Fn::FindInMap': ['M', 'a', 'b'] },
      prefix: 'Resolved Fn::FindInMap: ',
    },
  ])('describes a structured render whose mask unbalanced its JSON quotes: $site', async ({ intrinsic, prefix }) => {
    // A recorded secret holding a `"` of the structure: masked, the list's
    // JSON lost a quote, and bare it paired with the next line's.
    const context = {
      ...hostileContext('v'),
      template: {
        Parameters: { L: { Type: 'CommaDelimitedList' } },
        Mappings: { M: { a: { b: ['abcd', 'xyz'] } } },
        Resources: { T: { Type: 'AWS::S3::Bucket' } },
      } as unknown as CloudFormationTemplate,
      resources: {
        T: {
          physicalId: 'bucket',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: { Obj: { a: 1 } },
          dependencies: [],
        },
      },
      parameters: { L: ['abcd', 'xyz'] },
      recordedSecretValues: new Map([['abcd",', '{{resolve:ssm:/x}}']]),
    } as unknown as ResolverContext;
    const first = await lineOf(intrinsic, context, prefix);
    expect(first).not.toContain('abcd');
    const block = [
      first,
      await lineOf({ 'Fn::GetAtt': ['T', 'Obj'] }, context, 'Resolved Fn::GetAtt from attributes: '),
      await lineOf({ 'Fn::Join': ['', ['a; touch OWNED; #']] }, context, 'Resolved Fn::Join: '),
    ].join('\n');
    withPasteDir((dir) => {
      expectPastesNothing(block, dir);
    });
    expect(first.split(' resolved to ')[1], first).toBe(UNSHOWABLE_VALUE);
  }, 60_000);

  it('describes a render shaped as a shell assignment, which a pasted clause would run', async () => {
    // Its characters are all bare-safe, but as a clause's first word it
    // ASSIGNS: `HISTFILE=~/victim` truncates the file at an interactive bash's
    // exit, `PATH=.` redirects every later command. Nothing the harness sees
    // runs, so the spelling is the assertion. Quoted it would assign nothing,
    // but the rule is one: what is not inert is described.
    // The APPEND form (`+=`) assigns as well: `PATH+=:.` adds the working
    // directory to the search path.
    for (const v of ['HISTFILE=~/victim', 'PATH=.', 'PATH+=:.', 'HISTFILE+=/tmp/v']) {
      expect(await lineOf({ 'Fn::Join': ['', [v]] }, hostileContext('v'), 'Resolved Fn::Join: ')).toBe(
        `Resolved Fn::Join: ${UNSHOWABLE_VALUE}`
      );
      expect(await lineOf({ 'Fn::Sub': v }, hostileContext('v'), 'Resolved Fn::Sub: ')).toBe(
        `Resolved Fn::Sub: ${UNSHOWABLE_VALUE}`
      );
      expect(await lineOf({ Ref: 'Plain' }, hostileContext(v), 'Resolved Ref to parameter: ')).toBe(
        `Resolved Ref to parameter: Plain resolved to ${UNSHOWABLE_VALUE}`
      );
    }
    // CONTROL: `=` elsewhere in a word is not an assignment, and stays bare.
    expect(await lineOf({ 'Fn::Join': ['', ['a.b=c']] }, hostileContext('v'), 'Resolved Fn::Join: ')).toBe(
      'Resolved Fn::Join: a.b=c'
    );
  });
});

describe('CONTROL: the `"` flip this file adds is not vacuous (#4161)', () => {
  it('runs the JSON-quoted spelling the description replaced, and only under the flip', () => {
    // What a JSON-bounded render of the separator payload printed before the
    // go-to-k/cdkd#4229 decision: inert as printed, inside out below an
    // unpaired `"`.
    const jsonQuoted = 'Resolved Fn::Select: index 0 resolved to ["x; touch OWNED; #"]';
    // And the Split delimiter `quotedRender` admitted inside cdkd's `"…"`: its
    // `>` redirects once the quote flips.
    const quotedDelimiter = 'Resolved Fn::Split: split by "x>OWNED" resolved to ["a"]';
    withPasteDir((dir) => {
      for (const line of [jsonQuoted, quotedDelimiter]) {
        expect(spansThatRun(line, dir), line).toEqual([]);
        // The JSON one runs below one flip (its payload's `#` hides the
        // closing quote); the delimiter needs the second flip below to close
        // the quote its `>` sits in.
        expect(spansThatRun(`${DQ_FLIP}\n${line}\n${DQ_FLIP}`, dir).length, line).toBeGreaterThan(0);
      }
    });
  }, 60_000);
});
