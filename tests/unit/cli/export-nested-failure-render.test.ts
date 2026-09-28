/**
 * `runPerStackImportLoop`'s failure messages render AWS's text through
 * `displayAwsMessage` (go-to-k/cdkd#3910): the Phase 1A / 1B `Cause:` lines,
 * which carry the waiter's bare rethrow, and the nested pre-delete, which used
 * to reach the terminal unwrapped. AWS's text can quote a recorded value back,
 * so a planted newline must not start a line and a planted flood must be cut.
 *
 * A separate file from `export-nested-loop.test.ts` (held by another open PR),
 * with the same mock shape: fake CloudFormation command classes, stubbed
 * waiters, and a stubbed template upload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/logger.js', () => {
  const sink = { setLevel: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...sink, child: () => sink }) };
});

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
  const make = (name: string) =>
    class extends FakeCommand {
      constructor(input: Record<string, unknown>) {
        super(name, input);
      }
    };
  return {
    CreateChangeSetCommand: make('CreateChangeSet'),
    ExecuteChangeSetCommand: make('ExecuteChangeSet'),
    DescribeChangeSetCommand: make('DescribeChangeSet'),
    DescribeStacksCommand: make('DescribeStacks'),
    DescribeTypeCommand: make('DescribeType'),
    DescribeStackEventsCommand: make('DescribeStackEvents'),
    DeleteChangeSetCommand: make('DeleteChangeSet'),
    GetTemplateCommand: make('GetTemplate'),
    UpdateStackCommand: make('UpdateStack'),
  };
});

vi.mock('@aws-sdk/client-cloudformation', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-cloudformation');
  return {
    ...real,
    ...cfnCommands,
    waitUntilChangeSetCreateComplete: waitChangeSetCreate,
    waitUntilStackImportComplete: waitStackImport,
    waitUntilStackUpdateComplete: waitStackUpdate,
  };
});

vi.mock('../../../src/cli/upload-cfn-template.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '../../../src/cli/upload-cfn-template.js'
  );
  return {
    ...real,
    uploadCfnTemplate: vi.fn(async (opts: { stackName: string }) => ({
      url: `https://bucket.s3.amazonaws.com/cdkd-migrate-tmp/${opts.stackName}/template.json`,
      cleanup: vi.fn(async () => undefined),
    })),
  };
});

// The IAM::Policy pre-delete builds its OWN client.
const iamSend = vi.hoisted(() => vi.fn<(cmd: unknown) => Promise<unknown>>());
vi.mock('@aws-sdk/client-iam', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    IAMClient: class {
      send = iamSend;
    },
    DeleteRolePolicyCommand: class extends Cmd {},
    DeleteUserPolicyCommand: class extends Cmd {},
    DeleteGroupPolicyCommand: class extends Cmd {},
    NoSuchEntityException: class extends Error {},
  };
});

// The tree-wide confirmation reads stdin through readline.
const question = vi.hoisted(() => vi.fn(async (_prompt: string) => 'n'));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question, close: vi.fn() }),
}));

import { setStdinIsTty } from '../../stdin-tty.js';
import { getLogger } from '../../../src/utils/logger.js';
import { runPerStackImportLoop, type CdkdStateStackTree } from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/** Every `logger.info` line since the last {@link clearInfo}. */
function infoLines(): string[] {
  return (getLogger().info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
    String(c[0])
  );
}
function clearInfo(): void {
  (getLogger().info as unknown as { mockClear: () => void }).mockClear();
}
/** The plan's mark for a principal phase 2 cannot be confirmed to re-attach. */
const MARK = /phase 2 cannot be confirmed to re-attach it to /;
const marked = (): boolean => infoLines().some((l) => MARK.test(l));

/** AWS text quoting a planted value back: a forged labelled line, then a flood. */
const PLANTED = `quoted\nRe-run with: rm -rf ~ ${'e'.repeat(6000)}`;

function assertRendered(message: string, label: RegExp): void {
  const at = message.search(label);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = message.slice(at);
  // Folded: the planted newline did not start the forged line.
  expect(rest).not.toMatch(/\nRe-run with: rm -rf/);
  expect(rest).toContain('quoted Re-run with: rm -rf ~');
  // Bounded, with the cut marked.
  expect(rest).toMatch(/\[cut: \d+ more characters withheld\]/);
  expect(rest).not.toContain('e'.repeat(4097));
}

function state(
  stackName: string,
  resources: StackState['resources'],
  parent?: { stack: string; logicalId: string }
): StackState {
  return {
    version: 9,
    stackName,
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
    ...(parent && {
      parentStack: parent.stack,
      parentLogicalId: parent.logicalId,
      parentRegion: 'us-east-1',
    }),
  } as unknown as StackState;
}

const bucket = (physicalId: string) => ({
  physicalId,
  resourceType: 'AWS::S3::Bucket',
  properties: {},
  attributes: {},
  dependencies: [],
});

