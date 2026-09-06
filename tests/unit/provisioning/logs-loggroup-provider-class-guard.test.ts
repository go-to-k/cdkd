import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const PHYSICAL_ID = '/cdkd/class-guard-test';

// LogGroupClass is documented by CloudFormation as "Update requires: Updates
// are not supported" and CloudWatch Logs has no API to change a log group's
// class after creation. cdkd previously silently DROPPED the change (deploy
// reported success while AWS kept the old class, and state recorded the new
// one so the next diff saw no change). The guard throws the typed
// ResourceUpdateNotSupportedError so the deploy fails actionably and
// `--replace` can recreate the log group under the new class.
describe('LogsLogGroupProvider LogGroupClass update guard', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new LogsLogGroupProvider();
  });

  it('throws ResourceUpdateNotSupportedError on a STANDARD -> INFREQUENT_ACCESS change, before any mutation', async () => {
    await expect(
      provider.update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        // RetentionInDays ALSO changes so a guard misplaced after the
        // retention branch would provably send PutRetentionPolicy first.
        { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 7 },
        { LogGroupClass: 'STANDARD', RetentionInDays: 1 }
      )
    ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });

    // The guard must fire BEFORE any other mutation is applied.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('treats an absent property as STANDARD (absent -> INFREQUENT_ACCESS throws)', async () => {
    await expect(
      provider.update('ClassLg', PHYSICAL_ID, RESOURCE_TYPE, { LogGroupClass: 'INFREQUENT_ACCESS' }, {})
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });

  it('does NOT throw on an explicit-STANDARD <-> absent transition (both mean the default class)', async () => {
    await expect(
      provider.update('ClassLg', PHYSICAL_ID, RESOURCE_TYPE, {}, { LogGroupClass: 'STANDARD' })
    ).resolves.toBeDefined();
  });

  it('proceeds with unrelated updates when the class is unchanged', async () => {
    await provider.update(
      'ClassLg',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 7 },
      { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 1 }
    );

    const retention = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutRetentionPolicyCommand
    );
    expect(retention).toBeDefined();
  });

  it('throws on a change to the DELIVERY class too', async () => {
    await expect(
      provider.update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'DELIVERY' },
        { LogGroupClass: 'STANDARD' }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });

  it('names the class transition it refused, in both directions', async () => {
    // The flag set used to be CONDITIONAL, and this case asserted the negative
    // — a never-expiring log group was told a bare `--replace` would do. Issue
    // #2558 retired that premise, and the unconditional-advice cases below own
    // the flag set now. What is left here is the TRANSITION text, which no
    // other case pins — and the BACKWARD direction below is coverage no other
    // case has at all (the forward arm differs from its sibling only in the
    // retention value, which is why it is not the point of this case).
    const forward = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupClass: 'STANDARD', RetentionInDays: 30 }
      )
      .catch((e: Error) => e);
    expect((forward as Error).message).toMatch(/'STANDARD' -> 'INFREQUENT_ACCESS'/);

    const backward = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'STANDARD', RetentionInDays: 30 },
        { LogGroupClass: 'INFREQUENT_ACCESS' }
      )
      .catch((e: Error) => e);
    expect((backward as Error).message).toMatch(/'INFREQUENT_ACCESS' -> 'STANDARD'/);
  });

  it('names --force-stateful-recreation when the log group retains data (stateful guard)', async () => {
    const err = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 7 },
        { LogGroupClass: 'STANDARD', RetentionInDays: 7 }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/--replace --force-stateful-recreation/);
  });

  it('names it for a NEVER-EXPIRING log group too — the advice is unconditional (issue #2558)', async () => {
    // The polarity the retention case above cannot see, and the one the flag
    // set used to get WRONG: with no `RetentionInDays` in either bag the
    // provider advised a bare `--replace`, on the retired premise that such a
    // log group was not stateful. It is CloudWatch Logs' never-expire, the
    // mid-deploy guard refuses it, and following that advice cost the user a
    // second failed deploy. Both bags are retention-free here, so a
    // conditional keyed on EITHER bag reds.
    const err = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupClass: 'STANDARD' }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/--replace --force-stateful-recreation/);
    // The flag's SCOPE, which the message names because this remedy now
    // reaches every log group rather than only retention-carrying ones.
    expect((err as Error).message).toMatch(/no per-resource granularity/i);
  });

  it('names it when only the DESIRED bag drops the retention (the recorded one still has it)', async () => {
    // The bag-selection case issue #2521 filed against this line: the guard
    // reads the RECORDED bag, so a template merely DROPPING the retention was
    // told `--replace` alone would do and was then refused. Unconditional
    // advice answers it without having to pick a bag.
    const err = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupClass: 'STANDARD', RetentionInDays: 7 }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/--replace --force-stateful-recreation/);
  });
});

