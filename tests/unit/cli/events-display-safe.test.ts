import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#2438](https://github.com/go-to-k/cdkd/issues/2438): `cdkd events`
 * renders stored, provider- and template-authored text. `JSON.stringify`
 * escapes control bytes on the way INTO `deployments/{runId}.jsonl`, so the
 * store is well-formed — but the reader is a plain `JSON.parse` that restores
 * the original bytes, and the renderer used to print them verbatim. An
 * escape sequence reaching a physical name (frequently user-chosen) or a
 * provider `reason` therefore re-forged the terminal of the one command whose
 * whole purpose is to be believed after a run.
 *
 * The fixtures below use the ACTUAL feared shapes rather than a stand-in: a
 * CSI erase-line (`ESC [ 2 K`, which blanks the line it lands on), an SGR
 * colour set (`ESC [ 1 ; 3 1 m`, which repaints the rest of the row), and a
 * bare carriage return (which returns the cursor so following text overwrites
 * what was already printed). None of the three is a sequence cdkd itself
 * emits — `src/utils/colors.ts` emits only `ESC [ 0/1/2/31/32/33/34/36/90 m`
 * — so asserting their ABSENCE in the raw output cannot be satisfied by
 * cdkd's own colouring, and the assertions run on the RAW string with no
 * ANSI-stripping step that could hide them.
 *
 * Both polarities are pinned. A one-sided fence rewards the inverse
 * regression, so alongside every neutralisation case there is an exact-match
 * assertion that an ORDINARY row — including legitimately non-ASCII prose —
 * still renders byte-for-byte as it did before, which is what stops the fix
 * from being widened into `asciiOnly` on a field where that would mangle real
 * AWS error text.
 */

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
  reserveStdoutForPayload: vi.fn(),
  releaseStdoutForPayload: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

// Captures the PROMPT STRING rather than answering it. The prune confirmation
// is the one sentence the operator types `y` to, so a forged line there is
// worse than one inside an error -- and a non-TTY `confirmOrRefuse` throws
// before the prompt reaches any sink, so it cannot be observed any other way.
const confirmSpy = vi.hoisted(() =>
  // Typed from the REAL export rather than hand-copied: an argless `vi.fn()`
  // gives `mock.calls` the type `[]`, so reading the prompt back would not
  // type-check — and a hand-written signature silently drifts from
  // `ConfirmOrRefuseOptions` (round 2 review: it had already dropped
  // `output?`).
  vi.fn<typeof import('../../../src/cli/commands/confirm-prompt.js').confirmOrRefuse>(
    async () => false
  )
);
vi.mock('../../../src/cli/commands/confirm-prompt.js', async (importOriginal) => ({
  // Spread the real module so the constants stay the REAL constants — the
  // previous hand-spelled `DEFAULT_CONFIRM_SUFFIX` was a copy nothing
  // asserted on and could drift from its source.
  ...(await importOriginal<
    typeof import('../../../src/cli/commands/confirm-prompt.js')
  >()),
  confirmOrRefuse: confirmSpy,
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockVerifyBucketExists = vi.fn<() => Promise<void>>(async () => {});
const mockListRawKeys = vi.fn<(prefix: string) => Promise<string[]>>();
const mockGetRawObject = vi.fn<(key: string) => Promise<string | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    prefix: 'cdkd',
    verifyBucketExists: mockVerifyBucketExists,
    listRawKeys: mockListRawKeys,
    getRawObject: mockGetRawObject,
  })),
}));

import {
  colorizeEventType,
  createEventsCommand,
  createEventsPruneCommand,
  eventsCommand,
  eventsPruneCommand,
  printRunEvents,
} from '../../../src/cli/commands/events.js';
import { bold, cyan, gray, green, red, yellow } from '../../../src/utils/colors.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

/** A CSI erase-line: blanks the line the cursor is on. */
const CSI_ERASE_LINE = '\u001b[2K';
/** An SGR set: repaints everything after it until the next reset. */
const SGR_BRIGHT_RED = '\u001b[1;31m';
/** A bare CR: returns the cursor so later text overwrites what was printed. */
const CR = '\r';

/** Every rendered line, joined — deliberately WITHOUT stripping ANSI. */
const rawOutput = (): string => infoSpy.mock.calls.map((c) => String(c[0])).join('\n');

