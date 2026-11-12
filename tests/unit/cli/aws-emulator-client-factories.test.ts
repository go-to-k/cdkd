import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vite-plus/test';
import ts from 'typescript-v6';

import {
  buildReport,
  resolveObjectLiteral,
  sdkClientIdentifiers,
  sdkClientNamespaces,
} from '../../../scripts/check-aws-client-defaults.ts';
import { AwsClients } from '../../../src/utils/aws-clients.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';

/**
 * go-to-k/cdkd#6138: under `--aws-emulator` every SDK client cdkd builds must
 * sign with the emulator's keys and send to its endpoint — a missed client
 * must fail against the emulator, never reach real AWS.
 *
 * The mechanism is ONE helper, `awsClientDefaults`, whose endpoint override
 * outranks every other identity. Two things could still route a client
 * around it, and this file ENUMERATES the client factories for both:
 *
 * 1. A construction site that does not spread the helper first.
 *    `scripts/check-aws-client-defaults.ts` (CI) refuses it, and its
 *    allow-list is empty; asserted again here so this guarantee does not rest
 *    on a CI job alone.
 * 2. A site that sets its OWN `credentials` or `endpoint` AFTER the spread,
 *    which wins over the override. Each such site is listed below with why its
 *    value is still the emulator's under the flag; an unlisted one fails, and
 *    so does a listed one that no longer exists.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const srcDir = join(repoRoot, 'src');

/** The keys a site may not set after the defaults spread without a reason. */
const OVERRIDING_KEYS = new Set(['credentials', 'endpoint']);

/**
 * `<file>#<key>` -> why the value is the emulator's (or the user's explicit
 * choice) under `--aws-emulator`.
 */
const REVIEWED_OVERRIDES: Record<string, string> = {
  'src/utils/aws-clients.ts#credentials':
    'AwsClients.config.credentials: set only by a caller holding credentials resolved through a client built with awsClientDefaults (the emulator keys under the flag)',
  'src/utils/aws-region-resolver.ts#credentials':
    "the GetBucketLocation probe reuses the caller's resolved credentials, taken from a client built with awsClientDefaults",
  'src/utils/bucket-region-client.ts#credentials':
    "a region rebuild copies the credentials of the client it replaces, itself built with awsClientDefaults; or the store's static credentials from the same source",
  'src/cli/config-loader.ts#credentials':
    "the default-bucket probe reuses the STS client's provider, and that STS client is built with awsClientDefaults",
  'src/cli/upload-cfn-template.ts#credentials':
    "the export upload reuses the S3 client options' credentials, which come from a client built with awsClientDefaults",
  'src/state/s3-state-backend/client.ts#credentials':
    "the state backend's region rebuild reuses its own client's credentials (built with awsClientDefaults)",
  'src/deployment/intrinsic-resolver/stack-state.ts#credentials':
    'Fn::GetStackOutput RoleArn: credentials from an sts:AssumeRole sent through a client built with awsClientDefaults, i.e. issued by the emulator',
  'src/provisioning/cloud-control/update.ts#credentials':
    "a sibling client reuses the first client's resolved credentials (built with awsClientDefaults)",
  'src/provisioning/providers/custom-resource-response-endpoint.ts#credentials':
    "the presign client reuses the custom-resource response client's credentials (built with awsClientDefaults)",
  'src/utils/expected-bucket-owner.ts#credentials':
    "the owner probe's STS call reuses the credentials a state-bucket client resolved, and that client is built with awsClientDefaults",
  'src/local/ecr-puller.ts#credentials':
    '`cdkd local` --ecr-role-arn: credentials from an sts:AssumeRole sent through a client built with awsClientDefaults, i.e. issued by the emulator',
  'src/provisioning/providers/custom-resource-response-endpoint.ts#endpoint':
    'the user-set CDKD_CR_S3_ENDPOINT_URL, an explicit choice of where Lambda handlers PUT their response',
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield full;
  }
}

