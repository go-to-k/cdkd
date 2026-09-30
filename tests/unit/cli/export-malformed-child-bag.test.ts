/**
 * Issue [#3188](https://github.com/go-to-k/cdkd/issues/3188): `cdkd export`
 * REFUSES a nested tree whose CHILD record carries a `resources` bag that is
 * not a readable map — by NAME, before any changeset, upload or state write.
 *
 * `walkCdkdStateStackTree` returns a CHILDLESS node for an unreadable bag
 * (go-to-k/cdkd#3172) instead of aborting the walk, so the tree walk alone
 * would let the export carry on over a truncated subtree. What stops it is
 * `runPerStackImportLoop`'s `refuseMalformedState` pass over every tree node.
 * Before that pass existed the refusal was an accident of `buildImportPlan`:
 * a string / number / boolean / list bag read every row as "not deployed by
 * cdkd" and blocked, and a `null` or absent bag threw a bare `TypeError`
 * naming no record. The cases assert the named refusal and never a `TypeError`,
 * so either regression — the pass removed, or moved below a bag read — fails.
 *
 * Driven through `createExportCommand()` with a synthesized app (a
 * `Synthesizer` double handing back real nested-template files), because the
 * `--template` path carries no nested-template side cars and refuses a nested
 * child for that reason long before the plan is built — it cannot reach the
 * nested import loop at all. The ROOT record's own refusal, in
 * `exportCommand` at the state load, is driven the same way.
 *
 * The healthy-child `--dry-run` case is the negative control: the same tree
 * with a readable child bag gets past the pre-flight and prints its plan, so a
 * refusal in the malformed cases is the bag's doing and not the fixture's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => undefined),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

// Every CFn call answers "does not exist": that is what `assertCfnStackAbsent`
// needs, and the pre-flight reaches no OTHER CFn call. `cfnCalls` records each
// by name so a changeset submission is visible in the assertions below.
const cfnCalls = vi.hoisted(() => [] as string[]);
const cfnSend = vi.hoisted(() =>
  vi.fn(async (cmd: { constructor: { name: string } }) => {
    cfnCalls.push(cmd.constructor.name);
    throw new Error('Stack with id Exported does not exist');
  })
);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return { send: cfnSend };
    },
    get ec2() {
      return { send: vi.fn() };
    },
    get ssm() {
      return { send: () => Promise.reject(new Error('unexpected SSM read')) };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ sts: { send: vi.fn() } })),
}));

// Literals, not the consts below: a `vi.mock` factory is hoisted above them.
const STACK_NAME = 'Exported';
const STACK_REGION = 'us-east-1';

const mockGetState = vi.hoisted(() => vi.fn<(name: string) => Promise<unknown>>());
const mockDeleteState = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockSaveState = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => [{ stackName: STACK_NAME, region: STACK_REGION }]),
    getState: mockGetState,
    loadRollbackJournal: vi.fn(async () => null),
    deleteState: mockDeleteState,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const mockReleaseLock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    acquireLockWithRetry: mockAcquireLock,
    getLockInfo: vi.fn(async () => null),
    releaseLock: mockReleaseLock,
  })),
}));

// A child template upload would be the first S3 write of the adoption phase;
// the pre-flight refusal must come before it.
const uploadCfnTemplateMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/upload-cfn-template.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '../../../src/cli/upload-cfn-template.js'
  );
  return { ...real, uploadCfnTemplate: uploadCfnTemplateMock };
});

const synthesize = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('../../../src/synthesis/synthesizer.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '../../../src/synthesis/synthesizer.js'
  );
  return { ...real, Synthesizer: vi.fn().mockImplementation(() => ({ synthesize })) };
});

import { createExportCommand } from '../../../src/cli/commands/export.js';

const STACK = 'Exported';
const CHILD = `${STACK}~Child`;
const REGION = 'us-east-1';

const ROOT_TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    RootBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    Child: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'https://example.com/child.json' },
    },
  },
};

/**
 * The child declares a leaf resource AND a nested-stack row of its own: the
 * list-of-`AWS::CloudFormation::Stack` bag below is the shape that used to
 * hard-fail inside the walker, so the child template carries the row that bag
 * would have been describing.
 */