describe('cdkd events neutralises control bytes in stored text (issue #2438)', () => {
  beforeEach(() => {
    infoSpy.mockReset();
  });

  it('strips the escapes an attacker-influenced reason and identifier carry', () => {
    printRunEvents('TestStack', 'us-east-1', `run-1${CSI_ERASE_LINE}`, [
      {
        timestamp: `2026-01-01T00:00:00.000Z${CR}`,
        eventType: 'RESOURCE_SKIPPED',
        stackName: 'TestStack',
        operation: `DELETE${CSI_ERASE_LINE}` as DeploymentEvent['operation'],
        logicalId: `Bucket${CSI_ERASE_LINE}`,
        resourceType: `AWS::S3::Bucket${SGR_BRIGHT_RED}`,
        provisionedBy: `cc-api${CR}` as DeploymentEvent['provisionedBy'],
        guard: `cc-delete-region-identity${CSI_ERASE_LINE}`,
        reason: `s3:GetBucketLocation on my${CSI_ERASE_LINE}bucket denied${CR}DEPLOY SUCCEEDED`,
      },
    ]);

    const out = rawOutput();
    // The feared shapes themselves, not a stand-in.
    expect(out).not.toContain(CSI_ERASE_LINE);
    expect(out).not.toContain(SGR_BRIGHT_RED);
    expect(out).not.toContain(CR);
    // CONTENT, not presence: the exact neutralised text, so a change that
    // dropped the field entirely (or swapped in a different transform) fails
    // rather than passing on an unrelated substring.
    expect(out).toContain('my [2Kbucket denied DEPLOY SUCCEEDED');
    expect(out).toContain('Bucket [2K (AWS::S3::Bucket [1;31m)');
    expect(out).toContain('guard=cc-delete-region-identity [2K');
    expect(out).toContain('run-1 [2K');
  });

  it('strips them from the error block too', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RESOURCE_FAILED',
        stackName: 'TestStack',
        logicalId: 'Bucket',
        error: {
          name: `AccessDenied${CR}`,
          message: `bucket my${CSI_ERASE_LINE}bucket is not empty`,
          awsErrorCode: `AccessDeniedException${CSI_ERASE_LINE}`,
          requestId: `abc-123${SGR_BRIGHT_RED}`,
        },
      },
    ]);

    const out = rawOutput();
    expect(out).not.toContain(CSI_ERASE_LINE);
    expect(out).not.toContain(SGR_BRIGHT_RED);
    expect(out).not.toContain(CR);
    expect(out).toContain('bucket my [2Kbucket is not empty');
    expect(out).toContain('(AccessDeniedException [2K)');
    expect(out).toContain('requestId=abc-123 [1;31m');
  });

  it('strips them from the run-level columns', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RUN_FINISHED',
        stackName: 'TestStack',
        command: `deploy${CSI_ERASE_LINE}` as DeploymentEvent['command'],
        region: `us-east-1${CR}`,
        cdkdVersion: `0.286.0${CSI_ERASE_LINE}`,
        result: `SUCCEEDED${CSI_ERASE_LINE}` as DeploymentEvent['result'],
      },
    ]);

    const out = rawOutput();
    expect(out).not.toContain(CSI_ERASE_LINE);
    expect(out).not.toContain(CR);
    expect(out).toContain('cdkd 0.286.0 [2K');
    // A forged result is not the result: a token carrying the escape
    // sanitises to something that is NOT `SUCCEEDED`, so it must not steal
    // the green that certifies a run.
    expect(out).toContain(red('SUCCEEDED [2K'));
    expect(out).not.toContain(green('SUCCEEDED'));
  });

  it('renders a forged counter as ? rather than as its text', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RUN_FINISHED',
        stackName: 'TestStack',
        counts: {
          // Every counter, not just `created`: the first four were driven with
          // real numbers, so removing `safeCount` from `updated` / `deleted` /
          // `failed` / `skipped` rendered identically and no case failed.
          created: `1${CSI_ERASE_LINE}` as unknown as number,
          updated: `2${CSI_ERASE_LINE}` as unknown as number,
          deleted: `3${CSI_ERASE_LINE}` as unknown as number,
          failed: `4${CSI_ERASE_LINE}` as unknown as number,
          skipped: `5${CSI_ERASE_LINE}` as unknown as number,
        },
      },
    ]);

    const out = rawOutput();
    expect(out).not.toContain(CSI_ERASE_LINE);
    // Not merely stripped — a counter that is not a number is not renderable
    // as one, so its digits must not survive either.
    expect(out).toContain('+?/~?/-? !? ⚠?');
    expect(out).not.toContain('+1');
    expect(out).not.toContain('~2');
    expect(out).not.toContain('-3');
    expect(out).not.toContain('!4');
    expect(out).not.toContain('⚠5');
  });

  it('classifies AND colours the sanitised event type, so the two agree', () => {
    // Sanitising the token but classifying the raw one would let a row print
    // one thing and be coloured as another.
    expect(colorizeEventType(`RESOURCE_SKIPPED${CSI_ERASE_LINE}` as DeploymentEvent['eventType']))
      .toBe(cyan('RESOURCE_SKIPPED [2K'));
    expect(
      colorizeEventType(`RESOURCE_SKIPPED${CSI_ERASE_LINE}` as DeploymentEvent['eventType'])
    ).not.toContain(CSI_ERASE_LINE);
  });
});

