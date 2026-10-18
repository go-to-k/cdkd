import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-v6';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/deployment/intrinsic-resolver` slice: a handler that rendered its
 * caught value with `x instanceof Error ? x.message : String(x)` threw from
 * inside itself when the value could not be converted --
 * `String(Object.create(null))` throws `TypeError: Cannot convert object to
 * primitive value` -- so a best-effort fallback (the CloudFormation lookup,
 * the exports index, a per-stack state read, a condition assumed false, an
 * EC2 attribute read) became a hard failure, and a refusal that should name
 * the AWS failure was replaced by the converter's TypeError.
 *
 * Every behaviour case rejects with exactly that value and asserts the
 * DEGRADATION still happens and the placeholder is reported, never merely
 * "it did not throw". The masking these messages go through is untouched:
 * `describeAwsFailure(x).detail` is byte-identical to the old ternary for
 * every value that converts.
 */

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

const aws = vi.hoisted(() => ({
  ec2: (async () => ({})) as (command: { constructor: { name: string } }) => Promise<unknown>,
  cfn: (async () => ({})) as (command: { constructor: { name: string } }) => Promise<unknown>,
}));

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...actual,
    getAwsClients: () => ({
      sts: { send: async () => ({ Account: '123456789012' }) },
      ec2: { send: (command: never) => aws.ec2(command) },
    }),
  };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(function () {
      return { send: (command: never) => aws.cfn(command) };
    }),
  };
});

import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { evaluateConditions } from '../../../src/deployment/intrinsic-resolver/params-conditions.js';
import { subPlaceholderWarning } from '../../../src/deployment/intrinsic-resolver/sub.js';
import { describeFailureObserved } from '../../../src/deployment/intrinsic-resolver/getatt-refusals.js';
import { abandonedUnit } from '../../../src/deployment/intrinsic-resolver/masking.js';
import { describeInnermostAwsError } from '../../../src/deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const REGION = 'us-east-1';

function resolver(cfnFallback = true): IntrinsicFunctionResolver {
  return new IntrinsicFunctionResolver(REGION, { cfnFallback });
}

function context(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    template: { Resources: {} } as CloudFormationTemplate,
    resources: {},
    stackName: 'Consumer',
    ...overrides,
  };
}

/** A state backend holding `stacks`, where a stack named in `failing` rejects unconvertibly. */
function backend(
  stacks: Array<{ stackName: string; outputs: Record<string, unknown> }>,
  failing: ReadonlySet<string> = new Set()
): S3StateBackend {
  return {
    listStacks: async () => stacks.map((s) => ({ stackName: s.stackName, region: REGION })),
    getState: async (stackName: string) => {
      if (failing.has(stackName)) throw unconvertible();
      const found = stacks.find((s) => s.stackName === stackName);
      if (!found) return null;
      return {
        state: {
          version: 12,
          stackName,
          region: REGION,
          resources: {},
          outputs: found.outputs,
          lastModified: 1,
        },
        etag: 'e',
      };
    },
  } as unknown as S3StateBackend;
}

function linesWith(needle: string): string[] {
  return logged.lines.filter((l) => l.includes(needle));
}

beforeEach(() => {
  logged.lines.length = 0;
  resetAccountInfoCache();
  aws.ec2 = async () => ({});
  aws.cfn = async () => ({});
});

describe('the CloudFormation fallback (#3361)', () => {
  it('a ListExports failure with an unconvertible value still degrades to the not-found error', async () => {
    aws.cfn = () => Promise.reject(unconvertible());
    await expect(
      resolver().resolve({ 'Fn::ImportValue': 'Missing' }, context({ stateBackend: backend([]) }))
    ).rejects.toThrow("Fn::ImportValue: export 'Missing' not found in any stack");
    expect(linesWith('CloudFormation ListExports fallback failed')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });

  it('a DescribeStacks failure with an unconvertible value still degrades to the not-found error', async () => {
    aws.cfn = () => Promise.reject(unconvertible());
    await expect(
      resolver().resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'ApiUrl' } },
        context({ stateBackend: backend([]) })
      )
    ).rejects.toThrow('Fn::GetStackOutput: stack Producer not found in region us-east-1');
    expect(linesWith('CloudFormation DescribeStacks fallback failed')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });
});

