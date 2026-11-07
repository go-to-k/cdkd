import type { DeployEngine } from '../deploy-engine.js';
import { DeploymentEventsReader } from '../../state/deployment-events-store.js';
import { loadRollbackRetainedCopies } from '../kept-in-history.js';
import type { ResourceState } from '../../types/state.js';
import { ProvenanceCapture } from './provenance-capture.js';
import { isPinnedToCcApi } from './routing.js';
import type { ReplacementDeps } from './replacement.js';
import type { OutputsDeps } from './outputs.js';
import type { RollbackDeps } from './rollback.js';
import { ObservedCapture } from './observed-capture.js';
import {
  maskForResource,
  printingSecretsFor,
  readReaderForFreshNoEchoCeiling,
  stateNamingSecrets,
  type MaskingDeps,
} from './masking.js';
import { AttributeHealer } from './attribute-healer.js';
import type { DeleteDeps } from './delete.js';
import { guardedReplacementCreate } from './create.js';
import { buildResolverContext, type ResolverContextDeps } from './resolver-context.js';
import { noEchoPositionSources, type NoEchoDeps } from './noecho.js';

/**
 * A fresh {@link observedCapture} over this engine's deps, for the
 * constructor and `deploy()`'s per-run reset.
 * @internal
 */
export function freshObservedCapture(this: DeployEngine): ObservedCapture {
  return new ObservedCapture({
    logger: this.logger,
    options: this.options,
    resolver: this.resolver,
    providerRegistry: this.providerRegistry,
    printingSecretsFor: (logicalId) => printingSecretsFor(this.secretsRun, logicalId),
    // Live: replaced mid-run by the schema-upgrade backfill (deploy-flow.ts).
    fingerprintNoEchoValues: () => this.secretsRun.fingerprintNoEchoValues,
    provenanceCapture: () => this.provenanceCapture,
  });
}

/**
 * Set {@link healBaseline}: a fresh {@link attributeHealer} over `resources`.
 * @internal
 */
export function rebaseline(
  this: DeployEngine,
  resources: Readonly<Record<string, ResourceState>>
): AttributeHealer {
  this.attributeHealer = new AttributeHealer({
    providerRegistry: this.providerRegistry,
    stackRegion: this.stackRegion,
    logger: this.logger,
    baseline: resources,
    // Read at merge time: `secretsRun` is replaced per deploy.
    resolvedSecretsOf: (logicalId) => this.secretsRun.perResourceSecrets.get(logicalId),
    // Read at heal time: bound and captured after this rebaseline.
    namingSecrets: () => stateNamingSecrets(this.secretsRun),
    pinnedToCcApi: (stackName, logicalId) => isPinnedToCcApi(this.options, stackName, logicalId),
  });
  return this.attributeHealer;
}

/**
 * A fresh {@link provenanceCapture} over this engine's current deps, for
 * the constructor and `deploy()`'s per-run reset — never a clear in place,
 * so a reused engine never serves a previous deploy's capture tasks.
 * @internal
 */
export function freshProvenanceCapture(this: DeployEngine): ProvenanceCapture {
  return new ProvenanceCapture({
    buildResolverContext: (...args) => buildResolverContext(this.resolverContextDeps(), ...args),
    resolver: this.resolver,
    logger: this.logger,
  });
}

/**
 * This engine's current deps for `deploy-engine/outputs.ts`'s plain
 * functions, built fresh at each call site so a forwarded method
 * (`buildResolverContext`, `noEchoPositionSources`) stays bound to THIS
 * engine rather than a snapshot — the same arrow-forwarding
 * {@link freshProvenanceCapture} uses.
 * @internal
 */
export function outputsDeps(this: DeployEngine): OutputsDeps {
  return {
    options: this.options,
    logger: this.logger,
    resolver: this.resolver,
    buildResolverContext: (...args) => buildResolverContext(this.resolverContextDeps(), ...args),
    noEchoPositionSources: (...args) => noEchoPositionSources(this.noEchoRun, ...args),
  };
}

