/**
 * cdkd's own ` -> ` before a chosen value redirects nothing when pasted
 * (issue [#4239](https://github.com/go-to-k/cdkd/issues/4239)), outside the
 * resolver that #4161 covered.
 *
 * Pasted into a shell, `->` is `-` plus a `>` redirect whose target is the
 * render after it, so a value a template, a state record or AWS chose picked a
 * file to truncate. Each site now says `from <a> to <b>`, `then` (a chain),
 * `resolved to` or `with value`, none of which is a shell operator.
 *
 * Every case renders its site with a value that NAMES one of the paste
 * harness's decoys, reads the emitted text, and pastes it through
 * `spansThatRun` under bash and zsh. The provider sites are in
 * `tests/unit/provisioning/arrow-paste-sites-4239.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const capture = (...args: unknown[]): void => {
    logLines.push(args.map(String).join(' '));
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
// Only `execFile` is replaced (the soft-reload's docker calls): the paste
// harness spawns its shells through the real `spawnSync`.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (
        err: Error | null,
        result: { stdout: string; stderr: string }
      ) => void;
      cb(null, { stdout: String(execFileMock(rest[0], rest[1]) ?? ''), stderr: '' });
    },
  };
});
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return { ...actual, getCreateOnlyPropertyPaths: vi.fn().mockResolvedValue(['Name']) };
});
vi.mock('../../../src/provisioning/write-only-properties.js', () => ({
  tryGetTopLevelWriteOnlyProperties: vi.fn().mockResolvedValue([]),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'n'), close: vi.fn() })),
}));

import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { renderNestedTemplateTreeDefect } from '../../../src/utils/nested-template-cycle.js';
import { buildDependencyGraph } from '../../../src/local/ecs-task-runner.js';
import { softReloadAgentContainer } from '../../../src/local/invoke-agentcore-watch-loop.js';
import { promptMigrationConfirm } from '../../../src/cli/commands/prefix-migration-check.js';
import { printPerServerRouteTables } from '../../../src/cli/commands/local-start-api.js';
import { resolveFromS3BucketIntrinsic } from '../../../src/cli/commands/local-invoke-agentcore.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { setStdinIsTty } from '../../stdin-tty.js';
import { spansThatRun, withPasteDir } from './paste-harness.js';

/** The one line of `lines` starting with `prefix`, asserted present. */
function lineStarting(lines: readonly string[], prefix: string): string {
  const found = lines.filter((l) => l.startsWith(prefix));
  expect(found, `no single ${JSON.stringify(prefix)} line among ${JSON.stringify(lines)}`).toHaveLength(1);
  return found[0]!;
}

/**
 * The property: no span of `text` touches a file. Asserted BEFORE the
 * spelling pin, so a revert reds here rather than on the wording.
 */
function expectInert(text: string): void {
  withPasteDir((dir) => {
    expect(spansThatRun(text, dir)).toEqual([]);
  });
}

/**
 * The before/after pair inside a line's parentheses, as an operator selects
 * it (a drag between the brackets). The harness splits a line at sentence and
 * clause breaks only, and a `(` or `)` around the pair is a syntax error that
 * stops both shells before any redirect, so such a line pasted whole was inert
 * even on the pre-fix spelling; the pair on its own truncated its right side.
 */
function pairInParens(text: string): string {
  const m = /\(([^()]* (?:to|->) [^()]*)\)/.exec(text);
  expect(m, `no parenthesized pair in ${JSON.stringify(text)}`).not.toBeNull();
  return m![1]!;
}

async function thrownMessage(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  logLines.length = 0;
  execFileMock.mockReset();
});