const CHILD_TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    ChildBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    Grandchild: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'https://example.com/grandchild.json' },
    },
  },
};

function row(physicalId: string, resourceType: string): Record<string, unknown> {
  return { physicalId, resourceType, properties: {}, attributes: {}, dependencies: [] };
}

function rootRecord(): { state: Record<string, unknown>; etag: string } {
  return {
    state: {
      version: 10,
      stackName: STACK,
      region: REGION,
      resources: {
        RootBucket: row('root-bucket-phys', 'AWS::S3::Bucket'),
        Child: row(
          `arn:aws:cloudformation:${REGION}:123456789012:stack/${STACK}-Child/x`,
          'AWS::CloudFormation::Stack'
        ),
      },
      outputs: {},
      lastModified: 1,
    },
    etag: 'r0',
  };
}

/** `resources: ABSENT` omits the key, the one shape JSON cannot spell as a value. */
const ABSENT = Symbol('absent');

function childRecord(resources: unknown): { state: Record<string, unknown>; etag: string } {
  return {
    state: {
      version: 10,
      stackName: CHILD,
      region: REGION,
      parentStack: STACK,
      parentLogicalId: 'Child',
      parentRegion: REGION,
      ...(resources !== ABSENT && { resources }),
      outputs: {},
      lastModified: 1,
    },
    etag: 'c0',
  };
}

/** A readable child bag: the negative control's. */
const HEALTHY_CHILD_BAG = {
  ChildBucket: row('child-bucket-phys', 'AWS::S3::Bucket'),
};

let tmp: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  cfnCalls.length = 0;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
  tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-malformed-child-'));
  const rootPath = join(tmp, 'root.template.json');
  const childPath = join(tmp, 'child.nested.template.json');
  writeFileSync(rootPath, JSON.stringify(ROOT_TEMPLATE), 'utf-8');
  writeFileSync(childPath, JSON.stringify(CHILD_TEMPLATE), 'utf-8');
  synthesize.mockResolvedValue({
    stacks: [
      {
        stackName: STACK,
        displayName: STACK,
        region: REGION,
        template: ROOT_TEMPLATE,
        nestedTemplates: { Child: childPath },
      },
    ],
  });
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockDeleteState.mockResolvedValue(undefined);
  mockSaveState.mockResolvedValue('etag-1');
});

afterEach(() => {
  exitSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function serveTree(childBag: unknown): void {
  mockGetState.mockImplementation(async (name: string) => {
    if (name === STACK) return rootRecord();
    if (name === CHILD) return childRecord(childBag);
    return null;
  });
}

/**
 * Run the command and return what `handleError` logged, or `undefined` when
 * the run completed without an error. The action is wrapped in
 * `withErrorHandling`, which catches the refusal and routes it to
 * `logger.error` + `process.exit(1)`, so the logged message is the only place
 * the refusal is observable from here.
 */
async function runExport(extra: string[]): Promise<string | undefined> {
  const cmd = createExportCommand();
  cmd.exitOverride();
  await cmd
    .parseAsync(
      [
        STACK,
        '--app',
        'fake-app',
        '--state-bucket',
        'test-bucket',
        '--stack-region',
        REGION,
        '--skip-import-support-preflight',
        '--yes',
        ...extra,
      ],
      { from: 'user' }
    )
    .catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== 'process.exit-mock') throw e;
    });
  const logged = errorSpy.mock.calls.map((c) => String(c[0]));
  return logged.length > 0 ? logged.join('\n') : undefined;
}

/** Nothing irreversible happened: no changeset, no upload, no state write. */
function expectNothingWritten(): void {
  expect(cfnCalls).not.toContain('CreateChangeSetCommand');
  expect(cfnCalls).not.toContain('ExecuteChangeSetCommand');
  expect(cfnCalls).not.toContain('UpdateStackCommand');
  expect(uploadCfnTemplateMock).not.toHaveBeenCalled();
  expect(mockDeleteState).not.toHaveBeenCalled();
  expect(mockSaveState).not.toHaveBeenCalled();
}

