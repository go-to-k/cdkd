/**
 * The resolver's remaining log lines run nothing when pasted into a shell
 * (issue [#4250](https://github.com/go-to-k/cdkd/issues/4250)).
 *
 * go-to-k/cdkd#4243 bounded the `--verbose` `Resolved …` lines through
 * `logRender`; every OTHER line the resolver logs still printed a template-,
 * state- or AWS-chosen value through a bare `displayMasked`, which keeps `;`,
 * `|`, `>`, `&`, `$( )`, a backtick and spaces. Several print at DEFAULT
 * verbosity (the condition warns, the physical-id fallback warns, the
 * `Resolved Fn::ImportValue` / `Fn::GetStackOutput` info lines). Each value now
 * goes through the same bound: printed only when it is shell-inert with its
 * quotes stripped, otherwise DESCRIBED as `UNSHOWABLE_VALUE`, never JSON-quoted
 * (the go-to-k/cdkd#4229 decision). A value inside a quote of cdkd's own is
 * quoted only when it is inert too, since `quotedRender` admits `>` and `|`,
 * which a flipped quote leaves bare. Where AWS's message ECHOES the value
 * beside it (a `DescribeVpcs` / `DescribeStacks` / state-read failure), the
 * echo takes the same render.
 *
 * Every paste runs as printed (the harness adds its `'` flip), below
 * {@link DQ_FLIP}, and between two such lines, as in
 * `resolver-resolved-line-paste-4161.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { displayIdent } from '../../../src/utils/display-safe.js';
import { UNSHOWABLE_VALUE } from '../../../src/utils/pasteable-command.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  OPERATOR_FLIP,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/** An unpaired `"` above the pasted line (go-to-k/cdkd#4229's measurement). */
const DQ_FLIP = 'Invalid value "prod';

function expectPastesNothing(line: string, dir: string, label = line): void {
  expect(spansThatRun(line, dir), label).toEqual([]);
  // The harness flips the `'` parity ABOVE the line; a second flip BELOW
  // closes it, which is what leaves a value inside cdkd's own `'…'` bare.
  expect(spansThatRun(`${line}\n${OPERATOR_FLIP}`, dir), `between two ' flips: ${label}`).toEqual([]);
  expect(spansThatRun(`${DQ_FLIP}\n${line}`, dir), `under a " flip: ${label}`).toEqual([]);
  expect(
    spansThatRun(`${DQ_FLIP}\n${line}\n${DQ_FLIP}`, dir),
    `between two " flips: ${label}`
  ).toEqual([]);
}

/** Every line the resolver logs, at any level, in order. */
const logged = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../../../src/utils/logger.js', () => {
  const push = (m: unknown): void => void logged.lines.push(String(m));
  const fns = {
    setLevel: vi.fn(),
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

type Send = (command: { constructor: { name: string }; input?: Record<string, unknown> }) => Promise<unknown>;

/** What each mocked AWS client answers; a row sets the ones it reaches. */
const aws = vi.hoisted(() => ({
  ec2: (async () => ({})) as Send,
  ssm: (async () => ({})) as Send,
  secrets: (async () => ({})) as Send,
  cfn: (async () => ({})) as Send,
}));

vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = {
    sts: { send: async () => ({ Account: '123456789012' }) },
    ec2: { send: (c: never) => aws.ec2(c) },
    ssm: { send: (c: never) => aws.ssm(c) },
    secretsManager: { send: (c: never) => aws.secrets(c) },
    withRegion: () => clients,
  };
  return { getAwsClients: () => clients };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(function () {
      return { send: (c: never) => aws.cfn(c), destroy: vi.fn() };
    }),
  };
});

/** A state backend: `stacks` listed, each answering its outputs, or `null`. */
function backend(
  stacks: ReadonlyArray<{ stackName: string; region?: string; outputs?: unknown; fail?: Error }>
): S3StateBackend {
  return {
    listStacks: vi.fn(async () => stacks.map(({ stackName, region }) => ({ stackName, region }))),
    getState: vi.fn(async (name: string) => {
      const stack = stacks.find((s) => s.stackName === name);
      if (stack?.fail) throw stack.fail;
      if (stack?.outputs === undefined) return null;
      return {
        state: {
          version: 8,
          stackName: name,
          region: 'us-east-1',
          resources: {},
          outputs: stack.outputs,
          lastModified: 1,
        },
        etag: 'e',
      };
    }),
  } as unknown as S3StateBackend;
}

const EMPTY_TEMPLATE = { Resources: {} } as unknown as CloudFormationTemplate;

function ctx(over: Record<string, unknown> = {}): ResolverContext {
  return { template: EMPTY_TEMPLATE, resources: {}, ...over } as unknown as ResolverContext;
}

/** A context holding one resource `id` of `type`. */
function oneResource(
  id: string,
  type: string,
  physicalId: string,
  over: Record<string, unknown> = {}
): ResolverContext {
  return ctx({
    template: { Resources: { [id]: { Type: type } } },
    resources: {
      [id]: { physicalId, resourceType: type, properties: {}, attributes: {}, dependencies: [] },
    },
    ...over,
  });
}

/** Run `body`, swallowing a refusal: its message is pasted like a line. */
async function linesOf(body: () => Promise<unknown>): Promise<string[]> {
  logged.lines = [];
  let refusal: string | undefined;
  try {
    await body();
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }
  // A `.catch` handler the resolver chained (the exports-index patch) logs a
  // tick later.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return refusal === undefined ? [...logged.lines] : [...logged.lines, refusal];
}

