import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  buildContainerEnv,
  buildSigV4HeadersIfRequested,
  resolveInboundAuthorization,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import {
  droppedEnvVarWarning as invokeDroppedEnvVarWarning,
  resolveTmpfsForLambda,
} from '../../../src/cli/commands/local-invoke.js';
import {
  droppedEnvVarWarning as startApiDroppedEnvVarWarning,
  fromCfnRedundancyTip,
  stageMissWarning,
  stateSubstitutedDebug,
  stateUnsubstitutedWarnings,
} from '../../../src/cli/commands/local-start-api.js';
import {
  envVarsOverrideExample,
  shownBesideCommandOrDescribed,
} from '../../../src/utils/pasteable-command.js';
import { getLogger } from '../../../src/utils/logger.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/**
 * The `local` CLI lines that print a template-, assembly- or state-derived
 * value beside a `--flag` (go-to-k/cdkd#4322). Each value is shown only when it
 * stays inert pasted beside that flag, and described otherwise.
 *
 * Every row is driven with every PASTE_PAYLOADS family, asserting the
 * description, `expectNoCommandBesideDisplay` and an empty `spansThatRun`.
 * Every row also takes `~root` and `-rf`: `displayIdent` leaves both unchanged,
 * yet a pasted shell expands the one and reads the other as an option, so a
 * gate weakened to `displayIdent(v) === v` would show them.
 */

/** `displayIdent` leaves these unchanged; a pasted shell does not. */
const SHELL_SHAPED = ['~root', '-rf'] as const;

const ID_DESC = 'a logical id that is not a plain identifier';
const NAME_DESC = 'a variable name that is not a plain identifier';

function expectPasteSafe(message: string, value: string): void {
  withPasteDir((dir) => {
    expectNoCommandBesideDisplay(message, value);
    expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function captureWarn(): () => string {
  const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  // `spyOn` on an already-spied method returns the same spy, so clear it: a
  // later case must not pass on an earlier one's line.
  warn.mockClear();
  return () => warn.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('cdkd local invoke-agentcore: the runtime logical id beside an auth flag', () => {
  const runtime = (logicalId: string) =>
    ({
      logicalId,
      jwtAuthorizer: { discoveryUrl: 'https://example.com' },
      stack: { region: undefined },
    }) as never;

  async function noVerifyAuth(logicalId: string): Promise<string> {
    const warned = captureWarn();
    await resolveInboundAuthorization(runtime(logicalId), { verifyAuth: false });
    return warned();
  }

  async function sigv4(logicalId: string): Promise<string> {
    const warned = captureWarn();
    await buildSigV4HeadersIfRequested(
      { sigv4: true } as never,
      runtime(logicalId),
      undefined,
      'localhost',
      8080,
      {},
      's'
    );
    return warned();
  }

  it('renders an ordinary id quoted, as before', async () => {
    expect(await noVerifyAuth('Runtime')).toContain(
      "Runtime 'Runtime' declares a customJwtAuthorizer, but --no-verify-auth was set"
    );
    expect(await sigv4('Runtime')).toContain(
      "Runtime 'Runtime' declares a customJwtAuthorizer; --sigv4 ignored"
    );
  });

  it('names no payload id beside --no-verify-auth or --sigv4', async () => {
    for (const { value } of PASTE_PAYLOADS) {
      const a = await noVerifyAuth(value);
      expect(a, value).toContain(`Runtime ${ID_DESC} declares a customJwtAuthorizer, but --no-verify-auth`);
      expectPasteSafe(a, value);
      const b = await sigv4(value);
      expect(b, value).toContain(`Runtime ${ID_DESC} declares a customJwtAuthorizer; --sigv4 ignored`);
      expectPasteSafe(b, value);
    }
  }, 120_000);

  it.each(SHELL_SHAPED)('describes %s beside --no-verify-auth and --sigv4', async (value) => {
    expect(await noVerifyAuth(value)).toContain(`Runtime ${ID_DESC} declares`);
    expect(await sigv4(value)).toContain(`Runtime ${ID_DESC} declares`);
  });
});

describe('the --env-vars override example for a dropped env var', () => {
  it('shows an ordinary cdk path and variable name, as before', () => {
    expect(envVarsOverrideExample('MyStack/MyFn', 'TABLE_NAME')).toBe(
      '{"MyStack/MyFn":{"TABLE_NAME":"<literal>"}}'
    );
    expect(envVarsOverrideExample('MyFn', '_HANDLER')).toBe('{"MyFn":{"_HANDLER":"<literal>"}}');
    expect(shownBesideCommandOrDescribed('_HANDLER', 'variable name')).toBe('_HANDLER');
  });

  it.each([...PASTE_PAYLOADS.map((p) => p.value), ...SHELL_SHAPED])(
    'puts a placeholder in place of %s',
    (value) => {
      expect(envVarsOverrideExample(value, 'K')).toBe('{"<cdk path or logical id>":{"K":"<literal>"}}');
      expect(envVarsOverrideExample('MyFn', value)).toBe('{"MyFn":{"<variable name>":"<literal>"}}');
    }
  );
});

describe('cdkd local invoke-agentcore / invoke / start-api: a dropped env var beside --env-vars', () => {
  /** invoke-agentcore's line, driven through `buildContainerEnv` itself. */
  async function agentcore(key: string, path: string): Promise<string> {
    const warned = captureWarn();
    await buildContainerEnv(
      {
        logicalId: 'Runtime',
        environmentVariables: { [key]: { Ref: 'Tbl' } },
        resource: { Type: 'AWS::BedrockAgentCore::Runtime', Metadata: { 'aws:cdk:path': `${path}/Resource` } },
        stack: { region: 'us-east-1' },
      } as never,
      {} as never,
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      undefined,
      undefined,
      undefined,
      undefined
    );
    return warned()
      .split('\n')
      .filter((l) => l.includes('--env-vars'))
      .join('\n');
  }

  const rows: Array<[string, (key: string, path: string) => Promise<string> | string]> = [
    ['invoke-agentcore', agentcore],
    ['invoke', (key, path) => invokeDroppedEnvVarWarning(key, path)],
    ['start-api', (key, path) => startApiDroppedEnvVarWarning('MyFn', key, path)],
  ];

  it('renders ordinary values as before', async () => {
    expect(await agentcore('TABLE', 'MyStack/MyFn')).toContain(
      'Environment variable TABLE contains a CloudFormation intrinsic and was dropped. ' +
        'Override it with --env-vars (e.g. {"MyStack/MyFn":{"TABLE":"<literal>"}}), or pass a state-source flag'
    );
    // A leading `_` is an ordinary env var name, shown at every site.
    expect(await agentcore('_HANDLER', 'MyFn')).toContain('Environment variable _HANDLER contains');
    expect(invokeDroppedEnvVarWarning('_HANDLER', 'MyFn')).toContain('Environment variable _HANDLER contains');
    expect(startApiDroppedEnvVarWarning('MyFn', '_HANDLER', 'MyFn')).toContain('env var _HANDLER contains');
    expect(invokeDroppedEnvVarWarning('TABLE', 'MyStack/MyFn')).toContain(
      'Environment variable TABLE contains a CloudFormation intrinsic and was dropped. ' +
        'Override it with --env-vars (e.g. {"MyStack/MyFn":{"TABLE":"<literal>"}}), or pass --from-state'
    );
    expect(startApiDroppedEnvVarWarning('MyFn', 'TABLE', 'MyStack/MyFn')).toContain(
      'Lambda MyFn: env var TABLE contains a CloudFormation intrinsic and was dropped. ' +
        'Override it with --env-vars (e.g. {"MyStack/MyFn":{"TABLE":"<literal>"}}) or pass --from-state'
    );
  });

  it('names no payload variable name, cdk path or logical id beside --env-vars', async () => {
    for (const { value } of PASTE_PAYLOADS) {
      for (const [label, build] of rows) {
        const byKey = await build(value, 'MyFn');
        expect(byKey, `${label} ${value}`).toContain(NAME_DESC);
        expect(byKey, `${label} ${value}`).toContain('{"MyFn":{"<variable name>":"<literal>"}}');
        expectPasteSafe(byKey, value);
        const byPath = await build('K', value);
        expect(byPath, `${label} ${value}`).toContain('{"<cdk path or logical id>":{"K":"<literal>"}}');
        expectPasteSafe(byPath, value);
        vi.restoreAllMocks();
      }
      const byId = startApiDroppedEnvVarWarning(value, 'K', 'MyFn');
      expect(byId, value).toContain(`Lambda ${ID_DESC}: env var K`);
      expectPasteSafe(byId, value);
    }
  }, 120_000);

  it.each(SHELL_SHAPED)('describes %s in every position', async (value) => {
    for (const [label, build] of rows) {
      expect(await build(value, 'MyFn'), label).toContain(NAME_DESC);
      expect(await build('K', value), label).toContain('{"<cdk path or logical id>":{"K":"<literal>"}}');
      vi.restoreAllMocks();
    }
    expect(startApiDroppedEnvVarWarning(value, 'K', 'MyFn')).toContain(`Lambda ${ID_DESC}:`);
  });
});

describe('cdkd local start-api: --from-state env var substitution lines', () => {
  it('renders ordinary values as before, with the reason on a line of its own', () => {
    expect(stateSubstitutedDebug('MyFn', 'TABLE')).toBe(
      'Lambda MyFn: --from-state substituted env var TABLE'
    );
    expect(stateUnsubstitutedWarnings('MyFn', 'TABLE', "Ref 'Tbl': no record")).toEqual([
      "Lambda MyFn: could not substitute env var TABLE from state: Ref 'Tbl': no record",
      'Lambda MyFn: --from-state could not substitute env var TABLE. Override it via --env-vars or it will be dropped.',
    ]);
  });

  it('names no payload id or variable name beside --from-state / --env-vars', () => {
    for (const { value } of PASTE_PAYLOADS) {
      const debugById = stateSubstitutedDebug(value, 'K');
      expect(debugById, value).toContain(`Lambda ${ID_DESC}: --from-state`);
      expectPasteSafe(debugById, value);
      const debugByKey = stateSubstitutedDebug('MyFn', value);
      expect(debugByKey, value).toContain(`env var ${NAME_DESC}`);
      expectPasteSafe(debugByKey, value);
      for (const [id, key] of [
        [value, 'K'],
        ['MyFn', value],
      ] as const) {
        const [, remedy] = stateUnsubstitutedWarnings(id, key, 'r');
        expect(remedy, value).toContain(
          id === value ? `Lambda ${ID_DESC}: --from-state` : `env var ${NAME_DESC}.`
        );
        expectPasteSafe(remedy, value);
      }
      // The reason quotes template text, so it never shares a line with a
      // flag: a flag-free reason is shown on a line of its own, and one that
      // names a flag itself (cdk-local's pseudo-parameter and cross-stack
      // arms) is withheld.
      const [why, remedy] = stateUnsubstitutedWarnings('MyFn', 'K', `Ref '${value}': no record`);
      expect(why).toContain(`could not substitute env var K from state: Ref '${value}': no record`);
      expect(remedy).toContain('--from-state could not substitute env var K.');
      expect(remedy).not.toContain(value);
      for (const reason of [
        `Ref 'AWS::${value}': pseudo parameter not supplied (need an active state source, e.g. --from-cfn-stack)`,
        `Fn::ImportValue "${value}": no cross-stack resolver supplied (pass a state-source flag, e.g. --from-cfn-stack)`,
      ]) {
        const [withheld] = stateUnsubstitutedWarnings('MyFn', 'K', reason);
        expect(withheld, reason).toBe(
          "Lambda MyFn: could not substitute env var K from state: (the resolver's reason is not shown: it names a flag beside template text)"
        );
        expectPasteSafe(withheld, value);
      }
    }
  }, 120_000);

  it.each(SHELL_SHAPED)('describes %s', (value) => {
    expect(stateSubstitutedDebug(value, 'K')).toContain(`Lambda ${ID_DESC}:`);
    expect(stateSubstitutedDebug('MyFn', value)).toContain(`env var ${NAME_DESC}`);
    expect(stateUnsubstitutedWarnings(value, 'K', 'r')[1]).toContain(`Lambda ${ID_DESC}:`);
    expect(stateUnsubstitutedWarnings('MyFn', value, 'r')[1]).toContain(`env var ${NAME_DESC}.`);
  });
});

describe('cdkd local start-api: the --from-cfn-stack tip and the --stage miss', () => {
  it('renders ordinary values as before', () => {
    expect(fromCfnRedundancyTip('MyStack')).toBe(
      'tip: --from-cfn-stack value matches the routed stack name (MyStack); you can omit the value: `cdkd local start-api ... --from-cfn-stack` (bare flag) resolves to the same value.'
    );
    expect(stageMissWarning('prod', 'MyApi')).toBe(
      "--stage 'prod' did not match any Stage on API 'MyApi'; routes on that API will get stageVariables: null."
    );
  });

  it('names no payload stack name or API id beside the flag', () => {
    for (const { value } of PASTE_PAYLOADS) {
      const tip = fromCfnRedundancyTip(value);
      expect(tip, value).toContain(
        '(a stack name that is not a plain identifier); you can omit the value'
      );
      expectPasteSafe(tip, value);
      const stage = stageMissWarning('prod', value);
      expect(stage, value).toContain(
        'on API a logical id that is not a plain identifier; routes'
      );
      expectPasteSafe(stage, value);
    }
  }, 120_000);

  it.each(SHELL_SHAPED)('describes %s', (value) => {
    expect(fromCfnRedundancyTip(value)).toContain('(a stack name that is not a plain identifier)');
    expect(stageMissWarning('prod', value)).toContain(
      'on API a logical id that is not a plain identifier;'
    );
  });
});

describe('cdkd local invoke: the --tmpfs lines name the logical id only when plain', () => {
  function lines(kind: 'image' | 'zip', logicalId: string): string {
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
    const debug = vi.spyOn(getLogger(), 'debug').mockImplementation(() => undefined);
    resolveTmpfsForLambda({ kind, logicalId, ephemeralStorageMb: 1024 } as never);
    return [...info.mock.calls, ...debug.mock.calls].map((c) => String(c[0])).join('\n');
  }

  it('renders an ordinary id bare, as before', () => {
    expect(lines('image', 'MyFn')).toContain('Lambda MyFn: capping /tmp at 1024 MiB via --tmpfs');
    expect(lines('zip', 'MyFn')).toContain('Lambda MyFn: applying EphemeralStorage cap via --tmpfs');
  });

  it('names no payload id beside --tmpfs', () => {
    for (const { value } of PASTE_PAYLOADS) {
      for (const kind of ['image', 'zip'] as const) {
        const message = lines(kind, value);
        expect(message, `${kind} ${value}`).toContain(`Lambda ${ID_DESC}: `);
        expectPasteSafe(message, value);
        vi.restoreAllMocks();
      }
    }
  }, 120_000);

  it.each(SHELL_SHAPED)('describes %s', (value) => {
    expect(lines('image', value)).toContain(`Lambda ${ID_DESC}: capping`);
    vi.restoreAllMocks();
    expect(lines('zip', value)).toContain(`Lambda ${ID_DESC}: applying`);
  });
});
