/**
 * The import plan `cdkd export` prints DIRECTLY above its destructive
 * confirmation renders each recorded identifier value with its own boundary
 * (go-to-k/cdkd#3375): a state record's `physicalId` is anyone's who can write
 * the record, and a raw one carrying a newline forged plan rows under the
 * genuine ones. Driven through `createExportCommand()` with `--dry-run`, which
 * prints the plan and the pre-delete listing and returns before any AWS write
 * — the same harness `export-non-interactive-confirm.test.ts` uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

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

// `assertCfnStackAbsent` treats a "does not exist" rejection as "free to
// create", which is the shape a real DescribeStacks returns for an absent
// stack. `ec2` is consulted by `buildImportPlan` only for rows cdkd state
// cannot answer for (issue #1791), which this fixture has none of.
//
// With `phase1Succeeds` set, a REAL run gets through phase 1: the IMPORT
// changeset creates and executes, and the stack reaches IMPORT_COMPLETE, so
// the run reaches the pre-delete of the PreDel row. Every later CFn call fails,
// which ends the run there.
const cfnState = vi.hoisted(() => ({
  phase1Succeeds: false,
  describeStacksCalls: 0,
  /** When set, phase 2 reaches ExecuteChangeSet and it fails with this text. */
  phase2ExecuteError: undefined as string | undefined,
  executeCalls: 0,
}));
const cfnSend = vi.hoisted(() =>
  vi.fn(async (cmd: { constructor: { name: string }; input?: { ChangeSetType?: string } }) => {
    const name = cmd.constructor.name;
    if (cfnState.phase1Succeeds) {
      if (name === 'DescribeStacksCommand' && cfnState.describeStacksCalls++ > 0) {
        return { Stacks: [{ StackName: 'Exported', StackStatus: 'IMPORT_COMPLETE' }] };
      }
      if (name === 'CreateChangeSetCommand' && cmd.input?.ChangeSetType === 'IMPORT') return {};
      if (
        name === 'CreateChangeSetCommand' &&
        cmd.input?.ChangeSetType === 'UPDATE' &&
        cfnState.phase2ExecuteError !== undefined
      ) {
        return {};
      }
      if (name === 'DescribeChangeSetCommand') {
        return { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE' };
      }
      if (name === 'ExecuteChangeSetCommand') {
        cfnState.executeCalls += 1;
        if (cfnState.executeCalls > 1 && cfnState.phase2ExecuteError !== undefined) {
          throw new Error(cfnState.phase2ExecuteError);
        }
        return {};
      }
    }
    throw new Error('Stack with id Exported does not exist');
  })
);

// The IAM::Policy pre-delete builds its OWN client, so the SDK package is mocked.
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
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ sts: { send: vi.fn() } })),
}));

const mockVerifyBucketExists = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockListStacks = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const mockGetState = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockLoadRollbackJournal = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockDeleteState = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockSaveState = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mockVerifyBucketExists,
    listStacks: mockListStacks,
    getState: mockGetState,
    loadRollbackJournal: mockLoadRollbackJournal,
    deleteState: mockDeleteState,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const mockGetLockInfo = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockReleaseLock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: mockGetLockInfo,
    releaseLock: mockReleaseLock,
  })),
}));

// readline: mocked so a run that reached the confirmation fails as an
// assertion here rather than hanging — `--dry-run` must return before it.
const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
const createInterfaceMock = vi.hoisted(() =>
  vi.fn(() => ({ question: readlineQuestion, close: readlineClose }))
);
vi.mock('node:readline/promises', () => ({ createInterface: createInterfaceMock }));

import { createExportCommand } from '../../../src/cli/commands/export.js';
import { cutMarker } from '../../../src/utils/display-safe.js';

const STACK = 'Exported';
const REGION = 'us-east-1';
/** The region the run is keyed on; a case overrides it to drive a withheld value. */
let region = REGION;

let tmp: string;
let templatePath: string;

/**
 * One importable S3 bucket (a phase-1 plan row) and one `AWS::IAM::Policy`
 * (a pre-delete + re-CREATE listing row). The policy's template declares no
 * `PolicyName`, so its recorded physical id — the value these cases forge —
 * is marked unconfirmed rather than compared, and the run reaches the listing
 * and the pre-delete with any id.
 */
const TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    PreDel: { Type: 'AWS::IAM::Policy', Properties: { Roles: ['BaseRole'] } },
  },
};

let bucketPhysicalId = 'my-bucket-phys';
let preDelPhysicalId = 'predel-phys';
/** Recorded detach targets of an optional `AWS::IAM::Policy` row (go-to-k/cdkd#3857). */
let policyRoles: string[] | undefined;
/** The policy row's logical id, shared by the state record and the template. */
let policyLogicalId = 'MyPolicy';

function stateRecord(): { state: Record<string, unknown>; etag: string } {
  return {
    state: {
      version: 9,
      stackName: STACK,
      region,
      resources: {
        MyBucket: {
          physicalId: bucketPhysicalId,
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
        },
        PreDel: {
          physicalId: preDelPhysicalId,
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['BaseRole'] },
          attributes: {},
          dependencies: [],
        },
        ...(policyRoles && {
          [policyLogicalId]: {
            physicalId: 'MyPolicyName',
            resourceType: 'AWS::IAM::Policy',
            properties: { PolicyName: 'MyPolicyName', Roles: policyRoles },
            attributes: {},
            dependencies: [],
          },
        }),
      },
      outputs: {},
      lastModified: 1,
    },
    etag: 'e0',
  };
}

/**
 * Run the command and return the message `handleError` printed, or
 * `undefined` when the run completed without one.
 *
 * The action is wrapped in `withErrorHandling`, which CATCHES the refusal and
 * routes it to `handleError` -> `logger.error` + `process.exit(1)`. So the
 * throw never escapes `parseAsync`, and reading the logged message (plus the
 * exit spy) is the only way to observe it from here. `formatError` renders
 * `<name>: <message>`, so the name pins that this is a `CdkdError` rather
 * than a bare `Error` -- the shape CI branches on.
 */
async function runExport(args: string[]): Promise<string | undefined> {
  const cmd = createExportCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' }).catch((e: unknown) => {
    // `process.exit` is stubbed to throw, so a handled error surfaces here.
    if (!(e instanceof Error) || e.message !== 'process.exit-mock') throw e;
  });
  const logged = errorSpy.mock.calls.map((c) => String(c[0]));
  return logged.length > 0 ? logged.join('\n') : undefined;
}

let originalIsTTY: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  bucketPhysicalId = 'my-bucket-phys';
  preDelPhysicalId = 'predel-phys';
  region = REGION;
  policyRoles = undefined;
  policyLogicalId = 'MyPolicy';
  cfnState.phase1Succeeds = false;
  cfnState.describeStacksCalls = 0;
  cfnState.phase2ExecuteError = undefined;
  cfnState.executeCalls = 0;
  iamSend.mockReset();
  tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-plan-display-'));
  templatePath = join(tmp, 'template.json');
  writeFileSync(templatePath, JSON.stringify(TEMPLATE), 'utf-8');

  mockVerifyBucketExists.mockResolvedValue(undefined);
  mockListStacks.mockResolvedValue([{ stackName: STACK, region }]);
  mockGetState.mockImplementation(async () => stateRecord());
  mockLoadRollbackJournal.mockResolvedValue(null);
  mockAcquireLock.mockResolvedValue(true);
  mockGetLockInfo.mockResolvedValue(null);
  mockReleaseLock.mockResolvedValue(undefined);
  mockDeleteState.mockResolvedValue(undefined);
  mockSaveState.mockResolvedValue('etag-1');
});

afterEach(() => {
  exitSpy.mockRestore();
  setStdinIsTty(originalIsTTY);
  rmSync(tmp, { recursive: true, force: true });
});

/** A `--dry-run` export: prints the plan, then returns before any AWS write. */
function dryRunArgs(): string[] {
  return [
    STACK,
    '--dry-run',
    '--template',
    templatePath,
    '--state-bucket',
    'test-bucket',
    '--stack-region',
    region,
    '--skip-import-support-preflight',
  ];
}


/** Every line `logger.info` printed during the run. */
function infoLines(): string[] {
  // The run returned at `--dry-run`, before the prompt and any state write.
  expect(createInterfaceMock).not.toHaveBeenCalled();
  expect(mockDeleteState).not.toHaveBeenCalled();
  expect(mockSaveState).not.toHaveBeenCalled();
  return infoSpy.mock.calls.map((c) => String(c[0]));
}

