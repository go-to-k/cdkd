import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  GetFunctionCommand,
  GetFunctionConcurrencyCommand,
  GetFunctionRecursionConfigCommand,
  GetFunctionCodeSigningConfigCommand,
  GetRuntimeManagementConfigCommand,
  GetFunctionScalingConfigCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { LATEST_PUBLISHED, SEPARATELY_APPLIED_KEYS } from './shared.js';

/**
 * go-to-k/cdkd#5487: `readCurrentState`, except that a setting read by its
 * own call (concurrency, recursion, runtime management, code signing) is
 * read STRICTLY when it is unsettled: `readCurrentState` omits it on a failed
 * read, which the engine would take as "not set" and converge to the wrong
 * side. A `ResourceNotFoundException` on such a call means "not set".
 */
export async function readUnsettled(
  this: LambdaFunctionProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const live = await this.readCurrentState(physicalId, logicalId, resourceType);
  if (typeof live !== 'object' || live === null) return live;
  const out: Record<string, unknown> = { ...live };
  const strict = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  };
  const set = (key: string, value: unknown): void => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  if (names.has('ReservedConcurrentExecutions')) {
    const r = await strict(() =>
      this.lambdaClient.send(new GetFunctionConcurrencyCommand({ FunctionName: physicalId }))
    );
    set('ReservedConcurrentExecutions', r?.ReservedConcurrentExecutions);
  }
  if (names.has('RecursiveLoop')) {
    const r = await strict(() =>
      this.lambdaClient.send(new GetFunctionRecursionConfigCommand({ FunctionName: physicalId }))
    );
    set('RecursiveLoop', r?.RecursiveLoop);
  }
  if (names.has('RuntimeManagementConfig')) {
    const r = await strict(() =>
      this.lambdaClient.send(new GetRuntimeManagementConfigCommand({ FunctionName: physicalId }))
    );
    set(
      'RuntimeManagementConfig',
      r?.UpdateRuntimeOn === undefined
        ? undefined
        : {
            UpdateRuntimeOn: r.UpdateRuntimeOn,
            ...(r.RuntimeVersionArn !== undefined && { RuntimeVersionArn: r.RuntimeVersionArn }),
          }
    );
  }
  if (names.has('CodeSigningConfigArn')) {
    const r = await strict(() =>
      this.lambdaClient.send(new GetFunctionCodeSigningConfigCommand({ FunctionName: physicalId }))
    );
    set('CodeSigningConfigArn', r?.CodeSigningConfigArn);
  }
  if (names.has('FunctionScalingConfig')) {
    const r = await strict(() =>
      this.lambdaClient.send(
        new GetFunctionScalingConfigCommand({
          FunctionName: physicalId,
          Qualifier: LATEST_PUBLISHED,
        })
      )
    );
    set(
      'FunctionScalingConfig',
      r?.RequestedFunctionScalingConfig ?? r?.AppliedFunctionScalingConfig
    );
  }
  return out;
}

/**
 * go-to-k/cdkd#5487: while the function reads `State: Pending` or
 * `LastUpdateStatus: InProgress`, an unsettled configuration or code key is
 * still changing; the separately-applied ones (`Tags`, concurrency,
 * recursion, code signing, runtime management) are not. A failed read keeps
 * every name, which only costs the next deploy a re-send.
 */
export async function unsettledInTransition(
  this: LambdaFunctionProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  names: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  try {
    const resp = await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: physicalId }));
    const cfg = resp.Configuration;
    if (cfg?.State !== 'Pending' && cfg?.LastUpdateStatus !== 'InProgress') return new Set();
    return new Set([...names].filter((name) => !SEPARATELY_APPLIED_KEYS.has(name)));
  } catch {
    return names;
  }
}

