import type { Configuration, InstanceTypeConfig, StepConfig } from '@aws-sdk/client-emr';

/**
 * CFn -> SDK shape converters for the two `AWS::EMR::*` nested blobs whose CFn
 * key spelling diverges from the `@aws-sdk/client-emr` model (issue #1383).
 *
 * | CFn key                                          | SDK member                     |
 * | ------------------------------------------------ | ------------------------------ |
 * | `Configuration.ConfigurationProperties`           | `Configuration.Properties`     |
 * | `HadoopJarStepConfig.StepProperties`              | `HadoopJarStepConfig.Properties` |
 *
 * Both are plain renames — the VALUE shapes already match (`Record<string,string>`
 * for the former, `KeyValue[]` for the latter, verified against the live CFn
 * registry schema on 2026-08-09). The AWS SDK v3 serializer drops unknown
 * members, so before this conversion every EMR application configuration
 * (spark-defaults / hive-site / yarn-site ...) silently vanished while cdkd
 * reported the deploy as successful.
 *
 * `Configurations` nests into itself, so the rename is applied at EVERY level.
 * Non-object / non-array inputs (an unresolved intrinsic, a malformed template)
 * pass through untouched so this layer never turns a bad template into a
 * confusing crash — AWS surfaces the real validation error instead.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSdkConfiguration(raw: unknown): Configuration {
  if (!isRecord(raw)) return raw as Configuration;

  const { ConfigurationProperties, Configurations, ...rest } = raw;
  return {
    ...rest,
    ...(ConfigurationProperties !== undefined ? { Properties: ConfigurationProperties } : {}),
    ...(Configurations !== undefined
      ? { Configurations: toSdkConfigurations(Configurations) }
      : {}),
  } as Configuration;
}

/**
 * CFn `Configurations` list -> SDK `Configuration[]`, renaming
 * `ConfigurationProperties` -> `Properties` at every nesting level.
 */
export function toSdkConfigurations(value: unknown): Configuration[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value as Configuration[];
  return value.map(toSdkConfiguration);
}

/**
 * CFn `Steps` list -> SDK `StepConfig[]`, renaming
 * `HadoopJarStep.StepProperties` -> `HadoopJarStep.Properties`.
 */
export function toSdkStepConfigs(value: unknown): StepConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value as StepConfig[];

  return value.map((step) => {
    if (!isRecord(step)) return step as StepConfig;
    const hadoopJarStep = step['HadoopJarStep'];
    if (!isRecord(hadoopJarStep) || hadoopJarStep['StepProperties'] === undefined) {
      return step as unknown as StepConfig;
    }
    const { StepProperties, ...restHadoopJarStep } = hadoopJarStep;
    return {
      ...step,
      HadoopJarStep: { ...restHadoopJarStep, Properties: StepProperties },
    } as unknown as StepConfig;
  });
}

/**
 * CFn `InstanceTypeConfigs` list -> SDK `InstanceTypeConfig[]`, converting each
 * element's nested per-instance-type `Configurations`.
 */
export function toSdkInstanceTypeConfigs(value: unknown): InstanceTypeConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value as InstanceTypeConfig[];

  return value.map((instanceTypeConfig) => {
    if (!isRecord(instanceTypeConfig) || instanceTypeConfig['Configurations'] === undefined) {
      return instanceTypeConfig as InstanceTypeConfig;
    }
    return {
      ...instanceTypeConfig,
      Configurations: toSdkConfigurations(instanceTypeConfig['Configurations']),
    } as InstanceTypeConfig;
  });
}
