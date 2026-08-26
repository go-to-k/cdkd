import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

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
const realSleep = customResourceRetryDelays.sleep;
const realLogger = getLogger();

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
    // The non-terminal arms poll until the timeout; keep the waits free.
    customResourceRetryDelays.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    debugSpy.mockRestore();
    customResourceRetryDelays.sleep = realSleep;
    setLogger(realLogger);
  });

  it('logs Status / PhysicalResourceId / Data KEYS, never a Data value', async () => {
    respondWith(
      JSON.stringify({
        Status: 'SUCCESS',
        PhysicalResourceId: 'phys-1',
        Data: { GeneratedPassword: GENERATED_SECRET, Endpoint: 'db.example.com' },
      })
    );

    await newProvider().pollS3Response('cdkd/cr-response/req.json', 'MyCustomRes', 'Create', 5000);

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

    await newProvider().pollS3Response('cdkd/cr-response/req.json', 'MyCustomRes', 'Create', 5000);

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

    await newProvider().pollS3Response('cdkd/cr-response/req.json', 'MyCustomRes', 'Create', 5000);

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

    await newProvider().pollS3Response('cdkd/cr-response/req.json', 'MyCustomRes', 'Create', 5000);

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
      newProvider().pollS3Response('cdkd/cr-response/req.json', 'MyCustomRes', 'Create', 1)
    ).rejects.toThrow(/Timeout waiting for custom resource response/);

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
      newProvider().pollS3Response('cdkd/cr-response/req.json', 'MyCustomRes', 'Create', 1)
    ).rejects.toThrow(/Timeout waiting for custom resource response/);

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
      newProvider().pollS3Response('cdkd/cr-response/req.json', 'MyCustomRes', 'Create', 1)
    ).rejects.toThrow(/Timeout waiting for custom resource response/);

    const line = responseLine();
    expect(line).toBeDefined();
    expect(rendered()).not.toContain(GENERATED_SECRET);
    expect(line).toContain('Status="<absent>"');
    expect(line).toContain('PhysicalResourceId="<absent>"');
    expect(line).toContain('Data not an object');
  });
});
