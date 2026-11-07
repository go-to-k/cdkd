import type {
  EncryptionConfiguration,
  LoggingConfiguration,
  TracingConfiguration,
} from '@aws-sdk/client-sfn';

/**
 * CloudFormation's `StateMachineRevisionId` for a described state machine.
 * `DescribeStateMachine` omits `revisionId` until the machine is first
 * updated, and CloudFormation then reports `INITIAL` (measured live,
 * 2026-09-25, issue #3627), so the absent value maps to that.
 */
export function stateMachineRevisionId(described: { revisionId?: string | undefined }): string {
  return described.revisionId ?? 'INITIAL';
}

/**
 * Translate a CFn-shape `EncryptionConfiguration` (PascalCase) into the SDK's
 * camelCase shape, or `undefined` if the value is absent / a Class 2
 * empty-object placeholder.
 *
 * `readCurrentState` always-emits `EncryptionConfiguration: {}` on state
 * machines with no encryption — the comparator's top-level walk is
 * state-keys-only, so the placeholder is required to detect a console-side
 * encryption attach.  `cdkd drift --revert` later round-trips that
 * placeholder back through `update()`. AWS rejects an `encryptionConfiguration`
 * whose required `type` field is missing ("Member must not be null"), so an
 * empty placeholder is folded to `undefined` here (no-op on the wire).
 */
export function mapEncryptionConfiguration(value: unknown): EncryptionConfiguration | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const cfg = value as Record<string, unknown>;
  // Class 2 sanitize: empty placeholder => no-op
  if (cfg['Type'] === undefined) return undefined;
  return {
    type: cfg['Type'] as EncryptionConfiguration['type'],
    kmsKeyId: cfg['KmsKeyId'] as string | undefined,
    kmsDataKeyReusePeriodSeconds: cfg['KmsDataKeyReusePeriodSeconds'] as number | undefined,
  };
}

/**
 * Translate a CFn-shape `LoggingConfiguration` (PascalCase) into the SDK's
 * camelCase shape, or `undefined` for the empty placeholder case (no `Level`).
 *
 * `readCurrentState` always-emits `LoggingConfiguration: {}` (no `Level`) on
 * state machines that never configured logging.  Forwarding that placeholder
 * to `UpdateStateMachine` would inadvertently set `level=OFF` and disable
 * logging on a state machine that has logging configured outside cdkd's
 * managed view — fold to `undefined` here so the placeholder round-trip is
 * a no-op.
 */
export function mapLoggingConfiguration(value: unknown): LoggingConfiguration | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const cfg = value as Record<string, unknown>;
  // Class 2 sanitize: empty placeholder (no Level) => no-op
  if (cfg['Level'] === undefined) return undefined;
  const result: LoggingConfiguration = {
    level: cfg['Level'] as LoggingConfiguration['level'],
  };
  if (cfg['IncludeExecutionData'] !== undefined) {
    result.includeExecutionData = cfg['IncludeExecutionData'] as boolean;
  }
  if (Array.isArray(cfg['Destinations'])) {
    result.destinations = (cfg['Destinations'] as Array<Record<string, unknown>>).map((d) => {
      const cwLogs = d['CloudWatchLogsLogGroup'] as Record<string, unknown> | undefined;
      if (cwLogs?.['LogGroupArn'] !== undefined) {
        return {
          cloudWatchLogsLogGroup: { logGroupArn: cwLogs['LogGroupArn'] as string },
        };
      }
      return {};
    });
  }
  return result;
}

/**
 * Translate a CFn-shape `TracingConfiguration` (PascalCase) into the SDK's
 * camelCase shape.  `readCurrentState` always-emits `{ Enabled: false }` (the
 * AWS default), so no Class 2 sanitize is needed — the round-trip simply
 * reaffirms the existing tracing setting.
 */
export function mapTracingConfiguration(value: unknown): TracingConfiguration | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const cfg = value as Record<string, unknown>;
  if (cfg['Enabled'] === undefined) return undefined;
  return { enabled: cfg['Enabled'] as boolean };
}

// ---------------------------------------------------------------------------
// Removal-clear sentinels (issue #978)
//
// `UpdateStateMachine` is patch-style, so omitting a config field keeps the
// current AWS value. These helpers turn a prev-present / new-absent transition
// into the explicit disable payload AWS needs to actually clear the config.
//
// Each is only consulted when the corresponding `map*Configuration(properties[...])`
// returned `undefined` (i.e. the new side carries no meaningful config). The
// `wasMeaningfullyConfigured` guard distinguishes a genuine removal (the prop
// was really set before) from the `readCurrentState` empty-placeholder round-trip
// (`{}` / `{ Enabled: false }`), which must stay a no-op — sending a disable
// sentinel there would spuriously reaffirm the AWS default on every drift-revert.
// ---------------------------------------------------------------------------

/**
 * Return the SDK disable payload for `EncryptionConfiguration` when it was
 * present+configured in the previous properties but is absent/placeholder in
 * the new ones; otherwise `undefined` (no clear needed). `AWS_OWNED_KEY` is
 * the AWS default, so this resets a customer-managed-key config back to default.
 */
export function disabledEncryptionConfigurationOnRemoval(
  previous: unknown,
  next: unknown
): EncryptionConfiguration | undefined {
  if (!wasMeaningfullyConfigured(previous, 'Type')) return undefined;
  if (mapEncryptionConfiguration(next) !== undefined) return undefined;
  return { type: 'AWS_OWNED_KEY' };
}

/**
 * Return the SDK disable payload for `LoggingConfiguration` when it was
 * present+configured in the previous properties but is absent/placeholder in
 * the new ones; otherwise `undefined`. `level: OFF` disables logging;
 * `destinations: []` clears the log destinations (only required when level is
 * not OFF, so an empty list is accepted alongside OFF).
 */
export function disabledLoggingConfigurationOnRemoval(
  previous: unknown,
  next: unknown
): LoggingConfiguration | undefined {
  if (!wasMeaningfullyConfigured(previous, 'Level')) return undefined;
  if (mapLoggingConfiguration(next) !== undefined) return undefined;
  return { level: 'OFF', includeExecutionData: false, destinations: [] };
}

/**
 * Return the SDK disable payload for `TracingConfiguration` when it was
 * present+enabled in the previous properties but is absent/placeholder in the
 * new ones; otherwise `undefined`. `enabled: false` turns X-Ray tracing off.
 *
 * Unlike logging/encryption, the "meaningful" signal here is `Enabled === true`
 * (a previous `{ Enabled: false }` is already the AWS default, so there is
 * nothing to clear).
 */
export function disabledTracingConfigurationOnRemoval(
  previous: unknown,
  next: unknown
): TracingConfiguration | undefined {
  if (previous === null || typeof previous !== 'object') return undefined;
  const prevCfg = previous as Record<string, unknown>;
  if (prevCfg['Enabled'] !== true) return undefined;
  if (mapTracingConfiguration(next) !== undefined) return undefined;
  return { enabled: false };
}

/**
 * True when `value` is an object that carries a defined `discriminatorKey`
 * field (`Level` for logging, `Type` for encryption) — i.e. it was a real,
 * non-placeholder config in the previous properties. The empty-placeholder
 * shape `{}` that `readCurrentState` emits has no discriminator, so it returns
 * false and no clear is emitted.
 */
export function wasMeaningfullyConfigured(value: unknown, discriminatorKey: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  return (value as Record<string, unknown>)[discriminatorKey] !== undefined;
}
