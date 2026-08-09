import { describe, it, expect } from 'vite-plus/test';
import {
  extractAwsInvocations,
  formatAwsCommandViolation,
  lintFixtureTreeAwsCommands,
  lintScriptAwsCommands,
  loadRemovedCommands,
  parseRemovedCommandsContent,
  ALLOW_MARKER,
} from '../../../scripts/check-integ-aws-commands.js';
import { parseRemovalsSource } from '../../../scripts/refresh-aws-cli-removals.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for issue #1402: a `verify.sh` calling an `aws <service>
 * <verb>` the AWS CLI does not have.
 *
 * The originating case was `aws emr list-instance-groups`, which forced two EMR
 * fixtures to be rewritten. It is NOT an "AWS CLI customization" (the original
 * diagnosis): it is on the CLI's REMOVAL list, so the verb exists in the API
 * model / every SDK / the API reference and is missing only from the CLI. Its
 * sibling `aws emr list-instance-fleets` is untouched and works fine — which is
 * why the check is per (service, verb) and not per service.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');
const TABLE = loadRemovedCommands();

describe('parseRemovalsSource', () => {
  it('parses a removals.py command-table block', () => {
    const src = `
      cmd_remover.remove(
          on_event='building-command-table.emr',
          remove_commands=[
              'run-job-flow',
              'list-instance-groups',
          ],
      )
    `;
    expect([...parseRemovalsSource(src).get('emr')!].sort()).toEqual([
      'list-instance-groups',
      'run-job-flow',
    ]);
  });

  it('merges several blocks for the same service', () => {
    const src = `
      cmd_remover.remove(on_event='building-command-table.ec2', remove_commands=['import-instance'])
      cmd_remover.remove(on_event='building-command-table.ec2', remove_commands=['import-volume'])
    `;
    expect([...parseRemovalsSource(src).get('ec2')!].sort()).toEqual([
      'import-instance',
      'import-volume',
    ]);
  });

  it('ignores a non-command-table event', () => {
    // Only a command-TABLE removal makes a verb unavailable; other `remove`
    // registrations (argument tables etc.) must not be read as removals.
    const src = `
      cmd_remover.remove(
          on_event='building-argument-table.emr.add-tags',
          remove_commands=['not-a-command-removal'],
      )
    `;
    expect(parseRemovalsSource(src).size).toBe(0);
  });
});

describe('the captured AWS CLI removal table', () => {
  it('carries the originating case', () => {
    expect(TABLE.removed.get('emr')?.has('list-instance-groups')).toBe(true);
  });

  // The correction this checker encodes: the original write-up suspected "the
  // `list-instance-*` verbs" as a family. Only ONE of them is removed. If a
  // future AWS CLI actually removes list-instance-fleets, this flips and the
  // emr-instance-fleets fixture must be revisited deliberately rather than
  // silently.
  it('does NOT contain the working sibling verb', () => {
    expect(TABLE.removed.get('emr')?.has('list-instance-fleets') ?? false).toBe(false);
    expect(TABLE.removed.get('emr')?.has('list-instances') ?? false).toBe(false);
  });

  // A capture regression (bad parse, truncated write) would empty the table and
  // make every lint below pass vacuously.
  it('covers a substantial number of services and verbs', () => {
    const verbs = [...TABLE.removed.values()].reduce((n, s) => n + s.size, 0);
    expect(TABLE.removed.size).toBeGreaterThan(10);
    expect(verbs).toBeGreaterThan(25);
    // Services whose verbs cdkd fixtures actually call — the forward-looking
    // value of the table is that these are one typo away from being used.
    for (const svc of ['emr', 'ec2', 'lambda', 'logs', 'kinesis', 'ses']) {
      expect(TABLE.removed.has(svc), `no removals captured for ${svc}`).toBe(true);
    }
  });
});

describe('parseRemovedCommandsContent', () => {
  it('reads the fixture shape', () => {
    const t = parseRemovedCommandsContent(
      JSON.stringify({ $awsCliVersion: 'aws-cli/9.9.9', removed: { emr: ['list-instance-groups'] } })
    );
    expect(t.awsCliVersion).toBe('aws-cli/9.9.9');
    expect(t.removed.get('emr')?.has('list-instance-groups')).toBe(true);
  });

  it('degrades to an empty table on malformed input rather than throwing', () => {
    expect(parseRemovedCommandsContent('not json').removed.size).toBe(0);
    expect(parseRemovedCommandsContent('[]').removed.size).toBe(0);
  });
});

describe('extractAwsInvocations', () => {
  it('finds a plain invocation', () => {
    const inv = extractAwsInvocations('aws emr list-clusters --active\n');
    expect(inv).toHaveLength(1);
    expect([inv[0]!.service, inv[0]!.verb]).toEqual(['emr', 'list-clusters']);
  });

  it.each([
    ['command substitution', 'IDS="$(aws emr list-clusters --active)"'],
    ['if condition', 'if aws s3api head-object --bucket b --key k; then :; fi'],
    ['negated condition', 'if ! aws lambda get-function --function-name f; then :; fi'],
    ['pipeline', 'aws ec2 describe-vpcs --region us-east-1 | jq .'],
    ['chained', 'echo hi && aws sqs get-queue-url --queue-name q'],
    ['env prefix', 'AWS_PAGER="" aws logs describe-log-groups'],
    ['inside a for loop', 'for id in x; do aws ec2 delete-subnet --subnet-id "$id"; done'],
  ])('finds an invocation in the %s shape', (_label, body) => {
    expect(extractAwsInvocations(`${body}\n`)).toHaveLength(1);
  });

  // The repo's canonical gone-probe helpers take the probe as ARGUMENTS, so a
  // command-start anchor would skip every destroy assertion in the tree.
  it('finds the helper-argument probe form', () => {
    const inv = extractAwsInvocations(
      'assert_gone "state file still exists" aws s3api head-object --bucket b --key k\n'
    );
    expect(inv).toHaveLength(1);
    expect([inv[0]!.service, inv[0]!.verb]).toEqual(['s3api', 'head-object']);
  });

  it('joins a backslash continuation and reports the first line', () => {
    const inv = extractAwsInvocations('x=1\naws emr \\\n  list-clusters --active\n');
    expect(inv).toHaveLength(1);
    expect(inv[0]!.line).toBe(2);
    expect(inv[0]!.verb).toBe('list-clusters');
  });

  // Three fixtures discuss `aws emr list-instance-groups` in prose explaining
  // why they avoid it. Flagging prose would make the check unusable, and
  // stripping comments is also what stops a "don't do this" example from
  // becoming a violation.
  it('ignores an invocation inside a comment', () => {
    expect(extractAwsInvocations('# aws emr list-instance-groups is removed\n')).toEqual([]);
    expect(extractAwsInvocations('aws emr list-clusters # aws emr list-instance-groups\n')).toHaveLength(
      1
    );
  });

  it('skips a shape it cannot classify statically', () => {
    // A variable service/verb cannot be judged; reporting a guess would be worse
    // than reporting nothing (the coverage floors below are what catch a parser
    // that starts skipping everything).
    expect(extractAwsInvocations('aws "${SERVICE}" list-clusters\n')).toEqual([]);
    expect(extractAwsInvocations('aws --version\n')).toEqual([]);
  });

  it('marks the escape hatch on the same line and the line above', () => {
    const same = extractAwsInvocations(
      `aws emr list-instance-groups --cluster-id x # ${ALLOW_MARKER} proven to work here\n`
    );
    expect(same[0]!.allowed).toBe(true);

    const above = extractAwsInvocations(
      `# ${ALLOW_MARKER} proven to work here\naws emr list-instance-groups --cluster-id x\n`
    );
    expect(above[0]!.allowed).toBe(true);
  });
});