/** Every stack is absent at pre-flight and present afterwards; DescribeChangeSet can be made to throw. */
function cfnClient(opts: { describeChangeSetThrows?: boolean } = {}) {
  const seen = new Map<string, number>();
  const send = vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
    switch (cmd._name) {
      case 'DescribeStacks': {
        const name = String(cmd.input['StackName']);
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        if (n === 1) throw new Error('Stack does not exist');
        return {
          Stacks: [{ StackId: `arn:aws:cloudformation:us-east-1:1:stack/${name}/u`, StackName: name, Tags: [] }],
        };
      }
      case 'DescribeType':
        return { Schema: '{"primaryIdentifier": ["/properties/BucketName"]}' };
      case 'DescribeChangeSet':
        if (opts.describeChangeSetThrows) throw new Error('DescribeChangeSet unavailable');
        return {};
      case 'GetTemplate':
        return { TemplateBody: JSON.stringify({ Resources: {} }) };
      case 'DescribeStackEvents':
        return { StackEvents: [] };
      default:
        return {};
    }
  });
  return { send } as unknown as AwsClients['cloudFormation'];
}

function deps(client: AwsClients['cloudFormation']) {
  return {
    cfnClient: client,
    stateBackend: {
      async getState() {
        return null;
      },
      async deleteState() {},
    } as unknown as S3StateBackend,
    lockManager: {
      async acquireLockWithRetry() {},
      async releaseLock() {},
    } as unknown as LockManager,
    uploadOpts: { stateBucket: 'b' },
    lockOwner: 'test',
  };
}

const OPTIONS = {
  dryRun: false,
  yes: true,
  includeNonImportable: false,
  recreateImportUnsupported: true,
  skipImportSupportPreflight: true,
};

beforeEach(() => {
  waitChangeSetCreate.mockReset();
  waitChangeSetCreate.mockResolvedValue(undefined);
  waitStackImport.mockReset();
  waitStackImport.mockResolvedValue(undefined);
  waitStackUpdate.mockReset();
  waitStackUpdate.mockResolvedValue(undefined);
  iamSend.mockReset();
});

describe('Phase 1A: the Cause line renders the waiter rethrow through displayAwsMessage', () => {
  it('folds and bounds it', async () => {
    // The waiter rejects and DescribeChangeSet fails too, so the ORIGINAL
    // waiter error is rethrown bare into the Cause line.
    waitChangeSetCreate.mockRejectedValue(new Error(PLANTED));
    const root = state('Root', { MyBucket: bucket('b1') });
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map(),
    };
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree,
      rootTemplate: { Resources: { MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient({ describeChangeSetThrows: true })),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain('Phase 1A IMPORT changeset failed');
    assertRendered(err.message, /Cause: /);
    // Nothing was imported: only this stack's own leftover CloudFormation
    // stack stands in the way of a re-run (go-to-k/cdkd#3910).
    expect(err.message).toContain(
      "No stack was imported. A failed IMPORT can leave CloudFormation stack 'Root' behind, and a " +
        're-run is refused while it exists. Check that it holds no resources:\n' +
        '  aws cloudformation list-stack-resources --stack-name Root\n' +
        'then delete it, and re-run with: cdkd export Root'
    );
    expect(err.message).not.toContain('already-imported children will be adopted');
    expect(err.message).not.toContain('cdkd state orphan');
  });
});