const resolver = (region = 'us-east-1', cfnFallback = false): IntrinsicFunctionResolver =>
  new IntrinsicFunctionResolver(region, { cfnFallback });

/** A nested stack `id` whose recorded `attribute` is a dynamic reference. */
function nestedOrigin(id: string, attribute: string): Promise<string[]> {
  aws.ssm = async () => ({ Parameter: { Value: 'x', Type: 'String' } });
  const type = 'AWS::CloudFormation::Stack';
  return linesOf(() =>
    resolver().resolve(
      { 'Fn::GetAtt': [id, attribute] },
      ctx({
        template: { Resources: { [id]: { Type: type } } },
        resources: {
          [id]: {
            physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/Child/uuid',
            resourceType: type,
            properties: {},
            attributes: { [attribute]: '{{resolve:ssm:/p}}' },
            dependencies: [],
          },
        },
      })
    )
  );
}

const echo = (text: string): Error => new Error(`The ID '${text}' does not exist`);

interface Site {
  readonly site: string;
  /** Drive the site with `v` in the slot under test; the lines it logged. */
  readonly drive: (v: string) => Promise<string[]>;
  /** Which logged line (or refusal) is the site's. */
  readonly pick: (line: string) => boolean;
}

const starts =
  (prefix: string) =>
  (line: string): boolean =>
    line.startsWith(prefix);