describe('lintScriptAwsCommands', () => {
  it('flags a removed command', () => {
    const v = lintScriptAwsCommands(
      'sample',
      'aws emr list-instance-groups --cluster-id j-ABC\n',
      TABLE
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.verb).toBe('list-instance-groups');
    const report = formatAwsCommandViolation(v[0]!);
    expect(report).toContain('removal list');
    expect(report).toContain('@aws-sdk/client-emr');
  });

  it('accepts the working sibling verb', () => {
    expect(
      lintScriptAwsCommands('sample', 'aws emr list-instance-fleets --cluster-id j-ABC\n', TABLE)
    ).toEqual([]);
  });

  it('accepts a same-named verb on a different service', () => {
    // `chat` is removed on qbusiness only. A per-service denylist would have
    // over-blocked; this pins the (service, verb) granularity.
    expect(lintScriptAwsCommands('sample', 'aws lexv2-runtime chat\n', TABLE)).toEqual([]);
    expect(lintScriptAwsCommands('sample', 'aws qbusiness chat\n', TABLE)).toHaveLength(1);
  });

  it('honors the escape hatch', () => {
    expect(
      lintScriptAwsCommands(
        'sample',
        `aws emr list-instance-groups --cluster-id j-ABC # ${ALLOW_MARKER} verified on CLI 1.x\n`,
        TABLE
      )
    ).toEqual([]);
  });
});