describe('cdkd events leaves ORDINARY text untouched (issue #2438)', () => {
  beforeEach(() => {
    infoSpy.mockReset();
  });

  /**
   * The inverse fence. Byte-for-byte, because "contains the name somewhere"
   * would still pass if a column were dropped or the layout shifted — and the
   * non-ASCII prose is what stops `reason` / `error.message` from being
   * widened to the `asciiOnly` allowlist, which would silently mangle real
   * AWS error text.
   */
  it('renders a benign event exactly as before, non-ASCII prose included', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RESOURCE_SKIPPED',
        stackName: 'TestStack',
        operation: 'DELETE',
        logicalId: 'Bucket',
        resourceType: 'AWS::S3::Bucket',
        provisionedBy: 'cc-api',
        guard: 'cc-delete-region-identity',
        reason: 'delete skipped — bucket «my-café» is not empty',
      },
    ]);

    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe(
      `${bold('Events for run')} ${cyan('run-1')} ${gray('(TestStack, us-east-1)')}`
    );
    expect(lines[1]).toBe(
      `  ${gray('2026-01-01T00:00:00.000Z')}  ${yellow('RESOURCE_SKIPPED')}  ` +
        `Bucket (AWS::S3::Bucket)  ${gray('DELETE')}  ` +
        `${gray('guard=cc-delete-region-identity')}  ${gray('[cc-api]')}`
    );
    expect(lines[2]).toBe(`      ${yellow('delete skipped — bucket «my-café» is not empty')}`);
  });

  it('keeps a benign error block, its non-ASCII message, and the green result', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RESOURCE_FAILED',
        stackName: 'TestStack',
        logicalId: 'Bucket',
        error: {
          name: 'AccessDenied',
          message: 'bucket «my-café» is not empty',
          awsErrorCode: 'AccessDeniedException',
          requestId: 'abc-123',
        },
      },
      {
        timestamp: '2026-01-01T00:01:00.000Z',
        eventType: 'RUN_FINISHED',
        stackName: 'TestStack',
        result: 'SUCCEEDED',
        durationMs: 1200,
        counts: { created: 1, updated: 0, deleted: 2, failed: 3, skipped: 4 },
      },
    ]);

    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines[2]).toBe(
      `      ${red('AccessDenied (AccessDeniedException): bucket «my-café» is not empty')}` +
        `${gray(' requestId=abc-123')}`
    );
    expect(lines[3]).toBe(
      `  ${gray('2026-01-01T00:01:00.000Z')}  ${green('RUN_FINISHED')}  ${green('SUCCEEDED')}  ` +
        `${gray('1200ms')}  ${gray('+1/~0/-2 !3 ⚠4')}`
    );
  });

  it('leaves every declared event type colouring unchanged', () => {
    expect(colorizeEventType('RESOURCE_SKIPPED')).toBe(yellow('RESOURCE_SKIPPED'));
    expect(colorizeEventType('RESOURCE_GUARD_INDETERMINATE')).toBe(
      yellow('RESOURCE_GUARD_INDETERMINATE')
    );
    expect(colorizeEventType('ROLLBACK_STARTED')).toBe(yellow('ROLLBACK_STARTED'));
    expect(colorizeEventType('RESOURCE_FAILED')).toBe(red('RESOURCE_FAILED'));
    expect(colorizeEventType('RESOURCE_SUCCEEDED')).toBe(green('RESOURCE_SUCCEEDED'));
    expect(colorizeEventType('RUN_FINISHED')).toBe(green('RUN_FINISHED'));
    expect(colorizeEventType('RESOURCE_STARTED')).toBe(cyan('RESOURCE_STARTED'));
    expect(colorizeEventType('RESOURCE_RETAINED')).toBe(cyan('RESOURCE_RETAINED'));
  });
});

const INDEX_KEY = 'cdkd/TestStack/us-east-1/deployments/index.json';
const RUN_ID = '20260101T000000-abc';
const RUN_KEY = `cdkd/TestStack/us-east-1/deployments/${RUN_ID}.jsonl`;

const POISONED_REASON = `s3:GetBucketLocation on my${CSI_ERASE_LINE}bucket denied${CR}OK`;

function scriptBackend(indexRun: Record<string, unknown>): void {
  mockListRawKeys.mockImplementation(async (prefix: string) =>
    [INDEX_KEY, RUN_KEY].filter((k) => k.startsWith(prefix))
  );
  mockGetRawObject.mockImplementation(async (key: string) => {
    if (key === INDEX_KEY) return JSON.stringify({ runs: [indexRun] });
    if (key === RUN_KEY) {
      return JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RESOURCE_SKIPPED',
        stackName: 'TestStack',
        logicalId: 'Bucket',
        reason: POISONED_REASON,
      });
    }
    return null;
  });
}

async function runEvents(args: string[]): Promise<string> {
  const out: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const cmd = createEventsCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    process.stdout.write = origOut;
  }
  return out.join('');
}