describe('Phase 1A failing after a stack was imported gives the whole-tree recovery (go-to-k/cdkd#3910)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-1a-tail-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('refuses a re-run for the whole tree and orphans the imported child', async () => {
    const childPath = join(tmp, 'Child.template.json');
    writeFileSync(
      childPath,
      JSON.stringify({ Resources: { ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } }),
      'utf-8'
    );
    // Child 1A succeeds; root 1A (the second changeset wait) fails.
    waitChangeSetCreate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));
    const root = state('Root', {
      ParentBucket: bucket('b1'),
      Child: {
        physicalId: 'arn:x',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    const child = state('Root~Child', { ChildBucket: bucket('b2') }, { stack: 'Root', logicalId: 'Child' });
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree: {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          ['Child', { stackName: 'Root~Child', region: 'us-east-1', state: child, nestedChildren: new Map() }],
        ]),
      },
      rootTemplate: {
        Resources: {
          ParentBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://x/Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.template.json' },
          },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient({ describeChangeSetThrows: true })),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(waitChangeSetCreate).toHaveBeenCalledTimes(2);
    expect(err.message).toContain('Phase 1A IMPORT changeset failed for cdkd stack \'Root\'');
    expect(err.message).toContain(
      'Re-running `cdkd export` is refused for the whole tree: CloudFormation stacks now exist for ' +
        "every stack IMPORTed before this one, and this stack's may exist too"
    );
    expect(err.message).toMatch(
      /still have cdkd state[^\n]*:\n {2}cdkd state orphan '?Root~Child'? --stack-region '?us-east-1'?\n/
    );
    expect(err.message).toMatch(
      /Once this stack's IMPORT and phase 2 succeed by hand, clean up its record the same way \(its IMPORT must also adopt its already-imported nested children, per the AWS docs "Nest an existing stack" procedure\):\n {2}cdkd state orphan Root --stack-region us-east-1\n/
    );
    expect(err.message).toContain('Stacks not yet imported (still cdkd-managed): (none).');
    expect(err.message).not.toContain('Re-run with:');
    expect(err.message).not.toContain('No stack was imported');
  });

  it('asks for no adoption when the failed stack has no nested children', async () => {
    const leaf = { Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } } };
    const aPath = join(tmp, 'A.template.json');
    const bPath = join(tmp, 'B.template.json');
    writeFileSync(aPath, JSON.stringify(leaf), 'utf-8');
    writeFileSync(bPath, JSON.stringify(leaf), 'utf-8');
    // A's 1A succeeds; B's 1A (the second changeset wait) fails. B is a leaf.
    waitChangeSetCreate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));
    const row = (id: string) => ({
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: `https://x/${id}.template.json` },
      Metadata: { 'aws:asset:path': `${id}.template.json` },
    });
    const stackRecord = {
      physicalId: 'arn:x',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      attributes: {},
      dependencies: [],
    };
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { A: aPath, B: bPath },
      rootTemplateFormat: 'json',
      tree: {
        stackName: 'Root',
        region: 'us-east-1',
        state: state('Root', { A: stackRecord, B: stackRecord } as unknown as StackState['resources']),
        nestedChildren: new Map([
          [
            'A',
            {
              stackName: 'Root~A',
              region: 'us-east-1',
              state: state('Root~A', { B: bucket('a1') }, { stack: 'Root', logicalId: 'A' }),
              nestedChildren: new Map(),
            },
          ],
          [
            'B',
            {
              stackName: 'Root~B',
              region: 'us-east-1',
              state: state('Root~B', { B: bucket('b1') }, { stack: 'Root', logicalId: 'B' }),
              nestedChildren: new Map(),
            },
          ],
        ]),
      },
      rootTemplate: { Resources: { A: row('A'), B: row('B') } },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient({ describeChangeSetThrows: true })),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toMatch(/Phase 1A IMPORT changeset failed for cdkd stack 'Root~(A|B)'/);
    expect(err.message).toContain("Once this stack's IMPORT and phase 2 succeed by hand, clean up its record the same way:");
    expect(err.message).not.toContain('must also adopt');
    expect(err.message).toContain('Stacks not yet imported (still cdkd-managed): Root.');
  });
});

describe('Phase 1B: the Cause line renders the waiter rethrow through displayAwsMessage', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-1b-render-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('folds and bounds it', async () => {
    const childPath = join(tmp, 'Child.template.json');
    writeFileSync(
      childPath,
      JSON.stringify({ Resources: { ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } }),
      'utf-8'
    );
    // Child 1A, root 1A succeed; root 1B (the third changeset wait) fails.
    waitChangeSetCreate
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error(PLANTED));
    const root = state('Root', {
      ParentBucket: bucket('b1'),
      Child: {
        physicalId: 'arn:x',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    const child = state('Root~Child', { ChildBucket: bucket('b2') }, { stack: 'Root', logicalId: 'Child' });
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map([
        ['Child', { stackName: 'Root~Child', region: 'us-east-1', state: child, nestedChildren: new Map() }],
      ]),
    };
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree,
      rootTemplate: {
        Resources: {
          ParentBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://x/Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.template.json' },
          },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient({ describeChangeSetThrows: true })),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain('Phase 1B (nested-child adoption) IMPORT changeset failed');
    assertRendered(err.message, /Cause: /);
  });
});

describe('the nested pre-delete renders its failure like the single-stack path', () => {
  it('names the resource, folds and bounds AWS text, and gives the IAM by-hand delete', async () => {
    iamSend.mockRejectedValue(new Error(PLANTED));
    const root = state('Root', {
      MyBucket: bucket('b1'),
      HandlerPolicy: {
        physicalId: 'HandlerPolicyName',
        resourceType: 'AWS::IAM::Policy',
        properties: { Roles: ['RoleA'] },
        attributes: {},
        dependencies: [],
      },
    });
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map(),
    };
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree,
      rootTemplate: {
        Resources: {
          MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          HandlerPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'HandlerPolicyName', Roles: ['RoleA'] },
          },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain(
      "pre-delete of HandlerPolicy (AWS::IAM::Policy, physicalId: HandlerPolicyName) failed: "
    );
    // The recovery a partly migrated tree needs: what moved, what did not,
    // that re-running does not resume it, and the record clean-up.
    expect(err.message).toContain('Stacks IMPORTed so far (each CFn-managed): Root → Root.');
    expect(err.message).toContain(
      'Re-running `cdkd export` is refused for the whole tree'
    );
    expect(err.message).toContain(
      "Once this stack's phase 2 succeeds by hand, clean up its record the same way:\n" +
        '  cdkd state orphan Root --stack-region us-east-1'
    );
    expect(err.message).toContain('Stacks not yet imported (still cdkd-managed): (none).');
    // Nothing finished phase 2 before this, the only stack.
    expect(err.message).not.toContain('finished phase 2 but still have cdkd state');
    assertRendered(err.message, /failed: /);
    expect(err.message).toContain(
      "aws iam delete-role-policy --role-name '<RoleName>' --policy-name '<PolicyName>'"
    );
    // The API Gateway line belongs to a Stage failure only.
    expect(err.message).not.toContain('apigatewayv2');
  });
});

