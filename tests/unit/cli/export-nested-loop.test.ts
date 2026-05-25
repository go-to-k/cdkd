/**
 * Unit tests for `runPerStackImportLoop` — the per-stack IMPORT loop
 * driving `cdkd export` for nested-stack trees (issue #464 PR B2,
 * design doc §4.3).
 *
 * Kept in a separate file from export.test.ts so the AWS SDK / waiter /
 * upload-cfn-template vi.mocks don't leak into the rest of the export
 * test surface. Mock pattern mirrors export-template-format.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    }),
  }),
}));

const waitChangeSetCreate = vi.hoisted(() => vi.fn(async () => undefined));
const waitStackImport = vi.hoisted(() => vi.fn(async () => undefined));
const waitStackUpdate = vi.hoisted(() => vi.fn(async () => undefined));

const cfnCommands = vi.hoisted(() => {
  class FakeCommand {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  return {
    CreateChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('CreateChangeSet', input);
      }
    },
    ExecuteChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('ExecuteChangeSet', input);
      }
    },
    DescribeChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeChangeSet', input);
      }
    },
    DescribeStacksCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeStacks', input);
      }
    },
    DescribeTypeCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeType', input);
      }
    },
    DescribeStackEventsCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeStackEvents', input);
      }
    },
    DeleteChangeSetCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteChangeSet', input);
      }
    },
    GetTemplateCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('GetTemplate', input);
      }
    },
    UpdateStackCommand: class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super('UpdateStack', input);
      }
    },
  };
});

vi.mock('@aws-sdk/client-cloudformation', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '@aws-sdk/client-cloudformation'
  );
  return {
    ...real,
    CreateChangeSetCommand: cfnCommands.CreateChangeSetCommand,
    ExecuteChangeSetCommand: cfnCommands.ExecuteChangeSetCommand,
    DescribeChangeSetCommand: cfnCommands.DescribeChangeSetCommand,
    DescribeStacksCommand: cfnCommands.DescribeStacksCommand,
    DescribeTypeCommand: cfnCommands.DescribeTypeCommand,
    DescribeStackEventsCommand: cfnCommands.DescribeStackEventsCommand,
    DeleteChangeSetCommand: cfnCommands.DeleteChangeSetCommand,
    GetTemplateCommand: cfnCommands.GetTemplateCommand,
    UpdateStackCommand: cfnCommands.UpdateStackCommand,
    waitUntilChangeSetCreateComplete: waitChangeSetCreate,
    waitUntilStackImportComplete: waitStackImport,
    waitUntilStackUpdateComplete: waitStackUpdate,
  };
});

// Mock uploadCfnTemplate so child-template uploads for the non-leaf-parent
// path return a deterministic URL + a cleanup spy we can assert on.
const uploadCfnTemplateMock = vi.hoisted(() =>
  vi.fn(async (opts: { stackName: string }) => ({
    url: `https://state-bucket.s3.amazonaws.com/cdkd-migrate-tmp/${opts.stackName}/template.json`,
    cleanup: vi.fn(async () => undefined),
  }))
);

vi.mock('../../../src/cli/upload-cfn-template.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '../../../src/cli/upload-cfn-template.js'
  );
  return {
    ...real,
    uploadCfnTemplate: uploadCfnTemplateMock,
  };
});

// Mock the interactive confirmation prompt so the `--yes`-false cancellation
// path is reachable in tests. Default answer is 'n' (cancel); every test that
// passes `yes: true` skips the prompt entirely, so the default is inert there.
const readlineQuestion = vi.hoisted(() => vi.fn(async () => 'n'));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: readlineQuestion,
    close: vi.fn(),
  }),
}));

import {
  buildCdkdStateStackTree,
  runPerStackImportLoop,
  flipStackToUpdateComplete,
  type CdkdStateStackTree,
} from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

interface SendCall {
  name: string;
  input: Record<string, unknown>;
}

/** Build a v6 `StackState` shape with the minimal fields the orchestrator reads. */
function makeState(args: {
  stackName: string;
  region: string;
  resources?: Record<string, { resourceType: string; physicalId?: string }>;
  parentStack?: string;
  parentLogicalId?: string;
}): StackState {
  const resources: StackState['resources'] = {};
  for (const [logicalId, r] of Object.entries(args.resources ?? {})) {
    resources[logicalId] = {
      physicalId: r.physicalId ?? `phy-${logicalId}`,
      resourceType: r.resourceType,
      properties: {},
      attributes: {},
      dependencies: [],
    };
  }
  return {
    version: 6,
    stackName: args.stackName,
    region: args.region,
    resources,
    outputs: {},
    lastModified: 0,
    ...(args.parentStack !== undefined && { parentStack: args.parentStack }),
    ...(args.parentLogicalId !== undefined && { parentLogicalId: args.parentLogicalId }),
    ...(args.parentStack !== undefined && { parentRegion: args.region }),
  };
}

/**
 * Build a configurable mock CFn client. By default:
 *   - CreateChangeSet / ExecuteChangeSet / DeleteChangeSet / DescribeStackEvents:
 *     succeed silently.
 *   - DescribeType: succeeds with a `BucketName` PrimaryIdentifier so
 *     `buildImportPlan`'s identifier resolution works for AWS::S3::Bucket.
 *   - DescribeStacks: returns a synthetic stack with StackId = `arn:aws:cloudformation:...:stack/<name>/<uuid>`.
 *     The orchestrator uses this immediately post-IMPORT to capture the
 *     child stack ARN for the parent's adoption iteration.
 *   - DescribeStacks (pre-flight via assertCfnStackAbsent): throws "does
 *     not exist" so the orchestrator proceeds.
 *   - GetTemplate: returns a deterministic JSON body keyed by stack name.
 */