describe('the run LISTING is sanitised and the --json payload is not (issue #2438)', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    mockListRawKeys.mockReset();
    mockGetRawObject.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockImplementation(async () => {});
  });

  it('neutralises every stored column of the human run listing', async () => {
    scriptBackend({
      runId: `${RUN_ID}${CSI_ERASE_LINE}`,
      command: `deploy${CR}`,
      cdkdVersion: `0.286.0${CSI_ERASE_LINE}`,
      startedAt: `2026-01-01T00:00:00.000Z${CR}`,
      finishedAt: `2026-01-01T00:01:00.000Z${SGR_BRIGHT_RED}`,
      result: 'SUCCEEDED',
      eventCount: `2${CSI_ERASE_LINE}`,
    });

    await runEvents(['TestStack']);

    const out = rawOutput();
    expect(out).not.toContain(CSI_ERASE_LINE);
    expect(out).not.toContain(SGR_BRIGHT_RED);
    expect(out).not.toContain(CR);
    expect(out).toContain(`${RUN_ID} [2K`);
    expect(out).toContain('cdkd 0.286.0 [2K');
    expect(out).toContain('2026-01-01T00:01:00.000Z [1;31m');
    // A forged non-numeric event count is not renderable as a count.
    expect(out).toContain('? events');
  });

  /**
   * The `--json` payload is DELIBERATELY not sanitised: it is machine-consumed
   * and a substitution inside a value would corrupt what tooling reads back.
   * The escaping that path needs is `JSON.stringify`'s own — every C0 control
   * (ESC / CSI / CR, i.e. the actual line-forging mechanisms) is emitted in
   * escaped form -- a MIX of the two-character `\\r` / `\\n` family and
   * six-character `\\u00XX` (ESC among them), never one single form -- so a
   * human paging the payload sees the sequence spelled out rather than
   * executed.
   *
   * Both halves are asserted, and the second is the load-bearing one: the
   * feared widening is a sanitising pass over the event VALUES before they are
   * serialised, which leaves the first assertion satisfied (the escaped text
   * is still absent-of-raw-ESC) while silently changing what tooling reads
   * back. Measured: wrapping `reason` in `safeText` before `JSON.stringify`
   * reds this case; `displaySafe` applied to the already-serialised document
   * does NOT, because a JSON document holds no raw control bytes to strip.
   */
  it('leaves the --json payload byte-identical to the store', async () => {
    scriptBackend({
      runId: RUN_ID,
      command: 'deploy',
      cdkdVersion: '0.286.0',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      result: 'SUCCEEDED',
      eventCount: 1,
    });

    const stdout = await runEvents(['TestStack', '--run', RUN_ID, '--json']);

    // Escaped on the wire, so nothing executes in a terminal ...
    expect(stdout).not.toContain(CSI_ERASE_LINE);
    expect(stdout).not.toContain(CR);
    expect(stdout).toContain('\\u001b[2K');
    // ... while a consumer still parses back the ORIGINAL bytes.
    const events = JSON.parse(stdout) as DeploymentEvent[];
    expect(events[0]?.reason).toBe(POISONED_REASON);
  });
});

/**
 * The `|| UNRENDERABLE` arm, which the first round of this suite left with
 * ZERO coverage across ~25 sites (test review of PR #2644). It is not
 * cosmetic: this renderer is `  `-delimited, so a value that sanitises to
 * NOTHING and renders as an empty string collapses its column and shifts
 * every column after it — and an empty id reads as "cdkd recorded no id",
 * which is a different and false statement from "cdkd recorded something
 * unrenderable".
 *
 * The fixture is a string of nothing but control bytes: both `displaySafe`
 * modes map each to a space and then `.trim()` the result away, so the helper
 * returns `''` while the source field was truthy — the exact condition the
 * fallback exists for, and one no benign fixture can reach.
 */
describe('a value that sanitises to nothing renders <unrenderable> (issue #2438)', () => {
  // Control bytes ONLY. `CSI_ERASE_LINE` is NOT usable here: its `[2K` tail
  // is printable ASCII and survives sanitising, so the helper returns a
  // non-empty string and the fallback never fires -- the arm would go
  // untested while the case looked covered.
  const ALL_CONTROL = '\u001b\u0007\r';

  beforeEach(() => {
    infoSpy.mockReset();
  });

  it('falls back on every per-event column rather than collapsing it', () => {
    printRunEvents('TestStack', 'us-east-1', ALL_CONTROL, [
      {
        timestamp: ALL_CONTROL,
        eventType: 'RESOURCE_SKIPPED',
        stackName: 'TestStack',
        operation: ALL_CONTROL as DeploymentEvent['operation'],
        logicalId: ALL_CONTROL,
        resourceType: ALL_CONTROL,
        provisionedBy: ALL_CONTROL as DeploymentEvent['provisionedBy'],
        guard: ALL_CONTROL,
        reason: ALL_CONTROL,
      },
    ]);

    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe(
      `${bold('Events for run')} ${cyan('<unrenderable>')} ${gray('(TestStack, us-east-1)')}`
    );
    expect(lines[1]).toBe(
      `  ${gray('<unrenderable>')}  ${yellow('RESOURCE_SKIPPED')}  ` +
        `<unrenderable> (<unrenderable>)  ${gray('<unrenderable>')}  ` +
        `${gray('guard=<unrenderable>')}  ${gray('[<unrenderable>]')}`
    );
    expect(lines[2]).toBe(`      ${yellow('<unrenderable>')}`);
  });

  it('falls back on the run-level columns and the error block', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RUN_FINISHED',
        stackName: 'TestStack',
        command: ALL_CONTROL as DeploymentEvent['command'],
        region: ALL_CONTROL,
        cdkdVersion: ALL_CONTROL,
        result: ALL_CONTROL as DeploymentEvent['result'],
        error: {
          name: ALL_CONTROL,
          message: ALL_CONTROL,
          awsErrorCode: ALL_CONTROL,
          requestId: ALL_CONTROL,
        },
      },
    ]);

    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines[1]).toBe(
      `  ${gray('2026-01-01T00:00:00.000Z')}  ${green('RUN_FINISHED')}  ` +
        `${gray('<unrenderable>')}  ${gray('<unrenderable>')}  ` +
        `${gray('cdkd <unrenderable>')}  ${gray('<unrenderable>')}`
    );
    // The result column is NEUTRAL, matching the run listing's arm for the
    // same field. Red would assert a failure about a result cdkd could not
    // read, and the two views would disagree about one value.
    expect(lines[1]).not.toContain(red('<unrenderable>'));
    // A missing message used to render a dangling `Name (Code): ` — reachable
    // with no forgery at all, since `extractDeploymentEventError` defaults
    // `name` but not `message`.
    expect(lines[2]).toBe(
      `      ${red('<unrenderable> (<unrenderable>): <unrenderable>')}` +
        `${gray(' requestId=<unrenderable>')}`
    );
  });

  /**
   * The INVERSE, and this assertion is deliberately the opposite of the one
   * the previous round wrote. That round asserted `Error: <unrenderable>` for
   * a plain `new Error()` — pinning a defect rather than a contract:
   * `extractDeploymentEventError` defaults `name` but not `message`, so the
   * commonest possible error rendered a claim that a hostile value had been
   * suppressed when nothing had been written at all.
   *
   * `<unrenderable>` is a statement about the INPUT, so the two empties must
   * not collapse. The mutation the old assertion could not catch: rendering
   * `<unrenderable>` for a field that was never populated, which is
   * indistinguishable from the forged case it exists to announce.
   */
  it('says nothing about a message that was never written', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RESOURCE_FAILED',
        stackName: 'TestStack',
        logicalId: 'Bucket',
        error: { name: 'Error', message: '' },
      },
    ]);

    const line = infoSpy.mock.calls.map((c) => String(c[0]))[2];
    // No dangling separator either — the defect the previous round fixed.
    expect(line).toBe(`      ${red('Error')}`);
    expect(line).not.toContain('<unrenderable>');
  });

  it('still says <unrenderable> when a message WAS written and was consumed', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RESOURCE_FAILED',
        stackName: 'TestStack',
        logicalId: 'Bucket',
        error: { name: 'Error', message: ALL_CONTROL },
      },
    ]);

    expect(infoSpy.mock.calls.map((c) => String(c[0]))[2]).toBe(
      `      ${red('Error: <unrenderable>')}`
    );
  });
});