describe('a nested stack blocked on its own remedy says so, not destroy-or-remove', () => {
  it('carries the Repair with: row and the scoped tail', async () => {
    const root = state('Root', {
      MyBucket: bucket('b1'),
      HandlerPolicy: {
        physicalId: 'HandlerPolicyName',
        resourceType: 'AWS::IAM::Policy',
        properties: { Roles: ['RoleA', 'AdminRole'] },
        attributes: {},
        dependencies: [],
      },
    });
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree: { stackName: 'Root', region: 'us-east-1', state: root, nestedChildren: new Map() },
      rootTemplate: {
        Resources: {
          MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          HandlerPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'HandlerPolicyName', Roles: ['RoleA'] },
          },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain('role AdminRole, which the template does not name');
    // The ROOT stack, never the child's minted name, and the diff FIRST.
    expect(err.message).toContain('\nCheck first with: cdkd diff Root\nRepair with: cdkd deploy Root');
    expect(err.message).toMatch(/\nRun each row's 'Repair with:' command, then re-run cdkd export\.$/);
    expect(iamSend).not.toHaveBeenCalled();
  });
});

/** A root-only tree whose one IAM::Policy the template names, with a pre-delete that succeeds. */
function policyTree(): {
  tree: CdkdStateStackTree;
  rootTemplate: Record<string, unknown>;
} {
  const root = state('Root', {
    MyBucket: bucket('b1'),
    HandlerPolicy: {
      physicalId: 'HandlerPolicyName',
      resourceType: 'AWS::IAM::Policy',
      properties: { Roles: ['RoleA'] },
      attributes: {},
      dependencies: [],
    },
  });
  return {
    tree: { stackName: 'Root', region: 'us-east-1', state: root, nestedChildren: new Map() },
    rootTemplate: {
      Resources: {
        MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        HandlerPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'HandlerPolicyName', Roles: ['RoleA'] },
          },
      },
    },
  };
}

describe('a nested phase-2 failure renders AWS text folded and bounded (go-to-k/cdkd#3910)', () => {
  it('wraps executeUpdateChangeSet, which rethrows the update waiter bare', async () => {
    iamSend.mockResolvedValue({});
    waitStackUpdate.mockRejectedValue(new Error(PLANTED));
    const { tree, rootTemplate } = policyTree();
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree,
      rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain("Phase 2 (UPDATE) failed for cdkd stack 'Root' (CFn name 'Root'): ");
    assertRendered(err.message, /Phase 2 \(UPDATE\) failed/);
    // The same resume guidance as the pre-delete failure.
    expect(err.message).toContain('Re-running `cdkd export` is refused for the whole tree');
    expect(err.message).toContain(
      "clean up its record the same way:\n  cdkd state orphan Root --stack-region us-east-1"
    );
  });
});

describe('the tree-wide confirmation does not call the pre-deletes unchanged (go-to-k/cdkd#3910)', () => {
  let original: boolean | undefined;
  beforeEach(() => {
    original = process.stdin.isTTY;
    setStdinIsTty(true);
    question.mockClear();
  });
  afterEach(() => setStdinIsTty(original));

  it('points at the plan for them and scopes "unchanged" to the rest', async () => {
    const { tree, rootTemplate } = policyTree();
    const result = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree,
      rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: { ...OPTIONS, yes: false },
    });
    expect(result.outcome).toBe('cancelled');
    const prompt = String(question.mock.calls[0]?.[0]);
    expect(prompt).toContain(
      'cdkd will also DELETE 1 AWS resource(s) between phases so CFn can re-CREATE them in ' +
        'phase 2 (brief unavailability window — see the plan above for the affected resources, ' +
        'and for any marked as not confirmed to be re-created). All other AWS resources are ' +
        'unchanged.'
    );
    expect(prompt).not.toMatch(/\) AWS resources are unchanged|\. AWS resources are unchanged/);
    expect(iamSend).not.toHaveBeenCalled();
  });

  it('keeps the plain claim when nothing is pre-deleted', async () => {
    const root = state('Root', { MyBucket: bucket('b1') });
    const result = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree: { stackName: 'Root', region: 'us-east-1', state: root, nestedChildren: new Map() },
      rootTemplate: { Resources: { MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: { ...OPTIONS, yes: false },
    });
    expect(result.outcome).toBe('cancelled');
    const prompt = String(question.mock.calls[0]?.[0]);
    expect(prompt).toContain('. AWS resources are unchanged. cdkd state for every adopted stack');
    expect(prompt).not.toContain('All other');
  });
});