function buildCfnClient(overrides?: {
  describeStacksPreflight?: (stackName: string) => Promise<unknown>;
  describeStacksPostImport?: (stackName: string) => Promise<unknown>;
  createChangeSet?: (input: Record<string, unknown>) => Promise<unknown>;
}): { client: AwsClients['cloudFormation']; calls: SendCall[] } {
  const calls: SendCall[] = [];
  // Pre-flight DescribeStacks: every CFn name in the tree is checked once
  // before any AWS write. Returns "does not exist" so the orchestrator
  // proceeds. Post-IMPORT DescribeStacks (called after each per-stack
  // IMPORT) returns the synthetic ARN.
  const describeStacksCallsByStackName = new Map<string, number>();
  const describeStacksPreflight =
    overrides?.describeStacksPreflight ??
    (async () => {
      throw new Error('Stack does not exist');
    });
  const describeStacksPostImport =
    overrides?.describeStacksPostImport ??
    (async (stackName: string) => ({
      Stacks: [
        {
          StackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${stackName}/uuid-${stackName}`,
          StackName: stackName,
        },
      ],
    }));

  const send = vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
    calls.push({ name: cmd._name, input: cmd.input });
    switch (cmd._name) {
      case 'DescribeStacks': {
        const stackName = String(cmd.input['StackName']);
        const count = (describeStacksCallsByStackName.get(stackName) ?? 0) + 1;
        describeStacksCallsByStackName.set(stackName, count);
        // First call per stack name = pre-flight. Subsequent = post-IMPORT.
        if (count === 1) {
          return describeStacksPreflight(stackName);
        }
        return describeStacksPostImport(stackName);
      }
      case 'DescribeType': {
        const t = String(cmd.input['TypeName']);
        // Minimal handler for the integ-fixture-shape types.
        const schemaMap: Record<string, string> = {
          'AWS::S3::Bucket': '"BucketName"',
          'AWS::SSM::Parameter': '"Name"',
          'AWS::CloudFormation::Stack': '"StackId"',
        };
        const idField = schemaMap[t];
        if (!idField) {
          throw new Error(`DescribeType: unmocked type '${t}'`);
        }
        return { Schema: `{"primaryIdentifier": ["/properties/${idField.slice(1, -1)}"]}` };
      }
      case 'CreateChangeSet':
        if (overrides?.createChangeSet) {
          return overrides.createChangeSet(cmd.input);
        }
        return {};
      case 'GetTemplate':
        return {
          TemplateBody: JSON.stringify({
            Resources: {
              GetTemplateChildLeaf: {
                Type: 'AWS::SSM::Parameter',
                Properties: { Name: 'get-template-child-leaf', Type: 'String', Value: 'x' },
              },
            },
          }),
        };
      case 'DescribeStackEvents':
        return { StackEvents: [] };
      default:
        return {};
    }
  });
  return {
    client: { send } as unknown as AwsClients['cloudFormation'],
    calls,
  };
}

function buildStateBackend(initialStates: Record<string, StackState>): {
  backend: S3StateBackend;
  deleted: Array<{ stackName: string; region: string }>;
} {
  const deleted: Array<{ stackName: string; region: string }> = [];
  const backend = {
    async getState(stackName: string, region: string) {
      const s = initialStates[`${stackName}|${region}`];
      if (!s) return null;
      return { state: s, etag: '"mock"', migrationPending: undefined };
    },
    async deleteState(stackName: string, region: string) {
      deleted.push({ stackName, region });
    },
  } as unknown as S3StateBackend;
  return { backend, deleted };
}

function buildLockManager(opts?: { acquireFn?: (stackName: string) => Promise<boolean> }): {
  manager: LockManager;
  acquired: Array<{ stackName: string; region: string }>;
  released: Array<{ stackName: string; region: string }>;
} {
  const acquired: Array<{ stackName: string; region: string }> = [];
  const released: Array<{ stackName: string; region: string }> = [];
  const manager = {
    // The orchestrator switched to `acquireLockWithRetry` (#589 Minor 2),
    // which throws (does NOT return false) on terminal acquisition failure.
    // Mirror that contract so the lock-contention test exercises the real
    // error-wrapping path. No real retry/delay — `acquireFn` resolves the
    // terminal outcome synchronously for the test.
    async acquireLockWithRetry(stackName: string, region: string) {
      const ok = opts?.acquireFn ? await opts.acquireFn(stackName) : true;
      if (!ok) {
        throw new Error(
          `Failed to acquire lock for stack '${stackName}' (${region}) after retries.`
        );
      }
      acquired.push({ stackName, region });
    },
    async releaseLock(stackName: string, region: string) {
      released.push({ stackName, region });
    },
  } as unknown as LockManager;
  return { manager, acquired, released };
}

const STATE_BUCKET = 'cdkd-state-test';

describe('runPerStackImportLoop (issue #464 PR B2) — leaf-only happy path', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    uploadCfnTemplateMock.mockClear();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackImport.mockReset();
    waitStackImport.mockResolvedValue(undefined);
    waitStackUpdate.mockReset();
    waitStackUpdate.mockResolvedValue(undefined);
  });

  it('submits one IMPORT changeset for a single-node tree and deletes state', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { MyBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'my-bucket-123' } },
    });
    const { backend: stateBackend, deleted } = buildStateBackend({
      'Root|us-east-1': root,
    });
    const { manager: lockManager, acquired, released } = buildLockManager();
    const { client: cfnClient, calls } = buildCfnClient();

    const rootTemplate = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket-123' },
        },
      },
    };
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map(),
    };

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree,
      rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: {
        cfnClient,
        stateBackend,
        lockManager,
        uploadOpts: { stateBucket: STATE_BUCKET },
        lockOwner: 'tester@host:1234',
      },
      options: {
        dryRun: false,
        yes: true,
        includeNonImportable: false,
        recreateImportUnsupported: true,
      },
    });

    expect(result.outcome).toBe('success');
    expect(result.importedStacks).toHaveLength(1);
    expect(result.importedStacks[0]!.cdkdStackName).toBe('Root');
    expect(result.importedStacks[0]!.cfnStackName).toBe('Root');

    // Only ONE IMPORT changeset is submitted (no nested adoption for a leaf-only tree).
    const createCalls = calls.filter((c) => c.name === 'CreateChangeSet');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.input['ChangeSetType']).toBe('IMPORT');
    // No GetTemplate (no nested adoption) and no uploadCfnTemplate.
    expect(calls.find((c) => c.name === 'GetTemplate')).toBeUndefined();
    expect(uploadCfnTemplateMock).not.toHaveBeenCalled();
    // No UpdateStack flip: the root is never adopted as a nested member,
    // so the IMPORT_COMPLETE → UPDATE_COMPLETE transition is unnecessary.
    expect(calls.find((c) => c.name === 'UpdateStack')).toBeUndefined();

    // Per-non-root-child lock acquisition: NONE for a leaf-only tree.
    // (The root's lock is acquired by the outer exportCommand, not the orchestrator.)
    expect(acquired).toEqual([]);
    expect(released).toEqual([]);

    // State deletion: leaf-first → root alone.
    expect(deleted).toEqual([{ stackName: 'Root', region: 'us-east-1' }]);
  });
});

describe('runPerStackImportLoop (issue #464 PR B2) — parent + leaf', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    uploadCfnTemplateMock.mockClear();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackImport.mockReset();
    waitStackImport.mockResolvedValue(undefined);
    waitStackUpdate.mockReset();
    waitStackUpdate.mockResolvedValue(undefined);
  });

  // Write nested-stack child template files to a tmpdir so
  // `readNestedChildTemplateFile` runs unmocked. Yields the child path
  // each test can plumb into rootStackInfoNestedTemplates.
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cdkd-export-loop-test-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFixture(relPath: string, content: Record<string, unknown>): string {
    const abs = join(tmpRoot, relPath);
    writeFileSync(abs, JSON.stringify(content), 'utf-8');
    return abs;
  }

  it('imports leaf first, then parent with child-ARN adoption', async () => {
    const childTemplate = {
      Resources: {
        ChildBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'child-bucket-456' },
        },
      },
    };
    const childPath = writeFixture('Child.nested.template.json', childTemplate);

    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        ParentBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'parent-bucket-789' },
        Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
      },
    });
    const child = makeState({
      stackName: 'Root~Child',
      region: 'us-east-1',
      resources: {
        ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'child-bucket-456' },
      },
      parentStack: 'Root',
      parentLogicalId: 'Child',
    });
    const { backend: stateBackend, deleted } = buildStateBackend({
      'Root|us-east-1': root,
      'Root~Child|us-east-1': child,
    });
    const { manager: lockManager, acquired, released } = buildLockManager();
    const { client: cfnClient, calls } = buildCfnClient();

    const rootTemplate = {
      Resources: {
        ParentBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'parent-bucket-789' },
        },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://cdk-asset/.../Child.template.json' },
          Metadata: { 'aws:asset:path': 'Child.nested.template.json' },
        },
      },
    };
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map([
        [
          'Child',
          {
            stackName: 'Root~Child',
            region: 'us-east-1',
            state: child,
            nestedChildren: new Map(),
          },
        ],
      ]),
    };

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree,
      rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: {
        cfnClient,
        stateBackend,
        lockManager,
        uploadOpts: { stateBucket: STATE_BUCKET },
        lockOwner: 'tester@host:1234',
      },
      options: {
        dryRun: false,
        yes: true,
        includeNonImportable: false,
        recreateImportUnsupported: true,
      },
    });

    expect(result.outcome).toBe('success');
    expect(result.importedStacks).toHaveLength(2);
    // Leaf-first iteration: child first, then root parent.
    expect(result.importedStacks[0]!.cdkdStackName).toBe('Root~Child');
    expect(result.importedStacks[0]!.cfnStackName).toBe('Root-Child'); // cdkd2cfnStackName mapping
    expect(result.importedStacks[1]!.cdkdStackName).toBe('Root');
    expect(result.importedStacks[1]!.cfnStackName).toBe('Root');

    // Three IMPORT changesets total: leaf child (Phase 1A, single pass) +
    // parent (Phase 1A leaves-only CREATE-via-IMPORT then Phase 1B
    // UPDATE-via-IMPORT for nested-child adoption per AWS's "Nest an
    // existing stack" 2-step procedure).
    const createCalls = calls.filter((c) => c.name === 'CreateChangeSet');
    expect(createCalls).toHaveLength(3);
    expect(createCalls.map((c) => c.input['StackName'])).toEqual([
      'Root-Child', // leaf Phase 1A
      'Root', // parent Phase 1A (leaves only)
      'Root', // parent Phase 1B (nested-child adoption via UPDATE-via-IMPORT)
    ]);

    // Parent's Phase 1A submits ONLY the leaf resource (ParentBucket); the
    // nested-stack row is intentionally absent here so AWS doesn't try to
    // create-and-adopt the child in a single CREATE-via-IMPORT changeset
    // (which it rejects with "Stack <child-arn> is not in an importable
    // status, current stack status is IMPORT_COMPLETE").
    const parentPhase1A = createCalls[1]!;
    const parentPhase1AResources = parentPhase1A.input['ResourcesToImport'] as Array<
      Record<string, unknown>
    >;
    expect(parentPhase1AResources).toHaveLength(1);
    expect(parentPhase1AResources[0]!['ResourceType']).toBe('AWS::S3::Bucket');
    const parentPhase1ABody = String(parentPhase1A.input['TemplateBody']);
    expect(parentPhase1ABody).not.toContain('AWS::CloudFormation::Stack');

    // Parent's Phase 1B is the actual nested-child adoption: ResourcesToImport[]
    // has ONLY the nested-stack row (parent leaves are already imported and
    // owned by the parent stack from Phase 1A).
    const parentPhase1B = createCalls[2]!;
    const parentPhase1BResources = parentPhase1B.input['ResourcesToImport'] as Array<
      Record<string, unknown>
    >;
    expect(parentPhase1BResources).toHaveLength(1);
    const adoption = parentPhase1BResources[0]!;
    expect(adoption['ResourceType']).toBe('AWS::CloudFormation::Stack');
    expect(adoption['LogicalResourceId']).toBe('Child');
    // ResourceIdentifier.StackId must be the child's just-IMPORTed CFn ARN.
    const childArn = (adoption['ResourceIdentifier'] as { StackId: string }).StackId;
    expect(childArn).toContain('stack/Root-Child/');

    // Phase 1B's template must carry the nested-stack row with
    // DeletionPolicy: Retain + the rewritten TemplateURL pointing at the
    // uploaded child template.
    const parentPhase1BBody = String(parentPhase1B.input['TemplateBody']);
    expect(parentPhase1BBody).toContain('"DeletionPolicy": "Retain"');
    expect(parentPhase1BBody).toContain(
      'https://state-bucket.s3.amazonaws.com/cdkd-migrate-tmp/Root__nested__Child/template.json'
    );

    // uploadCfnTemplate was called once (for the child's adopted template).
    expect(uploadCfnTemplateMock).toHaveBeenCalledTimes(1);
    expect(uploadCfnTemplateMock.mock.calls[0]![0]).toMatchObject({
      bucket: STATE_BUCKET,
      stackName: 'Root__nested__Child',
    });
    // GetTemplate was called for the child stack post-IMPORT.
    expect(calls.filter((c) => c.name === 'GetTemplate')).toHaveLength(1);

    // UpdateStack flip: exactly 1 call against the child after its
    // Phase 1A (flips status from IMPORT_COMPLETE to UPDATE_COMPLETE so
    // the parent's Phase 1B can adopt it — AWS rejects IMPORT_COMPLETE
    // as a non-importable status for nesting). Root never gets flipped.
    const updateStackCalls = calls.filter((c) => c.name === 'UpdateStack');
    expect(updateStackCalls).toHaveLength(1);
    expect(updateStackCalls[0]!.input['StackName']).toBe('Root-Child');
    expect(updateStackCalls[0]!.input['UsePreviousTemplate']).toBe(true);
    const flipTags = updateStackCalls[0]!.input['Tags'] as Array<{ Key: string }>;
    expect(flipTags[0]!.Key).toBe('cdkd:nested-export-flip');

    // Per-non-root-child lock acquisition: ONE for the leaf child.
    expect(acquired).toEqual([{ stackName: 'Root~Child', region: 'us-east-1' }]);
    expect(released).toEqual([{ stackName: 'Root~Child', region: 'us-east-1' }]);

    // State deletion: leaf-first → child, then root.
    expect(deleted).toEqual([
      { stackName: 'Root~Child', region: 'us-east-1' },
      { stackName: 'Root', region: 'us-east-1' },
    ]);
  });

  it('honors per-child --cfn-child-stack-name override', async () => {
    const childTemplate = {
      Resources: {
        ChildBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'child-bucket-456' },
        },
      },
    };
    const childPath = writeFixture('Child.nested.template.json', childTemplate);

    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        ParentBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'parent-bucket-789' },
        Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
      },
    });
    const child = makeState({
      stackName: 'Root~Child',
      region: 'us-east-1',
      resources: {
        ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'child-bucket-456' },
      },
      parentStack: 'Root',
      parentLogicalId: 'Child',
    });
    const { backend: stateBackend } = buildStateBackend({
      'Root|us-east-1': root,
      'Root~Child|us-east-1': child,
    });
    const { manager: lockManager } = buildLockManager();
    const { client: cfnClient, calls } = buildCfnClient();

    const rootTemplate = {
      Resources: {
        ParentBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'parent-bucket-789' },
        },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://cdk-asset/.../Child.template.json' },
          Metadata: { 'aws:asset:path': 'Child.nested.template.json' },
        },
      },
    };
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map([
        [
          'Child',
          {
            stackName: 'Root~Child',
            region: 'us-east-1',
            state: child,
            nestedChildren: new Map(),
          },
        ],
      ]),
    };

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree,
      rootTemplate,
      cfnStackNameOverrides: {
        root: 'CustomRootName',
        childMap: new Map([['Root~Child', 'custom-child-name']]),
      },
      rootParameters: [],
      deps: {
        cfnClient,
        stateBackend,
        lockManager,
        uploadOpts: { stateBucket: STATE_BUCKET },
        lockOwner: 'tester@host:1234',
      },
      options: {
        dryRun: false,
        yes: true,
        includeNonImportable: false,
        recreateImportUnsupported: true,
      },
    });

    expect(result.importedStacks.map((s) => s.cfnStackName)).toEqual([
      'custom-child-name',
      'CustomRootName',
    ]);
    // 3 calls: leaf (Phase 1A) + parent (Phase 1A leaves-only) + parent
    // (Phase 1B nested adoption). The per-child override flips both names.
    const createCalls = calls.filter((c) => c.name === 'CreateChangeSet');
    expect(createCalls.map((c) => c.input['StackName'])).toEqual([
      'custom-child-name', // leaf Phase 1A
      'CustomRootName', // parent Phase 1A (leaves only)
      'CustomRootName', // parent Phase 1B (nested adoption)
    ]);
  });
});

describe('runPerStackImportLoop (issue #464 PR B2) — gates and failure semantics', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    uploadCfnTemplateMock.mockClear();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackImport.mockReset();
    waitStackImport.mockResolvedValue(undefined);
  });

  it('dry-run: prints plan, makes no AWS write, returns dry-run outcome', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b1' } },
    });
    const { backend: stateBackend, deleted } = buildStateBackend({
      'Root|us-east-1': root,
    });
    const { manager: lockManager, acquired } = buildLockManager();
    const { client: cfnClient, calls } = buildCfnClient();

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree: {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map(),
      },
      rootTemplate: {
        Resources: {
          Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b1' } },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: {
        cfnClient,
        stateBackend,
        lockManager,
        uploadOpts: { stateBucket: STATE_BUCKET },
        lockOwner: 'tester@host:1234',
      },
      options: {
        dryRun: true,
        yes: true,
        includeNonImportable: false,
        recreateImportUnsupported: true,
      },
    });

    expect(result.outcome).toBe('dry-run');
    expect(result.importedStacks).toEqual([]);
    expect(calls.filter((c) => c.name === 'CreateChangeSet')).toHaveLength(0);
    expect(deleted).toEqual([]);
    expect(acquired).toEqual([]);
  });

  it('refuses when a stack in the tree has phase-2 Custom Resources without --include-non-importable', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b1' },
        CR: { resourceType: 'Custom::MyResource', physicalId: 'phy-cr' },
      },
    });
    const { backend: stateBackend } = buildStateBackend({ 'Root|us-east-1': root });
    const { manager: lockManager } = buildLockManager();
    const { client: cfnClient } = buildCfnClient();

    await expect(
      runPerStackImportLoop({
        rootStackName: 'Root',
        rootRegion: 'us-east-1',
        rootStackInfoNestedTemplates: {},
        rootTemplateFormat: 'json',
        tree: {
          stackName: 'Root',
          region: 'us-east-1',
          state: root,
          nestedChildren: new Map(),
        },
        rootTemplate: {
          Resources: {
            Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b1' } },
            CR: { Type: 'Custom::MyResource', Properties: {} },
          },
        },
        cfnStackNameOverrides: { childMap: new Map() },
        rootParameters: [],
        deps: {
          cfnClient,
          stateBackend,
          lockManager,
          uploadOpts: { stateBucket: STATE_BUCKET },
          lockOwner: 'tester@host:1234',
        },
        options: {
          dryRun: false,
          yes: true,
          includeNonImportable: false,
          recreateImportUnsupported: true,
        },
      })
    ).rejects.toThrow(/non-importable resource\(s\) \(Custom::\*\)/);
  });

  it('refuses when any stack in the tree has blocked resources (missing state)', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      // State has NO resources, so the template's Bucket has no state entry → blocked.
    });
    const { backend: stateBackend } = buildStateBackend({ 'Root|us-east-1': root });
    const { manager: lockManager } = buildLockManager();
    const { client: cfnClient } = buildCfnClient();

    await expect(
      runPerStackImportLoop({
        rootStackName: 'Root',
        rootRegion: 'us-east-1',
        rootStackInfoNestedTemplates: {},
        rootTemplateFormat: 'json',
        tree: {
          stackName: 'Root',
          region: 'us-east-1',
          state: root,
          nestedChildren: new Map(),
        },
        rootTemplate: {
          Resources: {
            Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b1' } },
          },
        },
        cfnStackNameOverrides: { childMap: new Map() },
        rootParameters: [],
        deps: {
          cfnClient,
          stateBackend,
          lockManager,
          uploadOpts: { stateBucket: STATE_BUCKET },
          lockOwner: 'tester@host:1234',
        },
        options: {
          dryRun: false,
          yes: true,
          includeNonImportable: false,
          recreateImportUnsupported: true,
        },
      })
    ).rejects.toThrow(/has 1 resource\(s\) that block migration/);
  });

  it('refuses when lock acquisition for a nested child fails', async () => {
    const childTemplate = {
      Resources: {
        ChildBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b2' } },
      },
    };
    const tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-loop-lock-test-'));
    try {
      const childPath = join(tmp, 'Child.template.json');
      writeFileSync(childPath, JSON.stringify(childTemplate), 'utf-8');

      const root = makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: {
          Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
        },
      });
      const child = makeState({
        stackName: 'Root~Child',
        region: 'us-east-1',
        resources: { ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b2' } },
        parentStack: 'Root',
        parentLogicalId: 'Child',
      });
      const { backend: stateBackend, deleted } = buildStateBackend({
        'Root|us-east-1': root,
        'Root~Child|us-east-1': child,
      });
      const { manager: lockManager } = buildLockManager({
        acquireFn: async () => false, // Lock contention on the child.
      });
      const { client: cfnClient, calls } = buildCfnClient();

      const rootTemplate = {
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://cdk-asset/.../Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.template.json' },
          },
        },
      };
      const tree: CdkdStateStackTree = {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          [
            'Child',
            {
              stackName: 'Root~Child',
              region: 'us-east-1',
              state: child,
              nestedChildren: new Map(),
            },
          ],
        ]),
      };

      await expect(
        runPerStackImportLoop({
          rootStackName: 'Root',
          rootRegion: 'us-east-1',
          rootStackInfoNestedTemplates: { Child: childPath },
          rootTemplateFormat: 'json',
          tree,
          rootTemplate,
          cfnStackNameOverrides: { childMap: new Map() },
          rootParameters: [],
          deps: {
            cfnClient,
            stateBackend,
            lockManager,
            uploadOpts: { stateBucket: STATE_BUCKET },
            lockOwner: 'tester@host:1234',
          },
          options: {
            dryRun: false,
            yes: true,
            includeNonImportable: false,
            recreateImportUnsupported: true,
          },
        })
      ).rejects.toThrow(/Could not acquire lock for nested-stack child 'Root~Child'/);

      // No AWS write happened.
      expect(calls.filter((c) => c.name === 'CreateChangeSet')).toEqual([]);
      // No state deleted.
      expect(deleted).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaf IMPORT failure: error names imported (none) + remaining stacks; cdkd state preserved', async () => {
    const childTemplate = {
      Resources: {
        ChildBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b3' } },
      },
    };
    const tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-loop-failure-test-'));
    try {
      const childPath = join(tmp, 'Child.template.json');
      writeFileSync(childPath, JSON.stringify(childTemplate), 'utf-8');

      const root = makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: {
          Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
        },
      });
      const child = makeState({
        stackName: 'Root~Child',
        region: 'us-east-1',
        resources: { ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b3' } },
        parentStack: 'Root',
        parentLogicalId: 'Child',
      });
      const { backend: stateBackend, deleted } = buildStateBackend({
        'Root|us-east-1': root,
        'Root~Child|us-east-1': child,
      });
      const { manager: lockManager } = buildLockManager();
      const { client: cfnClient } = buildCfnClient({
        // CreateChangeSet for the leaf throws.
        createChangeSet: async (input) => {
          if (input['StackName'] === 'Root-Child') {
            throw new Error('Simulated CFn IMPORT validation error');
          }
          return {};
        },
      });

      const rootTemplate = {
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://cdk-asset/.../Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.template.json' },
          },
        },
      };
      const tree: CdkdStateStackTree = {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          [
            'Child',
            {
              stackName: 'Root~Child',
              region: 'us-east-1',
              state: child,
              nestedChildren: new Map(),
            },
          ],
        ]),
      };

      await expect(
        runPerStackImportLoop({
          rootStackName: 'Root',
          rootRegion: 'us-east-1',
          rootStackInfoNestedTemplates: { Child: childPath },
          rootTemplateFormat: 'json',
          tree,
          rootTemplate,
          cfnStackNameOverrides: { childMap: new Map() },
          rootParameters: [],
          deps: {
            cfnClient,
            stateBackend,
            lockManager,
            uploadOpts: { stateBucket: STATE_BUCKET },
            lockOwner: 'tester@host:1234',
          },
          options: {
            dryRun: false,
            yes: true,
            includeNonImportable: false,
            recreateImportUnsupported: true,
          },
        })
      ).rejects.toThrow(
        /Phase 1A IMPORT changeset failed for cdkd stack 'Root~Child' \(CFn name 'Root-Child'\)/
      );

      // NO state was deleted — error preserved cdkd state for retry.
      expect(deleted).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Phase 1B failure (after Phase 1A succeeded): error names imported standalone stacks; cdkd state preserved', async () => {
    const childTemplate = {
      Resources: {
        ChildBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b4' } },
      },
    };
    const tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-loop-1b-fail-test-'));
    try {
      const childPath = join(tmp, 'Child.template.json');
      writeFileSync(childPath, JSON.stringify(childTemplate), 'utf-8');

      const root = makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: {
          ParentBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'parent-bucket' },
          Child: {
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'arn:cdkd-local:...',
          },
        },
      });
      const child = makeState({
        stackName: 'Root~Child',
        region: 'us-east-1',
        resources: { ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b4' } },
        parentStack: 'Root',
        parentLogicalId: 'Child',
      });
      const { backend: stateBackend, deleted } = buildStateBackend({
        'Root|us-east-1': root,
        'Root~Child|us-east-1': child,
      });
      const { manager: lockManager } = buildLockManager();
      // Phase 1A succeeds for both the leaf child AND the parent; Phase
      // 1B (the SECOND CreateChangeSet call against 'Root', after the
      // first 'Root' Phase 1A) is what fails. Distinguish 1A vs 1B by
      // a per-stack call count.
      const createChangeSetCallsByStack = new Map<string, number>();
      const { client: cfnClient, calls } = buildCfnClient({
        createChangeSet: async (input) => {
          const stackName = String(input['StackName']);
          const n = (createChangeSetCallsByStack.get(stackName) ?? 0) + 1;
          createChangeSetCallsByStack.set(stackName, n);
          if (stackName === 'Root' && n === 2) {
            throw new Error(
              'Simulated nested-adoption failure (e.g. template-match validation)'
            );
          }
          return {};
        },
      });

      const rootTemplate = {
        Resources: {
          ParentBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: { BucketName: 'parent-bucket' },
          },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://cdk-asset/.../Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.template.json' },
          },
        },
      };
      const tree: CdkdStateStackTree = {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          [
            'Child',
            {
              stackName: 'Root~Child',
              region: 'us-east-1',
              state: child,
              nestedChildren: new Map(),
            },
          ],
        ]),
      };

      await expect(
        runPerStackImportLoop({
          rootStackName: 'Root',
          rootRegion: 'us-east-1',
          rootStackInfoNestedTemplates: { Child: childPath },
          rootTemplateFormat: 'json',
          tree,
          rootTemplate,
          cfnStackNameOverrides: { childMap: new Map() },
          rootParameters: [],
          deps: {
            cfnClient,
            stateBackend,
            lockManager,
            uploadOpts: { stateBucket: STATE_BUCKET },
            lockOwner: 'tester@host:1234',
          },
          options: {
            dryRun: false,
            yes: true,
            includeNonImportable: false,
            recreateImportUnsupported: true,
          },
        })
      ).rejects.toThrow(
        /Phase 1B \(nested-child adoption\) IMPORT changeset failed for parent 'Root'/
      );

      // Error message must enumerate stacks that DID succeed (both the
      // leaf child AND the parent's Phase 1A) so the user knows the
      // CFn-side state is partial.
      const matchingCalls = createChangeSetCallsByStack;
      expect(matchingCalls.get('Root-Child')).toBe(1);
      expect(matchingCalls.get('Root')).toBe(2);

      // cdkd state preserved across the entire tree (neither leaf nor
      // root state deleted; user re-runs after fixing the adoption cause).
      expect(deleted).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runPerStackImportLoop (issue #464 PR B2) — 3-level tree (post-Phase-1B non-root flip)', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    uploadCfnTemplateMock.mockClear();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackImport.mockReset();
    waitStackImport.mockResolvedValue(undefined);
    waitStackUpdate.mockReset();
    waitStackUpdate.mockResolvedValue(undefined);
  });

  // A 3-level tree exercises the only otherwise-untested code path:
  // a non-root, non-leaf parent gets flipped to UPDATE_COMPLETE BOTH
  // after Phase 1A AND after Phase 1B (so its OWN parent's later
  // Phase 1B can adopt it). The 2-level happy path only covers
  // post-Phase-1A flips on the leaf; the post-Phase-1B flip branch
  // is unreachable until at least one non-root parent has children.
  it('grandchild + middle parent + root: 5 IMPORT changesets + 3 flips (post-1A + post-1B on middle, post-1A on grandchild)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-loop-3level-test-'));
    try {
      // CDK synth shape: root template has nested-stack row 'Middle'
      // pointing at middle.nested.template.json; middle template has
      // nested-stack row 'Grandchild' pointing at grand.nested.template.json
      // (sibling of middle template).
      const grandTemplate = {
        Resources: {
          GrandBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'grand-bucket' } },
        },
      };
      const grandPath = join(tmp, 'Grandchild.nested.template.json');
      writeFileSync(grandPath, JSON.stringify(grandTemplate), 'utf-8');
      const middleTemplate = {
        Resources: {
          MiddleBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'middle-bucket' } },
          Grandchild: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://cdk-asset/.../Grandchild.template.json' },
            Metadata: { 'aws:asset:path': 'Grandchild.nested.template.json' },
          },
        },
      };
      const middlePath = join(tmp, 'Middle.nested.template.json');
      writeFileSync(middlePath, JSON.stringify(middleTemplate), 'utf-8');
      const rootTemplate = {
        Resources: {
          RootBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'root-bucket' } },
          Middle: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://cdk-asset/.../Middle.template.json' },
            Metadata: { 'aws:asset:path': 'Middle.nested.template.json' },
          },
        },
      };

      const root = makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: {
          RootBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'root-bucket' },
          Middle: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
        },
      });
      const middle = makeState({
        stackName: 'Root~Middle',
        region: 'us-east-1',
        resources: {
          MiddleBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'middle-bucket' },
          Grandchild: {
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'arn:cdkd-local:...',
          },
        },
        parentStack: 'Root',
        parentLogicalId: 'Middle',
      });
      const grand = makeState({
        stackName: 'Root~Middle~Grandchild',
        region: 'us-east-1',
        resources: { GrandBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'grand-bucket' } },
        parentStack: 'Root~Middle',
        parentLogicalId: 'Grandchild',
      });
      const { backend: stateBackend, deleted } = buildStateBackend({
        'Root|us-east-1': root,
        'Root~Middle|us-east-1': middle,
        'Root~Middle~Grandchild|us-east-1': grand,
      });
      const { manager: lockManager, acquired, released } = buildLockManager();
      const { client: cfnClient, calls } = buildCfnClient();

      const tree: CdkdStateStackTree = {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          [
            'Middle',
            {
              stackName: 'Root~Middle',
              region: 'us-east-1',
              state: middle,
              nestedChildren: new Map([
                [
                  'Grandchild',
                  {
                    stackName: 'Root~Middle~Grandchild',
                    region: 'us-east-1',
                    state: grand,
                    nestedChildren: new Map(),
                  },
                ],
              ]),
            },
          ],
        ]),
      };

      const result = await runPerStackImportLoop({
        rootStackName: 'Root',
        rootRegion: 'us-east-1',
        rootStackInfoNestedTemplates: { Middle: middlePath },
        rootTemplateFormat: 'json',
        tree,
        rootTemplate,
        cfnStackNameOverrides: { childMap: new Map() },
        rootParameters: [],
        deps: {
          cfnClient,
          stateBackend,
          lockManager,
          uploadOpts: { stateBucket: STATE_BUCKET },
          lockOwner: 'tester@host:1234',
        },
        options: {
          dryRun: false,
          yes: true,
          includeNonImportable: false,
          recreateImportUnsupported: true,
        },
      });

      expect(result.outcome).toBe('success');
      expect(result.importedStacks.map((s) => s.cfnStackName)).toEqual([
        'Root-Middle-Grandchild', // leaf-first iter 1 (Phase 1A only)
        'Root-Middle', // iter 2 (Phase 1A + Phase 1B, with flips before AND after)
        'Root', // iter 3 (Phase 1A + Phase 1B, root flip suppressed)
      ]);

      // 5 IMPORT changesets total:
      //   - Grandchild Phase 1A (leaf)
      //   - Middle Phase 1A (leaves) + Phase 1B (nested adoption)
      //   - Root Phase 1A (leaves) + Phase 1B (nested adoption)
      const createCalls = calls.filter((c) => c.name === 'CreateChangeSet');
      expect(createCalls.map((c) => c.input['StackName'])).toEqual([
        'Root-Middle-Grandchild',
        'Root-Middle',
        'Root-Middle',
        'Root',
        'Root',
      ]);

      // 3 UpdateStack flips: grandchild (post-1A), middle (post-1A AND
      // post-1B — the critical post-1B non-root path that's unreachable
      // in 2-level trees). Root never flips (always suppressed).
      const updateStackCalls = calls.filter((c) => c.name === 'UpdateStack');
      expect(updateStackCalls.map((c) => c.input['StackName'])).toEqual([
        'Root-Middle-Grandchild', // post-Phase-1A flip
        'Root-Middle', // post-Phase-1A flip
        'Root-Middle', // post-Phase-1B flip (the previously-untested branch)
      ]);

      // Both non-root non-leaf parent (Middle) AND leaf grandchild get
      // child locks pre-acquired; root's lock is held by the outer
      // exportCommand scope (not by the orchestrator).
      expect(acquired.map((l) => l.stackName).sort()).toEqual([
        'Root~Middle',
        'Root~Middle~Grandchild',
      ]);
      expect(released).toHaveLength(2);

      // State deletion: leaf-first across the full tree.
      expect(deleted).toEqual([
        { stackName: 'Root~Middle~Grandchild', region: 'us-east-1' },
        { stackName: 'Root~Middle', region: 'us-east-1' },
        { stackName: 'Root', region: 'us-east-1' },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runPerStackImportLoop (issue #464 PR B2) — Phase 2 UPDATE per stack', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    uploadCfnTemplateMock.mockClear();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackImport.mockReset();
    waitStackImport.mockResolvedValue(undefined);
    waitStackUpdate.mockReset();
    waitStackUpdate.mockResolvedValue(undefined);
  });

  it('parent + leaf with --include-non-importable: per-stack Phase 2 UPDATE fires only for the stack with CR', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-loop-phase2-test-'));
    try {
      const childTemplate = {
        Resources: {
          ChildBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'child-bucket-cr' } },
        },
      };
      const childPath = join(tmp, 'Child.nested.template.json');
      writeFileSync(childPath, JSON.stringify(childTemplate), 'utf-8');

      // Parent has 1 leaf (S3) + 1 nested child + 1 Custom Resource.
      // The Custom Resource triggers per-stack Phase 2 UPDATE on the parent;
      // the leaf child has no CR so its Phase 2 is skipped.
      const root = makeState({
        stackName: 'Root',
        region: 'us-east-1',
        resources: {
          ParentBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'parent-bucket-cr' },
          Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
          MyCR: { resourceType: 'Custom::Provisioner', physicalId: 'phy-cr' },
        },
      });
      const child = makeState({
        stackName: 'Root~Child',
        region: 'us-east-1',
        resources: { ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'child-bucket-cr' } },
        parentStack: 'Root',
        parentLogicalId: 'Child',
      });
      const { backend: stateBackend, deleted } = buildStateBackend({
        'Root|us-east-1': root,
        'Root~Child|us-east-1': child,
      });
      const { manager: lockManager } = buildLockManager();
      const { client: cfnClient, calls } = buildCfnClient();

      const rootTemplate = {
        Resources: {
          ParentBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: { BucketName: 'parent-bucket-cr' },
          },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://cdk-asset/.../Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.nested.template.json' },
          },
          MyCR: {
            Type: 'Custom::Provisioner',
            Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:cr' },
          },
        },
      };
      const tree: CdkdStateStackTree = {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          [
            'Child',
            {
              stackName: 'Root~Child',
              region: 'us-east-1',
              state: child,
              nestedChildren: new Map(),
            },
          ],
        ]),
      };

      const result = await runPerStackImportLoop({
        rootStackName: 'Root',
        rootRegion: 'us-east-1',
        rootStackInfoNestedTemplates: { Child: childPath },
        rootTemplateFormat: 'json',
        tree,
        rootTemplate,
        cfnStackNameOverrides: { childMap: new Map() },
        rootParameters: [],
        deps: {
          cfnClient,
          stateBackend,
          lockManager,
          uploadOpts: { stateBucket: STATE_BUCKET },
          lockOwner: 'tester@host:1234',
        },
        options: {
          dryRun: false,
          yes: true,
          includeNonImportable: true, // opt into the 2-phase per-stack flow
          recreateImportUnsupported: true,
        },
      });

      expect(result.outcome).toBe('success');
      expect(result.importedStacks).toHaveLength(2);

      // Changeset accounting:
      //   - Child Phase 1A (1 leaf IMPORT)
      //   - Root Phase 1A (1 leaf IMPORT)
      //   - Root Phase 1B (1 nested adoption IMPORT)
      //   - Root Phase 2 UPDATE (1 CR CREATE) — NEW (the previously-untested path)
      // Child has no CR, so its Phase 2 UPDATE is correctly skipped.
      const createCalls = calls.filter((c) => c.name === 'CreateChangeSet');
      expect(createCalls).toHaveLength(4);
      expect(createCalls.map((c) => c.input['ChangeSetType'])).toEqual([
        'IMPORT', // child 1A
        'IMPORT', // parent 1A
        'IMPORT', // parent 1B (nested adoption)
        'UPDATE', // parent Phase 2 (CR CREATE)
      ]);
      // Phase 2 template must include the rewritten nested-stack row
      // (carried over from Phase 1B's rewritten row map) so CFn doesn't
      // try to remove the just-adopted child on the UPDATE.
      const phase2 = createCalls[3]!;
      const phase2Body = String(phase2.input['TemplateBody']);
      expect(phase2Body).toContain('"DeletionPolicy": "Retain"'); // Retain on nested row preserved
      expect(phase2Body).toContain('"Type": "Custom::Provisioner"');

      // State deletion only after every stack succeeds.
      expect(deleted).toEqual([
        { stackName: 'Root~Child', region: 'us-east-1' },
        { stackName: 'Root', region: 'us-east-1' },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('flipStackToUpdateComplete (issue #589 Minor 1) — tag-value uniqueness', () => {
  beforeEach(() => {
    waitStackUpdate.mockReset();
    waitStackUpdate.mockResolvedValue(undefined);
  });

  it('emits a distinct cdkd:nested-export-flip tag value on each call', async () => {
    const updateInputs: Record<string, unknown>[] = [];
    const cfnClient = {
      send: vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
        if (cmd._name === 'UpdateStack') updateInputs.push(cmd.input);
        return {};
      }),
    } as unknown as AwsClients['cloudFormation'];

    // Two back-to-back flips on the same stack — the failure mode this guards
    // against is two flips landing within the same millisecond (e.g. an SDK
    // transient-error retry) emitting identical tag values, which AWS rejects
    // with "No updates are to be performed".
    await flipStackToUpdateComplete(cfnClient, 'My-Stack', []);
    await flipStackToUpdateComplete(cfnClient, 'My-Stack', []);

    expect(updateInputs).toHaveLength(2);
    const tag0 = (updateInputs[0]!['Tags'] as Array<{ Key: string; Value: string }>)[0]!;
    const tag1 = (updateInputs[1]!['Tags'] as Array<{ Key: string; Value: string }>)[0]!;
    expect(tag0.Key).toBe('cdkd:nested-export-flip');
    expect(tag1.Key).toBe('cdkd:nested-export-flip');
    // The UUID suffix guarantees uniqueness regardless of clock resolution.
    expect(tag0.Value).not.toBe(tag1.Value);
    // Shape: ISO-8601 timestamp + '-' + 8-hex UUID slice.
    expect(tag0.Value).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z-[0-9a-f]{8}$/);
    expect(tag1.Value).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z-[0-9a-f]{8}$/);
    // No Parameters passed → the UpdateStack omits the field entirely.
    expect(updateInputs[0]!['Parameters']).toBeUndefined();
  });

  it('re-supplies the stack Parameters on the no-op UpdateStack (#464 — no-Default param fix)', async () => {
    // Regression for the real-AWS bug the export-nested-stack integ surfaced:
    // once a child stack declares a no-`Default` Parameter (fed by a
    // parent-side Ref), a `UsePreviousTemplate: true` flip with NO Parameters
    // is rejected by CFn with `Parameters: [X] must have values`. The flip
    // must re-send the resolved Parameters as a no-op.
    const updateInputs: Record<string, unknown>[] = [];
    const cfnClient = {
      send: vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
        if (cmd._name === 'UpdateStack') updateInputs.push(cmd.input);
        return {};
      }),
    } as unknown as AwsClients['cloudFormation'];

    await flipStackToUpdateComplete(cfnClient, 'My-Stack', [
      { ParameterKey: 'StageParam', ParameterValue: 'prod' },
    ]);

    expect(updateInputs).toHaveLength(1);
    expect(updateInputs[0]!['UsePreviousTemplate']).toBe(true);
    expect(updateInputs[0]!['Parameters']).toEqual([
      { ParameterKey: 'StageParam', ParameterValue: 'prod' },
    ]);
  });
});

describe('runPerStackImportLoop (issue #589) — review-residual coverage', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    uploadCfnTemplateMock.mockClear();
    readlineQuestion.mockClear();
    waitChangeSetCreate.mockReset();
    waitChangeSetCreate.mockResolvedValue(undefined);
    waitStackImport.mockReset();
    waitStackImport.mockResolvedValue(undefined);
    waitStackUpdate.mockReset();
    waitStackUpdate.mockResolvedValue(undefined);
  });

  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cdkd-export-loop-589-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Minor 3 + Test gap 5: a parent whose nested-stack row passes an
  // intrinsic-valued Parameter (`{Ref: ...}`) to its child triggers BOTH the
  // per-iteration warn AND the post-loop aggregate summary warn.
  it('warns per-stack AND re-prints an aggregate summary for UNRESOLVABLE intrinsic Parameters', async () => {
    const childTemplate = {
      Resources: {
        ChildBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'child-589' } },
      },
    };
    const childPath = join(tmpRoot, 'Child.nested.template.json');
    writeFileSync(childPath, JSON.stringify(childTemplate), 'utf-8');

    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        ParentBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'parent-589' },
        Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
      },
    });
    const child = makeState({
      stackName: 'Root~Child',
      region: 'us-east-1',
      resources: { ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'child-589' } },
      parentStack: 'Root',
      parentLogicalId: 'Child',
    });
    const { backend: stateBackend } = buildStateBackend({
      'Root|us-east-1': root,
      'Root~Child|us-east-1': child,
    });
    const { manager: lockManager } = buildLockManager();
    const { client: cfnClient } = buildCfnClient();

    const rootTemplate = {
      Resources: {
        ParentBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'parent-589' } },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://cdk-asset/.../Child.template.json',
            // Mixed literal + intrinsic Parameters. RefValued points at a
            // parent Parameter that is NOT in rootParameters ([] below), so
            // the resolver cannot resolve it and it degrades to the
            // warn + aggregate-summary path (the intrinsic resolution added
            // in the #464 follow-up resolves Refs only when the target is
            // present; this exercises the unresolvable fallback).
            Parameters: { LiteralEnv: 'prod', RefValued: { Ref: 'SomeParentParam' } },
          },
          Metadata: { 'aws:asset:path': 'Child.nested.template.json' },
        },
      },
    };
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map([
        [
          'Child',
          { stackName: 'Root~Child', region: 'us-east-1', state: child, nestedChildren: new Map() },
        ],
      ]),
    };

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree,
      rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: {
        cfnClient,
        stateBackend,
        lockManager,
        uploadOpts: { stateBucket: STATE_BUCKET },
        lockOwner: 'tester@host:1234',
      },
      options: {
        dryRun: false,
        yes: true,
        includeNonImportable: false,
        recreateImportUnsupported: true,
      },
    });

    expect(result.outcome).toBe('success');

    const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Per-stack warn names the unresolvable intrinsic param for the child.
    expect(warnText).toContain("Child 'Root~Child': could not resolve intrinsic-valued Parameter(s)");
    expect(warnText).toContain('RefValued');
    // Post-loop aggregate summary names the affected stack + its param.
    expect(warnText).toContain(
      '1 stack(s) had intrinsic-valued Parameter(s) that cdkd could not resolve at IMPORT'
    );
    expect(warnText).toContain('Root~Child (RefValued)');
  });

  // The #464 follow-up: a parent-side {Ref: <rootParam>} child Parameter now
  // RESOLVES against the resolved root Parameters and reaches the child's
  // IMPORT changeset (instead of being skipped). End-to-end proof that the
  // root-first pre-pass is wired into runPerStackImportLoop.
  it('resolves a parent-side {Ref: rootParam} child Parameter into the child IMPORT changeset', async () => {
    const childTemplate = {
      Resources: {
        ChildBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'child-resolve' } },
      },
    };
    const childPath = join(tmpRoot, 'Child.nested.template.json');
    writeFileSync(childPath, JSON.stringify(childTemplate), 'utf-8');

    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:cdkd-local:...' },
      },
    });
    const child = makeState({
      stackName: 'Root~Child',
      region: 'us-east-1',
      resources: { ChildBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'child-resolve' } },
      parentStack: 'Root',
      parentLogicalId: 'Child',
    });
    const { backend: stateBackend } = buildStateBackend({
      'Root|us-east-1': root,
      'Root~Child|us-east-1': child,
    });
    const { manager: lockManager } = buildLockManager();
    const { client: cfnClient, calls } = buildCfnClient();

    const rootTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://cdk-asset/.../Child.template.json',
            // The child Parameter `Stage` is fed by a parent-side Ref to the
            // root Parameter `StageParam` (no Default needed on the child).
            Parameters: { Stage: { Ref: 'StageParam' } },
          },
          Metadata: { 'aws:asset:path': 'Child.nested.template.json' },
        },
      },
    };
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map([
        [
          'Child',
          { stackName: 'Root~Child', region: 'us-east-1', state: child, nestedChildren: new Map() },
        ],
      ]),
    };

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree,
      rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [{ ParameterKey: 'StageParam', ParameterValue: 'production' }],
      deps: {
        cfnClient,
        stateBackend,
        lockManager,
        uploadOpts: { stateBucket: STATE_BUCKET },
        lockOwner: 'tester@host:1234',
      },
      options: {
        dryRun: false,
        yes: true,
        includeNonImportable: false,
        recreateImportUnsupported: true,
      },
    });

    expect(result.outcome).toBe('success');

    // No "could not resolve" warning fired — the Ref resolved cleanly.
    const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).not.toContain('could not resolve intrinsic-valued Parameter');

    // The child's Phase 1A IMPORT changeset carries the RESOLVED Parameter.
    const childCreate = calls.find(
      (c) => c.name === 'CreateChangeSet' && c.input['StackName'] === 'Root-Child'
    );
    expect(childCreate).toBeDefined();
    const childParams = childCreate!.input['Parameters'] as Array<{
      ParameterKey: string;
      ParameterValue: string;
    }>;
    expect(childParams).toEqual([{ ParameterKey: 'Stage', ParameterValue: 'production' }]);
  });

  // Test gap 1: cdkd-bug guard — DescribeStacks returns a stack with no
  // StackId immediately after a successful Phase 1A IMPORT. AWS would never
  // do this legitimately, but the guard must fire with the documented message.
  it('throws when post-IMPORT DescribeStacks returns no StackId', async () => {
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { MyBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b-no-id' } },
    });
    const { backend: stateBackend, deleted } = buildStateBackend({ 'Root|us-east-1': root });
    const { manager: lockManager } = buildLockManager();
    const { client: cfnClient } = buildCfnClient({
      describeStacksPostImport: async (stackName: string) => ({
        Stacks: [{ StackName: stackName, StackId: undefined }],
      }),
    });

    await expect(
      runPerStackImportLoop({
        rootStackName: 'Root',
        rootRegion: 'us-east-1',
        rootStackInfoNestedTemplates: {},
        rootTemplateFormat: 'json',
        tree: { stackName: 'Root', region: 'us-east-1', state: root, nestedChildren: new Map() },
        rootTemplate: {
          Resources: { MyBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b-no-id' } } },
        },
        cfnStackNameOverrides: { childMap: new Map() },
        rootParameters: [],
        deps: {
          cfnClient,
          stateBackend,
          lockManager,
          uploadOpts: { stateBucket: STATE_BUCKET },
          lockOwner: 'tester@host:1234',
        },
        options: {
          dryRun: false,
          yes: true,
          includeNonImportable: false,
          recreateImportUnsupported: true,
        },
      })
    ).rejects.toThrow(/DescribeStacks returned no StackId for 'Root'/);

    // The failure is post-IMPORT but pre-state-deletion — no state removed.
    expect(deleted).toEqual([]);
  });

  // Test gap 4: the interactive confirmation prompt cancellation path. All
  // other tests pass `yes: true`; this one passes `yes: false` and answers
  // 'n' to the mocked prompt, expecting a clean 'cancelled' outcome.
  it('cancels (no AWS write, no state deletion) when the user declines the prompt', async () => {
    readlineQuestion.mockResolvedValueOnce('n');
    const root = makeState({
      stackName: 'Root',
      region: 'us-east-1',
      resources: { MyBucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b-cancel' } },
    });
    const { backend: stateBackend, deleted } = buildStateBackend({ 'Root|us-east-1': root });
    const { manager: lockManager, acquired } = buildLockManager();
    const { client: cfnClient, calls } = buildCfnClient();

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree: { stackName: 'Root', region: 'us-east-1', state: root, nestedChildren: new Map() },
      rootTemplate: {
        Resources: { MyBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b-cancel' } } },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: {
        cfnClient,
        stateBackend,
        lockManager,
        uploadOpts: { stateBucket: STATE_BUCKET },
        lockOwner: 'tester@host:1234',
      },
      options: {
        dryRun: false,
        yes: false,
        includeNonImportable: false,
        recreateImportUnsupported: true,
      },
    });

    expect(result.outcome).toBe('cancelled');
    expect(result.importedStacks).toEqual([]);
    // No changeset submitted, no state deleted, no child lock acquired.
    expect(calls.filter((c) => c.name === 'CreateChangeSet')).toEqual([]);
    expect(deleted).toEqual([]);
    expect(acquired).toEqual([]);
    expect(readlineQuestion).toHaveBeenCalledTimes(1);
  });
});
