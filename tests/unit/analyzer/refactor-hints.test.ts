/**
 * go-to-k/cdkd#5203: the `(moved to <Stack>.<LogicalId>, run 'cdkd refactor'
 * to keep it)` hint on a DELETE row -- which pairs earn it, and where it is
 * rendered (`cdkd diff` human and `--json`, `--fail-on=destructive`, and the
 * deploy approval prompt).
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  findRefactorHints,
  hintSidesOf,
  rollbackOrphanIds,
  movedToHint,
  withMovedTo,
  type RefactorHintStack,
} from '../../../src/analyzer/refactor-hints.js';
import { formatDestructiveChange } from '../../../src/analyzer/destructive-changes.js';
import {
  buildDiffTree,
  diffTreeToJson,
  renderChangeLines,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StackState } from '../../../src/types/state.js';
import type { DiffTreeNode } from '../../../src/cli/commands/diff-recursive.js';
import { requireDeploymentApproval } from '../../../src/deployment/deployment-approval.js';
import type { ResourceChange } from '../../../src/types/state.js';

const BUCKET = { BucketName: 'data' };

function stack(
  id: string,
  rows: { creates?: Array<[string, string, object]>; deletes?: Array<[string, string, object]> },
  env = 'acct/us-east-1'
): RefactorHintStack {
  return {
    id,
    stackName: `Stack${id}`,
    env,
    creates: (rows.creates ?? []).map(([logicalId, resourceType, properties]) => ({
      logicalId,
      resourceType,
      properties: properties as Record<string, unknown>,
    })),
    deletes: (rows.deletes ?? []).map(([logicalId, resourceType, properties]) => ({
      logicalId,
      resourceType,
      properties: properties as Record<string, unknown>,
    })),
  };
}

describe('findRefactorHints', () => {
  it('hints a rename in one stack and a move to another stack of the same environment', () => {
    const hints = findRefactorHints([
      stack('A', {
        deletes: [
          ['OldBucket', 'AWS::S3::Bucket', BUCKET],
          ['OldQueue', 'AWS::SQS::Queue', { QueueName: 'q' }],
        ],
        creates: [['NewBucket', 'AWS::S3::Bucket', BUCKET]],
      }),
      stack('B', { creates: [['MovedQueue', 'AWS::SQS::Queue', { QueueName: 'q' }]] }),
    ]);
    expect(Object.fromEntries(hints.get('A') ?? [])).toEqual({
      OldBucket: { stackName: 'StackA', logicalId: 'NewBucket' },
      OldQueue: { stackName: 'StackB', logicalId: 'MovedQueue' },
    });
  });

  it('gives no hint when the properties changed too: refactor would refuse the pair', () => {
    const hints = findRefactorHints([
      stack('A', {
        deletes: [['Old', 'AWS::S3::Bucket', BUCKET]],
        creates: [['New', 'AWS::S3::Bucket', { BucketName: 'other' }]],
      }),
    ]);
    expect(hints.size).toBe(0);
  });

  it('gives no hint to an ambiguous pair, in either direction', () => {
    const twoCreates = findRefactorHints([
      stack('A', {
        deletes: [['Old', 'AWS::SNS::Topic', {}]],
        creates: [
          ['New1', 'AWS::SNS::Topic', {}],
          ['New2', 'AWS::SNS::Topic', {}],
        ],
      }),
    ]);
    const twoDeletes = findRefactorHints([
      stack('A', { deletes: [['Old1', 'AWS::SNS::Topic', {}]] }),
      stack('B', {
        deletes: [['Old2', 'AWS::SNS::Topic', {}]],
        creates: [['New', 'AWS::SNS::Topic', {}]],
      }),
    ]);
    expect(twoCreates.size).toBe(0);
    expect(twoDeletes.size).toBe(0);
  });

  it('pairs only within one environment, and never a type refactor cannot move', () => {
    const crossEnv = findRefactorHints([
      stack('A', { deletes: [['Old', 'AWS::S3::Bucket', BUCKET]] }, 'acct/us-east-1'),
      stack('B', { creates: [['New', 'AWS::S3::Bucket', BUCKET]] }, 'acct/eu-west-1'),
    ]);
    const unpairable = findRefactorHints([
      stack('A', {
        deletes: [['OldMeta', 'AWS::CDK::Metadata', {}]],
        creates: [['NewMeta', 'AWS::CDK::Metadata', {}]],
      }),
    ]);
    expect(crossEnv.size).toBe(0);
    expect(unpairable.size).toBe(0);
  });

  it('treats an unresolved intrinsic as matching, as cdkd refactor does', () => {
    const hints = findRefactorHints([
      stack('A', {
        deletes: [['Old', 'AWS::SQS::Queue', { QueueName: 'q', KmsMasterKeyId: 'arn:key' }]],
        creates: [['New', 'AWS::SQS::Queue', { QueueName: 'q', KmsMasterKeyId: { Ref: 'Key' } }]],
      }),
    ]);
    expect(hints.get('A')?.get('Old')).toEqual({ stackName: 'StackA', logicalId: 'New' });
  });
});

describe('which stacks take part (cdkd refactor would plan them)', () => {
  const template = {
    Resources: { NewQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
  };
  const record: StackState = {
    version: 13,
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      OldQueue: { physicalId: 'u', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q' } },
    },
    outputs: {},
    lastModified: 1,
  };
  const tree = (state: StackState | null, isNestedChild = false) =>
    buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: false,
      stateBackend: {
        getState: async () => (state === null ? null : { state, etag: 'e' }),
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      isNestedChild,
    });

  it('a stack with a cdkd record offers its rows', async () => {
    const node = await tree(record);
    expect(node.refactorSides?.deletes.map((d) => d.logicalId)).toEqual(['OldQueue']);
    expect(node.refactorSides?.creates.map((c) => c.logicalId)).toEqual(['NewQueue']);
  });

  it('a stack with NO cdkd record yet offers none: a refactor never moves into it', async () => {
    expect((await tree(null)).refactorSides).toBeUndefined();
  });

  it('a nested child offers none: cdkd refactor plans top-level stacks only', async () => {
    expect((await tree(record, true)).refactorSides).toBeUndefined();
  });

  it('a rollback-orphan id is on neither side', async () => {
    const node = await tree({ ...record, orphans: [{ logicalId: 'OldQueue' } as never] });
    expect(node.refactorSides?.deletes).toEqual([]);
    expect(rollbackOrphanIds([{ logicalId: 'X' }, null, { logicalId: 3 }, 'Y'])).toEqual(new Set(['X']));
    expect(rollbackOrphanIds('not-a-list')).toEqual(new Set());
  });
});

describe('hintSidesOf', () => {
  it('takes CREATE desired properties and DELETE recorded properties, and nothing else', () => {
    const sides = hintSidesOf([
      { logicalId: 'C', changeType: 'CREATE', resourceType: 'T', desiredProperties: { a: 1 } },
      { logicalId: 'D', changeType: 'DELETE', resourceType: 'T', currentProperties: { b: 2 } },
      { logicalId: 'U', changeType: 'UPDATE', resourceType: 'T' },
    ]);
    expect(sides).toEqual({
      creates: [{ logicalId: 'C', resourceType: 'T', properties: { a: 1 } }],
      deletes: [{ logicalId: 'D', resourceType: 'T', properties: { b: 2 } }],
    });
  });
});

const MOVED = { stackName: 'Dest', logicalId: 'NewTable' };
const HINT = " (moved to Dest.NewTable, run 'cdkd refactor' to keep it)";

describe('where the hint is rendered', () => {
  it('words it as the AWS CDK CLI does, through the display helpers', () => {
    expect(movedToHint(MOVED)).toBe(HINT);
    expect(movedToHint({ stackName: 'S\u001b[31m', logicalId: 'X' })).not.toContain('\u001b');
  });

  it('on the diff DELETE row, and only there', () => {
    const lines: string[] = [];
    const changes = new Map<string, ResourceChange>([
      ['Table', { logicalId: 'Table', changeType: 'DELETE', resourceType: 'AWS::DynamoDB::Table' }],
      ['Other', { logicalId: 'Other', changeType: 'DELETE', resourceType: 'AWS::SQS::Queue' }],
    ]);
    renderChangeLines(changes, (l) => lines.push(l), undefined, undefined, new Map([['Table', MOVED]]));
    expect(lines).toEqual([`  [-] Table (AWS::DynamoDB::Table)${HINT}`, '  [-] Other (AWS::SQS::Queue)']);
  });

  it('in the --json payload, on the change and on the destructive change', () => {
    const node = {
      stackName: 'Src',
      displayName: 'Src',
      region: 'us-east-1',
      changes: new Map<string, ResourceChange>([
        ['Table', { logicalId: 'Table', changeType: 'DELETE', resourceType: 'AWS::DynamoDB::Table' }],
      ]),
      ccApiRoutes: new Map(),
      outputChanges: [],
      adoptedOrphans: [],
      unreadable: [],
      unreadableContainers: [],
      unreadableOrphans: [],
      destructiveChanges: withMovedTo(
        [{ stackName: 'Src', logicalId: 'Table', resourceType: 'AWS::DynamoDB::Table', impact: 'WILL_DESTROY' }],
        new Map([['Table', MOVED]])
      ),
      blocking: [],
      children: [],
      refactorHints: new Map([['Table', MOVED]]),
    } as unknown as DiffTreeNode;
    const json = diffTreeToJson(node) as unknown as {
      changes: Array<{ movedTo?: unknown }>;
      destructiveChanges: Array<{ movedTo?: unknown }>;
    };
    expect(json.changes[0]!.movedTo).toEqual(MOVED);
    expect(json.destructiveChanges[0]!.movedTo).toEqual(MOVED);
  });

  it('on a --fail-on=destructive line, and only for a removal', () => {
    const [destroyed, replaced] = withMovedTo(
      [
        { stackName: 'Src', logicalId: 'Table', resourceType: 'AWS::DynamoDB::Table', impact: 'WILL_DESTROY' },
        { stackName: 'Src', logicalId: 'Fn', resourceType: 'AWS::Lambda::Function', impact: 'WILL_REPLACE' },
      ],
      new Map([
        ['Table', MOVED],
        ['Fn', MOVED],
      ])
    );
    expect(formatDestructiveChange(destroyed!)).toContain(HINT);
    expect(formatDestructiveChange(replaced!)).not.toContain('moved to');
  });

  it('not in the approval prompt of a nested child, nor for a rollback-orphan id', async () => {
    for (const extra of [{ stackName: 'Parent~Child' }, { orphans: [{ logicalId: 'OldTable' }] }]) {
      const approve = vi.fn(async () => true);
      await requireDeploymentApproval({
        options: { requireApproval: 'destructive', approveDeployment: approve },
        stackName: 'Src',
        changes: [
          { logicalId: 'OldTable', changeType: 'DELETE', resourceType: 'AWS::DynamoDB::Table', currentProperties: {} },
          { logicalId: 'NewTable', changeType: 'CREATE', resourceType: 'AWS::DynamoDB::Table', desiredProperties: {} },
        ],
        records: { OldTable: { physicalId: 't', resourceType: 'AWS::DynamoDB::Table', properties: {} } },
        template: { Resources: {} },
        ...(extra as object),
      });
      const request = (approve.mock.calls[0] as unknown[])[0] as {
        destructiveChanges: Array<{ movedTo?: unknown }>;
      };
      expect(request.destructiveChanges[0]!.movedTo, JSON.stringify(extra)).toBeUndefined();
    }
  });

  it("in the deploy approval prompt, for a rename within the stack being deployed", async () => {
    const approve = vi.fn(async () => true);
    await requireDeploymentApproval({
      options: { requireApproval: 'destructive', approveDeployment: approve },
      stackName: 'Src',
      changes: [
        {
          logicalId: 'OldTable',
          changeType: 'DELETE',
          resourceType: 'AWS::DynamoDB::Table',
          currentProperties: { TableName: 't' },
        },
        {
          logicalId: 'NewTable',
          changeType: 'CREATE',
          resourceType: 'AWS::DynamoDB::Table',
          desiredProperties: { TableName: 't' },
        },
      ],
      records: {
        OldTable: { physicalId: 't', resourceType: 'AWS::DynamoDB::Table', properties: { TableName: 't' } },
      },
      template: { Resources: {} },
    });
    const request = (approve.mock.calls[0] as unknown[] | undefined)?.[0] as {
      destructiveChanges: Array<{ logicalId: string; movedTo?: unknown }>;
    };
    expect(request.destructiveChanges).toEqual([
      expect.objectContaining({ logicalId: 'OldTable', movedTo: { stackName: 'Src', logicalId: 'NewTable' } }),
    ]);
  });
});
