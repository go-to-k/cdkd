/**
 * Fence for issue #3588: no SDK client under `src/**` may be built from a
 * ZERO-ARGUMENT `awsClientDefaults()` alone.
 *
 * That shape carries the ambient environment (proxy, `--role-arn`, the stack
 * scope's region) but NOT an explicit `AwsClientConfig.credentials`, so a
 * library caller that installs `new AwsClients({ credentials })` has the
 * client sign with the default chain instead. The fix is
 * `ambientClientDefaults()` (src/utils/ambient-client-defaults.ts); this fence
 * is what keeps the NEXT provider from reintroducing the shape — it compiles,
 * every CLI run is correct, and only a library caller's identity is wrong.
 *
 * A site is exempt when its config literal carries its OWN unconditional
 * `credentials` property: that site chose its identity deliberately (the
 * cross-account `Fn::GetStackOutput` read, `expected-bucket-owner.ts`'s
 * per-credential probe). A `awsClientDefaults({ profile })` /
 * `{ ignoreAssumedRole }` call is out of scope: every such site is either
 * CLI-only (the profile-threaded asset-storage / asset-redirect / synthesizer
 * sites, which no library entry point constructs) or the `cdkd local` surface,
 * which opts out of the role on purpose. Anything else in the argument — `{}`,
 * `{ region }`, an unreadable expression — is the zero-arg shape spelled
 * differently and is flagged.
 *
 * BOUND: the allow-list is per FILE, so while a file sits on it a NEW
 * zero-arg site in that file is invisible; the stale check forces the entry
 * out once the file is routed.
 *
 * Construction detection reuses `scripts/check-aws-client-defaults.ts`'s
 * import-bound identifier resolution, which that suite reconciles against an
 * independent text scan.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import ts from 'typescript-v6';

import {
  resolveObjectLiteral,
  sdkClientIdentifiers,
  sdkClientNamespaces,
} from '../../../scripts/check-aws-client-defaults.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Files that still hold an `awsClientDefaults()`-only construction, each with
 * its reason. A STALE entry (the file is clean now) and a DEAD one (the file is
 * gone) both fail, so this list can only shrink.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/cli/commands/deploy.ts': 'held by open PR #3613 when #3588 landed; route it next',
  'src/cli/commands/export.ts': 'held by open PR #3613 when #3588 landed; route it next',
  'src/cli/config-loader.ts':
    "default-bucket probe deliberately reuses the STS client's resolved provider " +
    '(a CONDITIONAL credentials spread); CLI-only',
  'src/provisioning/providers/s3-tables-provider.ts':
    'held by open PR #3613 when #3588 landed; route it next',
};

const ROUTED_HELPERS = new Set(['ambientClientDefaults', 'clientDefaultsFor']);

type Verdict = 'bare-defaults' | 'own-credentials' | 'routed' | 'other';

interface Site {
  readonly file: string;
  readonly line: number;
  readonly verdict: Verdict;
}

function calleeName(expression: ts.Expression): string | undefined {
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    ? expression.expression.text
    : undefined;
}

/**
 * Does the literal carry a DIRECT, unconditional `credentials` property? A
 * literal `credentials: undefined` is not one, nor is `credentials: c ? a : b`.
 */
function hasOwnCredentials(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (property) =>
      ((ts.isPropertyAssignment(property) &&
        !(ts.isIdentifier(property.initializer) && property.initializer.text === 'undefined') &&
        !ts.isConditionalExpression(property.initializer)) ||
        ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'credentials'
  );
}

/**
 * Does this `awsClientDefaults(...)` call leave the identity to the ambient
 * environment? Decided by the argument's CONTENT, not its arity:
 * `awsClientDefaults({})` and `awsClientDefaults({ region })` are the zero-arg
 * shape spelled differently. Only a literal naming `profile` or
 * `ignoreAssumedRole` is a site deciding its own identity; an argument this
 * cannot read is flagged, like the parent checker's `opaque`.
 */