/**
 * Read the AWS-current Lambda function configuration in CFn-property shape.
 *
 * Issues a single `GetFunction` and surfaces the same property keys
 * `create()` accepts (`Runtime`, `Handler`, `Role`, `Timeout`, `MemorySize`,
 * `Description`, `Environment`, `Layers`, `Architectures`, `PackageType`,
 * `TracingConfig`, `EphemeralStorage`, `VpcConfig`, `DeadLetterConfig`,
 * `KmsKeyArn`, `FileSystemConfigs`, `ImageConfig`, `SnapStart`,
 * `LoggingConfig`, plus the physical `FunctionName`). The drift comparator
 * only descends into keys
 * present in
 * cdkd state, so AWS-managed fields (timestamps, FunctionArn, RevisionId,
 * etc.) are filtered at compare time — we still avoid serializing them on
 * the wire.
 *
 * `Code.S3Bucket` / `Code.S3Key` / `Code.S3ObjectVersion` / `Code.ZipFile`
 * are not surfaced: `GetFunction` returns a pre-signed S3 URL for the
 * deployed code, not the asset hash cdkd state holds, so they could
 * never match. Those keys are declared via `getDriftUnknownPaths` so
 * the drift comparator skips them, along with `Code.S3ObjectStorageMode`
 * (no read-back member) and `Code.SourceKMSKeyArn` (see
 * `getDriftUnknownPaths`). `Code.ImageUri` IS surfaced for
 * container Lambdas (`PackageType: 'Image'`) — AWS returns it on the
 * `GetFunction.Code.ImageUri` field, so a console-side image swap is
 * detectable as drift.
 *
 * `Tags` is surfaced from the `Tags` map on the same `GetFunction`
 * response. CDK's auto-injected `aws:cdk:*` tags (which AWS happily
 * returns) are filtered out by `normalizeAwsTagsToCfn` so they don't
 * fire false-positive drift against state. The result key is omitted
 * entirely when AWS reports no user tags, matching `create()`'s
 * behavior of only sending `Tags` when the user explicitly passes
 * them.
 *
 * Returns `RESOURCE_NOT_FOUND` when the function is gone (`ResourceNotFoundException`).
 */
