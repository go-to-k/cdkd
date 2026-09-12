/**
 * Issue #2728: `DeployEngine.handleOutputResolutionFailure` reported an
 * Output resolution failure with the resolver's error text UNMASKED, on both
 * arms — the default warn and the `--strict-getatt` throw — while every other
 * resolver-facing site in the engine masks against a secrets map.
 *
 * Two layers, because the exposure depends on what the REAL resolver echoes:
 *
 * - The engine's own masking, with the resolver MOCKED: a resolution that
 *   records a plaintext into the pass map and then fails with a message
 *   embedding it. This pins the handler on both arms, the `cause` the strict
 *   arm threads (a masked CLONE that still carries the non-retryable marker),
 *   the alias pass (whose name map writes each entry through to the pass map
 *   as it is recorded, so the catch sees them; issue #2814 replaced the
 *   `finally` that copied them), a plaintext known only to the INHERITED bag (a nested-stack
 *   child's parent-decrypted parameter), a non-`Error` thrown value, and the
 *   control that an unrecorded value is left alone (the mask is a needle set,
 *   not a blanket).
 * - REACHABILITY, with the real `IntrinsicFunctionResolver` over a faked
 *   Secrets Manager client: `resolveJoin` propagates a part's error unchanged
 *   (the "sibling's plaintext echoed" shape the scrub mock manufactures is
 *   not the resolver's), so the case that proves the path exists is one the
 *   resolver builds itself — an `Fn::Sub` whose variable resolves the secret's
 *   `password` key and whose body uses that VALUE as the JSON key of a second
 *   reference to the same secret. The lookup succeeds and the resolver's own
 *   `key '<password>' not found in secret` message carries the plaintext the
 *   same pass just recorded. (An SSM not-found is NOT a usable shape for
 *   that: a missing live parameter raises the SDK's `ParameterNotFound`,
 *   which propagates unchanged and names nothing — the fake below DOES name
 *   the parameter, so the engine warn on the SSM shapes has something to
 *   mask and is asserted masked; that is the fake's message, not AWS's, so
 *   the engine-side assertion on those shapes is redundancy over the
 *   mocked-resolver cases, which pin the engine's masking on shapes that do
 *   occur, not coverage of a live SSM shape.)
 *   The premise that the resolver echoes the plaintext at all is measured on
 *   the error the resolver THREW, captured at the mock seam — the engine's
 *   `cause` is a masked clone and can no longer carry it.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

/**
 * The faked Secrets Manager client the REAL resolver talks to in the
 * reachability cases. One secret, JSON, keyed exactly like the
 * `secrets-dynamic-ref` integ fixture's; every other command is refused so
 * a path this file does not model fails loudly instead of resolving.
 */
const SECRET_ID = 'cdkd-test-dynref-secret';
const PASSWORD = 'cdkd-known-pw-123';
const { secretSends, throttledIds } = vi.hoisted(() => ({
  secretSends: [] as string[],
  /** Secret ids whose FIRST lookup is answered with a throttle, so the retry label prints. */
  throttledIds: new Set<string>(),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { SecretId?: string }; constructor: { name: string } }): Promise<unknown> {
      secretSends.push(command.constructor.name);
      if (command.constructor.name !== 'GetSecretValueCommand') {
        throw new Error(`unexpected Secrets Manager command ${command.constructor.name}`);
      }
      const id = command.input?.SecretId;
      if (id !== undefined && throttledIds.delete(id)) {
        const throttle = new Error('Rate exceeded');
        throttle.name = 'ThrottlingException';
        throw throttle;
      }
      if (id !== SECRET_ID) {
        // The SDK's own not-found: it names nothing — the id reaches a log only
        // through the resolver's echo and the retry label.
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }
      return { SecretString: JSON.stringify({ username: 'cdkd-user', password: PASSWORD }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
/**
 * The faked SSM client for the SSM echo case: a parameter whose NAME was
 * assembled from the resolved password does not exist, and the client raises
 * `ParameterNotFound`, which propagates unchanged. The REAL SDK's message
 * names nothing, so what carries the name (and so the password) there is the
 * resolver's own `Resolving dynamic reference: ssm:<name>` debug line BEFORE
 * the lookup; this fake names the parameter too, so the engine warn is
 * exercised as well.
 */
const { throttledParams, unknownTypeParams } = vi.hoisted(() => ({
  /** Parameter names whose FIRST lookup is answered with a throttle, so the retry label prints. */
  throttledParams: new Set<string>(),
  /** Parameter names whose lookup SUCCEEDS with a `Type` cdkd does not know, so the unrecognized-Type warn prints. */
  unknownTypeParams: new Set<string>(),
}));
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSSMClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { Name?: string }; constructor: { name: string } }): Promise<unknown> {
      const name = command.input?.Name;
      if (name !== undefined && throttledParams.delete(name)) {
        const throttle = new Error('Rate exceeded');
        throttle.name = 'ThrottlingException';
        throw throttle;
      }
      if (command.constructor.name !== 'GetParameterCommand') {
        throw new Error(`unexpected SSM command ${command.constructor.name}`);
      }
      if (name !== undefined && unknownTypeParams.has(name)) {
        return { Parameter: { Name: name, Value: 'unknown-type-value', Type: 'Weird' } };
      }
      // Names the parameter (the real SDK's message does not — see the file
      // comment) so the engine's warn on this shape has a needle to mask.
      const error = new Error(`ParameterNotFound: parameter '${name}' not found`);
      error.name = 'ParameterNotFound';
      throw error;
    }
    destroy(): void {}
  }
  return { ...actual, SSMClient: FakeSSMClient };
});

