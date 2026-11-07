/**
 * The security-changes table and the stdout color check.
 * Split out of `../security-changes.ts` (#5835).
 */

import { bold, gray, green, red, yellow } from '../../utils/colors.js';
import type { SecurityChanges } from '../security-changes.js';
import type { DiffableCollection, Json, SecurityGroupRule, SsoElement } from './model.js';

// ---------------------------------------------------------------------------
// The table

/** Rows sorted by their second column (then `then`), header first. */
function withHeader(
  color: boolean,
  header: string[],
  rows: string[][],
  then: (row: string[]) => number = () => 0
): string[][] {
  rows.sort((a, b) => {
    const keyA = sortKey(a, color);
    const keyB = sortKey(b, color);
    if (keyA < keyB) return -1;
    if (keyB < keyA) return 1;
    return then(a) - then(b);
  });
  return [header, ...rows];
}

/**
 * A row's second column as the AWS CDK CLI compares it: with colors, wrapped
 * in chalk's codes for its sign (reopened around each line break), so a
 * removal (red) sorts before every addition (green) and a separator divides
 * the two even on one resource; without, the plain text.
 */
function sortKey(row: string[], color: boolean): string {
  const open = !color ? '' : row[0] === '-' ? '\u001b[31m' : row[0] === '+' ? '\u001b[32m' : '';
  // chalk leaves an empty string uncolored.
  if (open === '' || row[1] === '') return row[1]!;
  const close = '\u001b[39m';
  return open + row[1]!.replace(/\r?\n/g, (m) => close + m + open) + close;
}

function summarizeStatements(changes: SecurityChanges, color: boolean): string[][] {
  const rows = [
    ...changes.statements.additions.map((s) => ['+', ...s.render()]),
    ...changes.statements.removals.map((s) => ['-', ...s.render()]),
  ];
  return withHeader(color, ['', 'Resource', 'Effect', 'Action', 'Principal', 'Condition'], rows);
}

function summarizeManagedPolicies(changes: SecurityChanges, color: boolean): string[][] {
  const rows = [
    ...changes.managedPolicies.additions.map((a) => ['+', a.identityArn, a.managedPolicyArn]),
    ...changes.managedPolicies.removals.map((a) => ['-', a.identityArn, a.managedPolicyArn]),
  ];
  return withHeader(color, ['', 'Resource', 'Managed Policy ARN'], rows);
}

function ssoRows(
  collection: DiffableCollection<SsoElement>,
  cells: (f: Json) => string[]
): string[][] {
  return [
    ...collection.additions.map((e) => ['+', ...cells(e.fields)]),
    ...collection.removals.map((e) => ['-', ...cells(e.fields)]),
  ];
}

function formatManagedPolicyRef(s: Json): string {
  return `Name: ${s?.Name || ''}, Path: ${s?.Path || ''}`;
}

function summarizeSsoPermissionSets(changes: SecurityChanges, color: boolean): string[][] {
  const boundary = (pb: Json): string => {
    if (pb?.ManagedPolicyArn !== undefined)
      return `ManagedPolicyArn: ${pb?.ManagedPolicyArn || ''}`;
    if (pb?.CustomerManagedPolicyReference !== undefined) {
      return `CustomerManagedPolicyReference: {\n  ${formatManagedPolicyRef(pb?.CustomerManagedPolicyReference)}\n}`;
    }
    return '';
  };
  const rows = ssoRows(changes.ssoPermissionSets, (f) => [
    f.cfnLogicalId || '',
    f.ssoInstanceArn || '',
    f.name || '',
    boundary(f.ssoPermissionsBoundary),
    f.ssoCustomerManagedPolicyReferences?.map(formatManagedPolicyRef).join('\n') || '',
  ]);
  return withHeader(
    color,
    [
      '',
      'Resource',
      'InstanceArn',
      'PermissionSet name',
      'PermissionsBoundary',
      'CustomerManagedPolicyReferences',
    ],
    rows
  );
}

function summarizeSsoInstanceACAConfigs(changes: SecurityChanges, color: boolean): string[][] {
  const attribute = (aca: Json): string =>
    `Key: ${aca?.Key}, Values: [${aca?.Value?.Source.join(', ')}]`;
  const rows = ssoRows(changes.ssoInstanceACAConfigs, (f) => [
    f.cfnLogicalId || '',
    f.ssoInstanceArn || '',
    f.accessControlAttributes?.map(attribute).join('\n') || '',
  ]);
  return withHeader(color, ['', 'Resource', 'InstanceArn', 'AccessControlAttributes'], rows);
}

