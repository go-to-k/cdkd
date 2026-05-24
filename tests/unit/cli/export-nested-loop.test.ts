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

import {
  buildCdkdStateStackTree,
  runPerStackImportLoop,
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
    async acquireLock(stackName: string, region: string) {
      const ok = opts?.acquireFn ? await opts.acquireFn(stackName) : true;
      if (ok) acquired.push({ stackName, region });
      return ok;
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

    // Two IMPORT changesets: one per stack.
    const createCalls = calls.filter((c) => c.name === 'CreateChangeSet');
    expect(createCalls).toHaveLength(2);

    // Parent's IMPORT must include the child adoption row in ResourcesToImport.
    const parentImport = createCalls[1]!;
    const parentResourcesToImport = parentImport.input['ResourcesToImport'] as Array<
      Record<string, unknown>
    >;
    const adoption = parentResourcesToImport.find(
      (r) => r['ResourceType'] === 'AWS::CloudFormation::Stack'
    );
    expect(adoption).toBeDefined();
    expect(adoption!['LogicalResourceId']).toBe('Child');
    // ResourceIdentifier.StackId must be the child's just-IMPORTed CFn ARN.
    const childArn = (adoption!['ResourceIdentifier'] as { StackId: string }).StackId;
    expect(childArn).toContain('stack/Root-Child/');

    // Parent's filtered template must carry the nested-stack row with
    // DeletionPolicy: Retain + the rewritten TemplateURL pointing at the
    // uploaded child template.
    const parentTemplateBody = String(parentImport.input['TemplateBody']);
    expect(parentTemplateBody).toContain('"DeletionPolicy": "Retain"');
    expect(parentTemplateBody).toContain(
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
    const createCalls = calls.filter((c) => c.name === 'CreateChangeSet');
    expect(createCalls.map((c) => c.input['StackName'])).toEqual([
      'custom-child-name',
      'CustomRootName',
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
        /IMPORT changeset failed for cdkd stack 'Root~Child' \(CFn name 'Root-Child'\)/
      );

      // NO state was deleted — error preserved cdkd state for retry.
      expect(deleted).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