/**
 * Issue #2579: the `--replace --force-stateful-recreation` remedy dead-ends on
 * a log group that carries `DeletionProtectionEnabled`.
 *
 * The replacement's DELETE runs from the deploy engine, which never sets
 * `DeleteContext.removeProtection` — `cdkd deploy` has no `--remove-protection`
 * flag at all (only `cdkd destroy` does), so the flip-off in
 * `LogsLogGroupProvider.delete` cannot run. AWS then refuses the
 * `DeleteLogGroup` and the user, having followed cdkd's own advice, hits a
 * SECOND wall with nothing named to do about it.
 *
 * Both polarities are pinned here, and so is the BAG the predicate reads. The
 * recorded bag (`previousProperties`) is the one that describes the log group
 * that has to be deleted; the desired bag answers a different question and is
 * wrong in both directions, which is what the two bag-discrimination cases at
 * the end assert.
 */
describe('LogGroupClass refusal names the deletion-protection dead-end (#2579)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new LogsLogGroupProvider();
  });

  const refuse = async (
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<string> => {
    const err = await provider
      .update('ClassLg', PHYSICAL_ID, RESOURCE_TYPE, properties, previousProperties)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    // The guard still fires before any mutation, on this arm too.
    expect(mockSend).not.toHaveBeenCalled();
    return (err as Error).message;
  };

  it('says the two flags alone will NOT succeed, and names the out-of-band disable command', async () => {
    const message = await refuse(
      { LogGroupClass: 'INFREQUENT_ACCESS', DeletionProtectionEnabled: true },
      { LogGroupClass: 'STANDARD', DeletionProtectionEnabled: true }
    );

    // Not merely that protection is mentioned: that the advised remedy is
    // called out as insufficient. A message that named the property while
    // still saying "re-deploy with the flags" would leave the dead-end intact.
    expect(message).toContain(
      '--replace --force-stateful-recreation alone will NOT succeed while AWS still has it on'
    );
    expect(message).toContain('cdkd deploy has no --remove-protection flag');
    // The message says what cdkd RECORDED rather than asserting AWS state: two
    // of the four `update()` callers hand over a bag that is not the state
    // record (`drift.ts` an AWS readback, `rollback-executor.ts`'s
    // `--revert-failed` arm the failed attempt's DESIRED props), and
    // protection enabled out of band is in no bag at all.
    expect(message).toContain("cdkd's recorded properties for this log group");
    // `cdkd state destroy` registers `--remove-protection` too, so the message
    // must not say `cdkd destroy` is the only one. Pinned because the wrong
    // wording shipped in an earlier revision and nothing reddened. Named
    // exactly rather than as "the destroy commands": `cdkd orphan` spreads
    // `destroyOptions` and so advertises the flag inertly, which that phrasing
    // would have swept in.
    expect(message).toContain('only cdkd destroy and cdkd state destroy act on one');
    // The out-of-band escape hatch, with the ACTUAL log group name interpolated
    // in. Re-added after a review round found it had been dropped: the PHRASES
    // fence below reads the SOURCE, so with this gone, swapping `${physicalId}`
    // for `${logicalId}` reddened nothing while handing the user a command
    // naming a resource that does not exist. Flag spellings verified against
    // `aws logs put-log-group-deletion-protection help` (aws-cli 2.36.19).
    expect(message).toContain(
      `aws logs put-log-group-deletion-protection --log-group-identifier '${PHYSICAL_ID}' --no-deletion-protection-enabled`
    );
    // The message advises DISABLING a safety control, and what happens to the
    // flag afterwards depends on `UpdateReplacePolicy` and on whether the
    // deploy completes — NEITHER of which `update()` can see. Three review
    // rounds each proved a different confident sentence about that mechanism
    // false (see the guard's comment for all three). So the contract pinned
    // here is that the message HANDS OFF rather than narrates: it must send the
    // reader to the doc, and must say why it cannot answer itself.
    expect(message).toContain(
      'Read "Deletion protection blocks a replacement" in docs/cli-deploy-safety.md'
    );
    expect(message).toContain('depend on your UpdateReplacePolicy');
    // ORDER is load-bearing: a hedge the reader meets only AFTER the command
    // they were told to run has already been run is not a hedge. A review round
    // found it trailing the disable instruction.
    expect(
      message.indexOf('docs/cli-deploy-safety.md'),
      'the doc hand-off must come BEFORE the disable command, not after it'
    ).toBeLessThan(message.indexOf('put-log-group-deletion-protection'));
    // And it must NOT go back to narrating. These are the three sentences that
    // were each wrong; a future edit re-adding any of them reds here.
    expect(message).not.toMatch(/re-enable it on the NEW log group/);
    expect(message).not.toMatch(/which the replacement deletes/);
    expect(message).not.toMatch(/stops tracking/);
    // The shared tail is still there — the protection arm must not lose it.
    expect(message).toMatch(/no per-resource granularity/i);
    expect(message).toMatch(/'STANDARD' -> 'INFREQUENT_ACCESS'/);
  });

  it('treats the boolean-as-string shape `"true"` as protected', async () => {
    // A template can carry `DeletionProtectionEnabled: "true"`; a bare
    // `=== true` test would fall through to the dead-ending advice. This is the
    // defect class issue #2521 closed one property over, replacing the
    // sibling retention guard's `typeof === 'number'` test with a coercion —
    // `DeletionProtectionEnabled` was left on the old footing, so it is pinned
    // here rather than repeated.
    const message = await refuse(
      { LogGroupClass: 'INFREQUENT_ACCESS', DeletionProtectionEnabled: 'true' },
      { LogGroupClass: 'STANDARD', DeletionProtectionEnabled: 'true' }
    );
    expect(message).toContain('cdkd deploy has no --remove-protection flag');
  });

  it('leaves the existing advice untouched when the recorded bag has no protection', async () => {
    // The inverse regression a one-sided fence rewards: the unprotected case is
    // the common one, and it must keep the shorter message with no
    // protection wording at all.
    const message = await refuse(
      { LogGroupClass: 'INFREQUENT_ACCESS' },
      { LogGroupClass: 'STANDARD' }
    );
    // Anchored on the unprotected arm's own tail, not its opening clause: the
    // protected arm contains the same clause differing only in case
    // (`then re-deploy with ...`), so a sentence-split reword upstream could
    // make an opening-clause needle satisfiable by the WRONG message.
    expect(message).toContain(
      '(its stored log events are lost), or revert the LogGroupClass change.'
    );
    expect(message).not.toMatch(/DeletionProtection/);
    expect(message).not.toMatch(/remove-protection/);
    expect(message).not.toMatch(/put-log-group-deletion-protection/);
  });

  it('leaves it untouched for an explicit `false` too (the always-present-field case)', async () => {
    // The property is PRESENT with a falsy value on the unprotected path, by
    // two independent routes: a template declaring
    // `DeletionProtectionEnabled: false`, and `cdkd drift --revert`, which
    // passes a `readCurrentState` snapshot as `previousProperties`
    // (`drift.ts` -> `outcome.awsProperties`) — and that snapshot ALWAYS sets
    // this key, because `readCurrentState` emits an explicit `false`
    // placeholder for console-side toggle detection. So a presence check does
    // not merely risk misfiring, it misfires on every reverted log group; the
    // predicate has to test the CONTENT.
    const message = await refuse(
      { LogGroupClass: 'INFREQUENT_ACCESS', DeletionProtectionEnabled: false },
      { LogGroupClass: 'STANDARD', DeletionProtectionEnabled: false }
    );
    // Positive AND negative: a negative-only assertion stays green if the
    // protection arm leaks in under a reword that drops this one literal.
    // Anchored on the unprotected arm's own tail, not its opening clause: the
    // protected arm contains the same clause differing only in case
    // (`then re-deploy with ...`), so a sentence-split reword upstream could
    // make an opening-clause needle satisfiable by the WRONG message.
    expect(message).toContain(
      '(its stored log events are lost), or revert the LogGroupClass change.'
    );
    expect(message).not.toMatch(/remove-protection/);
    expect(message).not.toMatch(/put-log-group-deletion-protection/);
  });

  it('ignores protection that only the DESIRED bag adds (AWS is still unprotected)', async () => {
    // Reading `properties` here would be a FALSE alarm: the template is adding
    // protection in this very deploy, this refusal fires before the flip is
    // applied, so the log group AWS holds is unprotected and the replacement's
    // delete would have gone through.
    const message = await refuse(
      { LogGroupClass: 'INFREQUENT_ACCESS', DeletionProtectionEnabled: true },
      { LogGroupClass: 'STANDARD' }
    );
    // Anchored on the unprotected arm's own tail, not its opening clause: the
    // protected arm contains the same clause differing only in case
    // (`then re-deploy with ...`), so a sentence-split reword upstream could
    // make an opening-clause needle satisfiable by the WRONG message.
    expect(message).toContain(
      '(its stored log events are lost), or revert the LogGroupClass change.'
    );
    expect(message).not.toMatch(/remove-protection/);
    expect(message).not.toMatch(/put-log-group-deletion-protection/);
  });

  it('still warns when the DESIRED bag clears protection but the recorded bag has it', async () => {
    // The mirror image, and the one a desired-bag read would MISS: the user has
    // already edited the template to turn protection off, but the class guard
    // refuses before that update runs, so AWS is still protected and the
    // dead-end is still ahead of them. This is exactly the case the message's
    // "does NOT clear it in the same deploy" sentence exists for.
    const message = await refuse(
      { LogGroupClass: 'INFREQUENT_ACCESS', DeletionProtectionEnabled: false },
      { LogGroupClass: 'STANDARD', DeletionProtectionEnabled: true }
    );
    expect(message).toContain('cdkd deploy has no --remove-protection flag');
    expect(message).toMatch(/does NOT clear it in the same deploy/);
  });
});

