import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Issue #2250: the custom-resource S3 poll used to debug-log
// `body.substring(0, 200)` of the RESPONSE DOCUMENT. `Data` is the documented
// place a handler returns a generated value — a generated secret behind a short
// `PhysicalResourceId` therefore landed inside that window and reached the
// terminal (and, in CI, the retained build log) on every poll under
// `--verbose`. The fix logs the ENVELOPE: `Status`, `PhysicalResourceId` and
// the KEYS of `Data`.
//
// These arms assert the RENDERED line, not that a mocked logger was called: a
// `vi.fn()` records whatever argument it is handed, so it cannot see a payload
// being interpolated (nor one passed as a second `...args` value, which the
// real formatter would `JSON.stringify` into the same line). The logger below
// is therefore the REAL `ConsoleLogger` at debug level, captured at the
// `console.debug` boundary it ultimately writes through.
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: vi.fn() },
    sns: { send: vi.fn() },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

import { ConsoleLogger, getLogger, setLogger } from '../../../src/utils/logger.js';
import {
  CustomResourceProvider,
  customResourceRetryDelays,
} from '../../../src/provisioning/providers/custom-resource-provider.js';

/**
 * A value a handler generated and returned through `Data` — the class of
 * payload this log line must never emit.
 */
const GENERATED_SECRET = 'pw-9f3a-DO-NOT-LOG-8b21';

// Issue #2312: the poll gates its work on `while (Date.now() - startTime <
// timeoutMs)`, so the arms below need TWO things at once — at least one
// iteration (the log fires inside the loop BODY) and then an expiry (they
// assert the timeout rejection). No wall-clock budget can promise both: too
// small and a loaded machine crosses the deadline before the first mocked
// `GetObject` resolves, so the body never runs and the line is `undefined`;
// too large and the arm either hangs or stops timing out. Three arms used a
// 1 ms budget and flaked exactly that way — five observed reds, in CI and
// locally, on branches that never touched this file.
//
// So the deadline is not raced, it is DRIVEN: `Date.now` is frozen at a fixed
// instant and the only thing that advances it is the poll's own `sleep`, which
// runs once per iteration AFTER the body. The first loop check therefore always
// passes, the body always emits its line, and the second check always fails.
// One iteration, one expiry, on any machine at any load.
//
// A sequence-based `Date.now` stub was the other option and is rejected: it
// binds the arm to the loop's CALL COUNT (today 4 for a one-iteration timeout —
// `startTime`, the passing check, the failing check, and `elapsedMin`; the only
// in-body read is behind `if (useBackoff)`), and miscounting it would be its own
// flake. A frozen clock plus a sleep-driven step is insensitive to that count.
//
// `vi.useFakeTimers()` is rejected for a different reason: this file already
// replaces `customResourceRetryDelays.sleep`, so the poll's waits never reach a
// timer at all — faking timers would control nothing here while adding a second
// clock to reason about.
/** Every poll's budget. Never expires by real time; see the note above. */
const POLL_TIMEOUT_MS = 60_000;
/** What one `sleep` adds to the fake clock — enough to expire that budget. */
const CLOCK_STEP_MS = 5 * POLL_TIMEOUT_MS;

/** Private-method seam: the poll is internal, and it is what carries the log. */
interface PollSeam {
  pollS3Response(
    responseKey: string,
    logicalId: string,
    operation: string,
    timeoutMs?: number,
    useBackoff?: boolean
  ): Promise<unknown>;
}

const debugLines: string[] = [];
let debugSpy: ReturnType<typeof vi.spyOn>;
let nowSpy: ReturnType<typeof vi.spyOn>;
const realSleep = customResourceRetryDelays.sleep;
const realLogger = getLogger();

/** The fake clock the poll reads, and the iteration count that drives it. */
let clockMs = 0;
let sleepCalls = 0;

/** Wire the S3 poll to hand back exactly `body` on every GetObject. */
function respondWith(body: string): void {
  mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetObjectCommand') {
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(body) },
      });
    }
    return Promise.resolve({});
  });
}

