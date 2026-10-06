/**
 * The literals the producer stack, the consumer stack and `verify.sh` agree on
 * for the secret-bearing cross-stack arm (issue #2056).
 *
 * The secret name is a LITERAL, not built from an account token, so the
 * `{{resolve:secretsmanager:...}}` expression renders as one plain string —
 * which is also what lets the consumer's SAME-stack reference resolve with no
 * state flag at all. Secrets Manager names are account+region scoped, and
 * cdkd's secret provider deletes with `ForceDeleteWithoutRecovery`, so a
 * destroyed secret does not hold the name for the next run.
 */
export const SECRET_NAME = 'cdkd-local-invoke-from-state-2056';

/** The JSON key inside the secret. */
export const SECRET_JSON_FIELD = 'password';

/** `Output.Export.Name` on the producer; `Fn::ImportValue` argument on the consumer. */
export const EXPORT_NAME = 'CdkdLocalInvokeFromStateSecretPassword';

/** The producer stack's name. */
export const PRODUCER_STACK = 'CdkdLocalInvokeFromStateProducer';

/**
 * The secret's plaintext: fixture data, NOT a credential. It is unique per run
 * (`verify.sh` exports `CDKD_INTEG_RUN_ID` before any cdkd command, and every
 * synth subprocess inherits it), so a value left from an earlier run cannot
 * satisfy an assertion, and it shares no substring with any other literal the
 * fixture prints, so a grep for it in a log cannot match by collision.
 */
export function integSecretPlaintext(): string {
  return `itest-2056-${process.env['CDKD_INTEG_RUN_ID'] ?? 'local'}`;
}

/** The dynamic reference both stacks spell: the producer output and the same-stack env value. */
export function secretReference(): string {
  return `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:${SECRET_JSON_FIELD}::}}`;
}
