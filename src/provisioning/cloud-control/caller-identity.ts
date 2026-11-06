/**
 * Mask the CALLER's identity out of an AWS-authored failure message, keeping
 * every other word (go-to-k/cdkd#2319).
 *
 * A Cloud Control handler's `StatusMessage` is the text a user needs to fix
 * a template (`Property validation failure: ...`), so cdkd keeps it in the
 * thrown error and therefore in the persisted `RESOURCE_FAILED` event. But an
 * authorization denial in that text quotes who was denied:
 * `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not
 * authorized to perform: ...`. That record outlives the run, so the
 * principal and the account id are masked here and nothing else is.
 *
 * What is masked:
 * - every STS session principal (`assumed-role/...`, `federated-user/...`):
 *   a session is never a resource, so it is the caller wherever it appears;
 * - an IAM `user/...`, `role/...` or `root` principal in the DENIED-PRINCIPAL
 *   position only (`User: <arn>`, `Not authorized: <arn>`, `Access denied:
 *   <arn>`, `AccessDenied: <arn>` or `<arn> is not authorized`), since a role
 *   ARN elsewhere is a resource the template names;
 * - a principal's unique id or access key id (`AROA...:<session>`,
 *   `AIDA...`, `ASIA...`, `AKIA...`), which AWS prints for a deleted principal;
 * - the account id where it is one by POSITION: the account segment of any
 *   ARN (whose service, region and name are kept), a 12-digit run after the
 *   word `account`, `principal` or `owner` or a policy's `"AWS":`, and one embedded in a name, path or host
 *   (`cdk-hnb659fds-assets-<account>-us-east-1`, `AWSLogs/<account>/`,
 *   `<account>.dkr.ecr...`, Lambda's partial `<account>:function:...`).
 *   A free-standing 12-digit number is NOT masked: a validation message
 *   quotes sizes and template values of that length (`maximum: 107374182400`).
 *
 * No classifier reads an ARN or a digit out of this text: the collision,
 * retry and already-deleted needles are ARN-free prose ("already exists",
 * "Rate exceeded", "does not exist", ...), and the masks below never span a
 * space, so they cannot cut one. The raw text is for `--verbose` only.
 */

/** Replaces a masked caller principal ARN. */
export const CALLER_PRINCIPAL_MASK = '<caller-principal>';

/** Replaces a masked 12-digit account id. */
export const ACCOUNT_ID_MASK = '<account-id>';

// IAM / STS name characters (`[\w+=,.@-]`); a path adds `/`. None is a space,
// so a mask ends at the next word, and the last character is never `.` or
// `,`, so the sentence's own punctuation after the ARN survives.
export const NAME = String.raw`[\w+=,.@-]*[\w+=@-]`;

export const PARTITION = String.raw`aws[a-z-]*`;

export const STS_SESSION_PRINCIPAL = new RegExp(
  String.raw`\barn:${PARTITION}:sts::\d{12}:(?:assumed-role/${NAME}/${NAME}|federated-user/${NAME})`,
  'g'
);

export const IAM_PRINCIPAL = String.raw`arn:${PARTITION}:iam::\d{12}:(?:(?:user|role)/(?:[!-.0-~]+/)*${NAME}|root)`;

export const IAM_DENIED_AFTER_USER = new RegExp(String.raw`(\bUser:\s*)${IAM_PRINCIPAL}`, 'g');

// Other authorization lead-ins naming the denied principal
// (`Not authorized: arn:aws:iam::<account>:user/alice`). Only these lead-ins:
// an IAM ARN in a resource position keeps its name.
export const IAM_DENIED_AFTER_LEAD_IN = new RegExp(
  String.raw`(\b(?:Not authorized|Access denied|AccessDenied):\s*)${IAM_PRINCIPAL}`,
  'gi'
);

export const IAM_DENIED_BEFORE_VERB = new RegExp(
  String.raw`\b${IAM_PRINCIPAL}(?=\s+is not authorized)`,
  'g'
);

export const PRINCIPAL_UNIQUE_ID = new RegExp(
  String.raw`\b(?:AROA|AIDA|ASIA|AKIA)[A-Z0-9]{16,17}\b(?::${NAME})?`,
  'g'
);

export const ACCOUNT_IN_ARN = new RegExp(
  String.raw`(\barn:${PARTITION}:[^:\s]*:[^:\s]*:)\d{12}(?=:)`,
  'g'
);