/** One row per site class: the slot's value is the payload. */
const SITES: readonly Site[] = [
  // ---- resolveParameters' debug lines -------------------------------------
  {
    site: 'Parameter name (default-value line)',
    drive: (v) =>
      linesOf(() =>
        resolver().resolveParameters({
          Parameters: { [v]: { Type: 'String', Default: 'd' } },
          Resources: {},
        } as unknown as CloudFormationTemplate)
      ),
    pick: (l) => l.includes('using default value'),
  },
  {
    site: 'Parameter name (skipped SSM line)',
    drive: (v) =>
      linesOf(() =>
        resolver().resolveParameters({
          Parameters: { [v]: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/p' } },
          Resources: {},
        } as unknown as CloudFormationTemplate)
      ),
    pick: (l) => l.includes('skipping SSM resolution'),
  },
  {
    site: 'Parameter default value',
    drive: (v) =>
      linesOf(() =>
        resolver().resolveParameters({
          Parameters: { P: { Type: 'String', Default: v } },
          Resources: {},
        } as unknown as CloudFormationTemplate)
      ),
    pick: (l) => l.includes('using default value'),
  },
  {
    // A parsed-JSON list Default, which `coerceParameterDefault` passes
    // through, so the line takes the structured (JSON) arm.
    site: 'Parameter list default (a JSON render)',
    drive: (v) =>
      linesOf(() =>
        resolver().resolveParameters({
          Parameters: { P: { Type: 'CommaDelimitedList', Default: ['a', v] } },
          Resources: {},
        } as unknown as CloudFormationTemplate)
      ),
    pick: (l) => l.includes('using default value'),
  },
  {
    site: 'Parameter user-provided value',
    drive: (v) =>
      linesOf(() =>
        resolver().resolveParameters(
          { Parameters: { P: { Type: 'String' } }, Resources: {} } as unknown as CloudFormationTemplate,
          { P: v }
        )
      ),
    pick: (l) => l.includes('using user-provided value'),
  },
  {
    site: 'Parameter SSM path',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: 'x', Type: 'String' } });
      return linesOf(() =>
        resolver().resolveParameters({
          Parameters: { P: { Type: 'AWS::SSM::Parameter::Value<String>', Default: v } },
          Resources: { R: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { Ref: 'P' } } } },
        } as unknown as CloudFormationTemplate)
      );
    },
    pick: (l) => l.includes('resolving SSM parameter path'),
  },
  {
    site: 'Parameter resolved SSM value',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: v, Type: 'String' } });
      return linesOf(() =>
        resolver().resolveParameters({
          Parameters: { P: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/p' } },
          Resources: { R: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { Ref: 'P' } } } },
        } as unknown as CloudFormationTemplate)
      );
    },
    pick: (l) => l.includes('resolved SSM value'),
  },
  // ---- conditions ---------------------------------------------------------
  {
    site: 'undeclared condition WARN',
    drive: (v) =>
      linesOf(() =>
        resolver().evaluateConditions(
          ctx({ template: { Conditions: { D: { Condition: v } }, Resources: {} } })
        )
      ),
    pick: (l) => l.includes('not found in template'),
  },
  {
    site: 'evaluated condition',
    drive: (v) =>
      linesOf(() =>
        resolver().evaluateConditions(
          ctx({ template: { Conditions: { [v]: { 'Fn::Equals': ['a', 'a'] } }, Resources: {} } })
        )
      ),
    pick: starts('Evaluated condition '),
  },
  {
    site: 'failed condition WARN',
    drive: (v) =>
      linesOf(() =>
        resolver().evaluateConditions(
          ctx({ template: { Conditions: { [v]: { Ref: 'NoSuchThing' } }, Resources: {} } })
        )
      ),
    pick: starts('Failed to evaluate condition '),
  },
  {
    // The caught message names the condition too: the circular refusal
    // quotes it inside cdkd's own `"…"`.
    site: 'failed condition WARN, a circular condition',
    drive: (v) =>
      linesOf(() =>
        resolver().evaluateConditions(
          ctx({ template: { Conditions: { [v]: { Condition: v } }, Resources: {} } })
        )
      ),
    pick: starts('Failed to evaluate condition '),
  },
  {
    site: 'Fn::If condition not in context WARN',
    drive: (v) => linesOf(() => resolver().resolve({ 'Fn::If': [v, 'a', 'b'] }, ctx({ conditions: {} }))),
    pick: (l) => l.includes('not found in context'),
  },
  // ---- Fn::Sub placeholders and the Ref they re-enter (DEFAULT verbosity) ---
  {
    site: 'Ref not-found WARN and the Fn::Sub keep-placeholder WARN',
    drive: (v) => linesOf(() => resolver().resolve({ 'Fn::Sub': `a-\${${v}}` }, ctx())),
    pick: (l) => l.startsWith('Ref ') || l.startsWith('Fn::Sub variable '),
  },
  {
    site: 'Fn::Sub keep-placeholder WARN, a dotted placeholder',
    drive: (v) => linesOf(() => resolver().resolve({ 'Fn::Sub': `a-\${${v}.Arn}` }, ctx())),
    pick: starts('Fn::Sub variable '),
  },
  {
    // A control character in the name: the caught reason spells the name
    // through `displayMasked`, which deletes it, so its echo must be keyed on
    // that spelling too.
    site: 'Fn::Sub keep-placeholder WARN, a name holding a control character',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve({ 'Fn::Sub': `a-\${x\u001b${v}} b-\${y\u0007${v}.Arn}` }, ctx())
      ),
    pick: starts('Fn::Sub variable '),
  },
  // ---- a state record named like a parameter -----------------------------
  {
    site: 'ignored state record named like a parameter',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { Ref: v },
          ctx({
            template: { Parameters: { [v]: { Type: 'String' } }, Resources: {} },
            parameters: { [v]: 'x' },
            resources: {
              [v]: { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {}, dependencies: [] },
            },
          })
        )
      ),
    pick: starts('Ignoring the state record named '),
  },
  // ---- EC2 reads keyed by a state-record physical id ----------------------
  {
    site: 'VPC Ipv6CidrBlocks resolved line (the id)',
    drive: (v) => {
      aws.ec2 = async () => ({
        Vpcs: [
          {
            Ipv6CidrBlockAssociationSet: [
              { Ipv6CidrBlock: '2001:db8::/56', Ipv6CidrBlockState: { State: 'associated' } },
            ],
          },
        ],
      });
      return linesOf(() =>
        resolver().resolve({ 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] }, oneResource('Vpc', 'AWS::EC2::VPC', v))
      );
    },
    pick: starts('Resolved VPC Ipv6CidrBlocks for '),
  },
  {
    site: 'VPC Ipv6CidrBlocks resolved line (a block AWS returned)',
    drive: (v) => {
      aws.ec2 = async () => ({
        Vpcs: [
          { Ipv6CidrBlockAssociationSet: [{ Ipv6CidrBlock: v, Ipv6CidrBlockState: { State: 'associated' } }] },
        ],
      });
      return linesOf(() =>
        resolver().resolve(
          { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] },
          oneResource('Vpc', 'AWS::EC2::VPC', 'vpc-0abc')
        )
      );
    },
    pick: starts('Resolved VPC Ipv6CidrBlocks for '),
  },
  {
    site: 'VPC no-associations line',
    drive: (v) => {
      aws.ec2 = async () => ({ Vpcs: [{ Ipv6CidrBlockAssociationSet: [] }] });
      return linesOf(() =>
        resolver().resolve({ 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] }, oneResource('Vpc', 'AWS::EC2::VPC', v))
      );
    },
    pick: starts('No IPv6 CIDR associations found for VPC '),
  },
  {
    site: 'VPC Ipv6CidrBlocks failure WARN, the id and its echo',
    drive: (v) => {
      aws.ec2 = async (c) => {
        throw echo(String((c.input?.['VpcIds'] as string[])[0]));
      };
      return linesOf(() =>
        resolver().resolve({ 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] }, oneResource('Vpc', 'AWS::EC2::VPC', v))
      );
    },
    pick: starts('Failed to fetch VPC Ipv6CidrBlocks for '),
  },
  {
    site: 'DescribeLaunchTemplates failure WARN, the id and its echo',
    drive: (v) => {
      aws.ec2 = async (c) => {
        throw echo(String((c.input?.['LaunchTemplateIds'] as string[])[0]));
      };
      return linesOf(() =>
        resolver().resolve(
          { 'Fn::GetAtt': ['Lt', 'LatestVersionNumber'] },
          oneResource('Lt', 'AWS::EC2::LaunchTemplate', v)
        )
      );
    },
    pick: starts('DescribeLaunchTemplates('),
  },
  // ---- the physical-id fallback warns (DEFAULT verbosity) -----------------
  {
    site: 'unknown-attribute WARN, the attribute name',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve({ 'Fn::GetAtt': ['Q', v] }, oneResource('Q', 'AWS::SQS::Queue', 'physicalId'))
      ),
    pick: starts('Unknown attribute '),
  },
  {
    site: 'unknown-attribute WARN, the resource type',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve({ 'Fn::GetAtt': ['Q', 'Whatever'] }, oneResource('Q', `AWS::${v}`, 'physicalId'))
      ),
    pick: starts('Unknown attribute '),
  },
  {
    site: 'stale-record WARN, the attribute name',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::GetAtt': ['Q', v] },
          oneResource('Q', 'AWS::SQS::Queue', 'physicalId', {
            attributeHealer: async () => ({ kind: 'not-found' }),
          })
        )
      ),
    pick: starts('The state record for '),
  },
  {
    site: 'stale-record WARN, the logical id',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::GetAtt': [v, 'Whatever'] },
          oneResource(v, 'AWS::SQS::Queue', 'physicalId', {
            attributeHealer: async () => ({ kind: 'not-found' }),
          })
        )
      ),
    pick: starts('The state record for '),
  },
  // ---- the nested-stack origin label ---------------------------------------
  {
    site: 'Re-resolving line, a nested stack logical id',
    drive: (v) => nestedOrigin(v, 'Outputs.Foo'),
    pick: starts('Re-resolving dynamic reference(s) in nested stack '),
  },
  {
    site: 'Re-resolving line, a nested stack attribute',
    drive: (v) => nestedOrigin('Child', `Outputs.${v}`),
    pick: starts('Re-resolving dynamic reference(s) in nested stack '),
  },
  // ---- Fn::ImportValue ----------------------------------------------------
  {
    site: 'ImportValue export name (Resolving and Found lines, not-found refusal)',
    drive: (v) =>
      linesOf(() => resolver().resolve({ 'Fn::ImportValue': v }, ctx({ stateBackend: backend([]) }))),
    pick: (l) =>
      l.startsWith('Resolving Fn::ImportValue: ') ||
      l.startsWith('Found ') ||
      l.startsWith('Fn::ImportValue: export '),
  },
  {
    site: 'ImportValue resolved from a stack, the export name',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': v },
          ctx({ stateBackend: backend([{ stackName: 'Producer', region: 'us-east-1', outputs: { [v]: 'val' } }]) })
        )
      ),
    pick: starts('Resolved Fn::ImportValue: '),
  },
  {
    site: 'ImportValue resolved from a stack, the producer stack',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({ stateBackend: backend([{ stackName: v, region: 'us-east-1', outputs: { Exp: 'val' } }]) })
        )
      ),
    pick: starts('Resolved Fn::ImportValue: '),
  },
  {
    site: 'ImportValue resolved from the exports index, the producer stack',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({
            stackName: 'Consumer',
            stateBackend: backend([]),
            exportIndex: {
              lookup: async () => ({ value: 'val', producerStack: v, producerRegion: 'us-east-1' }),
            } as unknown as ExportIndexStore,
          })
        )
      ),
    pick: starts('Resolved Fn::ImportValue: '),
  },
  {
    site: 'Re-resolving line, the producer stack in the origin',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: 'x', Type: 'String' } });
      return linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({
            stackName: 'Consumer',
            stateBackend: backend([]),
            exportIndex: {
              lookup: async () => ({
                value: '{{resolve:ssm:/p}}',
                producerStack: v,
                producerRegion: 'us-east-1',
              }),
            } as unknown as ExportIndexStore,
          })
        )
      );
    },
    pick: starts('Re-resolving dynamic reference(s) in '),
  },
  {
    site: 'ImportValue resolved from the exports index, the producer region',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({
            stackName: 'Consumer',
            stateBackend: backend([]),
            exportIndex: {
              lookup: async () => ({ value: 'val', producerStack: 'Producer', producerRegion: v }),
            } as unknown as ExportIndexStore,
          })
        )
      ),
    pick: starts('Resolved Fn::ImportValue: '),
  },
  {
    site: 'ImportValue resolved from a stack, the listed region',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({ stateBackend: backend([{ stackName: 'Producer', region: v, outputs: { Exp: 'val' } }]) })
        )
      ),
    pick: starts('Resolved Fn::ImportValue: '),
  },
  {
    site: 'Re-resolving line, the producer stack of a state-scan import',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: 'x', Type: 'String' } });
      return linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({
            stateBackend: backend([
              { stackName: v, region: 'us-east-1', outputs: { Exp: '{{resolve:ssm:/p}}' } },
            ]),
          })
        )
      );
    },
    pick: starts('Re-resolving dynamic reference(s) in '),
  },
  {
    site: 'Re-resolving line, the output name of a GetStackOutput',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: 'x', Type: 'String' } });
      return linesOf(() =>
        resolver().resolve(
          { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: v } },
          ctx({
            stateBackend: backend([
              { stackName: 'Producer', region: 'us-east-1', outputs: { [v]: '{{resolve:ssm:/p}}' } },
            ]),
          })
        )
      );
    },
    pick: starts('Re-resolving dynamic reference(s) in '),
  },
  {
    site: 'skipping the current stack',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({ stackName: v, stateBackend: backend([{ stackName: v, region: 'us-east-1' }]) })
        )
      ),
    pick: starts('Skipping current stack: '),
  },
  {
    site: 'no state found for a listed stack',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({ stateBackend: backend([{ stackName: v, region: 'us-east-1' }]) })
        )
      ),
    pick: starts('No state found for stack: '),
  },
  {
    // `S3StateBackend.getState` names the region through `displayIdent`, so a
    // non-plain one reaches the message JSON-quoted.
    site: 'failed state read WARN, the region as getState echoes it',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({
            stateBackend: backend([
              {
                stackName: 'Producer',
                region: v,
                fail: new Error(`Failed to get state for stack Producer (${displayIdent(v)}): AccessDenied`),
              },
            ]),
          })
        )
      ),
    pick: starts('Failed to read state for stack '),
  },
  {
    site: 'failed state read WARN, the stack and its echo',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': 'Exp' },
          ctx({
            stateBackend: backend([
              { stackName: v, region: 'us-east-1', fail: new Error(`cannot read cdkd/${v}/us-east-1/state.json`) },
            ]),
          })
        )
      ),
    pick: starts('Failed to read state for stack '),
  },
  {
    site: 'exports index lookup failure WARN',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': v },
          ctx({
            stateBackend: backend([]),
            exportIndex: {
              lookup: async () => {
                throw new Error('AccessDenied: cdkd/_index/us-east-1/exports.json');
              },
            } as unknown as ExportIndexStore,
          })
        )
      ),
    pick: starts('Exports index lookup failed for '),
  },
  {
    site: 'exports index patch failure line',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::ImportValue': v },
          ctx({
            stateBackend: backend([{ stackName: 'Producer', region: 'us-east-1', outputs: { [v]: 'val' } }]),
            exportIndex: {
              lookup: async () => undefined,
              patchEntry: async () => {
                throw new Error('AccessDenied');
              },
            } as unknown as ExportIndexStore,
          })
        )
      ),
    pick: starts('Failed to patch exports index for '),
  },
  {
    site: 'ImportValue resolved from CloudFormation, the exporting stack id',
    drive: (v) => {
      aws.cfn = async () => ({ Exports: [{ Name: 'Exp', Value: 'val', ExportingStackId: v }] });
      return linesOf(() =>
        resolver('us-east-1', true).resolve({ 'Fn::ImportValue': 'Exp' }, ctx({ stateBackend: backend([]) }))
      );
    },
    pick: starts('Resolved Fn::ImportValue: '),
  },
  {
    site: 'ListExports fallback failure WARN, the export name',
    drive: (v) => {
      aws.cfn = async () => {
        throw new Error('AccessDenied');
      };
      return linesOf(() =>
        resolver('us-east-1', true).resolve({ 'Fn::ImportValue': v }, ctx({ stateBackend: backend([]) }))
      );
    },
    pick: (l) => l.includes('ListExports fallback failed'),
  },
  {
    site: "ListExports fallback failure WARN, the resolver's region",
    drive: (v) => {
      aws.cfn = async () => {
        throw new Error('AccessDenied');
      };
      return linesOf(() =>
        resolver(v, true).resolve({ 'Fn::ImportValue': 'Exp' }, ctx({ stateBackend: backend([]) }))
      );
    },
    pick: (l) => l.includes('ListExports fallback failed'),
  },
  // ---- Fn::GetStackOutput -------------------------------------------------
  {
    site: 'GetStackOutput Resolving line, the stack name',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::GetStackOutput': { StackName: v, OutputName: 'Out' } },
          ctx({ stateBackend: backend([]) })
        )
      ),
    pick: starts('Resolving Fn::GetStackOutput: '),
  },
  {
    site: 'GetStackOutput Resolving line, the output name',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: v } },
          ctx({ stateBackend: backend([]) })
        )
      ),
    pick: starts('Resolving Fn::GetStackOutput: '),
  },
  {
    site: "GetStackOutput Resolving line, the resolver's region",
    drive: (v) =>
      linesOf(() =>
        resolver(v).resolve(
          { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out' } },
          ctx({ stateBackend: backend([]) })
        )
      ),
    pick: starts('Resolving Fn::GetStackOutput: '),
  },
  {
    site: 'GetStackOutput Resolving line, the role ARN',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Out', RoleArn: v } },
          ctx({ stateBackend: backend([]) })
        )
      ),
    pick: starts('Resolving Fn::GetStackOutput: '),
  },
  {
    site: 'GetStackOutput resolved from a stack',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::GetStackOutput': { StackName: v, OutputName: 'Out' } },
          ctx({ stateBackend: backend([{ stackName: v, region: 'us-east-1', outputs: { Out: 'val' } }]) })
        )
      ),
    pick: starts('Resolved Fn::GetStackOutput: '),
  },
  {
    site: 'GetStackOutput resolved from CloudFormation',
    drive: (v) => {
      aws.cfn = async () => ({ Stacks: [{ Outputs: [{ OutputKey: v, OutputValue: 'val' }] }] });
      return linesOf(() =>
        resolver('us-east-1', true).resolve(
          { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: v } },
          ctx({ stateBackend: backend([]) })
        )
      );
    },
    pick: starts('Resolved Fn::GetStackOutput: '),
  },
  {
    site: 'DescribeStacks fallback failure WARN, the stack and its echo',
    drive: (v) => {
      aws.cfn = async (c) => {
        throw new Error(`ValidationError: Stack with id ${String(c.input?.['StackName'])} does not exist`);
      };
      return linesOf(() =>
        resolver('us-east-1', true).resolve(
          { 'Fn::GetStackOutput': { StackName: v, OutputName: 'Out' } },
          ctx({ stateBackend: backend([]) })
        )
      );
    },
    pick: (l) => l.includes('DescribeStacks fallback failed'),
  },
  {
    site: "the malformed-record refusal, which ends on 'cdkd state show'",
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          { 'Fn::GetStackOutput': { StackName: v, OutputName: 'Out' } },
          ctx({ stateBackend: backend([{ stackName: v, region: 'us-east-1', outputs: 'torn' }]) })
        )
      ),
    pick: starts('Fn::GetStackOutput: the state record of producer stack '),
  },
  // ---- dynamic references ---------------------------------------------------
  {
    site: 'secretsmanager Resolving line, the secret id',
    drive: (v) => {
      aws.secrets = async () => ({ SecretString: JSON.stringify({ k: 'val' }) });
      return linesOf(() => resolver().resolve(`{{resolve:secretsmanager:${v}:SecretString:k}}`, ctx()));
    },
    pick: starts('Resolving dynamic reference: secretsmanager:'),
  },
  {
    site: 'secretsmanager Resolving line, the json key',
    drive: (v) => {
      aws.secrets = async () => ({ SecretString: JSON.stringify({ k: 'val' }) });
      return linesOf(() => resolver().resolve(`{{resolve:secretsmanager:sid:SecretString:${v}}}`, ctx()));
    },
    pick: starts('Resolving dynamic reference: secretsmanager:'),
  },
  {
    site: 'ssm Resolving line, the parameter name',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: 'val', Type: 'String' } });
      return linesOf(() => resolver().resolve(`{{resolve:ssm:${v}}}`, ctx()));
    },
    pick: starts('Resolving dynamic reference: ssm:'),
  },
  {
    site: 'secretsmanager Resolving line, the version stage and id',
    drive: (v) => {
      aws.secrets = async () => ({ SecretString: JSON.stringify({ k: 'val' }) });
      return linesOf(() => resolver().resolve(`{{resolve:secretsmanager:sid:SecretString:k:${v}:${v}}}`, ctx()));
    },
    pick: starts('Resolving dynamic reference: secretsmanager:'),
  },
  {
    site: 'ssm unrecognized-Type WARN, the parameter name',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: 'val', Type: 'Weird' } });
      return linesOf(() => resolver().resolve(`{{resolve:ssm:${v}}}`, ctx()));
    },
    pick: starts('SSM parameter '),
  },
  {
    site: 'ssm unrecognized-Type WARN, the Type AWS reported',
    drive: (v) => {
      aws.ssm = async () => ({ Parameter: { Value: 'val', Type: v } });
      return linesOf(() => resolver().resolve('{{resolve:ssm:/p}}', ctx()));
    },
    pick: starts('SSM parameter '),
  },
  {
    site: 'unsupported dynamic reference service WARN',
    drive: (v) => linesOf(() => resolver().resolve(`{{resolve:${v}}}`, ctx())),
    pick: starts('Unsupported dynamic reference service: '),
  },
  {
    // A secret ARN's region is not gated before the guest resolver is built:
    // the refusal comes after this line.
    site: 'producer-region resolver line, a secret ARN region',
    drive: (v) =>
      linesOf(() =>
        resolver().resolve(
          `{{resolve:secretsmanager:arn:aws:secretsmanager:${v}:123456789012:secret:x:SecretString:k}}`,
          ctx()
        )
      ),
    pick: starts('Using a producer-region resolver for '),
  },
  // ---- the region-scoped clients line ---------------------------------------
  {
    // Driven through the private method, as `region-render-control-chars.test.ts`
    // does: every caller gates the REGION, and the line prints its LOG TEXT.
    site: 'region-scoped clients line',
    drive: (v) =>
      linesOf(async () => {
        (
          resolver() as unknown as { clientsForRegion: (r: string, t?: string) => unknown }
        ).clientsForRegion('eu-west-1', v);
      }),
    pick: starts('Using region-scoped AWS clients for '),
  },
];