/**
 * The MOCKED resolver for the engine-side cases. `__leak__` records a
 * plaintext into the pass map and then rejects with a message that embeds
 * it — the resolver's own `key '<jsonKey>' not found` shape; `__leak_raw__`
 * throws a bare string (a non-`Error` thrown value) embedding it;
 * `__unrecorded__` rejects with a message embedding a value nothing
 * recorded; `__inherited__` rejects with a message embedding a value that is
 * in the engine's INHERITED bag only (nothing recorded it into the pass
 * map); `__both__` records one plaintext and names it AND the inherited-only
 * one; `__leak_object__` throws a plain OBJECT (neither `Error` nor string)
 * embedding a recorded plaintext; `__nameless__` rejects with an EMPTY
 * message under an SDK-style `name`. Everything else resolves to itself.
 */
const LEAKED = 'resolved-secret-plaintext-value';
const UNRECORDED = 'never-recorded-value';
const INHERITED = 'parent-decrypted-parameter-plaintext';
const resolverMode = vi.hoisted(() => ({ real: false }));
/**
 * The exact value the resolver (mocked or real) threw last, captured at the
 * seam: the strict arm's `cause` is a masked CLONE, so the premise that the
 * resolver's own error carried the plaintext is measured here.
 */
const lastThrown = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/deployment/intrinsic-function-resolver.js');
  const { markNonRetryable } = await import('../../../src/deployment/retryable-errors.js');
  class MockResolver {
    getPhysicalIdFallbackCount = vi.fn(() => 0);
    resetPhysicalIdFallbackCount = vi.fn();
    resolveParameters = vi.fn().mockResolvedValue({});
    evaluateConditions = vi.fn().mockResolvedValue({});
    resolve = vi.fn(
      async (value: unknown, context: { recordedSecretValues?: Map<string, string> }): Promise<unknown> => {
        // The alias pass hands the name as an intrinsic OBJECT; unwrap the
        // one-key `Fn::Sub` spelling so the same sentinels drive both passes.
        const sub = (value as { 'Fn::Sub'?: unknown } | null)?.['Fn::Sub'];
        if (typeof sub === 'string') value = sub;
        if (value === '__leak__') {
          context.recordedSecretValues?.set(LEAKED, '{{resolve:secretsmanager:s:SecretString:password}}');
          // Marked non-retryable like a resolver refusal: the marker is a
          // NON-ENUMERABLE symbol on THIS instance, so only the instance
          // itself — not a copy carrying the same message — keeps it.
          lastThrown.value = markNonRetryable(
            new Error(`Dynamic reference: key '${LEAKED}' not found in secret 's'`)
          );
          throw lastThrown.value;
        }
        if (value === '__leak_raw__') {
          context.recordedSecretValues?.set(LEAKED, '{{resolve:secretsmanager:s:SecretString:password}}');
          throw `raw failure mentioning ${LEAKED}`;
        }
        if (value === '__unrecorded__') {
          throw new Error(`Dynamic reference: key '${UNRECORDED}' not found in secret 's'`);
        }
        if (value === '__inherited__') {
          throw new Error(`Dynamic reference: key '${INHERITED}' not found in secret 's'`);
        }
        if (value === '__both__') {
          // Records one plaintext into the pass map and names BOTH it and the
          // inherited-only one: the second masking pass runs over a clone.
          context.recordedSecretValues?.set(LEAKED, '{{resolve:secretsmanager:s:SecretString:password}}');
          lastThrown.value = markNonRetryable(
            new Error(`Dynamic reference: key '${LEAKED}' not found in secret '${INHERITED}'`)
          );
          throw lastThrown.value;
        }
        if (value === '__leak_object__') {
          context.recordedSecretValues?.set(LEAKED, '{{resolve:secretsmanager:s:SecretString:password}}');
          throw { code: 'NotAnError', detail: LEAKED };
        }
        if (value === '__nameless__') {
          // An SDK-shaped failure: the code is in the NAME, the message empty.
          const empty = new Error('');
          empty.name = 'ResourceNotFoundException';
          throw empty;
        }
        return value;
      }
    );
  }
  /** The real class, with its top-level `resolve` rejection captured into `lastThrown`. */
  function realResolver(args: unknown[]): InstanceType<typeof actual.IntrinsicFunctionResolver> {
    const resolver = new actual.IntrinsicFunctionResolver(...(args as [string, never]));
    const resolve = resolver.resolve.bind(resolver);
    resolver.resolve = (async (...resolveArgs: Parameters<typeof resolve>) => {
      try {
        return await resolve(...resolveArgs);
      } catch (error) {
        lastThrown.value = error;
        throw error;
      }
    }) as typeof resolver.resolve;
    return resolver;
  }
  return {
    ...actual,
    IntrinsicFunctionResolver: vi.fn().mockImplementation((...args: unknown[]) =>
      resolverMode.real ? realResolver(args) : new MockResolver()
    ),
  };
});

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { dynamicReferenceRetryDelays } from '../../../src/deployment/intrinsic-function-resolver.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { CdkdError, formatError } from '../../../src/utils/error-handler.js';

