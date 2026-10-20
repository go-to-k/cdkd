/**
 * Pins that every `DeployEngine` per-call deps helper
 * (`resolverContextDeps`, `deleteDeps`, `noEchoDeps`, `maskingDeps`,
 * `replacementDeps`, `outputsDeps`, `rollbackDeps`) reads the engine's per-deploy state
 * LIVE, not a snapshot taken when the deps object was built. Each is
 * documented as "built fresh at each call site" / "a live getter" for
 * exactly this reason: a collaborator holds the deps object across more
 * than one call, and `deploy()` replaces the per-deploy state (a new
 * `SecretsRunState` / `NoEchoRunState` / `OutputsRunState`, a `rebaseline`,
 * `stackRecordsView`, `deployStateResources`, `interrupted` /
 * `interruptCause`, `recordedImports` / `recordedOutputReads`,
 * `runProducerRegionEvidence`) BETWEEN those calls — never in place.
 *
 * Each `it` below takes a deps object ONCE, then mutates the engine the
 * way `deploy()` / `deploy-flow.ts` do, and asserts every getter the deps
 * object exposes for that state now answers with the NEW value.
 */
import { describe, it, expect } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { OutputsRunState } from '../../../src/deployment/deploy-engine/outputs.js';
import { NoEchoRunState } from '../../../src/deployment/deploy-engine/noecho.js';
import { SecretsRunState } from '../../../src/deployment/deploy-engine/masking.js';
import { ReplacementRunState } from '../../../src/deployment/deploy-engine/replacement.js';
import type { StackRecordsView } from '../../../src/deployment/stack-records-scope.js';
import type { ResourceState, StateImportEntry, StateOutputReadEntry } from '../../../src/types/state.js';

function makeEngine(): DeployEngine {
  return new DeployEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dryRun: false },
    'us-east-1'
  );
}

