const TYPE = 'AWS::CodeBuild::Project';

/**
 * Compare a project's `LogsConfig.S3Logs.EncryptionDisabled` with an ABSENT
 * value as `false`, the documented default (go-to-k/cdkd#6659).
 *
 * `BatchGetProjects` omitted `encryptionDisabled` for a project created
 * without a `logsConfig`, and reported `false` after `drift --revert` re-sent
 * the recorded `LogsConfig` without it (measured on real AWS). A baseline
 * captured before that write then read as drifted against the same live
 * setting on every run, and each revert sent the same block again.
 *
 * Only that absent / `false` pair is folded, by completing the absent side
 * with `false`: a `true` on either side is compared as before, so an
 * out-of-band change of the setting still drifts, and `drift --revert`, which
 * sends the returned baseline, sends the `false` explicitly. A side with no
 * `LogsConfig.S3Logs` object (a template baseline that declares none) is left
 * as it is: the comparator does not walk it there. Pure; returns both inputs
 * by identity when nothing applies.
 */
export function canonicalizeDriftPair(
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  if (resourceType !== TYPE) return { baseline, aws };
  const recorded = s3LogsOf(baseline);
  const live = s3LogsOf(aws);
  if (recorded === undefined || live === undefined) return { baseline, aws };
  const recordedValue = recorded['EncryptionDisabled'];
  const liveValue = live['EncryptionDisabled'];
  if (recordedValue === undefined && liveValue === false) {
    return { baseline: withEncryptionDisabledFalse(baseline, recorded), aws };
  }
  if (liveValue === undefined && recordedValue === false) {
    return { baseline, aws: withEncryptionDisabledFalse(aws, live) };
  }
  return { baseline, aws };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function s3LogsOf(bag: Record<string, unknown>): Record<string, unknown> | undefined {
  const logs = bag['LogsConfig'];
  if (!isPlainObject(logs)) return undefined;
  const s3 = logs['S3Logs'];
  return isPlainObject(s3) ? s3 : undefined;
}

function withEncryptionDisabledFalse(
  bag: Record<string, unknown>,
  s3Logs: Record<string, unknown>
): Record<string, unknown> {
  const logs = bag['LogsConfig'] as Record<string, unknown>;
  return {
    ...bag,
    LogsConfig: { ...logs, S3Logs: { ...s3Logs, EncryptionDisabled: false } },
  };
}