/**
 * The three columns the first round rendered but never pinned byte-exactly
 * (`command` / `region` / `cdkdVersion`), so dropping or reordering one of
 * them would have passed. `RUN_STARTED` is the row that carries all three.
 */
describe('the run-level columns keep their exact benign rendering (issue #2438)', () => {
  beforeEach(() => {
    infoSpy.mockReset();
  });

  it('renders command, region and version in order, unchanged', () => {
    printRunEvents('TestStack', 'us-east-1', 'run-1', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RUN_STARTED',
        stackName: 'TestStack',
        command: 'deploy',
        region: 'us-east-1',
        cdkdVersion: '0.286.3',
      },
    ]);

    expect(infoSpy.mock.calls.map((c) => String(c[0]))[1]).toBe(
      `  ${gray('2026-01-01T00:00:00.000Z')}  ${cyan('RUN_STARTED')}  ` +
        `${gray('deploy')}  ${gray('us-east-1')}  ${gray('cdkd 0.286.3')}`
    );
  });
});

/**
 * The eight sites the first round executed only with BENIGN values — the
 * three `EVENTS_*` errors and the two hoisted `events prune` values — so
 * deleting `safeId` from any of them would not have failed a test (test
 * review of PR #2644).
 *
 * These are worth their own cases rather than folding into the renderer's:
 * an error message is printed by the error handler and a PROMPT is the
 * sentence an operator types `y` to, so a forged line in either is at least
 * as bad as one in a row of output. `regions` in particular is derived from a
 * raw S3 key LISTING, so its entries are stored text and not values cdkd
 * chose.
 */