describe('a nested pre-delete failure in a child names the stacks after it', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-child-predelete-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('lists the parent as not yet imported', async () => {
    iamSend.mockRejectedValue(new Error('AccessDenied'));
    const childPath = join(tmp, 'Child.template.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Resources: {
          ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          ChildPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'ChildPolicyName', Roles: ['RoleA'] },
          },
        },
      }),
      'utf-8'
    );
    const root = state('Root', {
      ParentBucket: bucket('b1'),
      Child: {
        physicalId: 'arn:x',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    const child = state(
      'Root~Child',
      {
        ChildBucket: bucket('b2'),
        ChildPolicy: {
          physicalId: 'ChildPolicyName',
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['RoleA'] },
          attributes: {},
          dependencies: [],
        },
      },
      { stack: 'Root', logicalId: 'Child' }
    );
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree: {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          ['Child', { stackName: 'Root~Child', region: 'us-east-1', state: child, nestedChildren: new Map() }],
        ]),
      },
      rootTemplate: {
        Resources: {
          ParentBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://x/Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.template.json' },
          },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain('pre-delete of ChildPolicy');
    expect(err.message).toContain('Stacks not yet imported (still cdkd-managed): Root.');
    expect(err.message).toContain('"Nest an existing stack"');
    // The clean-up names the FAILED stack, not the first one in the loop.
    expect(err.message).toMatch(
      /clean up its record the same way:\n {2}cdkd state orphan '?Root~Child'? --stack-region '?us-east-1'?\n/
    );
  });
});

describe('a nested pre-delete failure in the ROOT, after its child was imported', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-root-predelete-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('names the root in the clean-up, and the child as imported', async () => {
    iamSend.mockRejectedValue(new Error('AccessDenied'));
    const childPath = join(tmp, 'Child.template.json');
    writeFileSync(
      childPath,
      JSON.stringify({ Resources: { ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } }),
      'utf-8'
    );
    const root = state('Root', {
      ParentBucket: bucket('b1'),
      RootPolicy: {
        physicalId: 'RootPolicyName',
        resourceType: 'AWS::IAM::Policy',
        properties: { Roles: ['RoleA'] },
        attributes: {},
        dependencies: [],
      },
      Child: {
        physicalId: 'arn:x',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    const child = state('Root~Child', { ChildBucket: bucket('b2') }, { stack: 'Root', logicalId: 'Child' });
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: childPath },
      rootTemplateFormat: 'json',
      tree: {
        stackName: 'Root',
        region: 'us-east-1',
        state: root,
        nestedChildren: new Map([
          ['Child', { stackName: 'Root~Child', region: 'us-east-1', state: child, nestedChildren: new Map() }],
        ]),
      },
      rootTemplate: {
        Resources: {
          ParentBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          RootPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'RootPolicyName', Roles: ['RoleA'] },
          },
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://x/Child.template.json' },
            Metadata: { 'aws:asset:path': 'Child.template.json' },
          },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain('pre-delete of RootPolicy');
    expect(err.message).toContain('Root~Child → Root-Child');
    expect(err.message).toContain('Stacks not yet imported (still cdkd-managed): (none).');
    // The child finished phase 2 and still holds cdkd state: its clean-up is
    // given too, or a later `cdkd destroy Root` deletes CFn-managed resources.
    expect(err.message).toMatch(
      /finished phase 2 but still have cdkd state[^\n]*:\n {2}cdkd state orphan '?Root~Child'? --stack-region '?us-east-1'?\n/
    );
    expect(err.message).toMatch(
      /clean up its record the same way:\n {2}cdkd state orphan Root --stack-region us-east-1\n/
    );
  });
});

/** A root with one nested child whose template is written to `dir`. */
function childTree(
  dir: string,
  childTemplate: Record<string, unknown>,
  childResources: StackState['resources'],
  rootExtra: {
    resources?: StackState['resources'];
    template?: Record<string, unknown>;
    rowParameters?: Record<string, unknown>;
    rootParameters?: Record<string, unknown>;
    /** What the child record says its parent row is (default: the true one). */
    childParentLogicalId?: string;
    /** What the child record says its parent stack is (default: the true one). */
    childParentStack?: string;
  } = {}
) {
  const childPath = join(dir, 'Child.template.json');
  writeFileSync(childPath, JSON.stringify(childTemplate), 'utf-8');
  const root = state('Root', {
    ParentBucket: bucket('b1'),
    Child: {
      physicalId: 'arn:x',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      attributes: {},
      dependencies: [],
    },
    ...(rootExtra.resources ?? {}),
  });
  const child = state('Root~Child', childResources, {
    stack: rootExtra.childParentStack ?? 'Root',
    logicalId: rootExtra.childParentLogicalId ?? 'Child',
  });
  return {
    childPath,
    tree: {
      stackName: 'Root',
      region: 'us-east-1',
      state: root,
      nestedChildren: new Map([
        ['Child', { stackName: 'Root~Child', region: 'us-east-1', state: child, nestedChildren: new Map() }],
      ]),
    } as CdkdStateStackTree,
    rootTemplate: {
      ...(rootExtra.rootParameters && { Parameters: rootExtra.rootParameters }),
      Resources: {
        ParentBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://x/Child.template.json',
            ...(rootExtra.rowParameters && { Parameters: rootExtra.rowParameters }),
          },
          Metadata: { 'aws:asset:path': 'Child.template.json' },
        },
        ...(rootExtra.template ?? {}),
      },
    },
  };
}

