import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6150 (maintainer decisions): `--aws-emulator` sends EVERY AWS
// call to the emulator, cdkd's own pre-start calls included, and a
// `"real-aws"` exception in `--env-vars` sends one service to real AWS — per
// workload (`Parameters` plus that workload's own section). An unmarked
// service stays on the emulator, so a forgotten entry fails CLOSED.
//
// In mixed mode cdkd's own clients default to the emulator
// (`mixedModeEmulatorOverride`, the process-wide override source); a call for
// an excepted service opts out with `awsClientDefaults({ realAws })`. STS
// hops that establish the real identity stay real; an account lookup follows
// the STS route.
//
// Two halves:
// - a MATRIX over cdkd's pre-start call sites x {excepted, not excepted, full
//   emulator, no flag}, building the REAL SDK clients and reading the endpoint
//   and credentials each one resolves (nothing is sent);
// - a POPULATION fence over ALL of src/: every AWS SDK client construction,
//   literal or not, is accounted for, so a new site cannot silently go to the
//   wrong side.

const captured = vi.hoisted(() => ({ resolverOpts: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cdk-local/internal')>();
  return {
    ...actual,
    // Capture the client factories cdkd hands cdk-local's resolver.
    DynamicReferenceResolver: class {
      constructor(opts: unknown) {
        captured.resolverOpts = opts;
      }
    },
  };
});

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { setActiveWorkloadAwsWiring, setAwsEmulatorServiceRouting } from 'cdk-local/internal';

import { createCallerDynamicReferenceResolver } from '../../../src/local/dynamic-reference.js';
import {
  mixedModeActive,
  mixedModeEmulatorOverride,
  realAwsException,
} from '../../../src/local/local-aws-wiring.js';
import {
  awsClientDefaults,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';

const EMULATOR_URL = 'https://127.0.0.1:9381';
const EMULATOR_KEYS = { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'emulator-secret' };
const REAL_KEYS = { accessKeyId: 'REALCALLERKEYID00000', secretAccessKey: 'real-secret' };
const OVERRIDE = { endpoint: EMULATOR_URL, credentials: EMULATOR_KEYS };

/**
 * Mixed mode as `cdkd local` installs it: cdk-local's routing with the parsed
 * `--env-vars` (per workload), its mixed wiring, and cdkd's override source.
 */
function mixed(envOverrides: Record<string, unknown>, realServices: string[]): void {
  setActiveWorkloadAwsWiring({
    mode: 'forward',
    mixed: { realServices, emulatorClientOverride: OVERRIDE },
    dispose: () => {},
  } as never);
  setAwsEmulatorServiceRouting({ realServices, override: OVERRIDE, envOverrides });
  setAwsEndpointOverrideSource(mixedModeEmulatorOverride);
}

/** `--aws-emulator` with no exception: the process-wide override alone. */
function fullEmulator(): void {
  setAwsEndpointOverrideSource(() => OVERRIDE);
}

const ENV_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // The real identity, as the default chain would find it.
  delete process.env['AWS_PROFILE'];
  process.env['AWS_ACCESS_KEY_ID'] = REAL_KEYS.accessKeyId;
  process.env['AWS_SECRET_ACCESS_KEY'] = REAL_KEYS.secretAccessKey;
  delete process.env['AWS_SESSION_TOKEN'];
  process.env['AWS_REGION'] = 'us-east-1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setAwsEmulatorServiceRouting(undefined);
  setActiveWorkloadAwsWiring(undefined);
  setAwsEndpointOverrideSource(undefined);
});

interface SdkClient {
  config: {
    credentials: () => Promise<{ accessKeyId: string }>;
    endpoint?: () => Promise<{ hostname: string; port?: number; protocol: string }>;
  };
  destroy(): void;
}

/** Where a built client would send its request, and as whom. Sends nothing. */
async function sideOf(client: SdkClient): Promise<{ endpoint: string | undefined; keyId: string }> {
  const ep = client.config.endpoint ? await client.config.endpoint() : undefined;
  const creds = await client.config.credentials();
  client.destroy();
  return {
    endpoint: ep ? `${ep.protocol}//${ep.hostname}${ep.port ? `:${ep.port}` : ''}` : undefined,
    keyId: creds.accessKeyId,
  };
}