/**
 * This engine's current deps for `deploy-engine/noecho.ts`'s plain
 * functions, built fresh at each call site like {@link outputsDeps}. The
 * per-deploy state `deploy()` REASSIGNS (`secretsRun`'s
 * `perResourceSecrets` / `perResourceTemplateProps` /
 * `perResourceResolvedType`, `outputsRun`) is read through live getters,
 * and a forwarded function stays bound to THIS engine.
 * @internal
 */
export function noEchoDeps(this: DeployEngine): NoEchoDeps {
  return {
    stackRegion: this.stackRegion,
    logger: this.logger,
    providerRegistry: this.providerRegistry,
    perResourceSecrets: () => this.secretsRun.perResourceSecrets,
    perResourceTemplateProps: () => this.secretsRun.perResourceTemplateProps,
    perResourceResolvedType: () => this.secretsRun.perResourceResolvedType,
    outputsRun: () => this.outputsRun,
    readReaderForFreshNoEchoCeiling: (...args) =>
      readReaderForFreshNoEchoCeiling(this.maskingDeps(), ...args),
    maskForResource: (...args) => maskForResource(this.secretsRun, ...args),
    pinnedToCcApi: (stackName, logicalId) => isPinnedToCcApi(this.options, stackName, logicalId),
  };
}

/**
 * This engine's current deps for `deploy-engine/masking.ts`'s plain
 * functions, built fresh at each call site like {@link noEchoDeps}.
 * `options` / `stackRegion` / `logger` / `providerRegistry` are never
 * reassigned after construction, so they are passed by value; `outputsRun`
 * and `noEchoRun` (replaced per `deploy()`) and
 * `noEchoCeilingReadbackTimeoutMs` (a field a test shortens) are live
 * getters, and `noEchoDeps` stays bound to THIS engine.
 * @internal
 */
export function maskingDeps(this: DeployEngine): MaskingDeps {
  return {
    options: this.options,
    stackRegion: this.stackRegion,
    logger: this.logger,
    providerRegistry: this.providerRegistry,
    outputsRun: () => this.outputsRun,
    noEchoRun: () => this.noEchoRun,
    noEchoDeps: () => this.noEchoDeps(),
    noEchoCeilingReadbackTimeoutMs: () => this.noEchoCeilingReadbackTimeoutMs,
  };
}

/**
 * This engine's current deps for `deploy-engine/replacement.ts`'s plain
 * functions, built fresh at each call site like {@link maskingDeps}.
 * `options` / `stackRegion` / `logger` are never reassigned after
 * construction, so they are passed by value; `secretsRun` (replaced per
 * `deploy()`), `stackRecordsView` / `deployStateResources` (set by
 * `executeDeployment`) and `interrupted` / `interruptCause` (set mid-deploy)
 * are live getters, and the forwarded methods stay bound to THIS engine.
 * @internal
 */
export function replacementDeps(this: DeployEngine): ReplacementDeps {
  return {
    options: this.options,
    stackRegion: this.stackRegion,
    logger: this.logger,
    secretsRun: () => this.secretsRun,
    stackRecordsView: () => this.stackRecordsView,
    deployStateResources: () => this.deployStateResources,
    interrupted: () => this.interrupted,
    interruptCause: () => this.interruptCause,
    userInterrupted: () => this.userInterrupted,
    withRetry: (...args) => this.withRetry(...args),
    maskingRetryLoggerFor: (...args) => this.maskingRetryLoggerFor(...args),
    inlinePolicyClaimedFor: (...args) => this.inlinePolicyClaimedFor(...args),
    recordEvent: (...args) => this.recordEvent(...args),
    guardedReplacementCreate: (input, create) => guardedReplacementCreate(this, input, create),
    generatedNameGuarded: (logicalId) =>
      this.generatedNameGuard?.candidate(logicalId) !== undefined,
    rollbackRetainedCopies: (stackName) => {
      const reader = new DeploymentEventsReader(this.stateBackend);
      return loadRollbackRetainedCopies(
        {
          listRuns: (s, r) => reader.listRuns(s, r),
          readRunEvents: (s, r, id) => reader.readRunEvents(s, r, id),
        },
        stackName,
        this.stackRegion
      );
    },
  };
}