function selectsNoIdentity(call: ts.CallExpression): boolean {
  const argument = call.arguments[0];
  if (argument === undefined) return true;
  if (!ts.isObjectLiteralExpression(argument)) return true;
  return !argument.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      (property.name.text === 'profile' || property.name.text === 'ignoreAssumedRole')
  );
}

/**
 * The call the literal OPENS with, following a first-position spread of a
 * same-file bag (`const opts = { ...awsClientDefaults(), region }`), since a
 * bag hides the shape from a site-only look.
 */
function openingCall(
  literal: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  depth = 0
): ts.CallExpression | undefined {
  const first = literal.properties[0];
  if (first === undefined || !ts.isSpreadAssignment(first)) return undefined;
  if (ts.isCallExpression(first.expression)) return first.expression;
  if (depth >= 4) return undefined;
  const inner = resolveObjectLiteral(first.expression, source);
  return inner === undefined ? undefined : openingCall(inner, source, depth + 1);
}

function classifySites(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const clients = sdkClientIdentifiers(source);
  const namespaces = sdkClientNamespaces(source);
  if (clients.size === 0 && namespaces.size === 0) return [];
  const out: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const isClient = ts.isIdentifier(node.expression)
        ? clients.has(node.expression.text)
        : ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          namespaces.has(node.expression.expression.text) &&
          node.expression.name.text.endsWith('Client');
      const argument = node.arguments?.[0];
      const literal = isClient && argument ? resolveObjectLiteral(argument, source) : undefined;
      if (isClient) {
        const call = literal ? openingCall(literal, source) : undefined;
        const name = call ? calleeName(call) : undefined;
        let verdict: Verdict = 'other';
        if (name !== undefined && ROUTED_HELPERS.has(name)) verdict = 'routed';
        else if (name === 'awsClientDefaults' && selectsNoIdentity(call!)) {
          verdict = hasOwnCredentials(literal!) ? 'own-credentials' : 'bare-defaults';
        }
        out.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          verdict,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function scanSrc(override?: { file: string; text: string }): Site[] {
  const out: Site[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const key = relative(repoRoot, full);
        const text = override?.file === key ? override.text : readFileSync(full, 'utf8');
        out.push(...classifySites(key, text));
      }
    }
  };
  walk(join(repoRoot, 'src'));
  return out;
}

function violations(scan: Site[]): { unexplained: string[]; stale: string[] } {
  const bare = scan.filter((site) => site.verdict === 'bare-defaults');
  const unexplained = bare
    .filter((site) => !(site.file in ALLOWED))
    .map((site) => `${site.file}:${site.line}`);
  const filesWithBare = new Set(bare.map((site) => site.file));
  const stale = Object.keys(ALLOWED).filter((file) => !filesWithBare.has(file));
  return { unexplained, stale };
}