function summarizeSsoAssignments(changes: SecurityChanges, color: boolean): string[][] {
  const rows = ssoRows(changes.ssoAssignments, (f) => [
    f.cfnLogicalId || '',
    f.ssoInstanceArn || '',
    f.permissionSetArn || '',
    f.principalId || '',
    f.principalType || '',
    f.targetId || '',
    f.targetType || '',
  ]);
  return withHeader(
    color,
    [
      '',
      'Resource',
      'InstanceArn',
      'PermissionSetArn',
      'PrincipalId',
      'PrincipalType',
      'TargetId',
      'TargetType',
    ],
    rows
  );
}

function summarizeSecurityGroups(changes: SecurityChanges, color: boolean): string[][] {
  const render =
    (sign: string, dir: string) =>
    (rule: SecurityGroupRule): string[] => [
      sign,
      `${rule.groupId}`,
      dir,
      rule.describeProtocol(),
      rule.describePeer(),
    ];
  const rows = [
    ...changes.ingress.additions.map(render('+', 'In')),
    ...changes.egress.additions.map(render('+', 'Out')),
    ...changes.ingress.removals.map(render('-', 'In')),
    ...changes.egress.removals.map(render('-', 'Out')),
  ];
  return withHeader(color, ['', 'Group', 'Dir', 'Protocol', 'Peer'], rows, (row) =>
    row[2]!.indexOf('In') > -1 ? 0 : 1
  );
}

/**
 * Terminal columns a line takes (`string-width`): East Asian wide characters
 * and emoji shown as emoji take two, control and combining characters none.
 * A pictograph that displays as text (`©`, `™`) takes one.
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(
    /(?:\p{Regional_Indicator}{2}|\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?)\p{Emoji_Modifier}?)*/gu,
    '  '
  )) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    width += isFullwidth(code) ? 2 : 1;
  }
  return width;
}

function isFullwidth(c: number): boolean {
  return (
    c >= 0x1100 &&
    (c <= 0x115f ||
      c === 0x2329 ||
      c === 0x232a ||
      (c >= 0x2e80 && c <= 0x3247 && c !== 0x303f) ||
      (c >= 0x3250 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0xa4c6) ||
      (c >= 0xa960 && c <= 0xa97c) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe19) ||
      (c >= 0xfe30 && c <= 0xfe6b) ||
      (c >= 0xff01 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1b000 && c <= 0x1b001) ||
      (c >= 0x1f200 && c <= 0x1f251) ||
      (c >= 0x20000 && c <= 0x3fffd))
  );
}

/**
 * A box-drawn table; the first row is the header. A line separates rows whose
 * second column differs. With colors, an added row (`+`) is green, a removed
 * one (`-`) red, the borders gray; widths are measured before any color.
 *
 * Unlike the AWS CDK CLI's `table`, a combining mark, a control character or a
 * ZWJ emoji is printed as given (it drops the first two and throws on the
 * third); only the width it takes is measured as `string-width` measures it.
 */
function formatTable(cells: string[][], color: boolean): string {
  const paint = (fn: (text: string) => string) => (color ? fn : (text: string) => text);
  const lines = cells.map((row) => row.map((cell) => String(cell).split('\n')));
  const widths = cells[0]!.map((_, i) =>
    Math.max(...lines.map((row) => Math.max(...row[i]!.map(displayWidth))))
  );
  const rule = (left: string, join: string, right: string): string =>
    paint(gray)(left + widths.map((w) => '─'.repeat(w + 2)).join(join) + right);
  const bar = paint(gray)('│');
  const out: string[] = [rule('┌', '┬', '┐')];
  lines.forEach((row, r) => {
    if (r > 0 && (r === 1 || sortKey(cells[r - 1]!, color) !== sortKey(cells[r]!, color))) {
      out.push(rule('├', '┼', '┤'));
    }
    const sign = r === 0 ? '' : cells[r]![0];
    const tint = paint(sign === '+' ? green : sign === '-' ? red : (text: string) => text);
    const height = Math.max(...row.map((cell) => cell.length));
    for (let l = 0; l < height; l++) {
      const cellsOut = row.map((cell, i) => {
        const text = cell[l] ?? '';
        return (
          ' ' + (text === '' ? '' : tint(text)) + ' '.repeat(widths[i]! - displayWidth(text)) + ' '
        );
      });
      out.push(bar + cellsOut.join(bar) + bar);
    }
  });
  out.push(rule('└', '┴', '┘'));
  return out.join('\n');
}

/**
 * The AWS CDK CLI's security table for these changes: IAM statements, managed
 * policies, IAM Identity Center and security-group rules, each as a section,
 * resources named by construct path where `logicalToPath` knows one. Empty when
 * nothing changed. `color` defaults to what chalk decides for stdout, which
 * also decides the row order (see {@link sortKey}).
 */