describe('Fn::ImportValue over cdkd state (#3361)', () => {
  it('an exports-index lookup failure falls back to the state scan', async () => {
    const exportIndex = {
      lookup: () => Promise.reject(unconvertible()),
      patchEntry: async () => {},
    };
    const value = await resolver(false).resolve(
      { 'Fn::ImportValue': 'Shared' },
      context({
        stateBackend: backend([{ stackName: 'Producer', outputs: { Shared: 'from-state' } }]),
        exportIndex: exportIndex as never,
      })
    );
    expect(value).toBe('from-state');
    expect(linesWith('Exports index lookup failed')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });

  it('an exports-index write-through failure is logged and the value still resolves', async () => {
    const exportIndex = {
      lookup: async () => undefined,
      patchEntry: () => Promise.reject(unconvertible()),
    };
    const value = await resolver(false).resolve(
      { 'Fn::ImportValue': 'Shared' },
      context({
        stateBackend: backend([{ stackName: 'Producer', outputs: { Shared: 'from-state' } }]),
        exportIndex: exportIndex as never,
      })
    );
    expect(value).toBe('from-state');
    // The write-through is fire-and-forget: let its `.catch` run. Before the
    // fix the handler threw inside that `.catch`, an unhandled rejection.
    await new Promise((r) => setTimeout(r, 0));
    expect(linesWith('Failed to patch exports index')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });

  it('one unreadable producer state is skipped and the next producer still answers', async () => {
    const value = await resolver(false).resolve(
      { 'Fn::ImportValue': 'Shared' },
      context({
        stateBackend: backend(
          [
            { stackName: 'Broken', outputs: {} },
            { stackName: 'Producer', outputs: { Shared: 'from-state' } },
          ],
          new Set(['Broken'])
        ),
      })
    );
    expect(value).toBe('from-state');
    expect(linesWith('Failed to read state for stack Broken')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });
});

describe('evaluateConditions (#3361)', () => {
  it('a condition whose evaluation throws an unconvertible value is assumed false', async () => {
    const r = resolver(false);
    vi.spyOn(r, 'resolveValue').mockRejectedValue(unconvertible());
    const conditions = await evaluateConditions(
      r,
      context({
        template: {
          Resources: {},
          Conditions: { IsProd: { 'Fn::Equals': ['a', 'b'] } },
        } as unknown as CloudFormationTemplate,
      })
    );
    expect(conditions['IsProd']).toBe(false);
    expect(linesWith('Failed to evaluate condition IsProd')).toEqual([
      expect.stringContaining(`${PLACEHOLDER}, assuming false`),
    ]);
  });
});

describe('constructed EC2 attributes (#3361)', () => {
  function getAtt(resourceType: string, attribute: string, physicalId: string): Promise<unknown> {
    return resolver(false).resolve(
      { 'Fn::GetAtt': ['Thing', attribute] },
      context({
        template: {
          Resources: { Thing: { Type: resourceType } },
        } as unknown as CloudFormationTemplate,
        resources: {
          Thing: { physicalId, resourceType, properties: {}, dependencies: [] },
        } as never,
      })
    );
  }

  it('a VPC Ipv6CidrBlocks read failing unconvertibly degrades to an empty list', async () => {
    aws.ec2 = () => Promise.reject(unconvertible());
    await expect(getAtt('AWS::EC2::VPC', 'Ipv6CidrBlocks', 'vpc-0abc')).resolves.toEqual([]);
    expect(linesWith('Failed to fetch VPC Ipv6CidrBlocks for vpc-0abc')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });

  it('a LaunchTemplate version read failing unconvertibly degrades to $Latest', async () => {
    aws.ec2 = () => Promise.reject(unconvertible());
    await expect(
      getAtt('AWS::EC2::LaunchTemplate', 'LatestVersionNumber', 'lt-0abc')
    ).resolves.toBe('$Latest');
    expect(linesWith('DescribeLaunchTemplates(lt-0abc) failed')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });

  it('a Fn::GetAZs describe failing unconvertibly refuses naming the failure, not a TypeError', async () => {
    aws.ec2 = () => Promise.reject(unconvertible());
    await expect(resolver(false).resolve({ 'Fn::GetAZs': '' }, context())).rejects.toThrow(
      `Fn::GetAZs: failed to describe availability zones for region '${REGION}': ${PLACEHOLDER}`
    );
  });
});

describe('helpers that render a caught value (#3361)', () => {
  it('subPlaceholderWarning names the placeholder for an unconvertible reason', () => {
    expect(subPlaceholderWarning(resolver(false), 'Var', unconvertible())).toBe(
      `Fn::Sub variable Var could not be resolved (${PLACEHOLDER}), keeping placeholder`
    );
  });

  it('describeFailureObserved returns its refusal sentence and logs the placeholder', () => {
    expect(describeFailureObserved(resolver(false), 'DescribeThing', unconvertible())).toBe(
      'DescribeThing failed (Error); re-run with --verbose for the AWS error text'
    );
    expect(linesWith('DescribeThing failed (Error): ')).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });

  it('abandonedUnit records an unconvertible failure with the placeholder as its message', () => {
    const error = unconvertible();
    const unit = abandonedUnit(resolver(false), 'placeholder', 'Var', error, undefined, 'Var');
    expect(unit.message).toBe(PLACEHOLDER);
    expect(unit.error).toBe(error);
  });

  it('describeInnermostAwsError renders an unconvertible error as the placeholder', () => {
    expect(describeInnermostAwsError(unconvertible())).toBe(PLACEHOLDER);
    // ...and still walks the cause chain to an unconvertible innermost link.
    expect(describeInnermostAwsError(new Error('outer', { cause: unconvertible() }))).toBe(
      PLACEHOLDER
    );
  });
});

/**
 * Two handlers no exported entry reaches without rebuilding the whole
 * dynamic-reference engine around them (the pinned recorded-reference read in
 * `recorded-reference-routes.ts`, the kept-placeholder note in
 * `dynamic-refs.ts`), so the resolver's source is scanned instead: no caught
 * value is rendered with the throwing ternary, and no caught value -- a
 * `catch` binding or a `.catch(...)` callback's parameter -- reaches a bare
 * `String()` or a template-literal interpolation (both run ToString).
 */
describe('src/deployment/intrinsic-resolver source scan (#3361)', () => {
  const DIR = join(process.cwd(), 'src/deployment/intrinsic-resolver');
  const files = [
    ...readdirSync(DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(DIR, f)),
    join(process.cwd(), 'src/deployment/intrinsic-function-resolver.ts'),
  ];

  /** The parameter name of `node` when it IS a `.catch(...)` callback, scoped to its own body. */
  function catchCallbackParam(node: ts.Node): string | undefined {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return undefined;
    const call = node.parent;
    if (
      !ts.isCallExpression(call) ||
      call.arguments[0] !== node ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== 'catch'
    ) {
      return undefined;
    }
    const param = node.parameters[0];
    return param !== undefined && ts.isIdentifier(param.name) ? param.name.text : undefined;
  }

  it('renders no caught value with String()', () => {
    const offenders: string[] = [];
    let catchBindings = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const at = (node: ts.Node): string =>
        `${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const visit = (node: ts.Node, bound: ReadonlySet<string>): void => {
        let inScope = bound;
        if (
          ts.isCatchClause(node) &&
          node.variableDeclaration &&
          ts.isIdentifier(node.variableDeclaration.name)
        ) {
          catchBindings++;
          inScope = new Set([...bound, node.variableDeclaration.name.text]);
        }
        const callbackParam = catchCallbackParam(node);
        if (callbackParam !== undefined) {
          catchBindings++;
          inScope = new Set([...bound, callbackParam]);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'String' &&
          node.arguments.length === 1 &&
          ts.isIdentifier(node.arguments[0]!) &&
          inScope.has(node.arguments[0].text)
        ) {
          offenders.push(at(node));
        }
        if (
          ts.isTemplateSpan(node) &&
          ts.isIdentifier(node.expression) &&
          inScope.has(node.expression.text)
        ) {
          offenders.push(`${at(node)} (template)`);
        }
        // `x instanceof Error ? x.message : String(x)` on ANY identifier: the
        // helpers above take their caught value as a parameter, out of reach
        // of the catch-scoped arms.
        if (
          ts.isConditionalExpression(node) &&
          ts.isBinaryExpression(node.condition) &&
          node.condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
          node.condition.right.getText() === 'Error' &&
          /^String\(/.test(node.whenFalse.getText())
        ) {
          offenders.push(`${at(node)} (ternary)`);
        }
        ts.forEachChild(node, (child) => visit(child, inScope));
      };
      visit(sf, new Set());
    }
    // Floors: the scan reads the directory and sees its catch clauses, so an
    // empty walk cannot pass as clean. Literals, not read from the scan.
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(catchBindings).toBeGreaterThanOrEqual(25);
    expect(offenders).toEqual([]);
  });
});