export const ACCOUNT_AFTER_WORD =
  /((?:\b(?:account(?:[ _-]?(?:id|number))?s?|principal(?:[ _-]?id)?|owner(?:[ _-]?id)?)\b|"AWS")[\s:='"#([]*)\d{12}(?![0-9A-Za-z])/gi;

// The next QUOTED id in a list that one of the arms above began
// (`"AWS": ["<a>", "<b>"]`); an unquoted number after a mask is not a list item.
export const ACCOUNT_LIST_NEXT = new RegExp(
  String.raw`(${ACCOUNT_ID_MASK}['"]\s*,\s*['"])\d{12}(?![0-9A-Za-z])`,
  'g'
);

// Inside a name, path or host: after `<letter>-` / `<letter>_` or `/`, or
// before `-<letter>`, `_<letter>`, `.<letter>`, `:<letter>` or `/`. A sign or
// a numeric range (`-107374182400`, `0-549755813888`) is not a name, and the
// 12-hex-digit tail of a request-id UUID (8-4-4-4-12) that is all digits is
// exempt.
export const ACCOUNT_IN_NAME =
  /(?<![0-9A-Za-z])(?<![0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-)(?:(?<=[A-Za-z][-_]|\/)\d{12}(?![0-9A-Za-z])|\d{12}(?=[-_.:][A-Za-z]|\/))/g;

/**
 * `text` with the caller's principal and its account id masked. Apply
 * it to the RAW AWS text, before `displaySafe` or any flattening.
 */
export function maskCallerIdentity(text: string): string {
  let masked = text
    .replace(STS_SESSION_PRINCIPAL, CALLER_PRINCIPAL_MASK)
    .replace(IAM_DENIED_AFTER_USER, `$1${CALLER_PRINCIPAL_MASK}`)
    .replace(IAM_DENIED_AFTER_LEAD_IN, `$1${CALLER_PRINCIPAL_MASK}`)
    .replace(IAM_DENIED_BEFORE_VERB, CALLER_PRINCIPAL_MASK)
    .replace(PRINCIPAL_UNIQUE_ID, CALLER_PRINCIPAL_MASK)
    .replace(ACCOUNT_IN_ARN, `$1${ACCOUNT_ID_MASK}`)
    .replace(ACCOUNT_AFTER_WORD, `$1${ACCOUNT_ID_MASK}`)
    .replace(ACCOUNT_IN_NAME, ACCOUNT_ID_MASK);
  let previous: string;
  do {
    previous = masked;
    masked = masked.replace(ACCOUNT_LIST_NEXT, `$1${ACCOUNT_ID_MASK}`);
  } while (masked !== previous);
  return masked;
}

/**
 * When a Cloud Control operation FAILS with an authorization error whose
 * Java-SDK trailer names a service OTHER than Cloud Control itself
 * ("... (Service: SesV2, Status Code: 403, Request ID: ...)"), the rejection
 * happened inside the AWS-managed resource handler's own downstream call —
 * cdkd's credentials already authenticated to Cloud Control to start the
 * operation, so the caller's local credential setup is not the culprit. The
 * raw StatusMessage reads like a local credential problem and sends users off
 * to debug their own keys (issue #1468: the AWS::SES::EmailIdentity UPDATE
 * handler's SesV2 call 403'd reproducibly while the exact same SesV2
 * operations succeeded when invoked directly with the same credentials).
 * Returns a re-framing hint to append to the failure message, or '' when the
 * shape does not match.
 *
 * Wording constraint: the hint is appended to an error message that
 * downstream matchers test against (isNotFoundMessage above, the
 * retryable-error message table in src/deployment/retryable-errors/patterns.ts), so it
 * must not introduce a "not found" / "does not exist" / "no such" match nor
 * any retryable-pattern substring. Pinned by a unit test.
 */
export function handlerAuthFailureHint(statusMessage: string): string {
  const match = /\(Service:\s*([A-Za-z0-9._-]+)[,;]\s*Status Code:\s*403[,;)]/i.exec(statusMessage);
  if (!match) {
    return '';
  }
  const service = match[1] ?? '';
  // A 403 from Cloud Control itself IS a caller-credential problem — only a
  // downstream service's refusal gets re-framed.
  if (/cloudcontrol/i.test(service)) {
    return '';
  }
  return (
    ` [hint: this 403 was returned by ${service} to the AWS-managed resource handler running the ` +
    `operation, not to cdkd directly — these credentials already passed Cloud Control's own auth ` +
    `to start it. If the equivalent ${service} API call succeeds with the same credentials, the ` +
    `resource handler itself is failing (an upstream AWS issue worth retrying later), not your ` +
    `local credential setup.]`
  );
}

/** How many key names a malformed-model log line may carry. */
export const MAX_LOGGED_MODEL_KEYS = 12;

/**
 * Summarize a JSON document by its KEY NAMES, for a log line that must not
 * carry the document's values (issue #1908).
 *
 * The document failed to parse, so the keys cannot be read structurally; this
 * matches the `"name":` lexical form instead. That is a deliberate trade: the
 * pattern requires the colon, so a bare string VALUE is never reported, and the
 * only way a value reaches the line is if the document contains a string that
 * is itself followed by a colon -- which for an AWS readback means a nested
 * key. Values are what must not leak, and a key-shaped token is not one.
 */
export function describeJsonKeys(document: string): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  const pattern = /"([^"\\]{1,64})"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(document)) !== null) {
    const key = match[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= MAX_LOGGED_MODEL_KEYS) break;
  }
  if (keys.length === 0) return 'no readable key names';
  const suffix =
    pattern.lastIndex < document.length && keys.length >= MAX_LOGGED_MODEL_KEYS ? ', ...' : '';
  return `keys: ${keys.join(', ')}${suffix}`;
}
