import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The four HAND-QUOTED pasteable commands of issue
 * [#3136](https://github.com/go-to-k/cdkd/issues/3136).
 *
 * Issue [#2610](https://github.com/go-to-k/cdkd/issues/2610) gave the
 * protected-arm remedies ONE rendering for the resource id they paste
 * (`renderDisableCommand`: `displaySafe(asciiOnly)`, then `shellQuote`, then
 * SUPPRESS the whole command when sanitizing CHANGED the value), and issue
 * [#2669](https://github.com/go-to-k/cdkd/issues/2669) routed the log-group
 * cleanup line through it. That closed the protected-arm FAMILY, not the CLASS:
 * four sites in three providers still wrapped a TEMPLATE- or state-borne value
 * in `'...'` by hand, so a `'` in the value broke out of the quoting and a
 * control byte forged lines on the operator's terminal. (These four are WARN
 * lines, which the recorder does not persist — only a thrown `error.message`
 * reaches `deployments/*.jsonl`, so the terminal is the whole reach here.)
 *
 * The four, each driven through its real `create()` / `import()` below:
 *
 *  - `ssm-parameter-provider.ts` — the partial-create cleanup warning
 *    (`aws ssm delete-parameter --name`) and `refuseUnwritableParameterId`'s
 *    thrown remedy (`aws ssm get-parameter --name`);
 *  - `s3-bucket-provider.ts` — both partial-create cleanup arms
 *    (`aws s3api delete-bucket --bucket`), which share one clause.
 *
 * WHY THESE FOUR VALUES. `displaySafe(asciiOnly)` is a positive allowlist over
 * printable ASCII, so the discriminating inputs split into two outcomes and
 * BOTH have to be pinned or the fence proves only half of the rule:
 *
 *  - a `'` is printable ASCII, so sanitizing does NOT change it and the command
 *    is still shown — SHELL-QUOTED, which is the whole point. Asserting
 *    "suppressed" for this one would have been wrong, and asserting nothing
 *    would leave the breakout unfenced.
 *  - a control byte, a newline and a non-ASCII character are each replaced (and
 *    the result trimmed), so the value CHANGES and the whole command is
 *    SUPPRESSED — naming the sanitized value would address a DIFFERENT
 *    resource.
 *
 * Every case also pins the CLEAN value rendering BARE, because `shellQuote`
 * leaves `[A-Za-z0-9._/@:+-]` alone: without that control a fence could be
 * satisfied by a renderer that quotes everything, and the integ fixtures that
 * grep these commands expect the bare form.
 */

const { mockSend, clientRegion, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'eu-west-1' },
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
    // The SSM provider builds its `Arn` attribute through `getAccountInfo`,
    // which reads `getAwsClients().sts`; omitting it routes every create in
    // this file through the fabricated-account arm and adds an unrelated warn
    // that the assertions below would then have to skip past.
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import type { MaskerFn } from '../../../src/provisioning/masked-retry-logger.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

/** Every warning the run emitted, joined — the assertions match substrings. */
const warnings = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

/**
 * U+0001, BUILT rather than written as a backslash-u escape in a string
 * literal.
 *
 * `vp run format` rewrites that escape into the RAW byte, which
 * `tests/unit/scripts/source-control-bytes.test.ts` then refuses across the
 * whole tree — so the escape spelling cannot survive a formatted commit.
 * `String.fromCharCode` produces the identical character and the formatter has
 * nothing to normalise.
 */
const CONTROL_BYTE = String.fromCharCode(1);

/** A 403 on the us-east-1 region probe: the answer is INDETERMINATE. */
function accessDenied(): Error {
  const e = new Error('Access Denied');
  Object.assign(e, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  return e;
}

/**
 * The value shapes every site is driven with.
 *
 * `rendered` says what must appear in the message for a value of this shape:
 * `'bare'` (unchanged and needing no quotes), `'quoted'` (unchanged but shown
 * inside `'...'` with any inner quote escaped) or `'suppressed'` (no command at
 * all).
 */
const CASES: ReadonlyArray<{
  readonly label: string;
  readonly suffix: string;
  readonly rendered: 'bare' | 'quoted' | 'suppressed';
}> = [
  { label: 'a clean value', suffix: 'clean', rendered: 'bare' },
  { label: 'a single quote', suffix: "it's-mine", rendered: 'quoted' },
  { label: 'a control byte', suffix: `a${CONTROL_BYTE}b`, rendered: 'suppressed' },
  { label: 'a newline', suffix: 'a\nb', rendered: 'suppressed' },
  { label: 'a non-ASCII character', suffix: 'aΩb', rendered: 'suppressed' },
];

/**
 * Assert `message` renders `before <value>` the way `expected` says, and — for
 * every non-bare shape — that the RAW hand-quoted form is absent.
 *
 * The negative half is what actually discriminates: the pre-#3136 providers
 * emitted `${before} '${value}'` for every shape, so a fence asserting only
 * that "the command is present" passed against them unchanged.
 */
function expectRendering(
  message: string,
  before: string,
  value: string,
  expected: 'bare' | 'quoted' | 'suppressed'
): void {
  const handQuoted = `${before} '${value}'`;
  expect(message).not.toContain(handQuoted);
  if (expected === 'suppressed') {
    // No command at all — not the command with a sanitized value in it, which
    // is the wrong-target harm. The clause naming the console must be there
    // instead, so the user is not left with a dead end.
    expect(message).not.toContain(before);
    expect(message).toContain('via the console');
    return;
  }
  expect(message).toContain(before);
  if (expected === 'bare') {
    expect(message).toContain(`${before} ${value}`);
  } else {
    // `shellQuote`'s escaping: the value is wrapped in `'...'` and each inner
    // `'` becomes `'\''`, so the pasted argument is exactly the original bytes.
    expect(message).toContain(`${before} '${value.replace(/'/g, `'\\''`)}'`);
  }
}

describe('pasteable provider commands sanitize, quote and suppress their id (#3136)', () => {
  beforeEach(() => {
    // `mockReset` as well as `clearAllMocks`, per this directory's rule: the
    // latter leaves a `*Once` queue intact across tests.
    mockSend.mockReset();
    vi.clearAllMocks();
    clientRegion.value = 'eu-west-1';
  });

  describe('SSMParameterProvider partial-create cleanup', () => {
    const BEFORE = 'aws ssm delete-parameter --name';

    /** Drive create() to the arm where BOTH the wiring and the cleanup fail. */
    const runFailedCleanup = async (name: string, maskSecrets?: MaskerFn): Promise<void> => {
      mockSend.mockResolvedValueOnce({}); // PutParameter
      mockSend.mockRejectedValueOnce(new Error('AddTags boom')); // AddTagsToResource
      mockSend.mockRejectedValueOnce(new Error('DeleteParameter also failed')); // cleanup
      await expect(
        new SSMParameterProvider().create(
          'MyParam',
          'AWS::SSM::Parameter',
          { Name: name, Type: 'String', Value: 'v', Tags: [{ Key: 'k', Value: 'v' }] },
          maskSecrets ? { maskSecrets } : undefined
        )
      ).rejects.toThrow('AddTags boom');
    };

    for (const c of CASES) {
      it(`${c.rendered}s the command for ${c.label}`, async () => {
        const name = `/cdkd/${c.suffix}`;
        await runFailedCleanup(name);
        expectRendering(warnings(), BEFORE, name, c.rendered);
      });
    }

    it('still names the parameter in PROSE when the command is suppressed', async () => {
      // The suppression removes the pasteable span, not the diagnosis: a
      // warning that named neither the resource nor a next step would be worse
      // than the defect it replaced.
      const name = `/cdkd/a${CONTROL_BYTE}b`;
      await runFailedCleanup(name);
      expect(warnings()).toContain('Failed to clean up partially-created SSM parameter MyParam');
      expect(warnings()).toContain('Manual deletion may be required');
    });

    it('SUPPRESSES the command for a name the MASKER would change', async () => {
      // The regression this file's own fix could have shipped (found by the
      // security review of #3136). `mask` is a message-level masker matching by
      // LITERAL occurrence, and `shellQuote` rewrites an inner `'` to `'\''` —
      // so the secret no longer OCCURS in the assembled line and comes through
      // in PLAINTEXT. The hand-quoted form this replaced did NOT have that
      // problem, because it left the value byte-identical. So a secret-bearing
      // id is suppressed exactly as a sanitized one is.
      //
      // The quote in the value is what makes the case discriminate: without it
      // `shellQuote` leaves the bytes contiguous and the message-level mask
      // still reaches them.
      await runFailedCleanup("/cdkd/o'brien-s3cr3t", (t) => t.replace(/s3cr3t/g, '<redacted>'));
      expect(warnings()).not.toContain('s3cr3t');
      expect(warnings()).not.toContain(BEFORE);
      expect(warnings()).toContain('via the console');
      // The PROSE copy is still there and IS masked, so the warning is still
      // diagnosable — masking is not the same as withholding.
      expect(warnings()).toContain('<redacted>');
    });

    it('still renders the command for a clean name when a masker IS supplied', async () => {
      // The other direction: supplying a masker must not suppress every
      // command, or the arm above would be indistinguishable from a renderer
      // that gave up whenever it was handed one.
      await runFailedCleanup('/cdkd/clean', (t) => t.replace(/s3cr3t/g, '<redacted>'));
      expect(warnings()).toContain(`${BEFORE} /cdkd/clean`);
    });

    it('SUPPRESSES the command when the name sanitizes to NOTHING', async () => {
      // The `!safeId` arm of the renderer: an all-non-ASCII name leaves an
      // empty string after the positive allowlist, and an empty ARGUMENT would
      // be a command acting on no resource at all.
      await runFailedCleanup('ΩΩΩ');
      expect(warnings()).not.toContain(BEFORE);
      expect(warnings()).toContain('via the console');
    });
  });

  describe('SSMParameterProvider import refusal', () => {
    const BEFORE = 'aws ssm get-parameter --name';

    /**
     * The refusal's message. The guard fires on a `:` in the id, which every
     * ARN carries — and the `:` is also why the CLEAN case must render BARE:
     * `shellQuote` allows `:`, so a well-formed ARN needs no quotes.
     */
    const refusalMessage = async (explicit: string, logicalId = 'MyParam'): Promise<string> => {
      try {
        await new SSMParameterProvider().import({
          logicalId,
          resourceType: 'AWS::SSM::Parameter',
          stackName: 'MyStack',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: explicit,
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('import() did not refuse the unwritable physical id');
    };

    for (const c of CASES) {
      it(`${c.rendered}s the command for ${c.label}`, async () => {
        const arn = `arn:aws:ssm:us-east-1:111122223333:parameter/${c.suffix}`;
        const message = await refusalMessage(arn);
        expectRendering(message, BEFORE, arn, c.rendered);
        // The refusal itself is unaffected by the rendering decision — it is
        // thrown for every shape, and `GetParameter` is never reached.
        expect(message).toContain('Cannot adopt SSM parameter MyParam');
        expect(mockSend).not.toHaveBeenCalled();
      });
    }

    /**
     * The OTHER pasteable span in the same refusal: the `--resource` remedy
     * fragment, which interpolated the TEMPLATE logical id raw and ended in a
     * bare `<parameterName>` (go-to-k/cdkd#3436's checkbox for this file). Both
     * directions are pinned, because a gate that holes everything and one that
     * names everything each satisfy one of them alone.
     */
    const ARN = 'arn:aws:ssm:us-east-1:111122223333:parameter/clean';

    it('names a PLAIN logical id in the --resource remedy, with the placeholder quoted', async () => {
      const message = await refusalMessage(ARN, 'MyParam');
      // The id is bare (a plain identifier needs no quoting) and the
      // placeholder is `commandHole`'s quoted form -- bare, `<parameterName>`
      // is two redirections once anything after it is pasted with it.
      expect(message).toContain("pass the parameter NAME instead: --resource MyParam='<parameterName>'");
      expect(message).not.toContain('<parameterName>.');
    });

    it('HOLES a logical id the --resource split or the shell would reshape', async () => {
      // `A=B` is the id `--resource` itself splits wrong (first `=`), and it
      // carries no space, quote or control byte -- so a gate keyed on those
      // instead of on `isPasteableIdent` names it, which is why it is here
      // beside the shell-shaped one. The `$( )` id would run when pasted.
      for (const hostile of ['A=B', 'P$(touch OWNED)', "P'; touch OWNED; #"]) {
        const message = await refusalMessage(ARN, hostile);
        expect(message, hostile).toContain(
          "pass the parameter NAME instead: --resource '<logicalId>'='<parameterName>'"
        );
        // Nothing of the id survives in the pasteable fragment. The PROSE still
        // displays it (`Cannot adopt SSM parameter ...`), which is a display
        // question and not this one.
        const fragment = message.split('pass the parameter NAME instead: ')[1] ?? '';
        expect(fragment, hostile).not.toContain(hostile);
        expect(fragment, hostile).not.toContain('--resource ' + hostile);
      }
    });

    it('displays a long plain id WHOLE, at the cap the --resource fragment is gated at', async () => {
      // `isPasteableIdent` admits up to the 1152 stack-ref cap, so the prose
      // beside the fragment renders at the same cap: a 256-1152 code-point id
      // was named in `--resource` under a sentence that cut it at 255 (code
      // review of go-to-k/cdkd#3764). Plain letters, one over 255.
      // Pinned at the BOUNDARY, both sides: at 1152 the prose and the fragment
      // carry the id whole; one over, the prose cuts it and the fragment holes
      // it (a case at 256 alone let a 256 cap pass -- Codex on this round).
      const at = 'p'.repeat(1152);
      const atCap = await refusalMessage(ARN, at);
      expect(atCap).toContain(`Cannot adopt SSM parameter ${at} from an ARN`);
      expect(atCap).toContain(`--resource ${at}='<parameterName>'`);
      const over = await refusalMessage(ARN, 'p'.repeat(1153));
      expect(over).not.toContain('p'.repeat(1153));
      expect(over).toContain('p'.repeat(1152));
      expect(over).toContain("--resource '<logicalId>'='<parameterName>'");
    });

    it('pastes nothing runnable at any granularity, through the provider itself', async () => {
      // The paste fence for THIS site: the refusal as `import()` renders it,
      // with the plain id (named) and each payload family as the logical id
      // (holed, and still displayed in prose), fed to bash at line, sentence
      // and clause granularity with decoys planted for every hole
      // (`tests/unit/utils/paste-harness.ts`).
      const named = await refusalMessage(ARN, 'MyParam');
      const withheld: Array<{ value: string; message: string }> = [];
      for (const { value } of PASTE_PAYLOADS) {
        withheld.push({ value, message: await refusalMessage(ARN, value) });
      }
      withPasteDir((dir) => {
        expect(spansThatRun(named, dir)).toEqual([]);
        // A withheld id is still DISPLAYED in the opening sentence; the first
        // cut rendered it through bare `displaySafe` and the separator payload
        // ran three spans of it.
        for (const { value, message } of withheld) {
          // The prose boundary, pinned DIRECTLY: every clause holding the id
          // also holds `('arn...')`, a bash syntax error, so the paste alone
          // cannot see the quote kind (a shell-quoted prose survives it). `displayIdent` JSON-quotes a non-plain id.
          expect(message, value).toContain(`Cannot adopt SSM parameter ${JSON.stringify(value)} from an ARN`);
          // And nothing runs at any granularity here -- the stronger contract,
          // which holds because of that same `(`; assert it rather than the
          // residual criterion that would accept a future running display.
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
      });
    }, 120_000);
  });

  describe('S3BucketProvider partial-create cleanup, both arms', () => {
    const BEFORE = 'aws s3api delete-bucket --bucket';

    /**
     * Arm 1: cdkd DID create the bucket and the cleanup DeleteBucket failed.
     * eu-west-1, where a `CreateBucket` 200 alone proves the create (us-east-1
     * answers a re-create of an owned bucket with a legacy 200, which is why
     * the second arm exists at all).
     */
    const runFailedCleanup = async (bucketName: string, maskSecrets?: MaskerFn): Promise<void> => {
      clientRegion.value = 'eu-west-1';
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteBucket also failed'));
      await expect(
        new S3BucketProvider().create(
          'MyBucket',
          'AWS::S3::Bucket',
          { BucketName: bucketName, VersioningConfiguration: { Status: 'Enabled' } },
          maskSecrets ? { maskSecrets } : undefined
        )
      ).rejects.toThrow('applyConfiguration boom');
    };

    /**
     * Arm 2: us-east-1, where the region probe could not answer, so cdkd
     * declines to delete and names the possible orphan instead.
     */
    const runIndeterminate = async (bucketName: string, maskSecrets?: MaskerFn): Promise<void> => {
      clientRegion.value = 'us-east-1';
      mockSend.mockRejectedValueOnce(accessDenied()); // GetBucketLocation pre-flight
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
      await expect(
        new S3BucketProvider().create(
          'MyBucket',
          'AWS::S3::Bucket',
          { BucketName: bucketName, VersioningConfiguration: { Status: 'Enabled' } },
          maskSecrets ? { maskSecrets } : undefined
        )
      ).rejects.toThrow('Failed to create S3 bucket');
    };

    // A bucket name AWS would accept cannot carry any of these characters, so
    // the population here is a hand-written or attacker-written template — the
    // same bound issue #3136 records. The rendering must still be right: the
    // command is printed BEFORE AWS ever sees the name, and the cleanup arm is
    // reached precisely when things have already gone wrong.
    for (const c of CASES) {
      it(`cleanup-failed arm ${c.rendered}s the command for ${c.label}`, async () => {
        const bucket = `cdkd-${c.suffix}`;
        await runFailedCleanup(bucket);
        expectRendering(warnings(), BEFORE, bucket, c.rendered);
        expect(warnings()).toContain('Failed to clean up partially-created S3 bucket');
      });

      it(`indeterminate-probe arm ${c.rendered}s the command for ${c.label}`, async () => {
        const bucket = `cdkd-${c.suffix}`;
        await runIndeterminate(bucket);
        expectRendering(warnings(), BEFORE, bucket, c.rendered);
        expect(warnings()).toContain('Not cleaning up S3 bucket');
      });
    }

    it('renders the SAME clause from both arms, so they cannot drift apart', async () => {
      // The two arms share one helper. Without this case a later edit could fix
      // one arm's rendering and leave the other hand-quoted — which is exactly
      // how this class survived issue #2669's sweep.
      const bucket = "cdkd-it's-mine";
      await runFailedCleanup(bucket);
      const first = warnings();
      warnSpy.mockClear();
      mockSend.mockReset();
      await runIndeterminate(bucket);
      const second = warnings();
      const quoted = `${BEFORE} '${bucket.replace(/'/g, `'\\''`)}'`;
      expect(first).toContain(quoted);
      expect(second).toContain(quoted);
    });

    it.each([
      ['cleanup-failed', (n: string, m: MaskerFn) => runFailedCleanup(n, m)],
      ['indeterminate-probe', (n: string, m: MaskerFn) => runIndeterminate(n, m)],
    ])(
      '%s arm masks its whole warning and SUPPRESSES the command for a secret name',
      async (_label, run) => {
        // Both halves of the security review's finding on these two arms: they
        // reached NO masker at all (a provider's own `logger.warn` reaches no
        // engine sink), and once they do, `shellQuote`'s `'\''` escaping would
        // still put a quote-carrying secret past a message-level mask. So the
        // arm masks, and the renderer suppresses.
        await run("cdkd-o'brien-s3cr3t", (t: string) => t.replace(/s3cr3t/g, '<redacted>'));
        expect(warnings()).not.toContain('s3cr3t');
        expect(warnings()).toContain('<redacted>');
        expect(warnings()).not.toContain(BEFORE);
        expect(warnings()).toContain('via the console');
      }
    );

    it('still renders the command for a clean bucket name when a masker IS supplied', async () => {
      // The other direction, so the suppression above is about the VALUE and
      // not about the presence of a masker.
      await runFailedCleanup('cdkd-clean', (t) => t.replace(/s3cr3t/g, '<redacted>'));
      expect(warnings()).toContain(`${BEFORE} cdkd-clean`);
    });
  });
});