describe('a pasted ` -> ` line redirects nothing (#4239)', () => {
  it('dag-builder: the edge debug line', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        physicalId: { Type: 'AWS::S3::Bucket', Properties: {} },
        logicalId: { Type: 'AWS::SNS::Topic', DependsOn: ['physicalId'] },
      } as unknown as CloudFormationTemplate['Resources'],
    };
    new DagBuilder().buildGraph(template);
    const line = lineStarting(logLines, 'Added edge');
    expectInert(line);
    expect(line).toBe('Added edge from physicalId to logicalId');
  }, 60_000);

  it('dag-builder: the cycle refusal', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        logicalId: { Type: 'AWS::S3::Bucket', DependsOn: ['physicalId'] },
        physicalId: { Type: 'AWS::SNS::Topic', DependsOn: ['logicalId'] },
      } as unknown as CloudFormationTemplate['Resources'],
    };
    const message = await thrownMessage(() => new DagBuilder().buildGraph(template));
    expect(message).toMatch(/Cycles: .*(logicalId|physicalId)/);
    expectInert(message);
    expect(message).toMatch(/Cycles: (logicalId|physicalId) then (logicalId|physicalId)/);
  }, 60_000);

  it('diff-calculator: the Type-change and replacement debug lines', async () => {
    const state: StackState = {
      version: 1,
      stackName: 'S',
      resources: {
        T: { physicalId: 'p', resourceType: 'AWS::SNS::Topic', properties: {}, attributes: {} },
        R: {
          physicalId: '/app/param',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: 'bucket', Type: 'String', Value: 'v' },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const template = {
      Resources: {
        T: { Type: 'region', Properties: {} },
        R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'name', Type: 'String', Value: 'v' } },
      },
    } as unknown as CloudFormationTemplate;
    await new DiffCalculator().calculateDiff(state, template);
    const typeChange = lineStarting(logLines, 'UPDATE (Type change)');
    const replacement = lineStarting(logLines, 'Property Name of AWS::SSM::Parameter requires replacement (');
    expectInert(typeChange);
    expectInert(pairInParens(typeChange));
    expectInert(replacement);
    expectInert(pairInParens(replacement));
    expect(typeChange).toBe('UPDATE (Type change): T (from AWS::SNS::Topic to region)');
    expect(replacement).toBe(
      'Property Name of AWS::SSM::Parameter requires replacement (from "bucket" to "name")'
    );
  }, 60_000);

  it('nested-template-cycle: the chain in the refusal', () => {
    // Every hop carries its own `(path)`, a syntax error that stopped both
    // shells before the pre-fix redirect, so this case is defence in depth: a
    // revert reds the spelling pin, not the paste.
    const text = renderNestedTemplateTreeDefect(
      {
        kind: 'cycle',
        chain: [
          { logicalId: 'logicalId', templatePath: '/out/a.json' },
          { logicalId: 'id', templatePath: '/out/a.json' },
        ],
      },
      'stack',
      'deploy'
    );
    expectInert(text);
    expect(text).toContain('logicalId (/out/a.json) then id (/out/a.json)');
  }, 60_000);

  it('ecs-task-runner: the DependsOn cycle refusal', async () => {
    const container = (name: string, dep: string) =>
      ({ name, dependsOn: [{ containerName: dep, condition: 'START' }] }) as never;
    const message = await thrownMessage(() =>
      buildDependencyGraph([container('name', 'id'), container('id', 'name')])
    );
    expectInert(message);
    expect(message).toMatch(/Cyclic DependsOn detected: (name|id) then (name|id)$/);
  }, 60_000);

  it('invoke-agentcore-watch-loop: the soft-reload line', async () => {
    // The image's WORKDIR comes from `docker inspect`; the soft-reload
    // appends a `/`, so the pre-fix redirect target was always a directory
    // path. The case is defence in depth: no later wording may run.
    execFileMock.mockImplementation((_cmd: unknown, argv: unknown) =>
      (argv as string[])[0] === 'inspect' ? 'prefix\n' : ''
    );
    await softReloadAgentContainer('id', 'bucket');
    const line = lineStarting(logLines, 'Soft-reload:');
    expectInert(line);
    expect(line).toBe('Soft-reload: copying bucket to id:prefix/, then restarting.');
  }, 60_000);

  it('prefix-migration-check: the pending rename row', async () => {
    const tty = process.stdin.isTTY;
    setStdinIsTty(true);
    try {
      await promptMigrationConfirm(
        [
          {
            logicalId: 'Role',
            resourceType: 'AWS::IAM::Role',
            oldPhysicalId: 'stack-physicalId',
            newPhysicalId: 'physicalId',
          },
        ],
        {}
      ).catch(() => undefined);
    } finally {
      setStdinIsTty(tty);
    }
    const line = lineStarting(logLines, '  - Role');
    expectInert(line);
    expect(line).toBe('  - Role (AWS::IAM::Role): from stack-physicalId to physicalId');
  }, 60_000);

  it('local-start-api: the route table row', () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      printPerServerRouteTables([
        {
          group: {
            displayName: 'Api',
            routes: [
              {
                route: {
                  method: 'GET',
                  pathPattern: '/items',
                  source: 'http-api',
                  lambdaLogicalId: 'logicalId',
                },
              },
            ],
          },
          server: { host: '127.0.0.1', port: 3000 },
        },
      ] as never);
    } finally {
      spy.mockRestore();
    }
    const row = out.join('').split('\n').find((l) => l.includes('/items'));
    expect(row).toBeDefined();
    expectInert(row!);
    // The row up to its target, without the source label whose `(` stops
    // both shells on the whole row.
    expectInert(row!.replace(/\s+\([^()]*\)$/, ''));
    expect(row).toBe('  GET     /items    to logicalId  (HTTP API)');
  }, 60_000);

  it('local-invoke-agentcore: the resolved fromS3 bucket line', async () => {
    const resources = {
      Bucket: {
        physicalId: 'bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
      },
    };
    await resolveFromS3BucketIntrinsic(
      {
        logicalId: 'Agent',
        codeArtifact: { s3Source: { bucketIntrinsic: { Ref: 'Bucket' } } },
      } as never,
      { buildCrossStackResolver: async () => undefined } as never,
      { region: 'us-east-1', resources } as never,
      undefined
    );
    const line = lineStarting(logLines, 'Resolved fromS3 Code.S3.Bucket from state: ');
    expectInert(line);
    expect(line).toMatch(/ resolved to bucket$/);
  }, 60_000);
});

