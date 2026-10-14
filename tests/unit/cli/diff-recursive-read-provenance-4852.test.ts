/**
 * go-to-k/cdkd#4852 through `buildDiffTree` with the real resolver: `cdkd diff
 * --recursive` shows the same read-provenance promotions the deploy makes. A
 * nested row whose `Parameters` read a queue the parent replaced under a
 * rotated secret in an earlier run is promoted by its own record, and its
 * child's reader by the snapshot derived from the parent's records, although
 * the child's diff binds the parameter in reference form. No secret is
 * resolved (decision 5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});
const lookups = vi.hoisted(() => ({ count: 0 }));
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    send(): Promise<unknown> {
      lookups.count++;
      return Promise.reject(new Error('no secret is resolved by cdkd diff'));
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

import {
  buildDiffTree,
  renderChangeLines,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ReferenceProvenance, ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;

const at = (versions: string[], read?: string[]): ReferenceProvenance => ({
  region: 'us-east-1',
  versions,
  ...(read !== undefined && { readVersions: read }),
});

function st(resources: Record<string, ResourceState>, stackName: string): StackState {
  return {
    stackName,
    region: 'us-east-1',
    resources,
    outputs: {},
    version: 12,
    lastModified: 0,
  } as StackState;
}

function printed(node: DiffTreeNode): string {
  const lines: string[] = [];
  renderChangeLines(node.changes, (line) => lines.push(line));
  return lines.join('\n');
}

describe('cdkd diff --recursive: read-provenance promotion (#4852)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-4852-'));
    lookups.count = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function treeOf(
    queueVersions: string[],
    rowProvenance: ReferenceProvenance = at([V1], [V1])
  ): Promise<DiffTreeNode> {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { QueueArn: { Type: 'String' } },
        Resources: {
          Reader: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/n', Type: 'String', Value: { Ref: 'QueueArn' } },
          },
        },
      })
    );
    const states: Record<string, StackState> = {
      Root: st(
        {
          Queue: {
            physicalId: 'https://sqs/q',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: REF },
            attributes: { Arn: ARN },
            dependencies: [],
            referenceProvenance: { [REF]: at(queueVersions) },
          },
          Child: {
            physicalId: 'arn:cdkd-local:us-east-1:stack/Root~Child',
            resourceType: 'AWS::CloudFormation::Stack',
            properties: { Parameters: { QueueArn: ARN } },
            attributes: {},
            dependencies: ['Queue'],
            referenceProvenance: { [REF]: rowProvenance },
          },
        },
        'Root'
      ),
      'Root~Child': st(
        {
          Reader: {
            physicalId: '/n',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Name: '/n', Type: 'String', Value: ARN },
            attributes: {},
            dependencies: [],
            referenceProvenance: { [REF]: at([V1], [V1]) },
          },
        },
        'Root~Child'
      ),
    };
    const backend = {
      getState: async (stackName: string) => {
        const state = states[stackName];
        return state ? { state, etag: 'e' } : null;
      },
      saveState: vi.fn(),
      putState: vi.fn(),
      deleteState: vi.fn(),
    } as unknown as S3StateBackend;
    return buildDiffTree({
      stackName: 'Root',
      displayName: 'Root',
      region: 'us-east-1',
      template: {
        Resources: {
          Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { QueueArn: { 'Fn::GetAtt': ['Queue', 'Arn'] } } },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
  }

  it('promotes the row by its Parameters and the child reader by the derived snapshot', async () => {
    const root = await treeOf([V2]);
    expect(root.changes.get('Child')?.changeType).toBe('UPDATE');
    const child = root.children[0]!;
    expect(child.changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(printed(root)).toContain('[read value moved upstream]');
    expect(printed(child)).toContain('[read value moved upstream]');
    expect(lookups.count).toBe(0);
  });

  it('a cross-stack consumer is promoted against the producer output it read', async () => {
    const producer = st({}, 'Producer');
    producer.outputs = { 'q-arn': ARN };
    producer.exportNames = ['q-arn'];
    producer.outputReferenceProvenance = { 'q-arn': { [REF]: at([V2], [V2]) } };
    const consumer = st(
      {
        Reader: {
          physicalId: '/c',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/c', Type: 'String', Value: ARN },
          attributes: {},
          dependencies: [],
          referenceProvenance: { [REF]: at([V1], [V1]) },
        },
      },
      'Consumer'
    );
    const reads: string[] = [];
    const backend = {
      getState: async (stackName: string) => {
        reads.push(stackName);
        const state = { Producer: producer, Consumer: consumer }[stackName];
        return state ? { state, etag: 'e' } : null;
      },
      listStacks: async () => [
        { stackName: 'Producer', region: 'us-east-1' },
        { stackName: 'Consumer', region: 'us-east-1' },
      ],
      saveState: vi.fn(),
    } as unknown as S3StateBackend;
    const node = await buildDiffTree({
      stackName: 'Consumer',
      displayName: 'Consumer',
      region: 'us-east-1',
      template: {
        Resources: {
          Reader: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/c', Type: 'String', Value: { 'Fn::ImportValue': 'q-arn' } },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(node.changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(printed(node)).toContain('[read value moved upstream]');
    expect(lookups.count).toBe(0);
    // The scan's own read of the producer serves the arm too: no second read.
    expect(reads.filter((n) => n === 'Producer')).toEqual(['Producer']);
  });

  it('a row the deploy leaves NO_CHANGE runs no child engine, so its child is not promoted', async () => {
    // The row recorded no read versions (a migrated record): not promoted, so
    // the deploy never reaches the child, whose own record would promote it.
    const root = await treeOf([V2], at([V1]));
    expect(root.changes.get('Child')?.changeType).toBe('NO_CHANGE');
    expect(root.children[0]!.changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });

  it('control: the queue still at the version both recorded promotes nothing', async () => {
    const root = await treeOf([V1]);
    expect(root.changes.get('Child')?.changeType).toBe('NO_CHANGE');
    expect(root.children[0]!.changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });
});