const EMULATED = { endpoint: EMULATOR_URL, keyId: EMULATOR_KEYS.accessKeyId };
const REAL = { endpoint: undefined, keyId: REAL_KEYS.accessKeyId };

type Workload = { logicalId?: string; cdkPath?: string; containerName?: string } | undefined;
type Factory = (region: string, route: { workload: Workload; emulator: boolean }) => SdkClient;

function resolverFactories(): { sm: Factory; ssm: Factory } {
  createCallerDynamicReferenceResolver(undefined);
  const o = captured.resolverOpts as { secretsManagerClientFactory: Factory; ssmClientFactory: Factory };
  return { sm: o.secretsManagerClientFactory, ssm: o.ssmClientFactory };
}

/** cdkd's pre-start call sites, each building the client it would use for `workload`. */
const SITES: { name: string; service: string; build: (workload?: Workload) => SdkClient }[] = [
  {
    name: '{{resolve:secretsmanager:...}} (dynamic-reference.ts)',
    service: 'SECRETS_MANAGER',
    build: (workload) => resolverFactories().sm('us-east-1', { workload, emulator: false }),
  },
  {
    name: '{{resolve:ssm:...}} / ssm-secure (dynamic-reference.ts)',
    service: 'SSM',
    build: (workload) => resolverFactories().ssm('us-east-1', { workload, emulator: false }),
  },
  // The ECS `Secrets` / `ValueFrom` fetch (ecs-secrets-resolver.ts) builds its
  // clients inline, from the option the population fence below requires; its
  // config is reproduced here as the site writes it.
  {
    name: 'ECS task Secrets from Secrets Manager (ecs-secrets-resolver.ts)',
    service: 'SECRETS_MANAGER',
    build: (workload) =>
      new SecretsManagerClient({
        ...awsClientDefaults({
          ignoreAssumedRole: true,
          realAws: realAwsException('SECRETS_MANAGER', workload),
        }),
        region: 'us-east-1',
      }) as unknown as SdkClient,
  },
  {
    name: 'ECS task Secrets from SSM (ecs-secrets-resolver.ts)',
    service: 'SSM',
    build: (workload) =>
      new SSMClient({
        ...awsClientDefaults({ ignoreAssumedRole: true, realAws: realAwsException('SSM', workload) }),
        region: 'us-east-1',
      }) as unknown as SdkClient,
  },
];