/** The harness's four families, its clause break, and a bare `|` and `>`. */
const PAYLOADS: readonly string[] = [
  ...PASTE_PAYLOADS.map((p) => p.value),
  CLAUSE_BREAK_PAYLOAD.value,
  'x|touch OWNED',
  'x>OWNED',
];

describe('a value on the resolver\'s remaining log lines runs nothing when pasted (#4250)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
    aws.ec2 = async () => ({});
    aws.ssm = async () => ({});
    aws.secrets = async () => ({});
    aws.cfn = async () => ({});
  });

  // `%s` over the name itself: `$site` cuts a long name, and cut names collide.
  it.each(SITES.map((s) => [s.site, s] as const))('%s', async (_site, { drive, pick }) => {
    const rendered: Array<{ payload: string; line: string }> = [];
    for (const payload of PAYLOADS) {
      resetAccountInfoCache();
      const lines = await drive(payload);
      const picked = lines.filter(pick);
      expect(picked.length, `${payload}: the site's line never printed, among ${JSON.stringify(lines)}`).toBeGreaterThan(0);
      for (const line of picked) rendered.push({ payload, line });
    }
    // The paste first: it is the property, so a revert reds HERE.
    withPasteDir((dir) => {
      for (const { payload, line } of rendered) {
        expectPastesNothing(line, dir, `${payload} on ${JSON.stringify(line)}`);
      }
    });
    // Then the shape. The `OWNED` pin is not redundant with the paste: for a
    // value inside cdkd's own `'…'` beside a `(`, as on the origin label, the
    // flipped line is a syntax error, so this pin is what reds a revert there.
    // No part of the payload's command printed, and the slot
    // was described for at least one payload (a payload whose separator the
    // site's own parse consumed, such as the clause break's `:` in a
    // dynamic reference, can leave an inert piece to print as it is).
    for (const { payload, line } of rendered) expect(line, payload).not.toContain('OWNED');
    expect(
      rendered.some(
        ({ line }) =>
          line.includes(UNSHOWABLE_VALUE) ||
          line.includes('(not shown') ||
          line.includes('not a plain identifier')
      ),
      JSON.stringify(rendered)
    ).toBe(true);
  }, 180_000);

  it('CONTROL: an ordinary value still prints as it is', async () => {
    const lines = await linesOf(() =>
      resolver().resolve(
        { 'Fn::ImportValue': 'Exp' },
        ctx({ stateBackend: backend([{ stackName: 'Producer', region: 'us-east-1', outputs: { Exp: 'val' } }]) })
      )
    );
    expect(lines).toContain('Resolving Fn::ImportValue: Exp');
    expect(lines).toContain(
      'Resolved Fn::ImportValue: Exp (from stack: Producer / us-east-1; literal value)'
    );
    const fallback = await linesOf(() =>
      resolver().resolve({ 'Fn::GetAtt': ['Q', 'Whatever'] }, oneResource('Q', 'AWS::SQS::Queue', 'physicalId'))
    );
    expect(fallback).toContain(
      'Unknown attribute Whatever for resource type AWS::SQS::Queue, returning physical ID'
    );
  });
});