function makeState(stackName: string): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName,
    region: 'us-east-1',
    resources: {
      ParamA: {
        physicalId: 'phys-param-a',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'x' },
        observedProperties: { Value: 'x' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

function templateWith(outputs: CloudFormationTemplate['Outputs']): CloudFormationTemplate {
  return {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: outputs,
  };
}

describe('DeployEngine - an output resolution failure is reported MASKED (issue #2728)', () => {
  const stackName = 'output-failure-mask-stack';
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let engineDeps: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    resolverMode.real = false;
    secretSends.length = 0;
    throttledIds.clear();
    throttledParams.clear();
    unknownTypeParams.clear();
    delete dynamicReferenceRetryDelays.sleep;
    lastThrown.value = undefined;
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: makeState(stackName), etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockReturnValue([]),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn(),
      getProviderFor: vi.fn(),
      getRegisteredTypes: vi.fn().mockReturnValue(['AWS::SSM::Parameter']),
      validateResourceTypes: vi.fn().mockReturnValue({ unsupported: [], custom: [] }),
      validateResourceProperties: vi.fn().mockReturnValue([]),
    };
    engineDeps = [mockStateBackend, mockLockManager, mockDagBuilder, mockDiffCalculator, mockProviderRegistry];
  });

  function makeEngine(strictGetAtt?: boolean, inheritedSecrets?: Map<string, string>): DeployEngine {
    return new DeployEngine(
      ...(engineDeps as [never, never, never, never, never]),
      {
        dryRun: false,
        ...(strictGetAtt !== undefined && { strictGetAtt }),
        ...(inheritedSecrets && { inheritedSecrets }),
      },
      'us-east-1'
    );
  }

  /** The one `Failed to resolve output` warn this deploy emitted, or undefined. */
  function outputFailureWarn(): string | undefined {
    return warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes('Failed to resolve output'));
  }

  it('default arm: the warn carries the mask, not the plaintext the failed resolution recorded', async () => {
    await makeEngine().deploy(stackName, templateWith({ Leak: { Value: '__leak__' } }));

    const warn = outputFailureWarn();
    // The WHOLE line: `error.message` masked, with no `Error: ` class prefix
    // (`String(error)` would add one) and nothing else appended.
    expect(warn).toBe("Failed to resolve output Leak: Dynamic reference: key '***' not found in secret 's'");
  });

  it('strict arm: the thrown message carries the mask, and its cause is a masked clone that keeps the marker', async () => {
    const engine = makeEngine(true);
    let thrown: unknown;
    try {
      await engine.deploy(stackName, templateWith({ Leak: { Value: '__leak__' } }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).toMatch(/Failed to resolve output Leak: .*--strict-getatt/s);
    expect(error.message).toContain('***');
    expect(error.message).not.toContain(LEAKED);
    // The cause is a `maskSecretsInError` clone of the resolver's error: the
    // same class, a masked message, and the non-retryable marker — a
    // NON-ENUMERABLE symbol the resolver put on ITS instance — carried
    // across, so `isMarkedNonRetryable` finds it on the chain. What is NOT
    // asserted is identity: hardening the cause must not cost a test edit.
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).not.toBe(error);
    expect((error.cause as Error).message).toBe("Dynamic reference: key '***' not found in secret 's'");
    expect(isMarkedNonRetryable(error.cause)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The premise, on the instance the resolver threw: it carried the
    // plaintext and the marker, so the clone had both to preserve.
    expect((lastThrown.value as Error).message).toContain(LEAKED);
    expect(isMarkedNonRetryable(lastThrown.value)).toBe(true);
  });

  it('a plaintext known only to the INHERITED bag is masked too (a nested-stack child before its parameter recorded)', async () => {
    // `inheritedSecrets` is the parent-decrypted bag a child engine is built
    // with; nothing here records `INHERITED` into the pass map. The resolver's
    // `maskSecretsForLog` masks against both bags for this reason (issue
    // #1903 round 2), and the handler must not argue the other side.
    const inherited = new Map([[INHERITED, '{{resolve:secretsmanager:parent:SecretString:password}}']]);
    await makeEngine(undefined, inherited).deploy(stackName, templateWith({ Leak: { Value: '__inherited__' } }));

    expect(outputFailureWarn()).toBe("Failed to resolve output Leak: Dynamic reference: key '***' not found in secret 's'");
  });

  it('alias pass, inherited bag: a failed Export.Name resolution is masked against the inherited bag too', async () => {
    // The two call sites thread the inherited bag independently; the alias
    // pass's site is the one a value-only case never reaches.
    const inherited = new Map([[INHERITED, '{{resolve:secretsmanager:parent:SecretString:password}}']]);
    await makeEngine(undefined, inherited).deploy(
      stackName,
      templateWith({ Pub: { Value: 'public-value', Export: { Name: { 'Fn::Sub': '__inherited__' } as never } } })
    );

    expect(outputFailureWarn()).toBe("Failed to resolve output Pub: Dynamic reference: key '***' not found in secret 's'");
  });

  it('both bags matching one error: the second pass masks a clone of the first, marker intact', async () => {
    // `maskSecretsInError` runs twice — inherited bag, then the pass map —
    // so the second run clones the FIRST run's clone (own data `message` and
    // `stack`, the marker already copied once). Both needles must end up
    // masked on the text and on the cause, and the marker must survive twice.
    const inherited = new Map([[INHERITED, '{{resolve:secretsmanager:parent:SecretString:password}}']]);
    let thrown: unknown;
    try {
      await makeEngine(true, inherited).deploy(stackName, templateWith({ Leak: { Value: '__both__' } }));
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).toContain("Dynamic reference: key '***' not found in secret '***'");
    expect(error.message).not.toContain(LEAKED);
    expect(error.message).not.toContain(INHERITED);
    expect((error.cause as Error).message).toBe("Dynamic reference: key '***' not found in secret '***'");
    expect(isMarkedNonRetryable(error.cause)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('strict arm with a thrown OBJECT (neither Error nor string): the message is masked and NO cause is threaded', async () => {
    // `String({...})` is `[object Object]`, so the text has nothing to mask
    // and nothing to leak; the object itself would come back from
    // `maskSecretsInError` by identity, UNMASKED, and `markNonRetryable`
    // marks `Error` instances only, so it can carry no marker of ours — the
    // handler does not thread it at all.
    let thrown: unknown;
    try {
      await makeEngine(true).deploy(stackName, templateWith({ Leak: { Value: '__leak_object__' } }));
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).toMatch(/^Failed to resolve output Leak: \[object Object\] \(--strict-getatt/);
    expect(error).not.toHaveProperty('cause');
  });

  it('strict arm on the ALIAS call site: a failed Export.Name resolution aborts the deploy, masked, with the marker', async () => {
    // The alias pass has its own catch and its own call into the handler;
    // the default-arm alias cases prove the masking there, this one proves
    // `--strict-getatt` promotes THAT site's failure too.
    let thrown: unknown;
    try {
      await makeEngine(true).deploy(
        stackName,
        templateWith({ Pub: { Value: 'public-value', Export: { Name: { 'Fn::Sub': '__leak__' } as never } } })
      );
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error & { cause?: unknown };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^Failed to resolve output Pub: Dynamic reference: key '\*\*\*' not found in secret 's' \(--strict-getatt/);
    expect(error.message).not.toContain(LEAKED);
    expect((error.cause as Error).message).toBe("Dynamic reference: key '***' not found in secret 's'");
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('strict arm, inherited bag: the cause is masked against it as well', async () => {
    const inherited = new Map([[INHERITED, '{{resolve:secretsmanager:parent:SecretString:password}}']]);
    let thrown: unknown;
    try {
      await makeEngine(true, inherited).deploy(stackName, templateWith({ Leak: { Value: '__inherited__' } }));
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).not.toContain(INHERITED);
    expect(error.message).toContain('***');
    expect((error.cause as Error).message).toBe("Dynamic reference: key '***' not found in secret 's'");
  });

  it('alias pass: a failed Export.Name resolution is masked against the entries its own resolution recorded', async () => {
    // The name is resolved into a map that writes each entry through to the
    // pass map as the resolver records it, so they are there BEFORE the catch
    // reaches the handler — which is what makes the name's own plaintext a
    // needle here. (Issue #2814; until then a `finally` copied them at the
    // end of the block, which dropped anything recorded after it.)
    await makeEngine().deploy(
      stackName,
      templateWith({ Pub: { Value: 'public-value', Export: { Name: { 'Fn::Sub': '__leak__' } as never } } })
    );

    const warn = outputFailureWarn();
    expect(warn).toBeDefined();
    expect(warn).toContain('Failed to resolve output Pub');
    expect(warn).toContain('***');
    expect(warn).not.toContain(LEAKED);
  });

  it('a non-Error thrown value is masked the same way', async () => {
    await makeEngine().deploy(stackName, templateWith({ Leak: { Value: '__leak_raw__' } }));

    // The WHOLE line again: `String(error)` of the thrown string, masked —
    // not a blanket `***` that would discard the diagnostic.
    expect(outputFailureWarn()).toBe('Failed to resolve output Leak: raw failure mentioning ***');
  });

  it('strict arm with a non-Error thrown value: the message is masked and the thrown string is the cause, masked as text', async () => {
    let thrown: unknown;
    try {
      await makeEngine(true).deploy(stackName, templateWith({ Leak: { Value: '__leak_raw__' } }));
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).toMatch(/^Failed to resolve output Leak: raw failure mentioning \*\*\* \(--strict-getatt/);
    expect(error.message).not.toContain(LEAKED);
    expect(error.cause).toBe('raw failure mentioning ***');
    expect(lastThrown.value).toBeUndefined(); // the `__leak_raw__` sentinel throws without recording
  });

  it('an empty message falls back to the error NAME, which is where an SDK error keeps its code', async () => {
    await makeEngine().deploy(stackName, templateWith({ Leak: { Value: '__nameless__' } }));

    // `error.message || error.name`: the message alone would render as
    // `Failed to resolve output Leak: ` and say nothing.
    expect(outputFailureWarn()).toBe('Failed to resolve output Leak: ResourceNotFoundException');
  });

  it('control: a value nothing recorded is printed as is — the mask is a needle set, not a blanket', async () => {
    await makeEngine().deploy(stackName, templateWith({ Bad: { Value: '__unrecorded__' } }));

    const warn = outputFailureWarn();
    expect(warn).toBeDefined();
    expect(warn).toContain(UNRECORDED);
    expect(warn).not.toContain('***');
  });

  describe('reachability with the REAL resolver over a faked Secrets Manager', () => {
    // The password is resolved into the variable, then used as the JSON key of
    // a second reference to the same secret: the lookup succeeds and the
    // resolver's own error names the missing key — the plaintext. Built FRESH
    // per case: `resolveSub` resolves the variable map IN PLACE, so a shared
    // literal would carry the resolved password into the next case's template
    // and that case would never resolve (or record) the inner reference.
    const assembled = () => ({
      'Fn::Sub': [
        `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${Pw}}}`,
        { Pw: `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}` },
      ],
    });

    beforeEach(() => {
      resolverMode.real = true;
    });

    it('the resolver reaches this throw and masks it AT THE THROW — premise, restated by issue #2827', async () => {
      await makeEngine().deploy(stackName, templateWith({ Leak: { Value: assembled() } }));

      // WHAT CHANGED. This case used to assert the real resolver's own message
      // CARRIES the password — the premise the boundary mask rested on. Issue
      // #2827 fixed the producer end: the resolver masks the raw `secretId` /
      // `jsonKey` before interpolating them, so the message never leaves it
      // unmasked and no caller inherits the obligation.
      //
      // Kept, inverted, rather than deleted, because the REACHABILITY half is
      // what the cases below depend on: two `GetSecretValueCommand` sends and
      // a not-found-key throw naming the secret. A shape that stopped reaching
      // the throw would satisfy every `not.toContain(PASSWORD)` below
      // vacuously, and `not.toContain` alone cannot tell masked from absent.
      // The boundary mask this file is about is NOT made inert: the fake-resolver
      // `__leak__` cases above drive an error the resolver did not build, and
      // those are what discriminate `handleOutputResolutionFailure` now.
      const thrown = lastThrown.value as Error;
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain(`not found in secret '${SECRET_ID}'`);
      expect(thrown.message).toContain('***');
      expect(thrown.message).not.toContain(PASSWORD);
      expect(secretSends.filter((c) => c === 'GetSecretValueCommand').length).toBeGreaterThanOrEqual(2);
    });

    it('default arm: the warn is masked', async () => {
      await makeEngine().deploy(stackName, templateWith({ Leak: { Value: assembled() } }));

      const warn = outputFailureWarn();
      expect(warn).toBeDefined();
      expect(warn).toContain('Failed to resolve output Leak');
      expect(warn).toContain('***');
      expect(warn).not.toContain(PASSWORD);
    });

    it('no log line at ANY level carries the password on that path — the resolver echoes the assembled reference too', async () => {
      // The second lookup's `Resolving dynamic reference: secretsmanager:<id>:SecretString:<jsonKey>...`
      // debug line would print the password (the JSON key) one line before
      // the warn under `--verbose`; it is masked against the same pass map.
      // (The throttle-retry label carries only the secret ID, constant on this
      // shape — the password-as-ID case below is the one that pins it.) Every
      // level is checked, and the premise that the resolver logged the second
      // lookup at all is pinned so a resolver that stopped emitting the line
      // could not pass this vacuously.
      await makeEngine().deploy(stackName, templateWith({ Leak: { Value: assembled() } }));

      const lines = [debugSpy, infoSpy, warnSpy, errorSpy].flatMap((spy) =>
        spy.mock.calls.map((c) => String(c[0]))
      );
      const echoes = lines.filter((l) => l.includes('Resolving dynamic reference: secretsmanager:'));
      expect(echoes.length).toBeGreaterThanOrEqual(2);
      expect(echoes.some((l) => l.includes(':SecretString:***'))).toBe(true);
      for (const line of lines) expect(line).not.toContain(PASSWORD);
    });

    it('strict arm: the thrown message and its cause are both masked', async () => {
      let thrown: unknown;
      try {
        await makeEngine(true).deploy(stackName, templateWith({ Leak: { Value: assembled() } }));
      } catch (error) {
        thrown = error;
      }
      const error = thrown as Error & { cause?: unknown };
      expect(error.message).toContain('***');
      expect(error.message).not.toContain(PASSWORD);
      expect((error.cause as Error).message).toContain(`key '***' not found in secret '${SECRET_ID}'`);
      expect((error.cause as Error).message).not.toContain(PASSWORD);
      // The resolver's OWN instance is masked at the throw since issue #2827,
      // so the engine's clone and the original now agree. Before that fix this
      // line read `toContain(PASSWORD)` — the whole point of the producer-side
      // change is that the original no longer carries it either.
      expect((lastThrown.value as Error).message).not.toContain(PASSWORD);
      expect((lastThrown.value as Error).message).toContain('***');
      // What the CLI prints for this error (`handleError` logs
      // `formatError(error)`): a plain `Error` renders as name + message.
      const rendered = formatError(error);
      expect(rendered).toContain('***');
      expect(rendered).not.toContain(PASSWORD);
      // ...and the OTHER branch of the renderer: a `CdkdError` wrapping this
      // error (the nested-stack parent's shape) renders `Caused by:` for its
      // DIRECT cause — the masked strict message. With the cause masked as an
      // object, a renderer that walked the whole chain would print `***` too.
      const wrapped = formatError(new CdkdError('Nested stack child deploy failed', 'NESTED_STACK_FAILED', error));
      expect(wrapped).toContain('Caused by: Failed to resolve output Leak: ');
      expect(wrapped).toContain('***');
      expect(wrapped).not.toContain(PASSWORD);
    });

    it('a resolved value landing in the SERVICE position: the unsupported-service warn is masked (default verbosity)', async () => {
      // `{{resolve:${Pw}}}`: the variable resolves and records the password,
      // the re-entry matches `{{resolve:<password>}}`, and `service` — the
      // text before the first `:` — IS the plaintext. That arm warns at
      // default verbosity and `continue`s, so the output RESOLVES (the
      // literal span stays in the value — issue #2743, not this one) and no
      // failure warn is emitted: this line is the whole exposure.
      const serviceAssembled = {
        'Fn::Sub': ['{{resolve:${Pw}}}', { Pw: `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}` }],
      };
      await makeEngine().deploy(stackName, templateWith({ Leak: { Value: serviceAssembled } }));

      const lines = [debugSpy, infoSpy, warnSpy, errorSpy].flatMap((spy) =>
        spy.mock.calls.map((c) => String(c[0]))
      );
      const unsupported = lines.filter((l) => l.includes('Unsupported dynamic reference service:'));
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]).toBe('Unsupported dynamic reference service: ***');
      for (const line of lines) expect(line).not.toContain(PASSWORD);
      expect(outputFailureWarn()).toBeUndefined();
    });

    // Both SSM spellings: `ssm` and `ssm-secure` reach `resolveSSMReference`
    // through different arms of `resolveDynamicReferences`, each threading
    // the context on its own, so each is pinned on its own.
    for (const service of ['ssm', 'ssm-secure'] as const) {
      const ssmAssembled = () => ({
        'Fn::Sub': [
          `{{resolve:${service}:/probe/\${Pw}}}`,
          { Pw: `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}` },
        ],
      });

      it(`an ${service} name assembled from the password is echoed masked too, before its lookup fails`, async () => {
        // `{{resolve:<service>:/probe/<password>}}`: the lookup raises
        // `ParameterNotFound`. The real SDK's message names nothing, so the
        // exposure on this shape is the resolver's `Resolving dynamic
        // reference: <service>:/probe/<name>` debug line emitted BEFORE the
        // call; the fake's message names the parameter, which also puts the
        // engine's failure warn on this path to the test.
        await makeEngine().deploy(stackName, templateWith({ Leak: { Value: ssmAssembled() } }));

        const lines = [debugSpy, infoSpy, warnSpy, errorSpy].flatMap((spy) =>
          spy.mock.calls.map((c) => String(c[0]))
        );
        const echoes = lines.filter((l) => l.includes(`Resolving dynamic reference: ${service}:`));
        expect(echoes).toHaveLength(1);
        expect(echoes[0]).toContain(`${service}:/probe/***`);
        for (const line of lines) expect(line).not.toContain(PASSWORD);
        expect(outputFailureWarn()).toBe(
          "Failed to resolve output Leak: ParameterNotFound: parameter '/probe/***' not found"
        );
      });

      it(`...and in the ${service} unrecognized-Type warn, when the lookup SUCCEEDS with a Type cdkd does not know`, async () => {
        // The one arm where the assembled name reaches a WARN at default
        // verbosity: the lookup returns a value whose `Type` is neither
        // String / StringList nor SecureString. The output then resolves
        // (the value is treated as a secret), so there is no failure warn —
        // the exposure is this line alone.
        unknownTypeParams.add(`/probe/${PASSWORD}`);
        await makeEngine().deploy(stackName, templateWith({ Leak: { Value: ssmAssembled() } }));

        const lines = [debugSpy, infoSpy, warnSpy, errorSpy].flatMap((spy) =>
          spy.mock.calls.map((c) => String(c[0]))
        );
        const typeWarns = lines.filter((l) => l.includes('reported an unrecognized Type'));
        expect(typeWarns).toHaveLength(1);
        expect(typeWarns[0]).toContain(`SSM parameter '/probe/***' reported an unrecognized Type 'Weird'`);
        for (const line of lines) expect(line).not.toContain(PASSWORD);
        expect(outputFailureWarn()).toBeUndefined();
      });

      it(`...and in the ${service} throttle-retry label`, async () => {
        dynamicReferenceRetryDelays.sleep = async () => {};
        throttledParams.add(`/probe/${PASSWORD}`);
        await makeEngine().deploy(stackName, templateWith({ Leak: { Value: ssmAssembled() } }));

        const lines = [debugSpy, infoSpy, warnSpy, errorSpy].flatMap((spy) =>
          spy.mock.calls.map((c) => String(c[0]))
        );
        const retries = lines.filter((l) => l.includes(`Retrying ${service}:`));
        expect(retries).toHaveLength(1);
        expect(retries[0]).toContain(`Retrying ${service}:/probe/***`);
        for (const line of lines) expect(line).not.toContain(PASSWORD);
      });
    }

    it('a secret ID assembled from the password is masked in the throttle-retry label too', async () => {
      // `{{resolve:secretsmanager:<password>:SecretString:password}}`: the
      // first lookup of that id is throttled, so `withRetry` prints
      // `Retrying <label> in ...` at debug — the label is the secret id. The
      // retry then meets the SDK's not-found, which names nothing. The
      // resolver's retry sleep is replaced through its exported seam so the
      // backoff does not run for real.
      dynamicReferenceRetryDelays.sleep = async () => {};
      throttledIds.add(PASSWORD);
      const idAssembled = {
        'Fn::Sub': [
          '{{resolve:secretsmanager:${Pw}:SecretString:password}}',
          { Pw: `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}` },
        ],
      };
      await makeEngine().deploy(stackName, templateWith({ Leak: { Value: idAssembled } }));

      const lines = [debugSpy, infoSpy, warnSpy, errorSpy].flatMap((spy) =>
        spy.mock.calls.map((c) => String(c[0]))
      );
      const retries = lines.filter((l) => l.includes('Retrying secretsmanager:'));
      expect(retries).toHaveLength(1);
      expect(retries[0]).toContain('Retrying secretsmanager:***');
      for (const line of lines) expect(line).not.toContain(PASSWORD);
      expect(outputFailureWarn()).toBeDefined();
    });

    it('Fn::Join, the other re-entry seam: the warn is masked (no throttle — the label cases above are the throttle probes)', async () => {
      // `resolveJoin` joins its resolved parts and re-enters
      // `resolveDynamicReferences` with the result: the inner part resolves
      // (and records) the password, the joined string is the second
      // reference with the password as its JSON key.
      const joined = {
        'Fn::Join': [
          '',
          [
            `{{resolve:secretsmanager:${SECRET_ID}:SecretString:`,
            { 'Fn::Join': ['', [`{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`]] },
            '}}',
          ],
        ],
      };
      await makeEngine().deploy(stackName, templateWith({ Leak: { Value: joined } }));

      const warn = outputFailureWarn();
      expect(warn).toBeDefined();
      expect(warn).toContain('***');
      expect(warn).not.toContain(PASSWORD);
    });
  });
});