export async function readCurrentState(
  this: LambdaFunctionProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  try {
    const resp = await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: physicalId }));
    const cfg = resp.Configuration;
    if (!cfg) return undefined;

    const result: Record<string, unknown> = {};

    if (cfg.FunctionName !== undefined) result['FunctionName'] = cfg.FunctionName;
    if (cfg.Runtime !== undefined) result['Runtime'] = cfg.Runtime;
    if (cfg.Handler !== undefined) result['Handler'] = cfg.Handler;
    if (cfg.Role !== undefined) result['Role'] = cfg.Role;
    if (cfg.Timeout !== undefined) result['Timeout'] = cfg.Timeout;
    if (cfg.MemorySize !== undefined) result['MemorySize'] = cfg.MemorySize;
    result['Description'] = cfg.Description ?? '';
    result['Environment'] = { Variables: cfg.Environment?.Variables ?? {} };
    // GetFunction returns Layers as [{Arn, CodeSize, ...}]; CFn shape
    // is a flat string[] of ARNs.
    result['Layers'] = (cfg.Layers ?? []).map((l) => l.Arn).filter((arn): arn is string => !!arn);
    result['Architectures'] = cfg.Architectures ? [...cfg.Architectures] : [];
    if (cfg.PackageType !== undefined) result['PackageType'] = cfg.PackageType;
    // Code.ImageUri is surfaced for container Lambdas only. AWS returns
    // `Code.ImageUri` on `GetFunction.Code.ImageUri` for Image-package
    // functions; ZIP-package functions return a pre-signed S3 URL on
    // `Code.Location` which is NOT the asset key cdkd state carries
    // (the ZIP-side sub-paths stay declared via getDriftUnknownPaths).
    // The Code subtree is only emitted when AWS reports an ImageUri so
    // ZIP-package functions don't get a misleading `Code: {}` placeholder.
    if (resp.Code?.ImageUri !== undefined) {
      result['Code'] = { ImageUri: resp.Code.ImageUri };
    }
    result['TracingConfig'] = { Mode: cfg.TracingConfig?.Mode ?? 'PassThrough' };
    if (cfg.EphemeralStorage?.Size !== undefined) {
      result['EphemeralStorage'] = { Size: cfg.EphemeralStorage.Size };
    }
    // Always emit VpcConfig so a console-side VPC attach is detected even
    // when the function was deployed without VpcConfig (Lambda's
    // GetFunction returns VpcConfig with empty arrays for non-VPC
    // functions; that empty shape becomes our placeholder).
    // AWS's GetFunction sometimes returns Ipv6AllowedForDualStack=undefined
    // and sometimes false (the default) for the same non-VPC function —
    // observed empirically after UpdateFunctionConfiguration. Emit it
    // unconditionally with `?? false` so the comparator sees a stable
    // shape and doesn't fire false-positive drift on every other
    // refresh.
    result['VpcConfig'] = {
      SubnetIds: cfg.VpcConfig?.SubnetIds ? [...cfg.VpcConfig.SubnetIds] : [],
      SecurityGroupIds: cfg.VpcConfig?.SecurityGroupIds ? [...cfg.VpcConfig.SecurityGroupIds] : [],
      Ipv6AllowedForDualStack: cfg.VpcConfig?.Ipv6AllowedForDualStack ?? false,
    };

    // The following fields are emitted ONLY when AWS reports a value (unlike
    // the always-emit placeholders above). AWS echoes back exactly what
    // create()/update() sent, so emit-when-present cannot drop a
    // user-templated value, and the drift comparator's state-keys-only
    // top-level walk ignores any key not present in state — so emitting an
    // AWS-default value the user never templated (e.g. SnapStart.ApplyOn=None)
    // never fires false-positive drift. Emitting them unconditionally would
    // instead break the "AWS minimum response" key-set regression test
    // (lambda-function-provider-readcurrentstate.test.ts).
    if (cfg.DeadLetterConfig?.TargetArn !== undefined) {
      result['DeadLetterConfig'] = { TargetArn: cfg.DeadLetterConfig.TargetArn };
    }
    // CFn names this `KmsKeyArn`; GetFunction returns it as `KMSKeyArn`.
    if (cfg.KMSKeyArn !== undefined) {
      result['KmsKeyArn'] = cfg.KMSKeyArn;
    }
    if (cfg.FileSystemConfigs !== undefined && cfg.FileSystemConfigs.length > 0) {
      result['FileSystemConfigs'] = cfg.FileSystemConfigs.map((f) => ({
        Arn: f.Arn,
        LocalMountPath: f.LocalMountPath,
      }));
    }
    // Container Lambdas: GetFunction nests ImageConfig under ImageConfigResponse.
    const imageConfig = cfg.ImageConfigResponse?.ImageConfig;
    if (imageConfig !== undefined) {
      const ic: Record<string, unknown> = {};
      if (imageConfig.EntryPoint !== undefined) ic['EntryPoint'] = [...imageConfig.EntryPoint];
      if (imageConfig.Command !== undefined) ic['Command'] = [...imageConfig.Command];
      if (imageConfig.WorkingDirectory !== undefined)
        ic['WorkingDirectory'] = imageConfig.WorkingDirectory;
      if (Object.keys(ic).length > 0) result['ImageConfig'] = ic;
    }
    if (cfg.SnapStart?.ApplyOn !== undefined) {
      // CFn SnapStart is { ApplyOn } only; OptimizationStatus is AWS-managed.
      result['SnapStart'] = { ApplyOn: cfg.SnapStart.ApplyOn };
    }
    // AWS always returns LoggingConfig (even for the Text-format default), so
    // this is effectively emit-always on real AWS — but the comparator's
    // state-keys-only walk ignores it unless the user templated LoggingConfig.
    // Emit only the user-controllable sub-fields (LogGroup is templatable too);
    // ApplicationLogLevel / SystemLogLevel only apply to JSON format and AWS
    // omits them under Text, so they stay emit-when-present.
    if (cfg.LoggingConfig?.LogFormat !== undefined) {
      const lc: Record<string, unknown> = { LogFormat: cfg.LoggingConfig.LogFormat };
      if (cfg.LoggingConfig.ApplicationLogLevel !== undefined)
        lc['ApplicationLogLevel'] = cfg.LoggingConfig.ApplicationLogLevel;
      if (cfg.LoggingConfig.SystemLogLevel !== undefined)
        lc['SystemLogLevel'] = cfg.LoggingConfig.SystemLogLevel;
      if (cfg.LoggingConfig.LogGroup !== undefined) lc['LogGroup'] = cfg.LoggingConfig.LogGroup;
      result['LoggingConfig'] = lc;
    }

    // DurableConfig / TenancyConfig ride on the SAME GetFunction response
    // (both are members of `FunctionConfiguration`), so they need no extra
    // call — emit-when-present like the block above. Live readback shapes
    // (us-east-1, 2026-08-11): `{RetentionPeriodInDays, ExecutionTimeout}`
    // and `{TenantIsolationMode}`, i.e. the CFn spellings verbatim.
    if (cfg.DurableConfig !== undefined) {
      const dc: Record<string, unknown> = {};
      if (cfg.DurableConfig.ExecutionTimeout !== undefined)
        dc['ExecutionTimeout'] = cfg.DurableConfig.ExecutionTimeout;
      if (cfg.DurableConfig.RetentionPeriodInDays !== undefined)
        dc['RetentionPeriodInDays'] = cfg.DurableConfig.RetentionPeriodInDays;
      if (Object.keys(dc).length > 0) result['DurableConfig'] = dc;
    }
    if (cfg.TenancyConfig?.TenantIsolationMode !== undefined) {
      result['TenancyConfig'] = { TenantIsolationMode: cfg.TenancyConfig.TenantIsolationMode };
    }

    // A Managed Instances function: the attachment rides on this response,
    // the scaling settings have their own read of the version they apply to.
    // AWS reports the request until it is applied, then only the applied one.
    if (cfg.CapacityProviderConfig !== undefined) {
      result['CapacityProviderConfig'] = cfg.CapacityProviderConfig;
      try {
        const scaling = await this.lambdaClient.send(
          new GetFunctionScalingConfigCommand({
            FunctionName: physicalId,
            Qualifier: LATEST_PUBLISHED,
          })
        );
        const live = scaling.RequestedFunctionScalingConfig ?? scaling.AppliedFunctionScalingConfig;
        if (live !== undefined) result['FunctionScalingConfig'] = live;
      } catch (scalingErr) {
        if (!(scalingErr instanceof ResourceNotFoundException)) {
          // WARN for the same reason as RuntimeManagementConfig below.
          this.logger.warn(
            safeMsg`GetFunctionScalingConfig failed for ${physicalId} — FunctionScalingConfig omitted from the drift snapshot (may surface as a false removal): ${describeAwsFailure(scalingErr).summary}`
          );
        }
      }
    }

    // Tags: GetFunction returns a map keyed by tag name. Filter
    // CDK / aws:* auto-tags, re-shape to CFn's `[{Key, Value}]`, and
    // omit the key entirely when AWS reports no user tags (matches
    // `create()`'s behavior of only sending Tags when the template
    // carries them).
    const tags = normalizeAwsTagsToCfn(resp.Tags);
    result['Tags'] = tags;

    // RecursiveLoop lives on a SEPARATE control-plane API
    // (GetFunctionRecursionConfig), not on GetFunction. Issue the
    // extra call and emit-when-present (AWS returns the default
    // 'Terminate' if the function never had the prop set; the drift
    // comparator's state-keys-only walk ignores the field unless
    // state carries it, so the always-emit shape from AWS does not
    // produce false-positive drift on functions that never used
    // RecursiveLoop).
    try {
      const rlResp = await this.lambdaClient.send(
        new GetFunctionRecursionConfigCommand({ FunctionName: physicalId })
      );
      if (rlResp.RecursiveLoop !== undefined) {
        result['RecursiveLoop'] = rlResp.RecursiveLoop;
      }
    } catch (rlErr) {
      // Non-fatal: tolerate transient access failures on the
      // secondary read so the primary read still produces a usable
      // snapshot. The drift report just omits RecursiveLoop on the
      // (rare) failure.
      if (!(rlErr instanceof ResourceNotFoundException)) {
        this.logger.debug(
          `GetFunctionRecursionConfig failed for ${physicalId}: ${describeAwsFailure(rlErr).detail}`
        );
      }
    }

    // ReservedConcurrentExecutions: a SEPARATE control-plane read
    // (GetFunctionConcurrency), emit-when-present. AWS returns an
    // empty response (no `ReservedConcurrentExecutions` field) for
    // functions that never set the limit, so a zero / undefined
    // response correctly maps to omit-from-readback — no phantom
    // drift on the typical un-throttled function.
    try {
      const pcResp = await this.lambdaClient.send(
        new GetFunctionConcurrencyCommand({ FunctionName: physicalId })
      );
      if (pcResp.ReservedConcurrentExecutions !== undefined) {
        result['ReservedConcurrentExecutions'] = pcResp.ReservedConcurrentExecutions;
      }
    } catch (pcErr) {
      if (!(pcErr instanceof ResourceNotFoundException)) {
        this.logger.debug(
          `GetFunctionConcurrency failed for ${physicalId}: ${describeAwsFailure(pcErr).detail}`
        );
      }
    }

    // Runtime-management controls and code signing apply to managed-runtime
    // ZIP functions only. Container-image functions own their runtime in the
    // image and do not support Lambda code signing, so AWS rejects both
    // secondary reads with `InvalidParameterValueException` (the write side
    // refuses the same two properties: `refuseImageFunctionUnsupported`).
    // Skipping them when GetFunction already identified the package as Image
    // saves two calls per readback and the two spurious `... failed`
    // warnings (neither rejection is a `ResourceNotFoundException`) each
    // drift snapshot of an image function printed. It prevents no false removal: AWS never
    // accepted either property on an image, so no baseline can carry them.
    if (cfg.PackageType !== 'Image') {
      // RuntimeManagementConfig: a SEPARATE control-plane read
      // (GetRuntimeManagementConfig), emit-when-present. AWS returns the
      // default `UpdateRuntimeOn: 'Auto'` for functions that never set it;
      // the comparator's state-keys-only walk ignores the field unless state
      // carries it, so the always-emit shape produces no phantom drift.
      try {
        const rmResp = await this.lambdaClient.send(
          new GetRuntimeManagementConfigCommand({ FunctionName: physicalId })
        );
        if (rmResp.UpdateRuntimeOn !== undefined) {
          const rm: Record<string, unknown> = { UpdateRuntimeOn: rmResp.UpdateRuntimeOn };
          // Only meaningful under Manual; AWS omits it otherwise.
          if (rmResp.RuntimeVersionArn !== undefined) {
            rm['RuntimeVersionArn'] = rmResp.RuntimeVersionArn;
          }
          result['RuntimeManagementConfig'] = rm;
        }
      } catch (rmErr) {
        if (!(rmErr instanceof ResourceNotFoundException)) {
          // WARN, not debug: this read backs a drift-compared key, so a
          // permission / throttle failure omits RuntimeManagementConfig from
          // the snapshot and `cdkd drift` then reports it as a REMOVAL against
          // state. The warning is what makes that false drift explainable.
          this.logger.warn(
            `GetRuntimeManagementConfig failed for ${physicalId} — RuntimeManagementConfig omitted from the drift snapshot (may surface as a false removal): ${describeAwsFailure(rmErr).detail}`
          );
        }
      }

      // CodeSigningConfigArn: a SEPARATE control-plane read
      // (GetFunctionCodeSigningConfig), emit-when-present. AWS raises
      // ResourceNotFoundException for a function with no code-signing config
      // attached, which the shared catch below maps to omit-from-readback —
      // no phantom drift on the typical function.
      try {
        const csResp = await this.lambdaClient.send(
          new GetFunctionCodeSigningConfigCommand({ FunctionName: physicalId })
        );
        if (csResp.CodeSigningConfigArn !== undefined) {
          result['CodeSigningConfigArn'] = csResp.CodeSigningConfigArn;
        }
      } catch (csErr) {
        if (!(csErr instanceof ResourceNotFoundException)) {
          // WARN for the same reason as the read above — an omitted
          // CodeSigningConfigArn reads as a removed security control.
          this.logger.warn(
            `GetFunctionCodeSigningConfig failed for ${physicalId} — CodeSigningConfigArn omitted from the drift snapshot (may surface as a false removal): ${describeAwsFailure(csErr).detail}`
          );
        }
      }
    }

    return result;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}