describe('the error and prompt paths sanitise too (issue #2438)', () => {
  const POISONED_STACK = `TestStack${CSI_ERASE_LINE}`;
  const stateOpts = { stateBucket: 'test-bucket', region: 'us-east-1', statePrefix: 'cdkd' };

  beforeEach(() => {
    infoSpy.mockReset();
    confirmSpy.mockClear();
    mockListRawKeys.mockReset();
    mockGetRawObject.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockImplementation(async () => {});
  });

  it('neutralises the stack name in EVENTS_NOT_FOUND', async () => {
    mockListRawKeys.mockImplementation(async () => []);

    const err = await eventsCommand(POISONED_STACK, { ...stateOpts }).catch((e: unknown) => e);
    const message = String((err as Error).message);
    expect(message).not.toContain(CSI_ERASE_LINE);
    expect(message).toContain("stack 'TestStack [2K'");
  });

  it('neutralises every region in EVENTS_REGION_AMBIGUOUS', async () => {
    // The second region is a raw KEY SEGMENT carrying the escape — the case
    // the call site's comment names, and one only a key listing can produce.
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/${POISONED_STACK}/us-east-1/deployments/index.json`,
      `cdkd/${POISONED_STACK}/eu-west-1${CSI_ERASE_LINE}/deployments/index.json`,
    ]);

    const err = await eventsCommand(POISONED_STACK, { ...stateOpts }).catch((e: unknown) => e);
    const message = String((err as Error).message);
    expect(message).not.toContain(CSI_ERASE_LINE);
    expect(message).toContain("Stack 'TestStack [2K'");
    expect(message).toContain('multiple regions: eu-west-1 [2K, us-east-1.');
  });

  it('neutralises the run id, stack and region in EVENTS_RUN_NOT_FOUND', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/${POISONED_STACK}/us-east-1/deployments/index.json`,
    ]);
    mockGetRawObject.mockImplementation(async () => null);

    const err = await eventsCommand(POISONED_STACK, {
      ...stateOpts,
      run: `run-1${CSI_ERASE_LINE}`,
    }).catch((e: unknown) => e);
    const message = String((err as Error).message);
    expect(message).not.toContain(CSI_ERASE_LINE);
    expect(message).toContain("run 'run-1 [2K'");
    expect(message).toContain("stack 'TestStack [2K'");
  });

  it('neutralises the prune confirmation prompt, which is what the operator answers', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/${POISONED_STACK}/us-east-1${CSI_ERASE_LINE}/deployments/index.json`,
    ]);
    mockGetRawObject.mockImplementation(async () => JSON.stringify({ runs: [] }));

    // `--older-than` reaches the prompt through the `scope` clause, and
    // `parseDuration` anchors on `value.trim()` — which strips CR — so this
    // spelling VALIDATES and used to be interpolated raw.
    await eventsPruneCommand(POISONED_STACK, { ...stateOpts, olderThan: `${CR}24h` });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = String(confirmSpy.mock.calls[0]?.[0]);
    expect(prompt).not.toContain(CSI_ERASE_LINE);
    expect(prompt).not.toContain(CR);
    expect(prompt).toContain('TestStack [2K');
    expect(prompt).toContain('us-east-1 [2K');
    expect(prompt).toContain('runs older than 24h');
  });
});

/**
 * `printRunList` is not exported, so these drive it through the command. The
 * first round asserted it only with `toContain`, which cannot see a column
 * being dropped or reordered — and it left the copy-pasteable FOOTER
 * unasserted entirely, which is the highest-value target on the page since
 * the user pastes it into a shell.
 */
describe('the run listing keeps its exact benign layout (issue #2438)', () => {
  const BENIGN_RUN = {
    runId: RUN_ID,
    command: 'deploy',
    cdkdVersion: '0.286.3',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    result: 'SUCCEEDED',
    eventCount: 4,
  };

  beforeEach(() => {
    infoSpy.mockReset();
    mockListRawKeys.mockReset();
    mockGetRawObject.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockImplementation(async () => {});
  });

  it('renders header, row and footer byte-for-byte', async () => {
    scriptBackend(BENIGN_RUN);
    await runEvents(['TestStack']);

    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe(
      `${bold('Deployment runs for')} ${cyan('TestStack')} ${gray('(us-east-1)')}`
    );
    expect(lines[1]).toBe(
      `  ${cyan(RUN_ID)}  deploy  ${green('SUCCEEDED')}  ` +
        `${gray('2026-01-01T00:00:00.000Z')} -> ${gray('2026-01-01T00:01:00.000Z')}  ` +
        `${gray('cdkd 0.286.3')}  ${gray('4 events')}`
    );
    expect(lines[2]).toBe(
      gray(`\nUse 'cdkd events TestStack --run <runId>' to read one run's events.`)
    );
  });

  it('neutralises the stack name inside the copy-pasteable footer', async () => {
    // Scripted under the POISONED prefix: region discovery walks the raw key
    // listing for `cdkd/<stackName>/`, so keys spelled with the benign name
    // would make this resolve to zero regions and assert nothing.
    const poisoned = `TestStack${CSI_ERASE_LINE}`;
    mockListRawKeys.mockImplementation(async (prefix: string) =>
      [`cdkd/${poisoned}/us-east-1/deployments/index.json`].filter((k) => k.startsWith(prefix))
    );
    mockGetRawObject.mockImplementation(async () => JSON.stringify({ runs: [BENIGN_RUN] }));

    await eventsCommand(poisoned, {
      stateBucket: 'test-bucket',
      region: 'us-east-1',
      statePrefix: 'cdkd',
    });

    const out = rawOutput();
    expect(out).not.toContain(CSI_ERASE_LINE);
    expect(out).toContain("Use 'cdkd events TestStack [2K --run <runId>'");
  });
});

/**
 * Two `--json` gaps the first round left. The document-level one matters
 * because the first round's fence is satisfied by ANY transform that leaves
 * the escaped text intact — including `displaySafe` over the whole serialised
 * document, which silently flattens the pretty-printing every consumer of a
 * `--json` payload sees. The run-LISTING branch carries the same
 * "deliberately unsanitised" comment as the `--run` branch and had no fence
 * at all.
 */
describe('--json stays byte-identical AND stays pretty-printed (issue #2438)', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    mockListRawKeys.mockReset();
    mockGetRawObject.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockImplementation(async () => {});
  });

  it('keeps the 2-space indentation of the --run payload', async () => {
    scriptBackend({
      runId: RUN_ID,
      command: 'deploy',
      cdkdVersion: '0.286.3',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      result: 'SUCCEEDED',
      eventCount: 1,
    });

    const stdout = await runEvents(['TestStack', '--run', RUN_ID, '--json']);
    expect(stdout).toContain('\n    "reason":');
    expect(stdout.split('\n').length).toBeGreaterThan(5);
  });

  it('leaves the run-LISTING payload byte-identical to the store too', async () => {
    scriptBackend({
      runId: `${RUN_ID}${CSI_ERASE_LINE}`,
      command: 'deploy',
      cdkdVersion: '0.286.3',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      result: 'SUCCEEDED',
      eventCount: 1,
    });

    const stdout = await runEvents(['TestStack', '--json']);
    expect(stdout).not.toContain(CSI_ERASE_LINE);
    expect(stdout).toContain('\\u001b[2K');
    const payload = JSON.parse(stdout) as { runs: Array<{ runId: string }> };
    expect(payload.runs[0]?.runId).toBe(`${RUN_ID}${CSI_ERASE_LINE}`);
    // Document level too, symmetrically with the `--run` branch above: the
    // value assertions alone survive a transform over the whole serialised
    // document, which is exactly what flattens the payload every consumer
    // reads.
    expect(stdout).toContain('\n      "runId":');
  });
});