describe('a name the display sanitizer ALTERED is described, not shown trimmed (#4250 review)', () => {
  // `Prod<NBSP>`, `Prod ` and `Prod<TAB>` sanitize to a bare `Prod`, and
  // `ProdЖ` holds non-ASCII: printed as the sanitizer left them, each would be
  // byte-identical to (or a homoglyph of) another stack's name, and the
  // malformed-record refusal tells the operator to repair THAT record.
  const ALTERED = ['Prod\u00a0', 'Prod ', 'Prod\t', 'Prod\u0416'];

  it.each(['caf\u00e9', '\u65e5\u672c\u8a9e'])('CONTROL: an inert non-ASCII VALUE still prints: %j', async (value) => {
    const lines = await linesOf(() => resolver().resolve({ 'Fn::Join': ['', [value]] }, ctx()));
    expect(lines).toContain(`Resolved Fn::Join: ${value}`);
    const param = await linesOf(() =>
      resolver().resolveParameters({
        Parameters: { P: { Type: 'String', Default: value } },
        Resources: {},
      } as unknown as CloudFormationTemplate)
    );
    expect(param).toContain(`Parameter P: using default value ${value}`);
  });

  it.each(ALTERED)('%j', async (name) => {
    const refusal = (
      await linesOf(() =>
        resolver().resolve(
          { 'Fn::GetStackOutput': { StackName: name, OutputName: 'Out' } },
          ctx({ stateBackend: backend([{ stackName: name, region: 'us-east-1', outputs: 'torn' }]) })
        )
      )
    ).find(starts('Fn::GetStackOutput: the state record of producer stack '));
    expect(refusal).toContain(`producer stack ${UNSHOWABLE_VALUE} (us-east-1)`);
    aws.cfn = async () => {
      throw new Error('AccessDenied');
    };
    const warn = (
      await linesOf(() =>
        resolver('us-east-1', true).resolve(
          { 'Fn::GetStackOutput': { StackName: name, OutputName: 'Out' } },
          ctx({ stateBackend: backend([]) })
        )
      )
    ).find((l) => l.includes('DescribeStacks fallback failed'));
    expect(warn).toContain(`for stack ${UNSHOWABLE_VALUE} (us-east-1)`);
  });

  it.each(ALTERED)('%j on the other bound callers', async (name) => {
    // Each caller threads the pre-sanitizer text itself, so each is driven.
    const paramName = await linesOf(() =>
      resolver().resolveParameters({
        Parameters: { [name]: { Type: 'String', Default: 'd' } },
        Resources: {},
      } as unknown as CloudFormationTemplate)
    );
    expect(paramName).toContain(`Parameter ${UNSHOWABLE_VALUE}: using default value d`);
    const paramValue = await linesOf(() =>
      resolver().resolveParameters({
        Parameters: { P: { Type: 'String', Default: name } },
        Resources: {},
      } as unknown as CloudFormationTemplate)
    );
    // A VALUE is held to the default sanitizer only: padding and control
    // characters are described, an inert non-ASCII value prints.
    expect(paramValue).toContain(
      `Parameter P: using default value ${name === 'Prod\u0416' ? name : UNSHOWABLE_VALUE}`
    );
    aws.ssm = async () => ({ Parameter: { Value: 'x', Type: 'String' } });
    const origin = await linesOf(() =>
      resolver().resolve(
        { 'Fn::ImportValue': 'Exp' },
        ctx({
          stackName: 'Consumer',
          stateBackend: backend([]),
          exportIndex: {
            lookup: async () => ({ value: '{{resolve:ssm:/p}}', producerStack: name, producerRegion: 'us-east-1' }),
          } as unknown as ExportIndexStore,
        })
      )
    );
    expect(origin).toContain(
      `Re-resolving dynamic reference(s) in Fn::ImportValue 'Exp' (producer ${UNSHOWABLE_VALUE} / us-east-1)`
    );
    const region = await linesOf(async () => {
      (
        resolver() as unknown as { clientsForRegion: (r: string, t?: string) => unknown }
      ).clientsForRegion('eu-west-1', name);
    });
    expect(region).toContain(`Using region-scoped AWS clients for ${UNSHOWABLE_VALUE}`);
  });

  it('describes a stack name past the length an identifier render cut, on the DescribeStacks warn too', async () => {
    aws.cfn = async () => {
      throw new Error('AccessDenied');
    };
    const lines = await linesOf(() =>
      resolver('us-east-1', true).resolve(
        { 'Fn::GetStackOutput': { StackName: 'P'.repeat(2000), OutputName: 'Out' } },
        ctx({ stateBackend: backend([]) })
      )
    );
    expect(lines.find((l) => l.includes('DescribeStacks fallback failed'))).toContain(
      `for stack ${UNSHOWABLE_VALUE} (us-east-1)`
    );
  });

  it('CONTROL: a plain list default still prints as JSON', async () => {
    const lines = await linesOf(() =>
      resolver().resolveParameters({
        Parameters: { P: { Type: 'CommaDelimitedList', Default: ['a', 'b'] } },
        Resources: {},
      } as unknown as CloudFormationTemplate)
    );
    expect(lines).toContain('Parameter P: using default value ["a","b"]');
  });

  it('describes a stack name past the length an identifier render cut', async () => {
    const name = 'P'.repeat(2000);
    const lines = await linesOf(() =>
      resolver().resolve(
        { 'Fn::GetStackOutput': { StackName: name, OutputName: 'O'.repeat(300) } },
        ctx({ stateBackend: backend([]) })
      )
    );
    expect(lines).toContain(
      `Resolving Fn::GetStackOutput: StackName=${UNSHOWABLE_VALUE}, Region=us-east-1, OutputName=${UNSHOWABLE_VALUE}`
    );
  });

  it('keeps a masked render as the mask, whatever the secret holds', async () => {
    // The altered-value test reads the RAW text; for a masked render that
    // would disclose whether the secret holds such a character.
    const secret = 'pass\u00a0word';
    const lines = await linesOf(() =>
      resolver().resolve(
        { 'Fn::GetStackOutput': { StackName: secret, OutputName: 'Out' } },
        ctx({
          stateBackend: backend([]),
          recordedSecretValues: new Map([[secret, '{{resolve:ssm:/x}}']]),
        })
      )
    );
    expect(lines).toContain('Resolving Fn::GetStackOutput: StackName=***, Region=us-east-1, OutputName=Out');
  });

  it('CONTROL: an unaltered plain name prints', async () => {
    const lines = await linesOf(() =>
      resolver().resolve(
        { 'Fn::GetStackOutput': { StackName: 'Prod', OutputName: 'Out' } },
        ctx({ stateBackend: backend([]) })
      )
    );
    expect(lines).toContain('Resolving Fn::GetStackOutput: StackName=Prod, Region=us-east-1, OutputName=Out');
  });
});