describe('a nested child policy naming a role through a Parameter is CHECKED (sec-m1a)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-param-ref-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const childTemplate = {
    Parameters: { ParentRoleRef: { Type: 'String' } },
    Resources: {
      ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      ChildPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'ChildPolicyName', Roles: [{ Ref: 'ParentRoleRef' }] },
      },
    },
  };
  const policy = (roles: string[]) => ({
    ChildBucket: bucket('b2'),
    ChildPolicy: {
      physicalId: 'ChildPolicyName',
      resourceType: 'AWS::IAM::Policy',
      properties: { Roles: roles },
      attributes: {},
      dependencies: [],
    },
  });
  const parentRole = {
    resources: {
      ParentRole: {
        physicalId: 'ParentRoleName',
        resourceType: 'AWS::IAM::Role',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    } as unknown as StackState['resources'],
    template: { ParentRole: { Type: 'AWS::IAM::Role', Properties: {} } },
    rowParameters: { ParentRoleRef: { Ref: 'ParentRole' } },
  };

  async function run(roles: string[], yes: boolean) {
    const t = childTree(tmp, childTemplate, policy(roles), parentRole);
    return runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: t.childPath },
      rootTemplateFormat: 'json',
      tree: t.tree,
      rootTemplate: t.rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: { ...OPTIONS, dryRun: true, yes },
    }).then(
      (r) => r,
      (e: unknown) => e as Error
    );
  }

  it('confirms the parent role the row passes: no mark', async () => {
    clearInfo();
    const r = await run(['ParentRoleName'], true);
    expect(r).toEqual({ outcome: 'dry-run', importedStacks: [] });
    expect(infoLines().some((l) => l.includes('removes inline policy ChildPolicyName'))).toBe(true);
    expect(marked()).toBe(false);
  });

  it('blocks a planted extra recorded role, even without --yes', async () => {
    const r = (await run(['ParentRoleName', 'AdminRole'], false)) as Error;
    expect(r.message).toContain('role AdminRole, which the template does not name');
  });
});

describe('the nested pre-delete wrapper renders a forged logical id with its own boundary (test-n1)', () => {
  it('JSON-quotes it', async () => {
    iamSend.mockRejectedValue(new Error('AccessDenied'));
    const forged = "Handler Policy'x";
    const root = state('Root', {
      MyBucket: bucket('b1'),
      [forged]: {
        physicalId: 'HandlerPolicyName',
        resourceType: 'AWS::IAM::Policy',
        properties: { Roles: ['RoleA'] },
        attributes: {},
        dependencies: [],
      },
    });
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree: { stackName: 'Root', region: 'us-east-1', state: root, nestedChildren: new Map() },
      rootTemplate: {
        Resources: {
          MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          [forged]: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'HandlerPolicyName', Roles: ['RoleA'] },
          },
        },
      },
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain(`pre-delete of ${JSON.stringify(forged)} (AWS::IAM::Policy,`);
  });
});

describe('a failure in the MIDDLE of a 3-stack tree gives the whole-tree recovery (code-m1)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-3stack-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('refuses a re-run for the whole tree, orphans every stack that finished, and names what is left', async () => {
    iamSend.mockRejectedValue(new Error('AccessDenied'));
    // Grand (leaf) completes; Child's pre-delete fails; Root is not reached.
    writeFileSync(
      join(tmp, 'Grand.template.json'),
      JSON.stringify({ Resources: { GrandBucket: { Type: 'AWS::S3::Bucket', Properties: {} } } }),
      'utf-8'
    );
    const childTemplate = {
      Resources: {
        ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        ChildPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: { PolicyName: 'ChildPolicyName', Roles: ['RoleA'] },
        },
        Grand: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://x/Grand.template.json' },
          Metadata: { 'aws:asset:path': 'Grand.template.json' },
        },
      },
    };
    const t = childTree(tmp, childTemplate, {
      ChildBucket: bucket('b2'),
      ChildPolicy: {
        physicalId: 'ChildPolicyName',
        resourceType: 'AWS::IAM::Policy',
        properties: { Roles: ['RoleA'] },
        attributes: {},
        dependencies: [],
      },
      Grand: {
        physicalId: 'arn:g',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    } as unknown as StackState['resources']);
    const grand = state('Root~Child~Grand', { GrandBucket: bucket('b3') }, {
      stack: 'Root~Child',
      logicalId: 'Grand',
    });
    const childNode = t.tree.nestedChildren.get('Child')!;
    childNode.nestedChildren.set('Grand', {
      stackName: 'Root~Child~Grand',
      region: 'us-east-1',
      state: grand,
      nestedChildren: new Map(),
    });
    const err = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: t.childPath },
      rootTemplateFormat: 'json',
      tree: t.tree,
      rootTemplate: t.rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: OPTIONS,
    }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toContain('pre-delete of ChildPolicy');
    expect(err.message).toContain('Re-running `cdkd export` is refused for the whole tree');
    // Grand finished phase 2 and still holds cdkd state: its clean-up.
    expect(err.message).toMatch(
      /finished phase 2 but still have cdkd state[^\n]*:\n {2}cdkd state orphan '?Root~Child~Grand'? --stack-region '?us-east-1'?\n/
    );
    // Child's own clean-up once its phase 2 is done by hand.
    expect(err.message).toMatch(
      /clean up its record the same way:\n {2}cdkd state orphan '?Root~Child'? --stack-region '?us-east-1'?\n/
    );
    // Root was never imported.
    expect(err.message).toContain('Stacks not yet imported (still cdkd-managed): Root.');
    expect(err.message).toContain('"Nest an existing stack"');
    // Root is not given an orphan command: it is still cdkd's to migrate.
    expect(err.message).not.toMatch(/cdkd state orphan Root --stack-region/);
  });
});