describe('the other dag-builder edge lines and the multi-cycle refusals (#4252 review)', () => {
  it('dag-builder: the skipped Parameter reference line', () => {
    new DagBuilder().buildGraph({
      Parameters: { logicalId: { Type: 'String' } },
      Resources: { id: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'logicalId' } } } },
    } as unknown as CloudFormationTemplate);
    const line = lineStarting(logLines, 'Skipped Parameter reference');
    expectInert(line);
    expect(line).toBe('Skipped Parameter reference from id to logicalId');
  }, 60_000);

  it('dag-builder: the skipped CDK-defensive DependsOn line', () => {
    // The Role waits on the NAT default route only defensively (the
    // allowlisted VPC-Lambda egress pair); ids named after decoys.
    new DagBuilder({ relaxCdkVpcDefensiveDeps: true }).buildGraph({
      Resources: {
        logicalId: { Type: 'AWS::IAM::Role', Properties: {}, DependsOn: ['id'] },
        NatGw: { Type: 'AWS::EC2::NatGateway', Properties: {} },
        id: { Type: 'AWS::EC2::Route', Properties: { NatGatewayId: { Ref: 'NatGw' } } },
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Role: { 'Fn::GetAtt': ['logicalId', 'Arn'] } },
        },
      },
    } as unknown as CloudFormationTemplate);
    const line = lineStarting(logLines, 'Skipped CDK-defensive DependsOn edge');
    expectInert(line);
    // The line without its `(default; ...)` tail, whose `(` stops both shells
    // on the whole line.
    expectInert(line.replace(/ \(default;.*$/, ''));
    expect(line).toMatch(/^Skipped CDK-defensive DependsOn edge from id to logicalId \(default;/);
  }, 60_000);

  it('dag-builder: the custom-resource policy implicit edge line', () => {
    new DagBuilder().buildGraph({
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        id: {
          Type: 'AWS::IAM::Policy',
          Properties: { Roles: [{ Ref: 'Role' }], PolicyDocument: {} },
        },
        Fn: { Type: 'AWS::Lambda::Function', Properties: { Role: { 'Fn::GetAtt': ['Role', 'Arn'] } } },
        logicalId: {
          Type: 'Custom::Seeder',
          Properties: { ServiceToken: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    } as unknown as CloudFormationTemplate);
    const line = lineStarting(logLines, 'Added implicit edge (custom resource policy)');
    expectInert(line);
    expectInert(line.replace(/^.*\) /, ''));
    expect(line).toBe('Added implicit edge (custom resource policy) from id to logicalId');
  }, 60_000);

  it('dag-builder: the lambda-vpc implicit edge line', async () => {
    // The pass only adds an edge the Ref extractor missed, so it is driven on
    // a graph holding the two nodes and no edge.
    const { Graph } = await import('graphlib');
    const graph = new Graph({ directed: true });
    graph.setNode('id');
    graph.setNode('logicalId');
    (
      new DagBuilder() as unknown as {
        addLambdaVpcEdges: (g: unknown, t: CloudFormationTemplate) => number;
      }
    ).addLambdaVpcEdges(graph, {
      Resources: {
        id: { Type: 'AWS::EC2::Subnet', Properties: {} },
        logicalId: {
          Type: 'AWS::Lambda::Function',
          Properties: { VpcConfig: { SubnetIds: [{ Ref: 'id' }] } },
        },
      },
    } as unknown as CloudFormationTemplate);
    const line = lineStarting(logLines, 'Added implicit edge (lambda vpc)');
    expectInert(line);
    expectInert(line.replace(/^.*\) /, ''));
    expect(line).toBe('Added implicit edge (lambda vpc) from id to logicalId');
  }, 60_000);

  it('dag-builder: a refusal naming TWO cycles runs nothing between them', async () => {
    // The cycles used to be joined by `; `, a command separator: the second
    // cycle's first node ran as a command with the rest as its arguments. Both
    // nodes of that cycle are commands that create files, so either rotation
    // graphlib reports reaches one.
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket', DependsOn: ['B'] },
        B: { Type: 'AWS::S3::Bucket', DependsOn: ['A'] },
        touch: { Type: 'AWS::S3::Bucket', DependsOn: ['mkdir'] },
        mkdir: { Type: 'AWS::S3::Bucket', DependsOn: ['touch'] },
      } as unknown as CloudFormationTemplate['Resources'],
    };
    const message = await thrownMessage(() => new DagBuilder().buildGraph(template));
    expect(message).toMatch(/(touch then mkdir|mkdir then touch)/);
    expectInert(message);
    expect(message).toMatch(/Cycles: \S+ then \S+ then \S+, and \S+ then \S+ then \S+$/);
  }, 60_000);

  it('ecs-task-runner: a refusal naming TWO cycles runs nothing between them', async () => {
    const container = (name: string, dep: string) =>
      ({ name, dependsOn: [{ containerName: dep, condition: 'START' }] }) as never;
    const message = await thrownMessage(() =>
      buildDependencyGraph([
        container('a', 'b'),
        container('b', 'a'),
        container('touch', 'mkdir'),
        container('mkdir', 'touch'),
      ])
    );
    expect(message).toMatch(/(touch then mkdir|mkdir then touch)/);
    expectInert(message);
    expect(message).toMatch(/detected: \S+ then \S+, and \S+ then \S+$/);
  }, 60_000);
});
