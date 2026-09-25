/**
 * Ratchet on logger calls that interpolate a value RAW (go-to-k/cdkd#3479).
 *
 * `ConsoleLogger` strips terminal control characters from every message, but
 * it cannot tell cdkd's own newline from one a value carried in; only
 * `safeMsg` at the call site can. So a message built with an untagged template
 * literal or a `+` over a non-literal is counted per file, and a file may not
 * gain one. A file that loses some FAILS until the baseline is lowered with
 * `--update`, so the ratchet cannot quietly stop turning.
 *
 * Not counted: a message passed in a variable, which this cannot see through.
 *
 * Usage:
 *   node scripts/check-raw-log-interpolation.ts            # summary
 *   node scripts/check-raw-log-interpolation.ts --check    # exit 1 on a change
 *   node scripts/check-raw-log-interpolation.ts --update   # rewrite the baseline
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-v6';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC_DIR = join(REPO_ROOT, 'src');
const BASELINE_PATH = join(REPO_ROOT, 'tests/raw-log-interpolation-baseline.json');

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);

function isLoggerReceiver(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return /logger$/i.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return /logger$/i.test(node.name.text);
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'getLogger'
  );
}

function isComposite(node: ts.Expression): boolean {
  return (
    ts.isTemplateExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isConditionalExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

/** A piece of a composed message: raw unless it is a literal or `safeMsg` all the way down. */
function isRawPart(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isRawPart(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return false;
  if (ts.isTaggedTemplateExpression(node)) {
    return !(ts.isIdentifier(node.tag) && node.tag.text === 'safeMsg');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isRawPart(node.left) || isRawPart(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    return isRawPart(node.whenTrue) || isRawPart(node.whenFalse);
  }
  return true;
}

function isRawMessage(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isRawMessage(node.expression);
  return isComposite(node) && isRawPart(node);
}

export function countRawLogInterpolations(sourceText: string, fileName = 'x.ts'): number {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOG_METHODS.has(node.expression.name.text) &&
      isLoggerReceiver(node.expression.expression) &&
      node.arguments[0] !== undefined &&
      isRawMessage(node.arguments[0])
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

export function measure(srcDir = SRC_DIR): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of listSourceFiles(srcDir)) {
    const n = countRawLogInterpolations(readFileSync(file, 'utf8'), file);
    if (n > 0) counts[relative(REPO_ROOT, file)] = n;
  }
  return counts;
}

/** Per-file differences from the baseline; empty when they agree exactly. */
export function compare(
  actual: Record<string, number>,
  baseline: Record<string, number>
): string[] {
  const problems: string[] = [];
  for (const file of new Set([...Object.keys(actual), ...Object.keys(baseline)])) {
    const now = actual[file] ?? 0;
    const was = baseline[file] ?? 0;
    if (now > was) {
      problems.push(`${file}: ${now} raw interpolations (baseline ${was}) -- build the message with safeMsg`);
    } else if (now < was) {
      problems.push(`${file}: ${now} raw interpolations (baseline ${was}) -- lower the baseline with --update`);
    }
  }
  return problems;
}

function main(): void {
  const actual = measure();
  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;
  const problems = compare(actual, baseline);
  const total = Object.values(actual).reduce((a, b) => a + b, 0);
  console.log(`raw log interpolations: ${total} in ${Object.keys(actual).length} files`);
  for (const p of problems) console.log(`  ${p}`);
  if (process.argv.includes('--check') && problems.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