/** `orphanCommandFor`'s note for a region `displaySafe` alters (go-to-k/cdkd#3436). */
const REGION_ALT_NOTE =
  "The next line's command names neither value, because its record's region does NOT " +
  'render exactly (another record may render identically). List the records with ' +
  "'cdkd state list --json' and act on the one whose stackName and region match, replacing " +
  'each quoted hole, quotes included, with the value decoded from its JSON string, then shell-quoted.';

describe('cdkd export --dry-run renders recorded ids in the plan with their own boundary', () => {
  it('renders an ordinary record exactly as before', async () => {
    expect(await runExport(dryRunArgs())).toBeUndefined();
    const lines = infoLines();
    expect(lines).toContain('  MyBucket (AWS::S3::Bucket) ← BucketName=my-bucket-phys');
    expect(lines).toContain('  PreDel (AWS::IAM::Policy) — physicalId: predel-phys');
  });

  it('describes a `$`-prefixed pre-delete id: it is not inert on a command line (go-to-k/cdkd#4229)', async () => {
    // The maintainer's decision on go-to-k/cdkd#4229: a displayed value that is
    // not `isInertUnquoted` is described, and `$` expands when pasted bare.
    preDelPhysicalId = '$default';
    expect(await runExport(dryRunArgs())).toBeUndefined();
    expect(infoLines()).toContain(
      '  PreDel (AWS::IAM::Policy) — physicalId: (not shown: it is not a plain identifier)'
    );
  });

  it('keeps a planted newline from forging a plan row, and quotes the value', async () => {
    // A second row spelled exactly like a genuine one, and a quote to close
    // any hand-written one around the value.
    bucketPhysicalId = "my-bucket\n  Other (AWS::S3::Bucket) ← BucketName=x'";
    preDelPhysicalId = "predel\n  Forged (AWS::IAM::Policy) — physicalId: y'";

    expect(await runExport(dryRunArgs())).toBeUndefined();
    const lines = infoLines();
    // Nothing printed begins a row the record did not have.
    expect(lines.some((l) => l.includes('\n'))).toBe(false);
    const planRow = lines.find((l) => l.startsWith('  MyBucket (AWS::S3::Bucket) ← '))!;
    // One JSON literal, every non-printable-ASCII character escaped: the
    // newline and the `←` inside the VALUE are `\n` and `\u2190`, so the
    // value is recoverable and cannot start or spell a row.
    expect(planRow).toBe(
      '  MyBucket (AWS::S3::Bucket) ← BucketName=' +
        String.raw`"my-bucket\n  Other (AWS::S3::Bucket) \u2190 BucketName=x'"`
    );
    // The pre-delete row DESCRIBES a value that is not inert (go-to-k/cdkd#4229):
    // its JSON quotes would still expand `$( )` when pasted.
    const preDelRow = lines.find((l) => l.startsWith('  PreDel (AWS::IAM::Policy) — '))!;
    expect(preDelRow).toBe(
      '  PreDel (AWS::IAM::Policy) — physicalId: (not shown: it is not a plain identifier)'
    );
  });

  it('keeps two distinct non-ASCII ids distinct on the plan row', async () => {
    // A legitimate id may be UTF-8 (a CloudWatch AlarmName). An ASCII
    // allowlist would print both of these as "CPU-alarm"; the escape keeps
    // each recoverable, so the plan never shows two ids as the same text.
    const rows: string[] = [];
    for (const id of ['\u9ad8CPU-alarm', '\u4f4eCPU-alarm']) {
      infoSpy.mockClear();
      bucketPhysicalId = id;
      expect(await runExport(dryRunArgs())).toBeUndefined();
      rows.push(infoLines().find((l) => l.startsWith('  MyBucket (AWS::S3::Bucket) ← '))!);
    }
    expect(rows).toEqual([
      '  MyBucket (AWS::S3::Bucket) ← BucketName=' + String.raw`"\u9ad8CPU-alarm"`,
      '  MyBucket (AWS::S3::Bucket) ← BucketName=' + String.raw`"\u4f4eCPU-alarm"`,
    ]);
  });

  it('caps a planted multi-kilobyte id on the plan row', async () => {
    bucketPhysicalId = 'b'.repeat(5000);
    expect(await runExport(dryRunArgs())).toBeUndefined();
    const planRow = infoLines().find((l) => l.startsWith('  MyBucket (AWS::S3::Bucket) ← '))!;
    expect(planRow).toContain(cutMarker(5000 - 2048, 'b'.repeat(5000 - 2048)));
    expect(planRow).not.toContain('b'.repeat(2049));
  });
});