describe('a JSON render whose mask unbalanced its quotes is described (#4250)', () => {
  // A recorded secret holding a `"` of the structure: the text mask runs AFTER
  // the JSON encoding, so the masked render lost a quote, and printed bare it
  // paired with the next line's and released that line's payload. The next
  // lines are the ones `resolver-resolved-line-paste-4161.test.ts` pastes
  // below such a render: a JSON object (quotes to pair with) and a described
  // payload. The description pin below is what reds a revert; the paste
  // pins that the block as printed runs nothing.
  async function nextLine(): Promise<string> {
    const object = await linesOf(() =>
      resolver().resolve(
        { 'Fn::GetAtt': ['T', 'Obj'] },
        ctx({
          template: { Resources: { T: { Type: 'AWS::S3::Bucket' } } },
          resources: {
            T: {
              physicalId: 'bucket',
              resourceType: 'AWS::S3::Bucket',
              properties: {},
              attributes: { Obj: { a: 1 } },
              dependencies: [],
            },
          },
        })
      )
    );
    const join = await linesOf(() => resolver().resolve({ 'Fn::Join': ['', ['a; touch OWNED; #']] }, ctx()));
    const lines = [
      object.find((l) => l.startsWith('Resolved Fn::GetAtt from attributes: ')),
      join.find((l) => l.startsWith('Resolved Fn::Join: ')),
    ];
    expect(lines.every((l) => l !== undefined), JSON.stringify([object, join])).toBe(true);
    return lines.join('\n');
  }

  it.each([
    {
      site: 'Fn::Cidr result',
      intrinsic: { 'Fn::Cidr': ['10.0.0.0/16', 2, 8] },
      secret: '0/24",',
      prefix: 'Fn::Cidr result: ',
    },
    {
      site: 'Resolving Fn::Cidr ipBlock',
      intrinsic: { 'Fn::Cidr': ['10.0.0.0/16', 2, 8] },
      secret: '0/16"',
      prefix: 'Resolving Fn::Cidr: ipBlock=',
    },
  ])('$site', async ({ intrinsic, secret, prefix }) => {
    const lines = await linesOf(() =>
      resolver().resolve(intrinsic, ctx({ recordedSecretValues: new Map([[secret, '{{resolve:ssm:/x}}']]) }))
    );
    const line = lines.find((l) => l.startsWith(prefix));
    expect(line, JSON.stringify(lines)).toBeDefined();
    const next = await nextLine();
    withPasteDir((dir) => {
      // As printed: the unbalanced quote a masked render left is itself the
      // flip, so no flip is added (the next line runs below one by design).
      expect(spansThatRun(`${line!}\n${next}`, dir)).toEqual([]);
    });
    expect(line).toContain(UNSHOWABLE_VALUE);
  }, 60_000);

  it('VPC Ipv6CidrBlocks', async () => {
    aws.ec2 = async () => ({
      Vpcs: [
        {
          Ipv6CidrBlockAssociationSet: [
            { Ipv6CidrBlock: '2001:db8::/56', Ipv6CidrBlockState: { State: 'associated' } },
          ],
        },
      ],
    });
    const lines = await linesOf(() =>
      resolver().resolve(
        { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] },
        oneResource('Vpc', 'AWS::EC2::VPC', 'vpc-0abc', {
          recordedSecretValues: new Map([[':/56"]', '{{resolve:ssm:/x}}']]),
        })
      )
    );
    const line = lines.find((l) => l.startsWith('Resolved VPC Ipv6CidrBlocks for '));
    expect(line, JSON.stringify(lines)).toBeDefined();
    const next = await nextLine();
    withPasteDir((dir) => {
      // As printed: the unbalanced quote a masked render left is itself the
      // flip, so no flip is added (the next line runs below one by design).
      expect(spansThatRun(`${line!}\n${next}`, dir)).toEqual([]);
    });
    expect(line).toBe(`Resolved VPC Ipv6CidrBlocks for vpc-0abc: ${UNSHOWABLE_VALUE}`);
  }, 60_000);

  it('CONTROL: a balanced JSON render still prints', async () => {
    const lines = await linesOf(() => resolver().resolve({ 'Fn::Cidr': ['10.0.0.0/16', 2, 8] }, ctx()));
    expect(lines).toContain('Fn::Cidr result: ["10.0.0.0/24","10.0.1.0/24"]');
  });
});