describe('cdkd pre-start call sites x {excepted, not excepted, full emulator, no flag}', () => {
  for (const site of SITES) {
    it(`${site.name}: ${site.service} excepted ("real-aws") -> real AWS, as the caller`, async () => {
      mixed({ Parameters: { [`AWS_ENDPOINT_URL_${site.service}`]: 'real-aws' } }, [site.service]);
      expect(await sideOf(site.build())).toEqual(REAL);
    });

    it(`${site.name}: ${site.service} NOT excepted (another service is) -> the emulator, with its keys`, async () => {
      mixed({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } }, ['STS']);
      expect(await sideOf(site.build())).toEqual(EMULATED);
    });

    it(`${site.name}: --aws-emulator with no exception -> the emulator`, async () => {
      fullEmulator();
      expect(await sideOf(site.build())).toEqual(EMULATED);
    });

    it(`${site.name}: no --aws-emulator -> real AWS (a "real-aws" value is a no-op)`, async () => {
      expect(await sideOf(site.build())).toEqual(REAL);
    });
  }

  it("the blog's case: Secrets Manager excepted -> the secret from real AWS as the caller; DynamoDB stays on the emulator", async () => {
    mixed({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } }, ['SECRETS_MANAGER']);
    expect(await sideOf(SITES[0]!.build())).toEqual(REAL);
    expect(realAwsException('DYNAMODB')).toBe(false);
  });

  describe('per workload: A excepts Secrets Manager in its own section, B does not', () => {
    const ENV = {
      Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' },
      'MyStack/FnA': { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' },
      taskA: { AWS_ENDPOINT_URL_SSM: 'real-aws' },
    };
    const A = { logicalId: 'FnA1234', cdkPath: 'MyStack/FnA' };
    const B = { logicalId: 'FnB5678', cdkPath: 'MyStack/FnB' };

    it("A's {{resolve:secretsmanager}} -> real AWS; B's -> the emulator", async () => {
      mixed(ENV, ['STS', 'SECRETS_MANAGER', 'SSM']);
      expect(await sideOf(SITES[0]!.build(A))).toEqual(REAL);
      expect(await sideOf(SITES[0]!.build(B))).toEqual(EMULATED);
    });

    it('ECS: container taskA reads SSM from real AWS, container taskB from the emulator', async () => {
      mixed(ENV, ['STS', 'SECRETS_MANAGER', 'SSM']);
      expect(await sideOf(SITES[3]!.build({ containerName: 'taskA' }))).toEqual(REAL);
      expect(await sideOf(SITES[3]!.build({ containerName: 'taskB' }))).toEqual(EMULATED);
    });

    it('with no workload (a shared read), only the `Parameters` exceptions apply — never the union', () => {
      mixed(ENV, ['STS', 'SECRETS_MANAGER', 'SSM']);
      expect(realAwsException('STS')).toBe(true);
      expect(realAwsException('SECRETS_MANAGER')).toBe(false);
      expect(realAwsException('SSM')).toBe(false);
    });
  });

  describe('STS', () => {
    const sts = (realAws: boolean): SdkClient =>
      new STSClient({ ...awsClientDefaults({ ignoreAssumedRole: true, realAws }), region: 'us-east-1' }) as unknown as SdkClient;

    it('a hop establishing the real identity (--assume-role / --profile resolution) stays real in mixed mode, STS excepted or not', async () => {
      mixed({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } }, ['SECRETS_MANAGER']);
      expect(mixedModeActive()).toBe(true);
      expect(await sideOf(sts(mixedModeActive()))).toEqual(REAL);
    });

    it('a hop under --aws-emulator alone goes to the emulator, which answers it', async () => {
      fullEmulator();
      expect(await sideOf(sts(mixedModeActive()))).toEqual(EMULATED);
    });

    it('an ${AWS::AccountId} lookup follows the STS route: the emulator unless `Parameters` excepts STS', async () => {
      mixed({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } }, ['SECRETS_MANAGER']);
      expect(await sideOf(sts(realAwsException('STS')))).toEqual(EMULATED);
      mixed({ Parameters: { AWS_ENDPOINT_URL_STS: 'real-aws' } }, ['STS']);
      expect(await sideOf(sts(realAwsException('STS')))).toEqual(REAL);
    });
  });

  it("matches the SDK's spelling, as cdk-local does: SECRETS_MANAGER, not SECRETSMANAGER", () => {
    mixed({ Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' } }, ['SECRETS_MANAGER']);
    expect(realAwsException('SECRETS_MANAGER')).toBe(true);
    expect(realAwsException('Secrets Manager')).toBe(true);
    expect(realAwsException('SECRETSMANAGER')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '../../..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The `cdkd local` surface: cdkd's own calls before or around a workload. */
function onLocalSurface(rel: string): boolean {
  return (
    rel.startsWith('src/local/') ||
    /^src\/cli\/commands\/local[-.]/.test(rel) ||
    rel === 'src/utils/role-arn.ts'
  );
}

/**
 * Every AWS SDK client construction in `src`: class, argument text, line, and
 * the few lines above it (where a hoisted `const realAws = ...` sits).
 */
function constructions(src: string): { cls: string; args: string; line: number; above: string }[] {
  const found: { cls: string; args: string; line: number; above: string }[] = [];
  const re = /\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Z][A-Za-z0-9]*Client)\s*\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const lineText = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
    if (/^\s*(\/\/|\*)/.test(lineText)) continue; // prose
    let depth = 1;
    let j = m.index + m[0].length;
    while (depth > 0 && j < src.length) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    }
    const before = src.slice(0, m.index).split('\n');
    found.push({
      cls: m[1]!,
      args: src.slice(m.index + m[0].length, j - 1).trim(),
      line: before.length,
      above: before.slice(-5).join('\n'),
    });
  }
  return found;
}

/** Is `cls` an AWS SDK client in this file (a static or dynamic `@aws-sdk/client-*` import)? */
function isSdkClient(src: string, cls: string): boolean {
  return (
    new RegExp(`import[^;]*\\b${cls}\\b[^;]*from '@aws-sdk/client-`).test(src) ||
    new RegExp(`\\b${cls}\\b[^;]*= await import\\('@aws-sdk/client-`).test(src)
  );
}

/** The workload-input reads routed per service: Secrets Manager / SSM. */
const ROUTED: Record<string, string> = { SecretsManagerClient: 'SECRETS_MANAGER', SSMClient: 'SSM' };

/**
 * Reviewed exemptions, by file and a phrase of the construction: a client
 * that is not a `cdkd local` pre-start read, or that mixed mode routes some
 * other way.
 */
const EXEMPT: { file: string; phrase: string; why: string }[] = [
  {
    file: 'src/utils/aws-clients.ts',
    phrase: 'SecretsManagerClient',
    why: "the deploy bag's client: `cdkd deploy`'s own dynamic-reference reads, never a local pre-start read",
  },
  { file: 'src/utils/aws-clients.ts', phrase: 'SSMClient', why: "the deploy bag's client, as above" },
  {
    file: 'src/local/custom-resource-runtime.ts',
    phrase: 'ambientClientDefaults(), region',
    why: "the custom-resource runtime's GetFunctionConfiguration in another region (go-to-k/cdkd#6213): it runs only in full emulator mode (its gate), never in mixed mode",
  },
  {
    file: 'src/provisioning/providers/ssm-parameter-provider.ts',
    phrase: 'clientDefaultsFor(this.credentialConfig)',
    why: 'provisioning an AWS::SSM::Parameter on deploy',
  },
  {
    file: 'src/synthesis/context-providers/ssm-provider.ts',
    phrase: 'ambientClientDefaults()',
    why: "a synth-time context lookup: the TEMPLATE must not depend on one run's routing (cdk.context.json caches it)",
  },
  {
    file: 'src/utils/role-arn.ts',
    phrase: 'clientDefaultsFor(sourceConfig)',
    why: 'assumeRoleForCrossAccountStateRead: the Fn::GetStackOutput RoleArn hop of a deploy-time state read',
  },
  {
    file: 'src/utils/role-arn.ts',
    phrase: 'awsClientDefaults({ ignoreAssumedRole: true })',
    why: 'applyRoleArnIfSet: `applyRoleArnForLocal` runs it on real AWS in mixed mode (`runWithRealAws`)',
  },
  {
    file: 'src/local/ecr-puller.ts',
    phrase: 'clientDefaultsFor(credentialConfig',
    why: 'the ECR pull: `pullEcrImage` runs the whole pull on real AWS (`runWithRealAws`) when the workload excepts ECR (#6179), else on the process default',
  },
];

/**
 * Does a construction pass `realAws` computed by `decision` — inline
 * (`realAws: <decision>`), or as the `realAws` shorthand of a
 * `const realAws = <decision>` just above it?
 */
function passesRealAws(c: { args: string; above: string }, decision: RegExp): boolean {
  const inline = new RegExp(`realAws: (?:${decision.source})`).test(c.args);
  const hoisted =
    /\brealAws\b(?!:)/.test(c.args) && new RegExp(`const realAws = (?:${decision.source})`).test(c.above);
  return inline || hoisted;
}
/** The decision a Secrets Manager / SSM site must take: its service's exception. */
const routedDecision = (svc: string): RegExp => new RegExp(`realAwsException\\('${svc}'`);
/** The decision an STS site on the local surface must take: a hop, or an account lookup. */
const STS_DECISION = /mixedModeActive\(\)|realAwsException\('STS'\)/;
/**
 * `local run-task --assume-task-role` (go-to-k/cdkd#6147): the route is decided
 * PER CONTAINER by the caller (`planTaskRoleCredentials` →
 * `taskRoleAssumedInRealAws`), so these sites take it as a REQUIRED `route`
 * parameter — the test below pins that it has no default.
 */
const TASK_ROLE_ROUTE_FILE = 'src/cli/commands/local-run-task/stack-account.ts';
const TASK_ROLE_ROUTE_DECISION = new RegExp(`${STS_DECISION.source}|route\\.realAws\\b`);
/**
 * Role-permission emulation (go-to-k/cdkd#6201) REPLACES a refused assume-role
 * hop, so its STS and IAM clients take that hop's route from the caller
 * (`args.realAws`, a REQUIRED field of `EmulateRoleArgs`) rather than deciding
 * one of their own.
 */
const ROLE_EMULATION_FILE = 'src/local/role-permission-emulation.ts';
const ROLE_EMULATION_DECISION = /args\.realAws\b/;

describe('population: every AWS SDK client in src/ is accounted for', () => {
  const offenders: string[] = [];
  let seen = 0;
  let routedSeen = 0;
  let stsSeen = 0;
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    for (const c of constructions(src)) {
      if (!isSdkClient(src, c.cls)) continue;
      seen++;
      const where = `${rel}:${c.line} new ${c.cls}`;
      if (EXEMPT.some((e) => rel === e.file && (c.args.includes(e.phrase) || c.cls === e.phrase))) continue;
      const svc = ROUTED[c.cls];
      if (svc !== undefined) {
        if (!c.args.startsWith('{') || !passesRealAws(c, routedDecision(svc))) {
          offenders.push(`${where}: no realAws: realAwsException('${svc}', <workload>)`);
        } else routedSeen++;
        continue;
      }
      if (!onLocalSurface(rel)) continue;
      if (rel === ROLE_EMULATION_FILE && (c.cls === 'STSClient' || c.cls === 'IAMClient')) {
        if (!c.args.startsWith('{') || !passesRealAws(c, ROLE_EMULATION_DECISION)) {
          offenders.push(`${where}: an emulation client takes the refused hop's route (realAws: args.realAws)`);
        } else stsSeen++;
        continue;
      }
      if (c.cls === 'STSClient') {
        const decision = rel === TASK_ROLE_ROUTE_FILE ? TASK_ROLE_ROUTE_DECISION : STS_DECISION;
        if (!c.args.startsWith('{') || !passesRealAws(c, decision)) {
          offenders.push(`${where}: an STS site needs realAws: mixedModeActive() (hop) or realAwsException('STS') (lookup)`);
        } else stsSeen++;
        continue;
      }
      offenders.push(`${where}: no mixed-mode routing decision for this service`);
    }
  }

  it('the task-role STS route is a REQUIRED parameter, so no caller falls back by omission (#6147)', () => {
    const src = readFileSync(join(ROOT, TASK_ROLE_ROUTE_FILE), 'utf8');
    // `,?`: `assumeTaskRole` takes `--emulate-role-via` after it (go-to-k/cdkd#6201).
    expect(src.match(/\broute: \{ realAws: boolean \},?\n/g)?.length).toBe(2);
    expect(src).not.toMatch(/\broute: \{ realAws: boolean \} =/);
  });

  it('finds the population (a floor per shape)', () => {
    expect(seen).toBeGreaterThanOrEqual(40);
    // The four routed Secrets Manager / SSM pre-start reads.
    expect(routedSeen).toBe(4);
    // 5 hops + 8 account lookups on the local surface.
    expect(stsSeen).toBeGreaterThanOrEqual(13);
  });

  it('routes each workload-input read, decides each STS site, and leaves no local client undecided', () => {
    expect(offenders).toEqual([]);
  });

  it('every exemption still names a construction (no stale entry)', () => {
    for (const e of EXEMPT) {
      const src = readFileSync(join(ROOT, e.file), 'utf8');
      expect(src.includes(e.phrase), `${e.file}: ${e.phrase}`).toBe(true);
    }
  });
});
