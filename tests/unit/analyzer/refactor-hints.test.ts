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

  // go-to-k/cdkd#6097: the diff reads the stack's template for references.
  it('a CREATE referencing a resource the diff updates is not offered', async () => {
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: {
          Fn: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'changed' } },
          NewQueue: {
            Type: 'AWS::SQS::Queue',
            Properties: { QueueName: 'q', RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Fn', 'Arn'] } } },
          },
        },
      },
      nestedTemplates: {},
      recursive: false,
      stateBackend: {
        getState: async () => ({
          state: {
            ...record,
            resources: {
              ...record.resources,
              Fn: { physicalId: 'f', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'old' } },
            },
          },
          etag: 'e',
        }),
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(node.changes.get('Fn')?.changeType).toBe('UPDATE');
    expect(node.refactorSides?.deletes.map((d) => d.logicalId)).toEqual(['OldQueue']);
    expect(node.refactorSides?.creates).toEqual([]);
  });

  // go-to-k/cdkd#6797: the diff hands the records over, so a DELETE carries
  // its recorded dependencies and a CREATE the staying resources it references.
  it('a DELETE carries its record dependencies, a CREATE its staying references', async () => {
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: {
          Dlq: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'dlq' } },
          NewQueue: {
            Type: 'AWS::SQS::Queue',
            Properties: { QueueName: 'q', RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Dlq', 'Arn'] } } },
          },
        },
      },
      nestedTemplates: {},
      recursive: false,
      stateBackend: {
        getState: async () => ({
          state: {
            ...record,
            resources: {
              OldQueue: { ...record.resources['OldQueue']!, dependencies: ['OtherDlq'] },
              Dlq: { physicalId: 'd', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'dlq' } },
            },
          },
          etag: 'e',
        }),
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(node.refactorSides?.deletes).toEqual([
      expect.objectContaining({ logicalId: 'OldQueue', recordedDependencies: ['OtherDlq'] }),
    ]);
    expect(node.refactorSides?.creates).toEqual([
      expect.objectContaining({ logicalId: 'NewQueue', stayingReferences: ['Dlq'] }),
    ]);
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
    const sides = hintSidesOf(
      [
        { logicalId: 'C', changeType: 'CREATE', resourceType: 'T', desiredProperties: { a: 1 } },
        { logicalId: 'D', changeType: 'DELETE', resourceType: 'T', currentProperties: { b: 2 } },
        { logicalId: 'U', changeType: 'UPDATE', resourceType: 'T' },
      ],
      { Resources: { C: { Type: 'T', Properties: { a: 1 } }, U: { Type: 'T' } } }
    );
    expect(sides).toEqual({
      creates: [{ logicalId: 'C', resourceType: 'T', properties: { a: 1 } }],
      deletes: [{ logicalId: 'D', resourceType: 'T', properties: { b: 2 } }],
    });
  });

  // go-to-k/cdkd#6097: CDK's `fn.currentVersion` after a code change. The new
  // version's own properties match the old one's, but it is a new resource.
  const VERSION_TEMPLATE = {
    Resources: {
      Role: { Type: 'AWS::IAM::Role', Properties: {} },
      Fn: { Type: 'AWS::Lambda::Function', Properties: { Role: { 'Fn::GetAtt': ['Role', 'Arn'] } } },
      FnVersionNew: { Type: 'AWS::Lambda::Version', Properties: { FunctionName: { Ref: 'Fn' } } },
    },
  };
  const versionRows = (changed: 'Fn' | 'Role' | undefined): ResourceChange[] => [
    {
      logicalId: 'FnVersionNew',
      changeType: 'CREATE',
      resourceType: 'AWS::Lambda::Version',
      desiredProperties: { FunctionName: 'my-fn' },
    },
    {
      logicalId: 'FnVersionOld',
      changeType: 'DELETE',
      resourceType: 'AWS::Lambda::Version',
      currentProperties: { FunctionName: 'my-fn' },
    },
    {
      logicalId: 'Fn',
      changeType: changed === 'Fn' ? 'UPDATE' : 'NO_CHANGE',
      resourceType: 'AWS::Lambda::Function',
    },
    {
      logicalId: 'Role',
      changeType: changed === 'Role' ? 'UPDATE' : 'NO_CHANGE',
      resourceType: 'AWS::IAM::Role',
    },
  ];
  const hintFor = (rows: ResourceChange[]) =>
    findRefactorHints([
      { id: 's', stackName: 'S', env: 'e', ...hintSidesOf(rows, VERSION_TEMPLATE) },
    ]).get('s');

  it('drops a CREATE that references a resource this diff updates (a new Lambda version)', () => {
    expect(hintFor(versionRows('Fn'))).toBeUndefined();
  });

  it('drops it when the updated resource is reached through another one', () => {
    expect(hintFor(versionRows('Role'))).toBeUndefined();
  });

  it('drops it when it references a CREATE no DELETE row could make a rename (an added method)', () => {
    const template = {
      Resources: {
        ...VERSION_TEMPLATE.Resources,
        FnVersionNew: { ...VERSION_TEMPLATE.Resources.FnVersionNew, DependsOn: ['Method'] },
        Method: { Type: 'AWS::ApiGateway::Method', Properties: {} },
      },
    };
    const added: ResourceChange = {
      logicalId: 'Method',
      changeType: 'CREATE',
      resourceType: 'AWS::ApiGateway::Method',
      desiredProperties: {},
    };
    const hints = (rows: ResourceChange[]) =>
      findRefactorHints([{ id: 's', stackName: 'S', env: 'e', ...hintSidesOf(rows, template) }]).get('s');
    expect(hints([...versionRows(undefined), added])).toBeUndefined();
    // A Method DELETE could make the CREATE a rename: left to `cdkd refactor`.
    const removed: ResourceChange = {
      logicalId: 'OldMethod',
      changeType: 'DELETE',
      resourceType: 'AWS::ApiGateway::Method',
      currentProperties: {},
    };
    expect(hints([...versionRows(undefined), added, removed])?.get('FnVersionOld')).toEqual({
      stackName: 'S',
      logicalId: 'FnVersionNew',
    });
  });

  // go-to-k/cdkd#6797: a subscription moved from Q1 to Q2, both existing.
  // The CREATE's `Ref: Q2` matches anything loosely, so only the record's
  // dependencies can tell the pair apart.
  describe('a CREATE referencing a resource that stays in the stack', () => {
    const template = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: {} },
        Q1: { Type: 'AWS::SQS::Queue', Properties: {} },
        Q2: { Type: 'AWS::SQS::Queue', Properties: {} },
        SubQ2: {
          Type: 'AWS::SNS::Subscription',
          Properties: {
            TopicArn: { Ref: 'Topic' },
            Protocol: 'sqs',
            Endpoint: { 'Fn::GetAtt': ['Q2', 'Arn'] },
          },
        },
      },
    };
    const rows: ResourceChange[] = [
      {
        logicalId: 'SubQ2',
        changeType: 'CREATE',
        resourceType: 'AWS::SNS::Subscription',
        desiredProperties: template.Resources.SubQ2.Properties,
      },
      {
        logicalId: 'SubQ1',
        changeType: 'DELETE',
        resourceType: 'AWS::SNS::Subscription',
        currentProperties: { TopicArn: 'arn:topic', Protocol: 'sqs', Endpoint: 'arn:q1' },
      },
      ...['Topic', 'Q1', 'Q2'].map(
        (logicalId): ResourceChange => ({
          logicalId,
          changeType: 'NO_CHANGE',
          resourceType: logicalId === 'Topic' ? 'AWS::SNS::Topic' : 'AWS::SQS::Queue',
        })
      ),
    ];
    const hint = (dependencies?: string[]) =>
      findRefactorHints([
        {
          id: 's',
          stackName: 'S',
          env: 'e',
          ...hintSidesOf(rows, template, new Set(), {
            SubQ1: {
              physicalId: 'arn:sub1',
              resourceType: 'AWS::SNS::Subscription',
              properties: {},
              ...(dependencies && { dependencies }),
            },
          }),
        },
      ]).get('s');

    it('gives no hint when the record referenced another existing resource', () => {
      expect(hint(['Topic', 'Q1'])).toBeUndefined();
    });

    it('hints a rename whose record referenced the same resources', () => {
      expect(hint(['Topic', 'Q2'])?.get('SubQ1')).toEqual({ stackName: 'S', logicalId: 'SubQ2' });
    });

    it('stays loose for a record with no dependencies field (an older record)', () => {
      expect(hint(undefined)?.get('SubQ1')).toEqual({ stackName: 'S', logicalId: 'SubQ2' });
    });
  });

  it('gives no hint across stacks to a CREATE referencing a staying resource: ids are per stack', () => {
    const hints = findRefactorHints([
      {
        id: 'A',
        stackName: 'A',
        env: 'e',
        creates: [],
        deletes: [
          {
            logicalId: 'Sub',
            resourceType: 'AWS::SNS::Subscription',
            properties: { Endpoint: 'arn:a-queue' },
            recordedDependencies: ['Queue'],
          },
        ],
      },
      {
        id: 'B',
        stackName: 'B',
        env: 'e',
        creates: [
          {
            logicalId: 'Sub',
            resourceType: 'AWS::SNS::Subscription',
            properties: { Endpoint: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
            stayingReferences: ['Queue'],
          },
        ],
        deletes: [],
      },
    ]);
    expect(hints.size).toBe(0);
  });

  it('gives no hint to a CREATE referencing a new resource, but keeps one referencing a renamed one', () => {
    const sub = (endpointQueue: string) => ({
      logicalId: 'Sub2',
      resourceType: 'AWS::SNS::Subscription',
      properties: { Endpoint: { 'Fn::GetAtt': [endpointQueue, 'Arn'] } },
      createdReferences: [endpointQueue],
    });
    const run = (newQueueName: string) =>
      findRefactorHints([
        {
          id: 's',
          stackName: 'S',
          env: 'e',
          creates: [
            { logicalId: 'Q2', resourceType: 'AWS::SQS::Queue', properties: { QueueName: newQueueName } },
            sub('Q2'),
          ],
          deletes: [
            { logicalId: 'Q1', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q1' } },
            { logicalId: 'Sub1', resourceType: 'AWS::SNS::Subscription', properties: { Endpoint: 'arn:q1' } },
          ],
        },
      ]).get('s');
    // Q2 is a new queue (another name): the subscription to it is new too.
    expect(run('q2')).toBeUndefined();
    // Two hops (Alarm2 -> Sub2 -> Q2): the alarm on the new subscription is new too.
    const chained = findRefactorHints([
      {
        id: 's',
        stackName: 'S',
        env: 'e',
        creates: [
          { logicalId: 'Q2', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q2' } },
          sub('Q2'),
          {
            logicalId: 'Alarm2',
            resourceType: 'AWS::CloudWatch::Alarm',
            properties: { Dimensions: [{ Value: { Ref: 'Sub2' } }] },
            createdReferences: ['Sub2'],
          },
        ],
        deletes: [
          { logicalId: 'Q1', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q1' } },
          { logicalId: 'Sub1', resourceType: 'AWS::SNS::Subscription', properties: { Endpoint: 'arn:q1' } },
          {
            logicalId: 'Alarm1',
            resourceType: 'AWS::CloudWatch::Alarm',
            properties: { Dimensions: [{ Value: 'arn:sub1' }] },
          },
        ],
      },
    ]).get('s');
    expect(chained).toBeUndefined();
    // A referenced CREATE that is no candidate at all (here: not offered) is new.
    const notOffered = findRefactorHints([
      {
        id: 's',
        stackName: 'S',
        env: 'e',
        creates: [sub('Q2')],
        deletes: [
          { logicalId: 'Sub1', resourceType: 'AWS::SNS::Subscription', properties: { Endpoint: 'arn:q1' } },
        ],
      },
    ]).get('s');
    expect(notOffered).toBeUndefined();
    // Q2 is Q1 renamed: the subscription may be renamed with it.
    expect(Object.fromEntries(run('q1') ?? [])).toEqual({
      Q1: { stackName: 'S', logicalId: 'Q2' },
      Sub1: { stackName: 'S', logicalId: 'Sub2' },
    });
  });

  it('keeps the hint when nothing the CREATE references changes (a plain rename)', () => {
    expect(hintFor(versionRows(undefined))?.get('FnVersionOld')).toEqual({
      stackName: 'S',
      logicalId: 'FnVersionNew',
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

  // go-to-k/cdkd#6797: the prompt hands the records over too.
  it('not in the deploy approval prompt for a subscription moved to another existing queue', async () => {
    const approve = vi.fn(async () => true);
    await requireDeploymentApproval({
      options: { requireApproval: 'destructive', approveDeployment: approve },
      stackName: 'Src',
      changes: [
        {
          logicalId: 'SubQ1',
          changeType: 'DELETE',
          resourceType: 'AWS::SNS::Subscription',
          currentProperties: { Protocol: 'sqs', Endpoint: 'arn:q1' },
        },
        {
          logicalId: 'SubQ2',
          changeType: 'CREATE',
          resourceType: 'AWS::SNS::Subscription',
          desiredProperties: { Protocol: 'sqs', Endpoint: { 'Fn::GetAtt': ['Q2', 'Arn'] } },
        },
        { logicalId: 'Q2', changeType: 'NO_CHANGE', resourceType: 'AWS::SQS::Queue' },
      ],
      records: {
        SubQ1: {
          physicalId: 's1',
          resourceType: 'AWS::SNS::Subscription',
          properties: { Protocol: 'sqs', Endpoint: 'arn:q1' },
          dependencies: ['Q1'],
        },
        Q2: { physicalId: 'q2', resourceType: 'AWS::SQS::Queue', properties: {} },
      },
      template: {
        Resources: {
          Q2: { Type: 'AWS::SQS::Queue', Properties: {} },
          SubQ2: {
            Type: 'AWS::SNS::Subscription',
            Properties: { Protocol: 'sqs', Endpoint: { 'Fn::GetAtt': ['Q2', 'Arn'] } },
          },
        },
      },
    });
    const request = (approve.mock.calls[0] as unknown[] | undefined)?.[0] as {
      destructiveChanges: Array<{ logicalId: string; movedTo?: unknown }>;
    };
    expect(request.destructiveChanges.map((c) => c.logicalId)).toEqual(['SubQ1']);
    expect(request.destructiveChanges[0]?.movedTo).toBeUndefined();
  });

  // go-to-k/cdkd#6097: the prompt reads the stack's template for references.
  it('not in the deploy approval prompt for a new Lambda version after a code change', async () => {
    const approve = vi.fn(async () => true);
    await requireDeploymentApproval({
      options: { requireApproval: 'destructive', approveDeployment: approve },
      stackName: 'Src',
      changes: [
        {
          logicalId: 'VerOld',
          changeType: 'DELETE',
          resourceType: 'AWS::Lambda::Version',
          currentProperties: { FunctionName: 'fn' },
        },
        {
          logicalId: 'VerNew',
          changeType: 'CREATE',
          resourceType: 'AWS::Lambda::Version',
          desiredProperties: { FunctionName: 'fn' },
        },
        { logicalId: 'Fn', changeType: 'UPDATE', resourceType: 'AWS::Lambda::Function' },
      ],
      records: {
        VerOld: { physicalId: 'v1', resourceType: 'AWS::Lambda::Version', properties: { FunctionName: 'fn' } },
      },
      template: {
        Resources: {
          Fn: { Type: 'AWS::Lambda::Function', Properties: {} },
          VerNew: { Type: 'AWS::Lambda::Version', Properties: { FunctionName: { Ref: 'Fn' } } },
        },
      },
    });
    const request = (approve.mock.calls[0] as unknown[] | undefined)?.[0] as {
      destructiveChanges: Array<{ logicalId: string; movedTo?: unknown }>;
    };
    expect(request.destructiveChanges).toEqual([expect.objectContaining({ logicalId: 'VerOld' })]);
    expect(request.destructiveChanges[0]!.movedTo).toBeUndefined();
  });
});
