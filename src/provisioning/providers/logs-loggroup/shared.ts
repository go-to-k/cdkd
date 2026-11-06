import { ProvisioningError } from '../../../utils/error-handler.js';

export const LOG_GROUP_TYPE = 'AWS::Logs::LogGroup';

/**
 * A log group NAME (1-512 of `A-Z a-z 0-9 . - _ / #`, CloudWatch Logs'
 * `logGroupName` pattern): the physical id this provider records. The
 * identity answers (`isSameResource`, `resourceIdentity`) refuse anything
 * else, an ARN included: this provider never records one.
 */
export function isLogGroupName(id: string): boolean {
  return /^[A-Za-z0-9._/#-]{1,512}$/.test(id);
}

/**
 * Whether a raw `RetentionInDays` is CloudFormation's spelling of "no
 * retention" — the shapes the send path SKIPS on create and routes to
 * `DeleteRetentionPolicy` on update, rather than refusing.
 *
 * MEASURED, not read off the docs (issue
 * [#2699](https://github.com/go-to-k/cdkd/issues/2699), live CloudFormation
 * A/B on `AWS::Logs::LogGroup`, us-east-1, 2026-09-14; the full table is on
 * `toCfnInteger` in `../../dynamodb-warm-throughput.ts`): an ABSENT property, an
 * EMPTY string and a WHITESPACE-ONLY string are all accepted by CloudFormation
 * and all REMOVE the live retention policy. Nothing else in the falsy family
 * is: `false`, `0`, `"0"` and `null` are every one REJECTED (the first three by
 * the Logs handler, `null` at `update-stack` itself), so routing them here
 * would make cdkd delete a live retention on a template CloudFormation refuses
 * to deploy. They go to {@link assertUsableRetention}.
 *
 * The ONE cdkd-side exception is a numeric `0` when `desiredFromAwsReadback`
 * is set. `0` is what {@link LogsLogGroupProvider.readCurrentState} records for
 * a log group with no retention policy — cdkd's OWN never-expire spelling,
 * persisted into `observedProperties` at every deploy — and `cdkd drift
 * --revert` hands `update()` that baseline as the DESIRED bag. Reverting a
 * console-added retention on a never-expiring log group is therefore desired
 * `0` over live `30`, and it must reach the delete arm; refusing it would leave
 * `--revert` unable to undo exactly the drift it reports. `UpdateContext`'s
 * own contract licenses this reading and nothing wider: the flag says every
 * value in the bag describes what AWS held, so `0` there is a report of "no
 * retention", not a template's request. On the template path `0` stays
 * refused, matching CloudFormation. `"0"` is never cdkd-produced (the readback
 * writes a number) and is refused everywhere.
 */
export function isAbsentRetention(raw: unknown, desiredFromAwsReadback: boolean): boolean {
  if (raw === undefined) return true;
  if (typeof raw === 'string' && raw.trim() === '') return true;
  return desiredFromAwsReadback && raw === 0;
}

/**
 * Refuse a `RetentionInDays` the send path cannot USE (issues [#2521],
 * [#2698], [#2699]).
 *
 * **The scope of this refusal is a TEST, not a paragraph.** Every review round
 * on issue [#2521] found a hole in a PROSE statement of it — a coercible
 * negative that fell through to `DeleteRetentionPolicy`, an unusable value
 * silenced by the wrong change gate, wrong cells in the hand-written table
 * that replaced those sentences, and then the one non-finite number
 * JavaScript makes FALSY. No count is given here: the count itself drifted
 * between this comment and the changelog, which is the same failure one level
 * up. The table now lives in
 * `tests/unit/provisioning/logs-loggroup-provider-retention-coercion.test.ts`
 * as `CREATE_MATRIX` / `UPDATE_MATRIX`: one row per (value, previous) pair,
 * each asserting which AWS call goes out, each carrying what the pre-#2521
 * code did. Read a change against those rows and add one for any pair they do
 * not cover; do not restate the rule here, because a fourth restatement is
 * the thing that keeps being wrong.
 *
 * What IS stated here is the RULE the rows pin, because since issues #2698 /
 * #2699 it is a measurement rather than a guess: the value is read through
 * `toCfnInteger` — CloudFormation's own Integer grammar, `optional sign +
 * decimal digits`, surrounding whitespace trimmed — and anything that grammar
 * rejects is refused here where CloudFormation would have refused it at
 * deploy time. The pre-#2698 reader was `Number()`, which FORWARDED `'0x1e'`
 * as 30 and `'30.5'` as 30.5 on a template CloudFormation rejects outright.
 * Five refusal ARMS, each with its own `detail` clause; only the WHY of each:
 *
 *  - **a non-finite NUMBER** (`NaN`, `Infinity`, `-Infinity`). Unreachable in
 *    production — both bags are `JSON.parse` output, which cannot express one —
 *    and kept as defence so the family is named whole. Sits BEFORE the null /
 *    type arms because `NaN` is a number whose siblings were already refused.
 *  - **`null`**. CloudFormation rejects it at `update-stack` (`'null' values
 *    are not allowed in templates`), and cdkd's own resolver never
 *    manufactures one for this key: an `AWS::NoValue` — bare or as an `Fn::If`
 *    branch — OMITS the property (`intrinsic-function-resolver.ts`,
 *    `resolveValue`'s object arm), so `null` arriving here is a literal the
 *    template wrote, not cdkd's spelling of absent. Issue #2521 left it in the
 *    delete arm on the guess that it was; the measurement settled it.
 *  - **not a CloudFormation Integer at all** (`'abc'`, `'0x1e'`, `'1e3'`,
 *    `'30.5'`, `[]`, `{}`, `true`, `false`). The pre-coercion code handed the
 *    raw value to `PutRetentionPolicyCommand` and CloudWatch Logs rejected it;
 *    refusing moves that rejection one layer earlier and names the property.
 *    `false` joined this arm with #2699 — it was in the delete arm before, on
 *    the same guess as `null`.
 *  - **ZERO** (`0`, `'0'`). The Logs handler rejects it by enum (`Valid values
 *    are: [1, 3, 5, ...]`), so it is not CloudFormation's never-expire — the
 *    ABSENT property or an empty string is. Numeric `0` under
 *    `desiredFromAwsReadback` never reaches this arm; see
 *    {@link isAbsentRetention} for why that one is cdkd's own spelling.
 *  - **a NEGATIVE number** (`-1`, `'-1'`). It coerces, so a refusal gated on
 *    coercibility alone let it through; it then failed the `> 0` send test and
 *    fell into the UPDATE path's `else`, which issues
 *    `DeleteRetentionPolicy` — a template typo SILENTLY REMOVING a live
 *    retention where the old code sent `-1` and failed loudly.
 *
 * The message names the value's TYPE and never the value. A provider's
 * `properties` bag arrives with dynamic references already RESOLVED, so a
 * `{{resolve:secretsmanager:...}}` scalar is PLAINTEXT by the time it reaches
 * here, and this function has no masker threaded
 * (`.claude/rules/provider-masking.md`). Interpolating it as
 * `${JSON.stringify(raw)}` was the first draft and
 * `vp run audit:provider-secret-mask:check` refused it — but read that as one
 * SPELLING being fenced, not the rule: the critic's population is
 * interpolated `JSON.stringify` calls, so a bare `${raw}` here would leave it
 * green. Do not put the value back without threading the capability first.
 *
 * The caller decides the ABSENT family FIRST, through {@link isAbsentRetention},
 * and never calls this for one: an absent value is not an error, and the
 * readback-only reading of `0` lives in that predicate rather than here, so
 * the zero arm below can stay unconditional.
 */
export function assertUsableRetention(
  raw: unknown,
  coerced: number | undefined,
  logicalId: string,
  resourceType: string
): void {
  const detail = (() => {
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      return 'the template declares a non-finite number';
    }
    if (raw === null) {
      return (
        "the template declares null, which CloudFormation rejects ('null' values are not " +
        'allowed in templates); to declare no retention, omit the property'
      );
    }
    if (coerced === undefined) {
      if (typeof raw === 'string') {
        return (
          'the template declares a string that is not a CloudFormation Integer (hex, ' +
          'exponent and decimal-point spellings are rejected, as they are by CloudFormation)'
        );
      }
      return `the template's value is of type ${Array.isArray(raw) ? 'array' : typeof raw}`;
    }
    if (coerced === 0) {
      return (
        'the template declares zero, which CloudWatch Logs rejects; to declare no retention, ' +
        'omit the property or declare an empty string'
      );
    }
    if (coerced < 0) return 'the template declares a negative number';
    return undefined;
  })();
  if (detail === undefined) return;
  throw new ProvisioningError(
    `${logicalId} (${resourceType}): RetentionInDays must be a positive CloudFormation Integer ` +
      `(optional sign then decimal digits, as a number or a string — 30 or '30'); ${detail}`,
    resourceType,
    logicalId
  );
}