describe('cdkd export renders the pre-deleted policy id with its own boundary on a real run', () => {
  /** A real, confirmed run: past phase 1, into the PreDel pre-delete. */
  function realRunArgs(): string[] {
    return dryRunArgs()
      .filter((a) => a !== '--dry-run')
      .concat('--yes');
  }

  beforeEach(() => {
    cfnState.phase1Succeeds = true;
    preDelPhysicalId = "predel\n  ✓ deleted prod'";
  });

  it('prints the success line with the recorded id escaped, on one line', async () => {
    iamSend.mockResolvedValue({});
    // Phase 2 then fails against the stub; the line under test precedes it.
    await runExport(realRunArgs());
    // One DeleteRolePolicy, for the one recorded role.
    expect(iamSend).toHaveBeenCalledTimes(1);
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('  ' + String.raw`✓ deleted "predel\n  \u2713 deleted prod'"`);
  });

  it('bounds the AWS error and describes the recorded id when the pre-delete fails', async () => {
    iamSend.mockRejectedValue(new Error(`AccessDenied\nRe-run with: rm -rf ~ ${'e'.repeat(5000)}`));
    const message = await runExport(realRunArgs());
    expect(message).toBeDefined();
    expect(message).toContain(
      'physicalId: (not shown: it is not a plain identifier)) failed: AccessDenied Re-run with'
    );
    expect(message).toContain('more characters withheld]');
    expect(message).not.toContain('e'.repeat(4097));
  });

  it('describes a forged physical id in the pre-delete failure, and no pasted span runs (S2)', async () => {
    const rendered: Array<{ value: string; message: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      preDelPhysicalId = value;
      iamSend.mockRejectedValue(new Error('AccessDenied'));
      const message = await runExport(realRunArgs());
      expect(message, value).toBeDefined();
      rendered.push({ value, message: message! });
    }
    withPasteDir((dir) => {
      for (const { value, message } of rendered) {
        expect(message, value).toContain(
          'physicalId: (not shown: it is not a plain identifier)) failed:'
        );
        expect(message, value).not.toContain(value);
        expect(spansThatRun(message, dir), value).toEqual([]);
      }
    });
  }, 120_000);

  it('ends the pre-delete refusal on its orphan command, alone on a labelled line (go-to-k/cdkd#3436)', async () => {
    iamSend.mockRejectedValue(new Error('AccessDenied'));
    const message = await runExport(realRunArgs());
    expect(message).toBeDefined();
    // The sentence first, then the command LAST on a line of its own: on the
    // sentence's line an apostrophe (`cdkd's`) would flip the shell quote
    // around a shell-quoted name.
    expect(
      message!.endsWith(
        "  4. Once phase 2 succeeds, clean up cdkd's stale state record.\n" +
          `     Run: cdkd state orphan ${STACK} --stack-region ${REGION}`
      )
    ).toBe(true);
  });

  it.each([
    ['pre-delete', '4', () => iamSend.mockRejectedValue(new Error('AccessDenied'))],
    ['phase-2', '3', () => iamSend.mockResolvedValue({})],
  ])(
    'puts the gate reason BEFORE the withheld orphan command in the %s refusal (go-to-k/cdkd#3436)',
    async (_, step, arrange) => {
      // A region `displaySafe` alters (a zero-width space) is WITHHELD, so the
      // note is non-empty and has to sit before the labelled command line.
      region = 'us-east-1\u200b';
      mockListStacks.mockResolvedValue([{ stackName: STACK, region }]);
      arrange();
      const message = await runExport(realRunArgs());
      expect(message).toBeDefined();
      expect(
        message!.endsWith(
          `  ${step}. Once phase 2 succeeds, clean up cdkd's stale state record. ` +
            REGION_ALT_NOTE +
            '\n' +
            "     Run: cdkd state orphan '<stack>' --stack-region '<region>'"
        )
      ).toBe(true);
    }
  );

  it('ends the phase-2 refusal on its orphan command, alone on a labelled line (go-to-k/cdkd#3436)', async () => {
    iamSend.mockResolvedValue({});
    // Phase 2 fails against the stub once the pre-delete succeeded.
    const message = await runExport(realRunArgs());
    expect(message).toContain('phase 2 (UPDATE) failed');
    expect(
      message!.endsWith(
        "  3. Once phase 2 succeeds, clean up cdkd's stale state record.\n" +
          `     Run: cdkd state orphan ${STACK} --stack-region ${REGION}`
      )
    ).toBe(true);
  });
});