describe('integ fixture aws invocations (#1402)', () => {
  it('no fixture calls a command the AWS CLI removed', () => {
    const violations = lintFixtureTreeAwsCommands(INTEG_ROOT, TABLE);
    expect(violations.map(formatAwsCommandViolation).join('\n\n')).toBe('');
  });

  // A green run above is only meaningful if the extractor actually SEES the
  // invocations. `.claude/rules/testing.md`: "0 violations" and "parsed nothing
  // at all" produce the identical green result, and the sibling #1097 lint
  // shipped that defect TWICE while its suite was green. Floors sit under the
  // current numbers with slack for ordinary fixture churn.
  it('parses a substantial share of the fixture tree', () => {
    const stats = collectStats();
    expect(stats.fixtures).toBeGreaterThan(150);
    // Current: 2687 invocations across 221 fixtures, 70 services, 362 verbs.
    expect(stats.total).toBeGreaterThan(2200);
    expect(stats.services.size).toBeGreaterThan(55);
    expect(stats.verbs.size).toBeGreaterThan(290);
    // The highest-traffic services must always be represented.
    for (const svc of ['s3api', 'lambda', 'ec2', 'iam', 'logs']) {
      expect(stats.services.has(svc), `no aws ${svc} invocation parsed`).toBe(true);
    }
  });

  // Aggregate floors have slack, so a regression that kills ONE shape stays
  // under them and passes — the exact failure the #1097 lint hit when its
  // env-prefix branch silently dropped every UPDATE-mode deploy. Assert each
  // shape the extractor claims to handle is exercised by the REAL tree.
  it('parses every invocation shape it claims to support', () => {
    const stats = collectStats();
    const floors: Record<keyof ReturnType<typeof collectStats>['shapes'], number> = {
      // Current: plain 1012, substitution 1030, helperArgument 414,
      // condition 211. Floors sit ~20% under, low enough for fixture churn and
      // high enough that losing a shape outright cannot slip through.
      // `aws ...` at the start of a segment — the common form.
      plain: 800,
      // `$(aws ...)` — the capture form. A whitespace-only tokenizer scores
      // near 0 here (`IDS="$(aws` is one token), which is why the extractor
      // splits on shell punctuation instead.
      substitution: 800,
      // `assert_gone "<desc>" aws ...` / `gone_probe aws ...` — the helper
      // form the destroy assertions use. A command-start anchor scores 0 here.
      helperArgument: 320,
      // `if aws ...` / `if ! aws ...` / `while ...` conditions.
      condition: 160,
    };
    for (const [name, floor] of Object.entries(floors)) {
      expect(
        stats.shapes[name as keyof typeof stats.shapes],
        `too few invocations parsed for shape: ${name}`
      ).toBeGreaterThan(floor);
    }
  });

  // The prose-mention fence, against the REAL tree rather than a synthetic
  // string: the EMR fixtures explain in comments why they avoid the removed
  // verb, and a comment-stripping regression would turn the three of them into
  // violations — which reads as "the checker works" right up until someone
  // deletes the explanation to silence it.
  it('does not flag the fixtures that DISCUSS the removed command in comments', () => {
    const discussing = readdirSync(INTEG_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
      .filter((e) =>
        readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8').includes(
          'list-instance-groups'
        )
      )
      .map((e) => e.name);
    // If this drops to zero the fence is vacuous — the fixtures were rewritten
    // and the guard needs a new anchor.
    expect(discussing.length).toBeGreaterThan(0);
    for (const fixture of discussing) {
      const content = readFileSync(join(INTEG_ROOT, fixture, 'verify.sh'), 'utf8');
      expect(lintScriptAwsCommands(fixture, content, TABLE), `${fixture} falsely flagged`).toEqual(
        []
      );
    }
  });
});

function collectStats() {
  const services = new Set<string>();
  const verbs = new Set<string>();
  const shapes = { plain: 0, substitution: 0, helperArgument: 0, condition: 0 };
  let total = 0;
  let fixtures = 0;

  for (const e of readdirSync(INTEG_ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || !existsSync(join(INTEG_ROOT, e.name, 'verify.sh'))) continue;
    fixtures++;
    const content = readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8');
    for (const inv of extractAwsInvocations(content)) {
      total++;
      services.add(inv.service);
      verbs.add(inv.verb);
      if (/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*aws\s/.test(inv.raw)) shapes.plain++;
      if (inv.raw.includes('$(')) shapes.substitution++;
      if (/^(?:assert_gone|gone_probe)\b/.test(inv.raw)) shapes.helperArgument++;
      if (/^(?:if|while|until)\b|^!\s/.test(inv.raw)) shapes.condition++;
    }
  }

  return { fixtures, total, services, verbs, shapes };
}