/** Object literals reachable from a spread's expression (`...(x && { credentials })`). */
function literalsIn(node: ts.Node): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      out.push(n);
      return;
    }
    if (ts.isCallExpression(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * The object literal a NAMED bag spread into a config resolves to: a
 * `const bag = {...}` / class field (the checker's own resolver), or a getter
 * returning a literal (`...this.clientOptions` in `AwsClients`).
 */
function resolveNamedBag(
  expression: ts.Expression,
  source: ts.SourceFile
): ts.ObjectLiteralExpression | undefined {
  const viaChecker = resolveObjectLiteral(expression, source);
  if (viaChecker !== undefined) return viaChecker;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const name = expression.name.text;
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const ret = node.body?.statements.find(ts.isReturnStatement)?.expression;
      if (ret !== undefined && ts.isObjectLiteralExpression(ret)) found = ret;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name) {
    return ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
  }
  return undefined;
}

interface Override {
  key: string;
  site: string;
}

/**
 * Every `credentials` / `endpoint` an SDK client config sets beside the
 * defaults: inline, inside a conditional spread, or inside a named bag spread
 * in (the `awsClientDefaults(...)` call itself is a call, so it is not opened).
 */
function scanOverrides(): { sites: number; overrides: Override[] } {
  let sites = 0;
  const overrides: Override[] = [];
  for (const file of walk(srcDir)) {
    const rel = relative(repoRoot, file);
    if (rel === 'src/utils/aws-client-defaults.ts') continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const clients = sdkClientIdentifiers(source);
    const namespaces = sdkClientNamespaces(source);
    if (clients.size === 0 && namespaces.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const e = node.expression;
        const isClient = ts.isIdentifier(e)
          ? clients.has(e.text)
          : ts.isPropertyAccessExpression(e) &&
            ts.isIdentifier(e.expression) &&
            namespaces.has(e.expression.text) &&
            e.name.text.endsWith('Client');
        const arg = node.arguments?.[0];
        if (isClient) {
          sites++;
          if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            arg.properties.forEach((p) => {
              const namesOf = (l: ts.ObjectLiteralExpression): string[] =>
                l.properties.flatMap((q) =>
                  ts.isSpreadAssignment(q)
                    ? literalsIn(q.expression).flatMap(namesOf)
                    : [propertyName(q)].filter((n): n is string => n !== undefined)
                );
              let names: string[];
              if (ts.isSpreadAssignment(p)) {
                const bag = resolveNamedBag(p.expression, source);
                names = [...literalsIn(p.expression), ...(bag ? [bag] : [])].flatMap(namesOf);
              } else {
                names = [propertyName(p)].filter((n): n is string => n !== undefined);
              }
              for (const key of names) {
                if (OVERRIDING_KEYS.has(key)) overrides.push({ key: `${rel}#${key}`, site: `${rel}:${line}` });
              }
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { sites, overrides };
}

describe('--aws-emulator: every SDK client factory follows the override', () => {
  it('every construction site opens with the defaults spread (no allow-listed gap)', () => {
    const report = buildReport(srcDir, { files: [] });
    expect(report.gaps).toEqual([]);
    // The scan saw the tree: a floor, so "no gaps" cannot mean "no sites".
    expect(report.totalSites).toBeGreaterThan(100);
  });

  it('every credentials / endpoint set after the spread is a reviewed site', () => {
    const { sites, overrides } = scanOverrides();
    expect(sites).toBeGreaterThan(100);
    const unreviewed = overrides.filter((o) => !(o.key in REVIEWED_OVERRIDES));
    expect(unreviewed.map((o) => o.site)).toEqual([]);
    const seen = new Set(overrides.map((o) => o.key));
    const stale = Object.keys(REVIEWED_OVERRIDES).filter((k) => !seen.has(k));
    expect(stale).toEqual([]);
  });
});

describe('--aws-emulator: every AwsClients getter signs with the emulator keys', () => {
  const EMULATOR = {
    endpoint: 'https://127.0.0.1:9331',
    credentials: { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'emulator-secret' },
  };

  afterEach(() => {
    setAwsEndpointOverrideSource(undefined);
    resetAwsClientDefaults();
  });

  /** Every public getter on `AwsClients` that returns an SDK client. */
  function clientGetters(): string[] {
    return Object.entries(Object.getOwnPropertyDescriptors(AwsClients.prototype))
      .filter(([, d]) => typeof d.get === 'function')
      .map(([name]) => name);
  }

  it('enumerates the getters', () => {
    // A floor per the class's population, so an empty walk cannot pass.
    expect(clientGetters().length).toBeGreaterThan(20);
  });

  it.each([
    ['no other identity', {}],
    ['--profile', { profile: 'prod' }],
  ])('with %s', async (_label, config) => {
    // A published --role-arn role too: the override must outrank it.
    setAssumedRoleCredentials({
      accessKeyId: 'ROLEKEYID00000000000',
      secretAccessKey: 'role-secret',
      sessionToken: 'role-token',
    });
    setAwsEndpointOverrideSource(() => EMULATOR);
    const clients = new AwsClients({ region: 'us-east-1', ...config });
    let checked = 0;
    try {
      for (const name of clientGetters()) {
        const client = (clients as unknown as Record<string, unknown>)[name] as
          | {
              config?: {
                credentials?: () => Promise<{ accessKeyId: string }>;
                endpoint?: () => Promise<{ hostname: string; port?: number }>;
              };
            }
          | undefined;
        if (typeof client?.config?.credentials !== 'function') continue;
        const creds = await client.config.credentials();
        expect(creds.accessKeyId, name).toBe(EMULATOR.credentials.accessKeyId);
        const ep = await client.config.endpoint?.();
        expect(ep?.hostname, name).toBe('127.0.0.1');
        expect(ep?.port, name).toBe(9331);
        checked++;
      }
    } finally {
      clients.destroy();
    }
    expect(checked).toBeGreaterThan(20);
  });
});