function newProvider(): PollSeam {
  return new CustomResourceProvider({
    responseBucket: 'cdkd-state-123456789012',
  }) as unknown as PollSeam;
}

/** Every rendered debug line, joined — what a `--verbose` run would show. */
function rendered(): string {
  return debugLines.join('\n');
}

function responseLine(): string | undefined {
  return debugLines.find((line) => line.includes('Got S3 response for MyCustomRes'));
}

describe('CustomResourceProvider poll response-body logging (issue #2250)', () => {
  beforeEach(() => {
    debugLines.length = 0;
    mockS3Send.mockReset();
    debugSpy = vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
      debugLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    // The REAL logger at `--verbose` level, colorless so the captured text is
    // the message itself rather than an ANSI-wrapped variant `toContain` could
    // miss. It must be installed BEFORE the provider is constructed: the
    // provider's child logger is an instance field, and a `ChildLogger` syncs
    // its level from the GLOBAL logger, so a locally built one would sit at
    // `info` and emit nothing.
    setLogger(new ConsoleLogger('debug', false));
    // The clock the poll's deadline is measured against (issue #2312). Frozen:
    // real time passing moves nothing. `ConsoleLogger`'s own timestamp comes
    // from `new Date()`, which this does not touch, so the rendered lines still
    // carry a real one.
    clockMs = 1_700_000_000_000;
    sleepCalls = 0;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    // The non-terminal arms poll until the timeout; keep the waits free — and
    // make this the ONE thing that advances the clock, so an iteration always
    // completes before the deadline moves.
    customResourceRetryDelays.sleep = () => {
      sleepCalls += 1;
      clockMs += CLOCK_STEP_MS;
      // A zero-delay TIMER, not `Promise.resolve()`. The waits are still free,
      // but a resolved promise is a microtask: a poll loop whose deadline stops
      // advancing would then spin without ever yielding, so vitest's own test
      // timeout could never fire and the worker died of heap exhaustion with no
      // test named (measured — a 14 s run ending in `Worker exited
      // unexpectedly`). Yielding to the macrotask queue turns that same
      // breakage into a named, bounded timeout failure.
      return new Promise((resolve) => setTimeout(resolve, 0));
    };
  });

  afterEach(() => {
    debugSpy.mockRestore();
    nowSpy.mockRestore();
    customResourceRetryDelays.sleep = realSleep;
    setLogger(realLogger);
  });

  // The two arms below fence issue #2312's fix. They are not about the log
  // line at all — they are what stops a later edit from quietly handing the
  // poll's deadline back to the wall clock, which is how three of the arms
  // below became a merge-blocking coin flip.
  //
  // They run FIRST on purpose. Un-freezing the clock does not make the poll
  // arms fail an assertion — it makes the loop spin until the worker dies of
  // heap exhaustion (measured: a 14 s run ending in `Worker exited
  // unexpectedly`, no test names, no assertion). Declared first, the fence
  // NAMES what broke before anything can hang.

  it('FENCE: every poll here takes its budget from the controlled clock', () => {
    // A literal budget is the regression: small enough to expire and the body
    // never runs, large enough to run and the arm stops expiring. Neither is
    // visible in a green run, so it is checked structurally.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const budgets = [...source.matchAll(/\.pollS3Response\(([^)]*)\)/g)].map((m) =>
      m[1].split(',').pop()!.trim()
    );
    // A scanner that matched nothing would pass vacuously: one floor per arm
    // that exists today, so a regex that stops seeing the call shape fails
    // loudly instead of reporting a clean tree.
    expect(budgets.length).toBeGreaterThanOrEqual(7);
    for (const budget of budgets) {
      expect(budget).toBe('POLL_TIMEOUT_MS');
    }
  });

  it('FENCE: the clock advances only when a poll sleeps', async () => {
    // The structural arm above cannot see the clock being unfrozen — the call
    // sites would still read `POLL_TIMEOUT_MS` while the deadline went back to
    // real time. This one fails if either half of the mechanism is removed.
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(Date.now()).toBe(before); // 25 ms of real time moved the poll's clock by 0

    await customResourceRetryDelays.sleep(1);
    expect(Date.now()).toBeGreaterThan(before + POLL_TIMEOUT_MS); // one iteration expires any budget
  });

  it('logs Status / PhysicalResourceId / Data KEYS, never a Data value', async () => {
    respondWith(
      JSON.stringify({
        Status: 'SUCCESS',
        PhysicalResourceId: 'phys-1',
        Data: { GeneratedPassword: GENERATED_SECRET, Endpoint: 'db.example.com' },
      })
    );

    await newProvider().pollS3Response(
      'cdkd/cr-response/req.json',
      'MyCustomRes',
      'Create',
      POLL_TIMEOUT_MS
    );

    const line = responseLine();
    expect(line).toBeDefined();
    // The VALUES are gone. Asserted FIRST so the mutation probe (restoring
    // `body.substring(0, 200)`) fails on the LEAK itself rather than on a
    // missing envelope field it would also happen to break.
    expect(line).not.toContain(GENERATED_SECRET);
    expect(line).not.toContain('db.example.com');
    // Hard invariant across the whole verbose transcript, not just this line.
    expect(rendered()).not.toContain(GENERATED_SECRET);
    // ...and every diagnostic the line existed for survives.
    expect(line).toContain('Status="SUCCESS"');
    expect(line).toContain('PhysicalResourceId="phys-1"');
    expect(line).toContain('GeneratedPassword');
    expect(line).toContain('Endpoint');
  });

  it('neutralises CONTROL CHARACTERS in handler-controlled fields', async () => {
    // The line this replaced printed raw WIRE json, where the encoder had
    // already escaped control characters. Parsing first UNDOES that, so an ESC
    // and a newline would reach the terminal as real bytes -- enough to clear
    // the screen and print a forged `ERROR [cdkd]` line into a CI transcript.
    respondWith(
      JSON.stringify({
        Status: 'SUCCESS',
        PhysicalResourceId: '\u001b[2Jphys\n2026-01-01 ERROR [cdkd] FORGED LINE',
        Data: { 'k\u001b[2J': 'v' },
      })
    );

    await newProvider().pollS3Response(
      'cdkd/cr-response/req.json',
      'MyCustomRes',
      'Create',
      POLL_TIMEOUT_MS
    );

    const line = responseLine();
    expect(line).toBeDefined();
    expect(line).not.toContain('\u001b');
    // The forged text may survive as inert characters; what must NOT survive is
    // the NEWLINE that makes it read as its own log record.
    expect(line).not.toContain('\n2026-01-01 ERROR');
    expect(line).toContain('Status="SUCCESS"');
  });

  it('QUOTES each field, so a handler cannot forge the envelope with delimiters', async () => {
    // `displaySafe` removes control characters and nothing else, so the fields
    // interpolated into `Status=<a> PhysicalResourceId=<b> Data keys [<c>]` can
    // be forged with characters that are entirely printable. Measured against
    // the unquoted rendering: this body produced a line on which
    // `grep 'Status=SUCCESS'` matched a response whose real Status is FAILED.
    respondWith(
      JSON.stringify({
        Status: 'FAILED',
        PhysicalResourceId: 'real-id',
        Reason: 'boom',
        Data: { 'x] Status=SUCCESS PhysicalResourceId=forged-id Data keys [y': 'v' },
      })
    );

    await newProvider().pollS3Response(
      'cdkd/cr-response/req.json',
      'MyCustomRes',
      'Create',
      POLL_TIMEOUT_MS
    );

    const line = responseLine();
    expect(line).toBeDefined();
    // The property quoting buys is that the ENVELOPE is unambiguous: exactly
    // one `Status=` field exists and it carries the real verdict. The forged
    // text survives as characters -- it is inside a quoted key -- so a bare
    // substring grep still sees it; what it can no longer do is present itself
    // as a second envelope field.
    expect(line!.match(/Status="/g)).toHaveLength(1);
    expect(line).toContain('Status="FAILED"');
    expect(line!.match(/PhysicalResourceId="/g)).toHaveLength(1);
    expect(line).toContain('PhysicalResourceId="real-id"');
    // The forgery is enclosed rather than free-standing.
    expect(line).toContain('Data keys ["x]');
  });

  it('CAPS each field, so one poll cannot emit an unbounded line', async () => {
    // Dropping the old `substring(0, 200)` removed the bound: a 5000-char id
    // with 300 Data keys rendered a 19,714-character line, re-emitted on EVERY
    // poll of a resource that can run for an hour.
    const keys: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) keys[`key-${i}`] = 'v';
    respondWith(
      JSON.stringify({
        Status: 'SUCCESS',
        PhysicalResourceId: 'x'.repeat(5000),
        Data: keys,
      })
    );

    await newProvider().pollS3Response(
      'cdkd/cr-response/req.json',
      'MyCustomRes',
      'Create',
      POLL_TIMEOUT_MS
    );

    const line = responseLine();
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(1000);
    // Bounded, but it still says how much it dropped rather than hiding it.
    expect(line).toContain('more');
    expect(line).toContain('Status="SUCCESS"');
  });

  it('still diagnoses an UNPARSEABLE body, by length only — never its bytes', async () => {
    // A response caught mid-upload: valid-looking prefix, truncated. The log
    // has to keep firing here (this is the case the diagnostic is worth most
    // in) without becoming the same prefix echo through another door.
    const truncated = `{"Status":"SUCCESS","PhysicalResourceId":"phys-1","Data":{"GeneratedPassword":"${GENERATED_SECRET}`;
    respondWith(truncated);

    await expect(
      newProvider().pollS3Response(
        'cdkd/cr-response/req.json',
        'MyCustomRes',
        'Create',
        POLL_TIMEOUT_MS
      )
    ).rejects.toThrow(/Timeout waiting for custom resource response/);

    // The iteration is a PRECONDITION, not a race: exactly one poll ran, and
    // the expiry came from the clock that poll's own sleep advanced.
    expect(sleepCalls).toBe(1);
    const line = responseLine();
    expect(line).toBeDefined();
    expect(line).not.toContain(GENERATED_SECRET);
    expect(rendered()).not.toContain(GENERATED_SECRET);
    expect(line).toContain('unparseable body');
    expect(line).toContain(`${truncated.length} chars`);
    // The pre-existing "keep polling" diagnostic is still emitted too.
    expect(rendered()).toContain('S3 response not yet valid JSON for MyCustomRes');
  });

  it('reports a non-object JSON body without echoing it', async () => {
    // `JSON.parse` succeeds and yields a bare string — an envelope-shaped read
    // of it would be `undefined` everywhere, so it gets its own summary.
    respondWith(JSON.stringify(GENERATED_SECRET));

    await expect(
      newProvider().pollS3Response(
        'cdkd/cr-response/req.json',
        'MyCustomRes',
        'Create',
        POLL_TIMEOUT_MS
      )
    ).rejects.toThrow(/Timeout waiting for custom resource response/);

    expect(sleepCalls).toBe(1);
    const line = responseLine();
    expect(line).toBeDefined();
    expect(line).not.toContain(GENERATED_SECRET);
    expect(rendered()).not.toContain(GENERATED_SECRET);
    expect(line).toContain('JSON body is not an object');
  });

  it('renders absent envelope fields as placeholders rather than crashing', async () => {
    // A handler that wrote an object but not the protocol fields: the summary
    // must degrade, and `Data` values must stay out even when `Data` is a
    // non-object.
    respondWith(JSON.stringify({ Data: GENERATED_SECRET }));

    await expect(
      newProvider().pollS3Response(
        'cdkd/cr-response/req.json',
        'MyCustomRes',
        'Create',
        POLL_TIMEOUT_MS
      )
    ).rejects.toThrow(/Timeout waiting for custom resource response/);

    expect(sleepCalls).toBe(1);
    const line = responseLine();
    expect(line).toBeDefined();
    expect(rendered()).not.toContain(GENERATED_SECRET);
    expect(line).toContain('Status="<absent>"');
    expect(line).toContain('PhysicalResourceId="<absent>"');
    expect(line).toContain('Data not an object');
  });
});