describe('DeployEngine per-call deps helpers read per-deploy state LIVE', () => {
  it('resolverContextDeps reads secretsRun, noEchoRun, healBaseline, attributeHealer, recordedImports, recordedOutputReads and runProducerRegionEvidence live', () => {
    const engine = makeEngine();
    const deps = engine.resolverContextDeps();

    const newSecretsRun = new SecretsRunState();
    engine.secretsRun = newSecretsRun;
    expect(deps.secretsRun()).toBe(newSecretsRun);

    const newNoEchoRun = new NoEchoRunState();
    engine.noEchoRun = newNoEchoRun;
    expect(deps.noEchoRun()).toBe(newNoEchoRun);

    const newBaseline: Record<string, ResourceState> = {
      A: { physicalId: 'p', resourceType: 'T', properties: {} } as ResourceState,
    };
    const newHealer = engine.rebaseline(newBaseline);
    expect(deps.attributeHealer()).toBe(newHealer);
    expect(deps.healBaseline()).toBe(newBaseline);

    const newImports: StateImportEntry[] = [];
    engine.recordedImports = newImports;
    expect(deps.recordedImports()).toBe(newImports);

    const newOutputReads: StateOutputReadEntry[] = [];
    engine.recordedOutputReads = newOutputReads;
    expect(deps.recordedOutputReads()).toBe(newOutputReads);

    const evidence = (): never => ({}) as never;
    engine.runProducerRegionEvidence = evidence;
    expect(deps.runProducerRegionEvidence()).toBe(evidence);
  });

  it('deleteDeps reads secretsRun live', () => {
    const engine = makeEngine();
    const deps = engine.deleteDeps();

    const newSecretsRun = new SecretsRunState();
    engine.secretsRun = newSecretsRun;
    expect(deps.secretsRun()).toBe(newSecretsRun);
  });

  it('noEchoDeps reads perResourceSecrets/perResourceTemplateProps/perResourceResolvedType (via secretsRun) and outputsRun live', () => {
    const engine = makeEngine();
    const deps = engine.noEchoDeps();

    const newSecretsRun = new SecretsRunState();
    engine.secretsRun = newSecretsRun;
    expect(deps.perResourceSecrets()).toBe(newSecretsRun.perResourceSecrets);
    expect(deps.perResourceTemplateProps()).toBe(newSecretsRun.perResourceTemplateProps);
    expect(deps.perResourceResolvedType()).toBe(newSecretsRun.perResourceResolvedType);

    const newOutputsRun = new OutputsRunState();
    engine.outputsRun = newOutputsRun;
    expect(deps.outputsRun()).toBe(newOutputsRun);
  });

  it('maskingDeps reads outputsRun, noEchoRun and noEchoCeilingReadbackTimeoutMs live', () => {
    const engine = makeEngine();
    const deps = engine.maskingDeps();

    const newOutputsRun = new OutputsRunState();
    engine.outputsRun = newOutputsRun;
    expect(deps.outputsRun()).toBe(newOutputsRun);

    const newNoEchoRun = new NoEchoRunState();
    engine.noEchoRun = newNoEchoRun;
    expect(deps.noEchoRun()).toBe(newNoEchoRun);

    engine.noEchoCeilingReadbackTimeoutMs = 1;
    expect(deps.noEchoCeilingReadbackTimeoutMs()).toBe(1);
  });

  it('replacementDeps reads secretsRun, stackRecordsView, deployStateResources, interrupted, interruptCause and userInterrupted live', () => {
    const engine = makeEngine();
    const deps = engine.replacementDeps();

    const newSecretsRun = new SecretsRunState();
    engine.secretsRun = newSecretsRun;
    expect(deps.secretsRun()).toBe(newSecretsRun);

    const view: StackRecordsView = { live: () => [], survivors: () => [] };
    engine.stackRecordsView = view;
    expect(deps.stackRecordsView()).toBe(view);

    const resources: Record<string, ResourceState> = {};
    engine.deployStateResources = resources;
    expect(deps.deployStateResources()).toBe(resources);

    engine.interrupted = true;
    expect(deps.interrupted()).toBe(true);

    engine.interruptCause = 'sibling-failure';
    expect(deps.interruptCause()).toBe('sibling-failure');

    engine.userInterrupted = true;
    expect(deps.userInterrupted()).toBe(true);
  });

  it('rollbackDeps reads secretsRun, noEchoRun, outputsRun, recordedImports, recordedOutputReads, resumedCreates, absentJournalVersionPurge and interrupted live, and resets resumedCreates on the engine', () => {
    const engine = makeEngine();
    const deps = engine.rollbackDeps();
    expect(deps.owner).toBe(engine);

    const newSecretsRun = new SecretsRunState();
    engine.secretsRun = newSecretsRun;
    expect(deps.secretsRun()).toBe(newSecretsRun);

    const newNoEchoRun = new NoEchoRunState();
    engine.noEchoRun = newNoEchoRun;
    expect(deps.noEchoRun()).toBe(newNoEchoRun);

    const newOutputsRun = new OutputsRunState();
    engine.outputsRun = newOutputsRun;
    expect(deps.outputsRun()).toBe(newOutputsRun);

    const newImports: StateImportEntry[] = [];
    engine.recordedImports = newImports;
    expect(deps.recordedImports()).toBe(newImports);

    const newOutputReads: StateOutputReadEntry[] = [];
    engine.recordedOutputReads = newOutputReads;
    expect(deps.recordedOutputReads()).toBe(newOutputReads);

    const newResumed: DeployEngine['resumedCreates'] = new Map();
    engine.resumedCreates = newResumed;
    expect(deps.resumedCreates()).toBe(newResumed);
    // The success settle REPLACES the engine's map (never clears in place).
    deps.resetResumedCreates();
    expect(engine.resumedCreates).not.toBe(newResumed);
    expect(engine.resumedCreates.size).toBe(0);
    expect(deps.resumedCreates()).toBe(engine.resumedCreates);

    const purge = Promise.resolve();
    engine.absentJournalVersionPurge = purge;
    expect(deps.absentJournalVersionPurge()).toBe(purge);

    engine.interrupted = true;
    expect(deps.interrupted()).toBe(true);

    engine.userInterrupted = true;
    expect(deps.userInterrupted()).toBe(true);
  });

  it('outputsDeps forwards buildResolverContext and noEchoPositionSources bound to the CURRENT engine, not a snapshot', () => {
    const engine = makeEngine();
    const deps = engine.outputsDeps();

    // buildResolverContext rebuilds `resolverContextDeps()` at CALL time, so
    // a `recordedImports` swap made AFTER taking `deps` must still show up.
    const newImports: StateImportEntry[] = [];
    engine.recordedImports = newImports;
    const context = deps.buildResolverContext({ template: { Resources: {} }, resources: {} }, 'Stack');
    expect(context.recordedImports).toBe(newImports);

    // noEchoPositionSources is `(...args) => noEchoPositionSources(this.noEchoRun, ...args)`,
    // so a `noEchoRun` swap made AFTER taking `deps` must be the instance it reads from.
    const newNoEchoRun = new NoEchoRunState();
    newNoEchoRun.inheritedNoEchoParameters = new Set(['LiveParam']);
    engine.noEchoRun = newNoEchoRun;
    const sources = deps.noEchoPositionSources({}, { Resources: {} });
    expect(sources?.parameters.has('LiveParam')).toBe(true);
  });
});