/**
 * The run LISTING's own `|| UNRENDERABLE` arms. Split from the per-event
 * block above because `printRunList` is not exported and its columns come
 * from `index.json` rather than from the JSONL — a mutation probe measured
 * that dropping the fallback on `run.command` survived every other case in
 * this file, so this row is the only thing holding that site.
 */
describe('the run listing falls back to <unrenderable> too (issue #2438)', () => {
  const ALL_CONTROL = '\u001b\u0007\r';

  beforeEach(() => {
    infoSpy.mockReset();
    mockListRawKeys.mockReset();
    mockGetRawObject.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockImplementation(async () => {});
  });

  it('renders every collapsed column as <unrenderable>, keeping the layout', async () => {
    scriptBackend({
      runId: ALL_CONTROL,
      command: ALL_CONTROL,
      cdkdVersion: ALL_CONTROL,
      startedAt: ALL_CONTROL,
      finishedAt: ALL_CONTROL,
      result: ALL_CONTROL,
      eventCount: ALL_CONTROL,
    });

    await runEvents(['TestStack']);

    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    // The timestamps keep the file's pre-existing `'?'`, which this renderer
    // already used for a value it cannot show. Collapsing `?` and
    // `<unrenderable>` into one spelling was tried and reverted: it needed a
    // presence-tracking helper across the whole renderer, and each review
    // round found it making the same false claim on a different input class.
    // A forged timestamp showing `?` says "not shown", which is true; only
    // `error.message` — empty with no forgery at all — earned a special case.
    expect(lines[1]).toBe(
      `  ${cyan('<unrenderable>')}  <unrenderable>  ${gray('<unrenderable>')}  ` +
        `${gray('?')} -> ${gray('?')}  ` +
        `${gray('cdkd <unrenderable>')}  ${gray('? events')}`
    );
  });


});

/**
 * The `--keep` parse refusal echoes the rejected argument back. Own-argv
 * provenance, so the blast radius is the user's own terminal — but it is the
 * same class as every other site here, it costs one call, and an unfenced
 * sanitiser is one a later edit removes silently (measured: dropping it
 * survived all 23 other cases in this file).
 */
describe('the --keep parse refusal sanitises the rejected argument (issue #2438)', () => {
  it('does not echo a control byte back out of the argument', async () => {
    const cmd = createEventsPruneCommand();
    cmd.exitOverride();

    const err = await cmd
      .parseAsync(['TestStack', '--keep', `abc${CSI_ERASE_LINE}`], { from: 'user' })
      .then(() => undefined)
      .catch((e: unknown) => e);

    const message = String((err as Error).message);
    expect(message).not.toContain(CSI_ERASE_LINE);
    expect(message).toContain('Invalid --keep value "abc [2K"');
  });
});

/**
 * The sites round 2 left executing the `|| UNRENDERABLE` arm only in theory —
 * the six inside the three `EVENTS_*` errors, the four header interpolations,
 * and `colorizeEventType`'s token — plus the one site (`targetRegion` in
 * `EVENTS_RUN_NOT_FOUND`) that was still driven with a benign value while the
 * case NAME claimed otherwise.
 *
 * All are reachable: an all-control stack name is ordinary argv, and an
 * all-control region is a raw S3 key segment.
 */