export function formatSecurityChanges(
  changes: SecurityChanges,
  logicalToPath: Readonly<Record<string, string>> = {},
  color: boolean = stdoutSupportsColor()
): string {
  if (!changes.permissionsAnyChanges) return '';
  const paint = (fn: (text: string) => string) => (color ? fn : (text: string) => text);
  const substitute = (source: string): string =>
    source.replace(/\$\{([^.}]+)(.[^}]+)?\}/gi, (_m, logId: string, suffix?: string) => {
      const path = Object.hasOwn(logicalToPath, logId) ? logicalToPath[logId] : undefined;
      return '${' + ((path && normalizePath(path)) || logId) + (suffix || '') + '}';
    });
  let out = '';
  const section = (title: string): void => {
    out += `${paint(bold)(title)}\n`;
  };
  const table = (rows: string[][]): void => {
    out +=
      formatTable(
        rows.map((row) => row.map(substitute)),
        color
      ) + '\n';
  };
  if (changes.statements.hasChanges) {
    section('IAM Statement Changes');
    table(summarizeStatements(changes, color));
  }
  if (changes.managedPolicies.hasChanges) {
    section('IAM Policy Changes');
    table(summarizeManagedPolicies(changes, color));
  }
  if (
    changes.ssoPermissionSets.hasChanges ||
    changes.ssoInstanceACAConfigs.hasChanges ||
    changes.ssoAssignments.hasChanges
  ) {
    section('IAM Identity Center Changes');
    if (changes.ssoPermissionSets.hasChanges) table(summarizeSsoPermissionSets(changes, color));
    if (changes.ssoInstanceACAConfigs.hasChanges)
      table(summarizeSsoInstanceACAConfigs(changes, color));
    if (changes.ssoAssignments.hasChanges) table(summarizeSsoAssignments(changes, color));
  }
  if (changes.securityGroupsHaveChanges) {
    section('Security Group Changes');
    table(summarizeSecurityGroups(changes, color));
  }
  out += `${paint(yellow)('(NOTE: There may be security-related changes not in this list. See https://github.com/aws/aws-cdk/issues/1299)')}\n`;
  out += '\n';
  return out;
}

/** A construct path without its stack and a trailing `Resource` / `Default`. */
function normalizePath(p: string): string {
  if (p.startsWith('/')) p = p.slice(1);
  let parts = p.split('/');
  if (parts.length > 1) {
    parts = parts.slice(1);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (last === 'Resource' || last === 'Default') parts = parts.slice(0, parts.length - 1);
    }
    p = parts.join('/');
  }
  return p;
}

/**
 * Does chalk color stdout: `supports-color` 7's rule at level 1 or above. The
 * table colors only then, as the AWS CDK CLI's does, so a CI log or a pipe gets
 * plain text in plain row order.
 */
export function stdoutSupportsColor(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  isTTY: boolean = process.stdout.isTTY === true,
  platform: string = process.platform
): boolean {
  const terminator = argv.indexOf('--');
  const hasFlag = (flag: string): boolean => {
    const position = argv.indexOf(`--${flag}`);
    return position !== -1 && (terminator === -1 || position < terminator);
  };
  let force: number | undefined;
  if (['no-color', 'no-colors', 'color=false', 'color=never'].some(hasFlag)) force = 0;
  else if (['color', 'colors', 'color=true', 'color=always'].some(hasFlag)) force = 1;
  const forceEnv = env['FORCE_COLOR'];
  if (forceEnv !== undefined) {
    if (forceEnv === 'true') force = 1;
    else if (forceEnv === 'false') force = 0;
    else force = forceEnv.length === 0 ? 1 : Math.min(parseInt(forceEnv, 10), 3);
  }
  if (force === 0) return false;
  if (['color=16m', 'color=full', 'color=truecolor', 'color=256'].some(hasFlag)) return true;
  if (!isTTY && force === undefined) return false;
  const min = force || 0;
  if (env['TERM'] === 'dumb') return min > 0;
  if (platform === 'win32') return true;
  if ('CI' in env) {
    return (
      ['TRAVIS', 'CIRCLECI', 'APPVEYOR', 'GITLAB_CI', 'GITHUB_ACTIONS', 'BUILDKITE'].some(
        (sign) => sign in env
      ) ||
      env['CI_NAME'] === 'codeship' ||
      min > 0
    );
  }
  if ('TEAMCITY_VERSION' in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env['TEAMCITY_VERSION'] ?? '');
  }
  if (env['COLORTERM'] === 'truecolor') return true;
  if (env['TERM_PROGRAM'] === 'iTerm.app' || env['TERM_PROGRAM'] === 'Apple_Terminal') return true;
  const term = env['TERM'] ?? '';
  if (/-256(color)?$/i.test(term)) return true;
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term)) return true;
  if ('COLORTERM' in env) return true;
  return min > 0;
}