describe('cdkd export --dry-run names what an IAM::Policy pre-delete detaches (go-to-k/cdkd#3857)', () => {
  it('lists the recorded roles under the policy row, before the confirmation', async () => {
    policyRoles = ['HandlerRole', 'OtherRole'];
    writeFileSync(
      templatePath,
      JSON.stringify({
        ...TEMPLATE,
        Resources: {
          ...TEMPLATE.Resources,
          MyPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'MyPolicyName', Roles: ['HandlerRole', 'OtherRole'] },
          },
        },
      }),
      'utf-8'
    );
    expect(await runExport(dryRunArgs())).toBeUndefined();
    const lines = infoLines();
    const at = lines.indexOf('  MyPolicy (AWS::IAM::Policy) — physicalId: MyPolicyName');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe(
      '    removes inline policy MyPolicyName from roles: HandlerRole, OtherRole'
    );
  });
});

describe('cdkd export refuses an IAM::Policy whose recorded principals the template does not name (go-to-k/cdkd#3910)', () => {
  it('blocks it before the plan, with the deploy repair and a tail scoped to it', async () => {
    policyRoles = ['HandlerRole', 'AdminRole'];
    writeFileSync(
      templatePath,
      JSON.stringify({
        ...TEMPLATE,
        Resources: {
          ...TEMPLATE.Resources,
          MyPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'MyPolicyName', Roles: ['HandlerRole'] },
          },
        },
      }),
      'utf-8'
    );
    const message = await runExport(dryRunArgs());
    expect(message).toContain(
      'its record removes the policy from role AdminRole, which the template does not name'
    );
    expect(message).toContain("Run each row's 'Repair with:' command, then re-run cdkd export.");
    expect(message).not.toContain('Either destroy them first');
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The app stack, and the diff that shows the same detach FIRST.
    expect(logged).toContain('Check first with: cdkd diff Exported\nRepair with: cdkd deploy Exported');
    // Stopped before any plan row or confirmation.
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });
});

describe('a failed IAM::Policy pre-delete names the IAM by-hand delete (go-to-k/cdkd#3910)', () => {
  /** PreDel's pre-delete succeeds; MyPolicy's, which runs after it, fails. */
  function failOnlyMyPolicy(): void {
    iamSend.mockImplementation(async (cmd) => {
      if ((cmd as { input: { PolicyName?: string } }).input.PolicyName === 'MyPolicyName') {
        throw new Error('AccessDenied');
      }
      return {};
    });
  }

  it('gives a recovery line per principal kind present', async () => {
    cfnState.phase1Succeeds = true;
    failOnlyMyPolicy();
    policyRoles = ['HandlerRole'];
    writeFileSync(
      templatePath,
      JSON.stringify({
        ...TEMPLATE,
        Resources: {
          ...TEMPLATE.Resources,
          MyPolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'MyPolicyName', Roles: ['HandlerRole'] },
          },
        },
      }),
      'utf-8'
    );
    const message = await runExport(
      dryRunArgs()
        .filter((a) => a !== '--dry-run')
        .concat('--yes')
    );
    expect(message).toContain('pre-delete of MyPolicy');
    // Once per principal KIND, however many policies record one.
    expect(
      message!.split("aws iam delete-role-policy --role-name '<RoleName>' --policy-name '<PolicyName>'")
    ).toHaveLength(2);
    expect(message).not.toContain('apigatewayv2');
  });
  it('describes a forging logical id in the failure head (go-to-k/cdkd#4245 review)', async () => {
    cfnState.phase1Succeeds = true;
    failOnlyMyPolicy();
    policyRoles = ['HandlerRole'];
    policyLogicalId = "Handler Policy'x";
    writeFileSync(
      templatePath,
      JSON.stringify({
        ...TEMPLATE,
        Resources: {
          ...TEMPLATE.Resources,
          [policyLogicalId]: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'MyPolicyName', Roles: ['HandlerRole'] },
          },
        },
      }),
      'utf-8'
    );
    const message = await runExport(
      dryRunArgs()
        .filter((a) => a !== '--dry-run')
        .concat('--yes')
    );
    // Described, not displayed (`plainOrNotShown`): the message carries the
    // recovery commands, and behind an operator's unpaired quote a
    // shell-quoted JSON display runs its `$( )`.
    expect(message).toContain(
      'pre-delete of (not shown: it is not a plain identifier) (AWS::IAM::Policy,'
    );
    expect(message).not.toContain(policyLogicalId);
  });
});