const SHAPES: Array<[string, unknown]> = [
  // First: the shape go-to-k/cdkd#3172 moved from a walker hard-fail onto an
  // accidental `buildImportPlan` refusal.
  [
    'a list of AWS::CloudFormation::Stack resource objects',
    [row('arn:aws:cloudformation:us-east-1:123456789012:stack/g/x', 'AWS::CloudFormation::Stack')],
  ],
  ['a string', 'not-a-map'],
  ['a number', 5],
  ['a boolean', true],
  ['null', null],
  ['absent', ABSENT],
];

describe('cdkd export over a nested child whose resources bag is unreadable (issue #3188)', () => {
  it('negative control: the same tree with a readable child bag plans past the pre-flight', async () => {
    serveTree(HEALTHY_CHILD_BAG);
    // The healthy child template must not declare the Grandchild row, which
    // its state does not carry and which would block for that reason instead.
    const childOnly = {
      ...CHILD_TEMPLATE,
      Resources: { ChildBucket: CHILD_TEMPLATE.Resources.ChildBucket },
    };
    writeFileSync(join(tmp, 'child.nested.template.json'), JSON.stringify(childOnly), 'utf-8');

    const message = await runExport(['--dry-run']);

    expect(message).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Both stacks were PLANNED — the child's plan is what the malformed cases
    // below never reach.
    expect(info).toContain(`Migrating cdkd nested-stack tree rooted at '${STACK}'`);
    expect(info).toContain('(2 stack(s), leaf-first)');
    expect(info).toContain(`[${CHILD}]`);
    expectNothingWritten();
  });

  for (const [label, bag] of SHAPES) {
    it(`REFUSES by name when the child's resources is ${label}`, async () => {
      serveTree(bag);

      const message = await runExport([]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(message).toContain(
        `CdkdError: State for '${CHILD}' (${REGION}) has no readable 'resources' map`
      );
      expect(message).toContain(`cdkd state show '${CHILD}' --stack-region ${REGION} --json`);
      // Neither accidental refusal the named one replaced: a bare `TypeError`
      // from a bag read, or every row reported as blocked.
      expect(message).not.toContain('TypeError');
      expect(message).not.toContain('block migration');
      // The child was LOADED (the walker returned it, childless) and nothing
      // below it was asked for.
      expect(mockGetState.mock.calls.map((c) => c[0])).toEqual([STACK, CHILD]);
      expectNothingWritten();
      // The root lock the command took is released on the way out.
      expect(mockAcquireLock).toHaveBeenCalledTimes(1);
      expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    });
  }

  it('REFUSES a --dry-run too, which would otherwise print a plan over the truncated tree', async () => {
    serveTree('not-a-map');

    const message = await runExport(['--dry-run']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(message).toContain(`State for '${CHILD}' (${REGION}) has no readable 'resources' map`);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

describe('cdkd export over a ROOT record whose resources bag is unreadable (issue #3188)', () => {
  for (const [label, bag] of SHAPES) {
    it(`REFUSES by name, before the lock, when the root's resources is ${label}`, async () => {
      mockGetState.mockImplementation(async (name: string) => {
        if (name !== STACK) return null;
        const record = rootRecord();
        if (bag === ABSENT) delete record.state['resources'];
        else record.state['resources'] = bag;
        return record;
      });

      const message = await runExport([]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(message).toContain(
        `CdkdError: State for ${STACK} (${REGION}) has no readable 'resources' map`
      );
      expect(message).not.toContain('TypeError');
      expect(message).not.toContain('block migration');
      // Refused at the load: no tree walk, no lock.
      expect(mockGetState.mock.calls.map((c) => c[0])).toEqual([STACK]);
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expectNothingWritten();
    });
  }
});