describe('the header, error and event-type fallbacks all execute (issue #2438)', () => {
  const ALL_CONTROL = '\u001b\u0007\r';
  const stateOpts = { stateBucket: 'test-bucket', region: 'us-east-1', statePrefix: 'cdkd' };

  beforeEach(() => {
    infoSpy.mockReset();
    confirmSpy.mockClear();
    mockListRawKeys.mockReset();
    mockGetRawObject.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockImplementation(async () => {});
  });

  it('names an unrenderable stack in EVENTS_NOT_FOUND rather than quoting nothing', async () => {
    mockListRawKeys.mockImplementation(async () => []);

    const err = await eventsCommand(ALL_CONTROL, { ...stateOpts }).catch((e: unknown) => e);
    // `stack ''` would read as "you passed no stack name", which is false.
    expect(String((err as Error).message)).toContain("stack '<unrenderable>'");
  });

  it('names an unrenderable region among the ambiguous ones', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/TestStack/us-east-1/deployments/index.json`,
      `cdkd/TestStack/${ALL_CONTROL}/deployments/index.json`,
    ]);

    const err = await eventsCommand('TestStack', { ...stateOpts }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain('multiple regions: <unrenderable>, us-east-1.');
  });

  it('names an unrenderable run id AND the region in EVENTS_RUN_NOT_FOUND', async () => {
    // Round 2's case for this error scripted a clean `us-east-1`, so the
    // region interpolation was unfenced while the case name claimed it.
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/TestStack/${ALL_CONTROL}/deployments/index.json`,
    ]);
    mockGetRawObject.mockImplementation(async () => null);

    const err = await eventsCommand('TestStack', {
      ...stateOpts,
      run: ALL_CONTROL,
    }).catch((e: unknown) => e);
    const message = String((err as Error).message);
    expect(message).toContain("run '<unrenderable>'");
    expect(message).toContain("region '<unrenderable>'");
  });

  /**
   * The `--keep` AND `--older-than` scope clause. Grep proved no test in the
   * repo reached this branch, so its `safeId(options.olderThan)` was held by
   * nothing — the sibling arm one line down was the only one covered.
   */
  it('sanitises --older-than in the combined keep+older-than scope clause', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/TestStack/us-east-1/deployments/index.json`,
    ]);
    mockGetRawObject.mockImplementation(async () => JSON.stringify({ runs: [] }));

    await eventsPruneCommand('TestStack', {
      ...stateOpts,
      keep: 5,
      olderThan: `${CR}24h`,
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = String(confirmSpy.mock.calls[0]?.[0]);
    expect(prompt).not.toContain(CR);
    expect(prompt).toContain('runs beyond the newest 5 AND older than 24h');
  });

  it('falls back on BOTH prune-header interpolations', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/${ALL_CONTROL}/${ALL_CONTROL}/deployments/index.json`,
    ]);
    mockGetRawObject.mockImplementation(async () => JSON.stringify({ runs: [] }));

    await eventsPruneCommand(ALL_CONTROL, { ...stateOpts });

    // Exact, not `toContain('<unrenderable>')`: that form is satisfied by
    // EITHER interpolation, so dropping the fallback on one of them passed.
    // (The companion `not.toContain('for  ')` guard it replaced was worse than
    // weak — it was unfalsifiable, since `cyan()` always emits an escape
    // between the two spaces.)
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toBe(
      `Prune deployment-event history for ${cyan('<unrenderable>')} ` +
        `${gray('(<unrenderable>)')}: runs beyond the newest 20?`
    );
  });

  it('falls back on the stack name in EVENTS_REGION_AMBIGUOUS', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/${ALL_CONTROL}/us-east-1/deployments/index.json`,
      `cdkd/${ALL_CONTROL}/eu-west-1/deployments/index.json`,
    ]);

    const err = await eventsCommand(ALL_CONTROL, { ...stateOpts }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain("Stack '<unrenderable>' has");
  });

  it('falls back on the stack name in EVENTS_RUN_NOT_FOUND', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/${ALL_CONTROL}/us-east-1/deployments/index.json`,
    ]);
    mockGetRawObject.mockImplementation(async () => null);

    const err = await eventsCommand(ALL_CONTROL, { ...stateOpts, run: 'run-1' }).catch(
      (e: unknown) => e
    );
    expect(String((err as Error).message)).toContain("stack '<unrenderable>'");
  });

  it('falls back on BOTH interpolations of the single-run header', () => {
    // Every other `printRunEvents` case in this file passes a clean
    // `'TestStack'` / `'us-east-1'`, so these two sites had never run their arm.
    printRunEvents(ALL_CONTROL, ALL_CONTROL, 'run-1', []);

    expect(infoSpy.mock.calls.map((c) => String(c[0]))[0]).toBe(
      `${bold('Events for run')} ${cyan('run-1')} ` +
        `${gray('(<unrenderable>, <unrenderable>)')}`
    );
  });

  it('colours an unrenderable run result as UNKNOWN, never as a failure', async () => {
    // `DeploymentRunSummaryResult` forbids fabricating `FAILED` for a result
    // that is not definitively known, and a result cdkd cannot RENDER is not
    // one it knows — so this must not take the red arm.
    scriptBackend({
      runId: RUN_ID,
      command: 'deploy',
      cdkdVersion: '0.286.3',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      result: ALL_CONTROL,
      eventCount: 1,
    });

    await runEvents(['TestStack']);

    const line = infoSpy.mock.calls.map((c) => String(c[0]))[1];
    expect(line).toContain(gray('<unrenderable>'));
    expect(line).not.toContain(red('<unrenderable>'));
  });

  it('falls back in the run-listing header', async () => {
    mockListRawKeys.mockImplementation(async () => [
      `cdkd/${ALL_CONTROL}/${ALL_CONTROL}/deployments/index.json`,
    ]);
    mockGetRawObject.mockImplementation(async () => JSON.stringify({ runs: [] }));

    await eventsCommand(ALL_CONTROL, { ...stateOpts });

    expect(infoSpy.mock.calls.map((c) => String(c[0]))[0]).toBe(
      `${bold('Deployment runs for')} ${cyan('<unrenderable>')} ${gray('(<unrenderable>)')}`
    );
  });

  it('falls back on an unrenderable event type rather than colouring an empty token', () => {
    // The default arm, because `<unrenderable>` ends in neither FAILED nor
    // SUCCEEDED — which is the conservative answer for a token cdkd cannot
    // read.
    expect(colorizeEventType(ALL_CONTROL as DeploymentEvent['eventType'])).toBe(
      cyan('<unrenderable>')
    );
  });
});