describe('awsClientDefaults()-only client construction fence (#3588)', () => {
  describe('classification', () => {
    const IMPORT = "import { S3Client } from '@aws-sdk/client-s3';\n";
    const verdicts = (body: string): Verdict[] =>
      classifySites('src/fake.ts', IMPORT + body).map((site) => site.verdict);

    it('flags a zero-argument awsClientDefaults() spread', () => {
      expect(verdicts("new S3Client({ ...awsClientDefaults(), region: 'x' });")).toEqual([
        'bare-defaults',
      ]);
    });

    it('flags the shape hidden behind a same-file bag', () => {
      expect(
        verdicts("const opts = { ...awsClientDefaults(), region: 'x' };\nnew S3Client(opts);")
      ).toEqual(['bare-defaults']);
    });

    it('flags the dynamic-namespace form', () => {
      expect(
        classifySites(
          'src/fake.ts',
          "const mod = await import('@aws-sdk/client-sts');\n" +
            'new mod.STSClient({ ...awsClientDefaults() });'
        ).map((site) => site.verdict)
      ).toEqual(['bare-defaults']);
    });

    it('does not count a CONDITIONAL credentials spread as the site choosing its identity', () => {
      expect(
        verdicts('new S3Client({ ...awsClientDefaults(), ...(c && { credentials: c }) });')
      ).toEqual(['bare-defaults']);
    });

    it('exempts a site with its own unconditional credentials', () => {
      expect(verdicts('new S3Client({ ...awsClientDefaults(), credentials: c });')).toEqual([
        'own-credentials',
      ]);
      expect(verdicts('new S3Client({ ...awsClientDefaults(), credentials });')).toEqual([
        'own-credentials',
      ]);
    });

    it('credits the ambient helpers and leaves an argument-carrying call alone', () => {
      expect(verdicts('new S3Client({ ...ambientClientDefaults(), region });')).toEqual([
        'routed',
      ]);
      expect(verdicts('new S3Client({ ...clientDefaultsFor(cc) });')).toEqual(['routed']);
      expect(verdicts('new S3Client({ ...awsClientDefaults({ profile }) });')).toEqual(['other']);
      expect(
        verdicts('new S3Client({ ...awsClientDefaults({ ignoreAssumedRole: true }) });')
      ).toEqual(['other']);
    });

    it('flags the zero-arg shape spelled with an argument that selects no identity', () => {
      expect(verdicts('new S3Client({ ...awsClientDefaults({}) });')).toEqual(['bare-defaults']);
      expect(verdicts("new S3Client({ ...awsClientDefaults({ region: 'x' }) });")).toEqual([
        'bare-defaults',
      ]);
      expect(verdicts('new S3Client({ ...awsClientDefaults(opts) });')).toEqual(['bare-defaults']);
      expect(
        verdicts('new S3Client({ ...awsClientDefaults(), credentials: undefined });')
      ).toEqual(['bare-defaults']);
      expect(
        verdicts('new S3Client({ ...awsClientDefaults(), credentials: c ? c : undefined });')
      ).toEqual(['bare-defaults']);
    });
  });

  describe('the real tree', () => {
    const scan = scanSrc();

    it('has no awsClientDefaults()-only construction outside the allow-list, and no stale entry', () => {
      const { unexplained, stale } = violations(scan);
      expect(
        unexplained,
        'build this client with `...ambientClientDefaults()` (src/utils/ambient-client-defaults.ts) ' +
          'so an explicit AwsClientConfig.credentials reaches it (issue #3588)'
      ).toEqual([]);
      expect(stale, 'the file is clean now: drop its ALLOWED entry').toEqual([]);
    });

    it('still sees the population — a collapsed parse must fail loudly', () => {
      // Measured at #3588: 85 routed sites, 2 own-credentials sites. Round
      // floors below that, so a walk that stops matching cannot pass vacuously.
      expect(scan.filter((site) => site.verdict === 'routed').length).toBeGreaterThanOrEqual(80);
      expect(scan.filter((site) => site.verdict === 'own-credentials').length).toBeGreaterThanOrEqual(
        2
      );
      // Every allow-listed file is SEEN as holding the shape, which is what the
      // stale check reads; asserting it here names the floor per entry.
      const bareFiles = new Set(
        scan.filter((site) => site.verdict === 'bare-defaults').map((site) => site.file)
      );
      for (const file of Object.keys(ALLOWED)) expect(bareFiles, file).toContain(file);
    });

    it('reports a routed REAL site reverted to awsClientDefaults()', () => {
      const file = 'src/provisioning/providers/glue-provider.ts';
      const original = readFileSync(join(repoRoot, file), 'utf8');
      const reverted = original.replace('...ambientClientDefaults(),', '...awsClientDefaults(),');
      expect(reverted, 'the anchor moved — re-point this probe').not.toBe(original);
      const { unexplained } = violations(scanSrc({ file, text: reverted }));
      expect(unexplained.map((entry) => entry.split(':')[0])).toEqual([file]);
    });

    it('reports the role-arn.ts STS hop reverted to awsClientDefaults()', () => {
      const file = 'src/utils/role-arn.ts';
      const original = readFileSync(join(repoRoot, file), 'utf8');
      const reverted = original.replace(
        '...clientDefaultsFor(sourceConfig)',
        '...awsClientDefaults()'
      );
      expect(reverted, 'the anchor moved — re-point this probe').not.toBe(original);
      expect(violations(scanSrc({ file, text: reverted })).unexplained).toHaveLength(1);
    });
  });
});