describe('a failed single-stack phase 2 renders AWS text folded and bounded (go-to-k/cdkd#3910)', () => {
  it('through displayAwsMessage, since executeUpdateChangeSet rethrows ExecuteChangeSet bare', async () => {
    cfnState.phase1Succeeds = true;
    cfnState.phase2ExecuteError = `quoted\nRe-run with: rm -rf ~ ${'e'.repeat(6000)}`;
    iamSend.mockResolvedValue({});
    const message = await runExport(
      dryRunArgs()
        .filter((a) => a !== '--dry-run')
        .concat('--yes')
    );
    expect(message).toContain('phase 2 (UPDATE) failed: quoted Re-run with: rm -rf ~');
    expect(message).not.toMatch(/\nRe-run with: rm -rf/);
    expect(message).toMatch(/\[cut: \d+ more characters withheld\]/);
    expect(message).not.toContain('e'.repeat(4097));
  });
});

describe('the single-stack path wires --parameter into the IAM::Policy check', () => {
  function writeTemplate(policy: Record<string, unknown>, parameters?: Record<string, unknown>): void {
    writeFileSync(
      templatePath,
      JSON.stringify({
        ...TEMPLATE,
        ...(parameters && { Parameters: parameters }),
        Resources: {
          ...TEMPLATE.Resources,
          MyPolicy: { Type: 'AWS::IAM::Policy', Properties: policy },
        },
      }),
      'utf-8'
    );
  }

  it('only marks an unconfirmed principal, with and without --yes', async () => {
    policyRoles = ['CrossStackRole'];
    writeTemplate({ PolicyName: 'MyPolicyName', Roles: [{ 'Fn::ImportValue': 'Shared' }] });
    const MARK_LINE =
      '    phase 2 cannot be confirmed to re-attach it to role CrossStackRole: the template ' +
      'names its principals through a value cdkd cannot resolve';
    expect(await runExport(dryRunArgs().concat('--yes'))).toBeUndefined();
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContain(MARK_LINE);
    infoSpy.mockClear();
    expect(await runExport(dryRunArgs())).toBeUndefined();
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContain(MARK_LINE);
  });

  it('checks a principal given as a root Parameter from --parameter, so an extra one blocks', async () => {
    policyRoles = ['RoleA', 'AdminRole'];
    writeTemplate(
      { PolicyName: 'MyPolicyName', Roles: [{ Ref: 'RoleParam' }] },
      { RoleParam: { Type: 'String' } }
    );
    const message = await runExport(dryRunArgs().concat('--parameter', 'RoleParam=RoleA'));
    expect(message).toContain('role AdminRole, which the template does not name');
    // The root's values are --parameter values, so a wrong one is named too.
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('re-run the export with the --parameter values the stack was deployed with');
  });

  it('does not read an SSM-typed root Parameter default as the principal name', async () => {
    policyRoles = ['RealRole'];
    writeTemplate(
      { PolicyName: 'MyPolicyName', Roles: [{ Ref: 'RoleParam' }] },
      { RoleParam: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/role-name' } }
    );
    // Marked (not a false "not named" block), so a reviewed run proceeds.
    expect(await runExport(dryRunArgs())).toBeUndefined();
  });
});