/**
 * Connects the refusal's out-of-band remedy to the page that documents it.
 *
 * `docs/cli-deploy-safety.md` quotes the same
 * `aws logs put-log-group-deletion-protection` invocation the protected arm
 * emits, and states the same two facts about it — that `cdkd deploy` has no
 * `--remove-protection`, and that nothing needs re-enabling because the
 * replacement re-creates from the template. Nothing connected those copies, so
 * a reword on either side left the other stale and silent. This is the
 * compile-time half; the runtime half is the `loggroup-class-guard` integ,
 * which greps `cannot be changed after creation` (unchanged by this branch).
 *
 * Deliberately a small set of PHRASES rather than a message comparison: the
 * source builds the message from template literals and the doc hard-wraps its
 * fenced block, so neither side holds it as one contiguous string. Each phrase
 * is asserted UNIQUE in the provider source — a phrase occurring twice goes
 * inert the moment a comment quotes an old wording (the lesson
 * `stateful-replace-message-doc-sync.test.ts` records).
 */
describe('the LogGroupClass protection remedy stays in step with its doc (#2579)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const providerSrc = readFileSync(
    join(repoRoot, 'src', 'provisioning', 'providers', 'logs-loggroup-provider.ts'),
    'utf8'
  );
  const doc = readFileSync(join(repoRoot, 'docs', 'cli-deploy-safety.md'), 'utf8');
  /**
   * Only the doc's FENCED code blocks, whitespace-collapsed.
   *
   * Scoping matters: these phrases are a command the reader is meant to RUN,
   * so prose mentioning them must neither satisfy the fence nor keep it green
   * after the runnable example is deleted. Unscoped, removing the ```bash
   * block while leaving any sentence naming the command — a "do not run this"
   * caveat, say — passes. The sibling
   * `tests/unit/deployment/stateful-replace-message-doc-sync.test.ts` scopes
   * its doc side for the same reason.
   */
  const docFenced = [...doc.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)]
    .map((m) => m[1])
    .join('\n')
    .replace(/\s+/g, ' ');

  const PHRASES = [
    // The remedy call, its target argument, and the flag that makes it a
    // DISABLE — between them, the whole of what a user copies out of the
    // refusal. Deliberately NOT `--remove-protection`: that string appears in
    // this provider THREE times (the message, the comment explaining why the
    // message says it, and `delete()`'s own flip-off block), so pinning it
    // would fail the uniqueness check below — which is the check catching the
    // inert-fence failure mode, not a formality.
    'aws logs put-log-group-deletion-protection',
    '--log-group-identifier',
    '--no-deletion-protection-enabled',
  ] as const;

  it('the phrase set is non-empty (guards the sweep below from passing vacuously)', () => {
    expect(PHRASES.length).toBeGreaterThanOrEqual(3);
  });

  it('the doc SECTION the refusal tells the reader to open still exists', () => {
    // The message hands off with `Read "<section>" in docs/cli-deploy-safety.md`
    // rather than narrating a mechanism it cannot see. That makes the section
    // TITLE load-bearing: rename the heading and the refusal points nowhere,
    // silently. Derived from the source rather than hard-coded on both sides,
    // so this cannot pass by agreeing with itself.
    // `matchAll`, not `exec`: `exec` takes the FIRST match, and this provider
    // carries a 30-line comment ABOVE the remedy explaining why the hand-off
    // exists. A future comment quoting an OLD section title would silently
    // become what this fence validates — the same inert-fence mode the
    // uniqueness check below guards against.
    const matches = [...providerSrc.matchAll(/Read "([^"]+)" in docs\/cli-deploy-safety\.md/g)];
    expect(
      matches.length,
      'expected EXACTLY one doc hand-off in logs-loggroup-provider.ts. ZERO means ' +
        'the refusal no longer sends the reader anywhere — if that was deliberate, ' +
        'drop this fence; if not, the reader has been left with no next step. MORE ' +
        'THAN ONE (typically a comment quoting an older title) makes this fence ' +
        'inert, because it would then validate whichever copy comes first'
    ).toBe(1);
    // No null check below: `toBe(1)` throws, so this line is reached only when
    // exactly one match exists. An `expect(...).not.toBeNull()` here would be
    // dead — it can never fail — and a dead assertion reads as coverage.
    const section = matches[0][1];
    const headings = [...doc.matchAll(/^#{2,6} (.+)$/gm)].map((m) => m[1]);
    expect(
      headings.filter((h) => h.includes(section)),
      `logs-loggroup-provider.ts sends the reader to "${section}"; exactly one heading in ` +
        'docs/cli-deploy-safety.md must contain it — zero means the reference is ' +
        'dangling, more than one means it is ambiguous. Headings: ' +
        headings.join(' | ')
    ).toHaveLength(1);
  });

  for (const phrase of PHRASES) {
    it(`\`${phrase}\` appears in the provider and in docs/cli-deploy-safety.md`, () => {
      const inSource = providerSrc.split(phrase).length - 1;
      expect(
        inSource,
        `"${phrase}" must appear EXACTLY once in logs-loggroup-provider.ts — a second ` +
          'copy (typically a comment quoting an older wording) makes this fence inert'
      ).toBe(1);
      expect(
        docFenced,
        `logs-loggroup-provider.ts emits "${phrase}" but no fenced example in ` +
          'docs/cli-deploy-safety.md contains it — the message and its documented ' +
          'runnable example have to move together'
      ).toContain(phrase);
    });
  }
});