/**
 * A child's principal passed through its parent row is checked against the
 * value `buildResolvedParametersPerStack` resolves for the changeset — the one
 * resolution, not a copy of it. Driven through a dry run of the loop.
 */
describe('nested parameter values: the check reads what the changeset submits (go-to-k/cdkd#3910)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-child-params-'));
    clearInfo();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const childTemplate = (paramType = 'String') => ({
    Parameters: { RoleParam: { Type: paramType } },
    Resources: {
      ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      ChildPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'ChildPolicyName', Roles: [{ Ref: 'RoleParam' }] },
      },
    },
  });
  const childRecord = (roles: string[]) =>
    ({
      ChildBucket: bucket('b2'),
      ChildPolicy: {
        physicalId: 'ChildPolicyName',
        resourceType: 'AWS::IAM::Policy',
        properties: { Roles: roles },
        attributes: {},
        dependencies: [],
      },
    }) as unknown as StackState['resources'];
  const recorded = (physicalId: string, resourceType: string) => ({
    physicalId,
    resourceType,
    properties: {},
    attributes: {},
    dependencies: [],
  });

  async function run(
    t: ReturnType<typeof childTree>,
    opts: {
      yes?: boolean;
      dryRun?: boolean;
      rootParameters?: Array<{ ParameterKey: string; ParameterValue: string }>;
    } = {}
  ) {
    return runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: t.childPath },
      rootTemplateFormat: 'json',
      tree: t.tree,
      rootTemplate: t.rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: opts.rootParameters ?? [],
      deps: deps(cfnClient()),
      options: { ...OPTIONS, dryRun: opts.dryRun ?? true, yes: opts.yes ?? true },
    }).then(
      (r) => r,
      (e: unknown) => e as Error
    );
  }
  const DRY = { outcome: 'dry-run', importedStacks: [] };
  const NOT_NAMED = /role (\S+), which the template does not name/;

  it('confirms a literal the row passes', async () => {
    const t = childTree(tmp, childTemplate(), childRecord(['LiteralRole']), {
      rowParameters: { RoleParam: 'LiteralRole' },
    });
    expect(await run(t)).toEqual(DRY);
    expect(marked()).toBe(false);
  });

  it("confirms a root parameter the row passes through, from the root's values", async () => {
    const t = childTree(tmp, childTemplate(), childRecord(['FromRoot']), {
      rootParameters: { RootRole: { Type: 'String' } },
      rowParameters: { RoleParam: { Ref: 'RootRole' } },
    });
    expect(await run(t, { rootParameters: [{ ParameterKey: 'RootRole', ParameterValue: 'FromRoot' }] })).toEqual(
      DRY
    );
    expect(marked()).toBe(false);
  });

  it('checks the value the resolver submits, which reads parent STATE before parent parameters', async () => {
    // A planted parent record whose key is the parent PARAMETER's name: the
    // resolver answers `Ref: AppRoleName` from state, so the changeset passes
    // AttackerRole and phase 2 attaches the policy there. The check reads the
    // same value, so the recorded AppRole is a mismatch — blocked, not confirmed.
    const t = childTree(tmp, childTemplate(), childRecord(['AppRole']), {
      rootParameters: { AppRoleName: { Type: 'String' } },
      rowParameters: { RoleParam: { Ref: 'AppRoleName' } },
      resources: {
        AppRoleName: recorded('AttackerRole', 'AWS::IAM::Role'),
      } as unknown as StackState['resources'],
    });
    const err = (await run(t, {
      rootParameters: [{ ParameterKey: 'AppRoleName', ParameterValue: 'AppRole' }],
    })) as Error;
    expect(err.message).toMatch(NOT_NAMED);
    expect(err.message.match(NOT_NAMED)![1]).toBe('AppRole');
    // A child's value is not a --parameter value, so that hint is not given.
    expect(err.message).not.toContain('--parameter values');
  });

  it('marks an SSM-typed child parameter (its value is an SSM name), and proceeds under --yes', async () => {
    const t = childTree(tmp, childTemplate('AWS::SSM::Parameter::Value<String>'), childRecord(['RealRole']), {
      rowParameters: { RoleParam: '/app/role-name' },
    });
    expect(await run(t)).toEqual(DRY);
    expect(marked()).toBe(true);
    expect(infoLines().some((l) => l.includes('role RealRole: the template names its principals'))).toBe(true);
  });

  it('blocks when an SSM-typed parent parameter is passed through: the child is submitted the SSM name', async () => {
    const t = childTree(tmp, childTemplate(), childRecord(['RealRole']), {
      rootParameters: { RootRole: { Type: 'AWS::SSM::Parameter::Value<String>' } },
      rowParameters: { RoleParam: { Ref: 'RootRole' } },
    });
    const err = (await run(t, {
      rootParameters: [{ ParameterKey: 'RootRole', ParameterValue: '/app/role-name' }],
    })) as Error;
    expect(err.message).toContain('role RealRole, which the template does not name');
  });

  it('marks a principal the row the child record names does not pass', async () => {
    // The record names row `Other`, which the parent does not have, so the
    // changeset submits no RoleParam and the check cannot resolve it.
    const t = childTree(tmp, childTemplate(), childRecord(['LiteralRole']), {
      rowParameters: { RoleParam: 'LiteralRole' },
      childParentLogicalId: 'Other',
    });
    expect(await run(t)).toEqual(DRY);
    expect(marked()).toBe(true);
  });

  it('refuses a child record naming another parent STACK on a real run, before any changeset', async () => {
    const t = childTree(tmp, childTemplate(), childRecord(['LiteralRole']), {
      rowParameters: { RoleParam: 'LiteralRole' },
      childParentStack: 'OtherRoot',
    });
    expect(((await run(t, { dryRun: false })) as Error).message).toContain(
      "references parent 'OtherRoot' which is not in the per-stack node list"
    );
    expect(waitChangeSetCreate).not.toHaveBeenCalled();
  });

  it('on --dry-run, warns about that record and still plans, the principal unconfirmed', async () => {
    const warn = getLogger().warn as unknown as {
      mock: { calls: unknown[][] };
      mockClear: () => void;
    };
    warn.mockClear();
    const t = childTree(tmp, childTemplate(), childRecord(['LiteralRole']), {
      rowParameters: { RoleParam: 'LiteralRole' },
      childParentStack: 'OtherRoot',
    });
    expect(await run(t)).toEqual(DRY);
    expect(marked()).toBe(true);
    expect(
      warn.mock.calls.some(
        (c) =>
          String(c[0]).includes("references parent 'OtherRoot'") &&
          String(c[0]).includes('a real run refuses here')
      )
    ).toBe(true);
  });

  it('marks an unresolvable principal and proceeds, with and without --yes', async () => {
    const t = childTree(tmp, childTemplate(), childRecord(['Anything']), {});
    expect(await run(t)).toEqual(DRY);
    expect(marked()).toBe(true);
    clearInfo();
    expect(await run(t, { yes: false })).toEqual(DRY);
    expect(marked()).toBe(true);
  });
});