/**
 * This engine's current deps for `deploy-engine/resolver-context.ts`'s
 * plain functions, built fresh at each call site like
 * {@link replacementDeps}. `options` / `stateBackend` / `exportIndexStore` /
 * `resolver` are set only in the constructor, so they are passed by value;
 * `secretsRun` / `noEchoRun` / `recordedImports` / `recordedOutputReads` /
 * `runProducerRegionEvidence` (replaced per `deploy()`, the last also set
 * mid-deploy) and `attributeHealer` / `healBaseline` (replaced by
 * {@link rebaseline}) are live getters, so a context's healer and
 * producer-secret closures read the CURRENT value when called.
 * @internal
 */
export function resolverContextDeps(this: DeployEngine): ResolverContextDeps {
  return {
    options: this.options,
    stateBackend: this.stateBackend,
    exportIndexStore: this.exportIndexStore,
    resolver: this.resolver,
    secretsRun: () => this.secretsRun,
    noEchoRun: () => this.noEchoRun,
    healBaseline: () => this.healBaseline,
    attributeHealer: () => this.attributeHealer,
    recordedImports: () => this.recordedImports,
    recordedOutputReads: () => this.recordedOutputReads,
    runProducerRegionEvidence: () => this.runProducerRegionEvidence,
  };
}

/**
 * This engine's current deps for `deploy-engine/delete.ts`'s
 * `provisionDelete`, built fresh at each call site like
 * {@link replacementDeps}. `options` / `stateBackend` / `stackRegion` /
 * `logger` / `providerRegistry` are set only in the constructor, so they are
 * passed by value; `secretsRun` (replaced per `deploy()`) is a live getter,
 * `owner` is this engine's identity (the retained-readoption key), and the
 * forwarded methods stay bound to THIS engine.
 * @internal
 */
export function deleteDeps(this: DeployEngine): DeleteDeps {
  return {
    owner: this,
    options: this.options,
    stateBackend: this.stateBackend,
    stackRegion: this.stackRegion,
    logger: this.logger,
    providerRegistry: this.providerRegistry,
    secretsRun: () => this.secretsRun,
    replacementDeps: () => this.replacementDeps(),
    withRetry: (...args) => this.withRetry(...args),
    inlinePolicyClaimedFor: (...args) => this.inlinePolicyClaimedFor(...args),
  };
}

/**
 * This engine's current deps for `deploy-engine/rollback.ts`'s plain
 * functions, built fresh at each call site like {@link deleteDeps}.
 * `options` / `stateBackend` / `lockManager` / `stackRegion` / `logger` /
 * `providerRegistry` are set only in the constructor, so they are passed by
 * value; `secretsRun` / `noEchoRun` / `outputsRun` / `recordedImports` /
 * `recordedOutputReads` / `resumedCreates` (replaced per `deploy()`, the last
 * also by the success settle) and `absentJournalVersionPurge` /
 * `interrupted` (set mid-deploy) are live getters, `owner` is this engine's
 * identity (the adopted-orphan records' key), and the forwarded methods stay
 * bound to THIS engine.
 * @internal
 */
export function rollbackDeps(this: DeployEngine): RollbackDeps {
  return {
    owner: this,
    logger: this.logger,
    options: this.options,
    stackRegion: this.stackRegion,
    stateBackend: this.stateBackend,
    lockManager: this.lockManager,
    providerRegistry: this.providerRegistry,
    secretsRun: () => this.secretsRun,
    noEchoRun: () => this.noEchoRun,
    outputsRun: () => this.outputsRun,
    recordedImports: () => this.recordedImports,
    recordedOutputReads: () => this.recordedOutputReads,
    resumedCreates: () => this.resumedCreates,
    resetResumedCreates: () => {
      this.resumedCreates = new Map();
    },
    absentJournalVersionPurge: () => this.absentJournalVersionPurge,
    interrupted: () => this.interrupted,
    userInterrupted: () => this.userInterrupted,
    noEchoDeps: () => this.noEchoDeps(),
    recordEvent: (...args) => this.recordEvent(...args),
    crossStackReadKeyNormalizer: (...args) => this.crossStackReadKeyNormalizer(...args),
  };
}
