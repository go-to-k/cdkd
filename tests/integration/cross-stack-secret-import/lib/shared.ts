/**
 * The literals BOTH stacks and `verify.sh` have to agree on (issue #1934).
 *
 * They live in one module so the producer's `{{resolve:secretsmanager:...}}`
 * expression, the consumer's `Fn::ImportValue` and the shell assertions cannot
 * drift apart — a mismatch between any two of them would surface as a
 * resolution failure whose message points nowhere near the cause.
 *
 * NAMING RULE FOR THIS FIXTURE: no literal here may CONTAIN the secret
 * plaintext {@link integSecretPlaintext} returns, and the plaintext may not
 * contain any of them. `verify.sh` proves the consumer's state carries no
 * plaintext by grepping the WHOLE state file for that one string, and every
 * literal below is persisted into that same file (stack names, the parameter
 * name, the export name, the descriptions). A literal sharing a substring with
 * the needle would report a leak that is really a collision — indistinguishable
 * from a real one, and the natural response is to go hunting in the redaction
 * code. The two vocabularies are therefore kept disjoint: everything here is
 * spelled `cross-stack` / `crossstack`, and the plaintext is spelled
 * `integ-1934-<run id>`.
 */

/**
 * The Secrets Manager secret the producer creates. A LITERAL, not a name built
 * from `Stack.of(this).account`: an account token renders the dynamic
 * reference as an `Fn::Join` rather than a plain string, and the point of
 * deliverable 4 is a template line a human can read the token off.
 *
 * Secrets Manager names are account+region scoped, so a fixed name cannot
 * collide across accounts, and cdkd's `SecretsManagerSecretProvider.delete`
 * passes `ForceDeleteWithoutRecovery: true`, so a destroyed secret does not
 * hold the name for a 7-day recovery window and block the next run.
 */
export const SECRET_NAME = 'cdkd-crossstack-secret-import';

/** The JSON key inside the secret that the producer exports. */
export const SECRET_JSON_FIELD = 'password';

/** `Output.Export.Name` on the producer; `Fn::ImportValue` argument on the consumer. */
export const EXPORT_NAME = 'CdkdCrossStackSecretPassword';

/** The consumer resource `verify.sh` reads back from AWS. */
export const PARAMETER_NAME = '/cdkd-integ/cross-stack-secret-import/imported-secret';

/**
 * The secret's plaintext.
 *
 * NOT sensitive, and deliberately so: the consumer writes this value into an
 * SSM `String` parameter that `verify.sh` reads back in the clear, which is the
 * only way to prove the consumer shipped the RESOLVED value rather than the
 * literal `{{resolve:...}}` token. Nothing resembling a real credential may
 * ever be put here.
 *
 * The run id makes it unique per run so a parameter left behind by an earlier
 * run cannot satisfy the assertion: a stale value carries the OLD run id and
 * fails. `verify.sh` exports `CDKD_INTEG_RUN_ID` once, before any cdkd
 * invocation, and every cdkd command re-synthesizes this app in a subprocess
 * that inherits `process.env` — so all of them (deploy, the convergence
 * re-deploy, diff) see the same value.
 */
export function integSecretPlaintext(): string {
  const runId = process.env['CDKD_INTEG_RUN_ID'] ?? 'local';
  return `integ-1934-${runId}`;
}

/**
 * `Output.Export.Name` on the CONSUMER, which RE-EXPORTS the value it imported
 * from the producer (issue
 * [#2146](https://github.com/go-to-k/cdkd/issues/2146)).
 *
 * This is what turns the fixture from a two-stack import into a CHAIN: the
 * consumer's template declares this output as `{"Fn::ImportValue":
 * "CdkdCrossStackSecretPassword"}` — no literal `{{resolve:` anywhere in it —
 * which is exactly the shape that defeated scrub's producer-plaintext refusal,
 * since that gate asked only the DIRECT producer's template for an expression.
 */
export const REEXPORT_NAME = 'CdkdCrossStackSecretReexport';

/**
 * The SSM parameter at the END of the chain, written by the chain consumer.
 *
 * Distinct from {@link PARAMETER_NAME} so both consumers can be read back
 * independently and neither can stand in for the other.
 */
export const CHAIN_PARAMETER_NAME = '/cdkd-integ/cross-stack-secret-import/chained-secret';

/**
 * `Output.Export.Name` of the producer's CONDITIONAL export (issue
 * [#2150](https://github.com/go-to-k/cdkd/issues/2150)).
 *
 * Its `Value` is an `Fn::If` whose TRUE arm is a literal
 * `{{resolve:secretsmanager:...}}` expression and whose FALSE arm is the plain
 * {@link CONDITIONAL_PLAIN_VALUE}. The condition is a literal-false
 * `Fn::Equals`, so the deployed value is ALWAYS the plain branch -- no
 * parameter, no per-run variation, nothing to get wrong at deploy time.
 *
 * WHY THAT SHAPE STRANDS A STACK. `producerPublishesSecretExpression` used to
 * answer "is this export secret-bearing?" with
 * `JSON.stringify(value).includes('{{resolve:')`, which sees BOTH arms. The
 * verdict was `declared`; the discriminator then read the producer's STORED
 * value, found the plain branch, concluded the producer had not been scrubbed,
 * and raised `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`. That refusal is
 * UNCLEARABLE -- no `cdkd scrub` of the producer can turn the plain branch into
 * an expression, and there is no bypass flag -- so every other secret in the
 * importing stack was stranded with it.
 */
export const CONDITIONAL_EXPORT_NAME = 'CdkdCrossStackConditionalSecret';

/**
 * The FALSE branch's value: what AWS and cdkd actually store for
 * {@link CONDITIONAL_EXPORT_NAME}.
 *
 * Spelled in the fixture's `crossstack` vocabulary per the naming rule at the
 * top of this file: it lands in the consumer's state.json, which `verify.sh`
 * greps whole for the plaintext needle, so it must share no substring with it.
 * It carries no `{{resolve:` of its own, which is the point -- the stored value
 * having no expression is what turned the wrong verdict into a refusal.
 */
export const CONDITIONAL_PLAIN_VALUE = 'crossstack-conditional-plain-branch';