describe('nested parameter values carry through a grandparent chain', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-grand-params-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("confirms a grandchild's principal that the root passes down two rows", async () => {
    writeFileSync(
      join(tmp, 'Grand.template.json'),
      JSON.stringify({
        Parameters: { G: { Type: 'String' } },
        Resources: {
          GrandBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          GrandPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'GrandPolicyName', Roles: [{ Ref: 'G' }] },
          },
        },
      }),
      'utf-8'
    );
    const t = childTree(
      tmp,
      {
        Parameters: { C: { Type: 'String' } },
        Resources: {
          ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
          Grand: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://x/Grand.template.json', Parameters: { G: { Ref: 'C' } } },
            Metadata: { 'aws:asset:path': 'Grand.template.json' },
          },
        },
      },
      {
        ChildBucket: bucket('b2'),
        Grand: {
          physicalId: 'arn:g',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      } as unknown as StackState['resources'],
      { rowParameters: { C: 'PassedDown' } }
    );
    const grand = state(
      'Root~Child~Grand',
      {
        GrandBucket: bucket('b3'),
        GrandPolicy: {
          physicalId: 'GrandPolicyName',
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['PassedDown'] },
          attributes: {},
          dependencies: [],
        },
      } as unknown as StackState['resources'],
      { stack: 'Root~Child', logicalId: 'Grand' }
    );
    t.tree.nestedChildren.get('Child')!.nestedChildren.set('Grand', {
      stackName: 'Root~Child~Grand',
      region: 'us-east-1',
      state: grand,
      nestedChildren: new Map(),
    });
    const r = await runPerStackImportLoop({
      lockRecovery: {},
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: { Child: t.childPath },
      rootTemplateFormat: 'json',
      tree: t.tree,
      rootTemplate: t.rootTemplate,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: deps(cfnClient()),
      options: { ...OPTIONS, dryRun: true, yes: true },
    });
    expect(r).toEqual({ outcome: 'dry-run', importedStacks: [] });
  });
});
