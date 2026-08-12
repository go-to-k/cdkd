import { describe, it, expect } from 'vite-plus/test';
import {
  blankQuotedSpans,
  extractAwsInvocations,
  formatAwsCommandViolation,
  lintFixtureTreeAwsCommands,
  lintScriptAwsCommands,
  loadRemovedCommands,
  readFixtureScripts,
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

  // Two fixtures discuss `aws emr list-instance-groups` in prose explaining
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

  // False positives found by review against the REAL tree. None of these is an
  // invocation, and before the quoted-span blanking + `:`-in-token change all
  // three parsed as one — inflating the coverage floors with non-invocations
  // and, worse, making a fixture's own `echo "... aws emr list-instance-groups
  // ..."` explanation a CI-blocking violation curable only by deleting the
  // explanation.
  it.each([
    ['prose in a double-quoted echo', 'echo "==> Verifying deploy via aws cli (sanity)"'],
    ['an ARN literal', 'ARN="arn:aws:s3:::my-bucket"'],
    ['an unquoted ARN literal', 'aws s3 rm arn:aws:s3:::my-bucket'],
    ['a JMESPath backtick literal', "QUERY=\"Tags[?Key==\\`aws:cdk:path\\`]\""],
    ['a single-quoted explanation', "echo 'do not call aws emr list-instance-groups'"],
  ])('does not parse %s as an invocation', (_label, body) => {
    const found = extractAwsInvocations(`${body}\n`).map((i) => `${i.service} ${i.verb}`);
    // `aws s3 rm ...` IS a real invocation in one case — assert only that the
    // ARN did not additionally yield a bogus `s3 my-bucket`.
    expect(found.filter((f) => f !== 's3 rm')).toEqual([]);
  });

  // The capture form must SURVIVE quoted-span blanking — it is the single
  // largest shape in the tree (~1000 invocations) and lives inside double
  // quotes, so blanking without preserving `$( )` would delete it wholesale.
  it('still sees an invocation inside a double-quoted command substitution', () => {
    const inv = extractAwsInvocations('IDS="$(aws emr list-clusters --active)"\n');
    expect(inv.map((i) => `${i.service} ${i.verb}`)).toEqual(['emr list-clusters']);
  });

  // Without the global-option skip this invocation VANISHED silently — the
  // service slot held `--region`, `NAME` rejected it, and the call went
  // unchecked with no diagnostic.
  it.each([
    ['--region', 'aws --region us-east-1 emr list-instance-groups --cluster-id j-A'],
    ['--region=value', 'aws --region=us-east-1 emr list-instance-groups --cluster-id j-A'],
    ['a boolean global', 'aws --no-cli-pager emr list-instance-groups --cluster-id j-A'],
    ['two globals', 'aws --profile p --debug emr list-instance-groups --cluster-id j-A'],
    // The AWS CLI accepts a global option AFTER the service too.
    ['a global after the service', 'aws emr --region us-east-1 list-instance-groups --cluster-id j-A'],
    ['globals on both sides', 'aws --debug emr --region us-east-1 list-instance-groups'],
  ])('sees the invocation behind a leading global option: %s', (_label, body) => {
    const inv = extractAwsInvocations(`${body}\n`);
    expect(inv.map((i) => `${i.service} ${i.verb}`)).toEqual(['emr list-instance-groups']);
  });

  // Review finding: a QUOTED global-option value made the whole invocation
  // vanish. Blanking replaced `"${REGION}"` with spaces, so it stopped being a
  // token and the skip loop consumed `emr` as the option's value instead.
  // `"${REGION}"` is the spelling EVERY fixture here uses, so the earlier fix
  // was blind to the form it actually meets. Blanking to `_` keeps the span as
  // one token.
  it.each([
    ['a quoted global value', 'aws --region "${REGION}" emr list-instance-groups --cluster-id j-A'],
    ['a single-quoted global value', "aws --region 'us-east-1' emr list-instance-groups"],
    ['a quoted value after the service', 'aws emr --region "${REGION}" list-instance-groups'],
  ])('sees the invocation when the global option value is quoted: %s', (_label, body) => {
    const inv = extractAwsInvocations(`${body}\n`);
    expect(inv.map((i) => `${i.service} ${i.verb}`)).toEqual(['emr list-instance-groups']);
  });

  // Review finding: quote state was per-LINE, so the body of a multi-line
  // string was parsed as code. These fixtures embed exactly that shape (a
  // `node --input-type=module -e "` program spanning many lines), so a comment
  // inside one mentioning the removed verb became a CI-blocking violation
  // curable only by deleting the comment.
  it('does not parse the body of a multi-line quoted string as commands', () => {
    const script = [
      'run_it() {',
      '  node --input-type=module -e "',
      "import { EMRClient } from '@aws-sdk/client-emr';",
      '// do not use aws emr list-instance-groups here',
      'process.stdout.write(JSON.stringify(x));',
      '" "$1"',
      '}',
      'aws emr list-clusters --active',
    ].join('\n');
    const inv = extractAwsInvocations(`${script}\n`);
    expect(inv.map((i) => `${i.service} ${i.verb}`)).toEqual(['emr list-clusters']);
  });

  it('does not parse a heredoc body as commands', () => {
    const script = [
      'cat <<EOF',
      'never call aws emr list-instance-groups from a fixture',
      'EOF',
      'aws emr list-clusters --active',
    ].join('\n');
    const inv = extractAwsInvocations(`${script}\n`);
    expect(inv.map((i) => `${i.service} ${i.verb}`)).toEqual(['emr list-clusters']);
  });

  it('resumes scanning after a quoted heredoc delimiter', () => {
    const script = ["cat <<'EOF'", 'aws emr list-instance-groups', 'EOF', 'aws emr list-clusters'].join(
      '\n'
    );
    const inv = extractAwsInvocations(`${script}\n`);
    expect(inv.map((i) => `${i.service} ${i.verb}`)).toEqual(['emr list-clusters']);
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

    // The marker must be a COMMENT, not any occurrence of the string. A
    // fixture that merely PRINTS the marker text must not silently disarm the
    // check for the command on that line.
    const inString = extractAwsInvocations(
      `echo "${ALLOW_MARKER} nope"; aws emr list-instance-groups --cluster-id x\n`
    );
    expect(inString.some((i) => i.allowed)).toBe(false);

    // "The line above" means a WHOLE-line comment. A marker trailing the
    // PREVIOUS command is about that command, not the next one.
    const trailingAbove = extractAwsInvocations(
      `aws emr list-clusters # ${ALLOW_MARKER} about this line only\naws emr list-instance-groups --cluster-id x\n`
    );
    const leaked = trailingAbove.find((i) => i.verb === 'list-instance-groups');
    expect(leaked?.allowed).toBe(false);
  });
});

describe('blankQuotedSpans', () => {
  it('blanks a double-quoted span but keeps a $( ) substitution inside it', () => {
    const out = blankQuotedSpans('IDS="prose $(aws emr list-clusters) more"');
    expect(out).toContain('$(aws emr list-clusters)');
    expect(out).not.toContain('prose');
    // Length must be PRESERVED so column/line accounting downstream is intact.
    expect(out).toHaveLength('IDS="prose $(aws emr list-clusters) more"'.length);
  });

  it('blanks a single-quoted span entirely (no expansion happens there)', () => {
    const out = blankQuotedSpans("echo 'aws emr list-instance-groups'");
    expect(out).not.toContain('list-instance-groups');
    expect(out).toHaveLength("echo 'aws emr list-instance-groups'".length);
  });

  it('handles a nested quote inside a preserved substitution', () => {
    const out = blankQuotedSpans('X="$(aws emr describe-cluster --query "Cluster.Id")"');
    expect(out).toContain('aws emr describe-cluster');
  });

  it('does not treat an escaped quote as the closer', () => {
    const out = blankQuotedSpans('echo "a \\"b" ; aws emr list-clusters');
    expect(out).toContain('aws emr list-clusters');
  });

  // KNOWN LIMITATIONS, pinned so a future change is a deliberate decision
  // rather than a silent behavior shift.
  it('pins the known limitations: unterminated quote, backticks, heredocs', () => {
    // An unterminated quote blanks the rest of the line — conservative
    // (under-reports) rather than dangerous (over-reports).
    expect(blankQuotedSpans('echo "unterminated aws emr list-instance-groups')).not.toContain(
      'list-instance-groups'
    );
    // Backtick substitution inside double quotes is NOT preserved. No fixture
    // uses the legacy form; if one appears its invocation is missed, not
    // misreported.
    expect(blankQuotedSpans('X="`aws emr list-clusters`"')).not.toContain('list-clusters');
    // Heredoc BODIES are not quoted spans, so they are scanned as commands.
    // Prose in a heredoc could therefore false-positive; accepted because the
    // removal table is tiny and every entry is an implausible prose word.
    expect(blankQuotedSpans('aws emr list-clusters')).toContain('aws emr list-clusters');
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
    expect(report).toContain('@aws-sdk/client-*');
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
    // Current: 3002 invocations (was 2635 when these floors were written; the
    // comment had not been refreshed as the tree grew, which is how the ceiling
    // below came to sit 2 invocations away from the real number).
    expect(stats.total).toBeGreaterThan(2200);
    expect(stats.services.size).toBeGreaterThan(55);
    expect(stats.verbs.size).toBeGreaterThan(290);
    // CEILING as well as floor. Floors catch a parser that stops seeing things;
    // only a ceiling catches one that starts seeing things that are not there
    // (the quoted-prose / ARN false positives review found were exactly that,
    // and no floor could have flagged them).
    //
    // Raised 3000 -> 3400 when the asset-migration fixture gained its
    // import-driven phase (issue #1652): ordinary fixture growth pushed the
    // real total to 3002. The ceiling keeps roughly the same proportional
    // headroom over the measured total as it had when it was written, which is
    // what makes it tight enough to still catch a false-positive explosion
    // rather than merely tracking the tree.
    expect(stats.total).toBeLessThan(3400);
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
    // `globalOption` is deliberately absent — it has no FLOOR (zero
    // occurrences today) and is asserted `toBe(0)` below instead. Omitting it
    // from this Record's key set is what keeps that distinction type-checked:
    // adding a shape to `collectStats` now forces a conscious choice here
    // between "give it a floor" and "assert it exactly".
    const floors: Omit<
      Record<keyof ReturnType<typeof collectStats>['shapes'], number>,
      'globalOption'
    > = {
      // Current: plain 1008, substitution 1023, helperArgument 414,
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
    // No fixture uses a global option before the service today. Asserted
    // EXACTLY 0 rather than floored: if one appears, this fails and the shape
    // gets a real floor, instead of the branch rotting untested.
    expect(stats.shapes.globalOption).toBe(0);
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
      // Must be the FULL invocation, not a bare mention of the verb name. The
      // `emr-instance-fleets` fixture names `` `list-instance-groups` `` in prose
      // ("...it is only its `list-instance-groups` sibling that is unusable")
      // with no `aws emr` prefix, so uncommenting that line yields no
      // invocation and the positive control below cannot fire. Matching the
      // whole invocation keeps this fence about the case it exists for: a
      // comment that spells out the banned COMMAND.
      .filter((e) =>
        readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8').includes(
          'aws emr list-instance-groups'
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

      // POSITIVE CONTROL. Without it the fence is satisfied by a checker that
      // flags NOTHING at all, and equally by one whose quoted-span blanking
      // swallowed the mention for the wrong reason. Strip the leading `#` from
      // the discussing comment lines and the SAME content must now flag — so
      // the fence proves comment-stripping specifically, not general silence.
      const uncommented = content
        .split('\n')
        .map((l) =>
          l.trimStart().startsWith('#') && l.includes('aws emr list-instance-groups')
            ? l.replace(/^(\s*)#\s?/, '$1')
            : l
        )
        .join('\n');
      expect(
        lintScriptAwsCommands(fixture, uncommented, TABLE).length,
        `${fixture}: fence is vacuous — uncommenting the mention did not flag`
      ).toBeGreaterThan(0);
    }
  });

  // The real-code fail probe, automated so it cannot bit-rot between manual
  // runs. Splices a removed verb into the REAL emr-cluster/verify.sh content
  // in memory (no file is touched) and asserts the checker names it.
  it('flags a removed verb spliced into a real fixture, reporting its line', () => {
    const real = readFileSync(join(INTEG_ROOT, 'emr-cluster', 'verify.sh'), 'utf8');
    expect(lintScriptAwsCommands('emr-cluster', real, TABLE)).toEqual([]);

    const lines = real.split('\n');
    lines.splice(10, 0, 'PROBE="$(aws emr list-instance-groups --cluster-id "${CID}")"');
    const violations = lintScriptAwsCommands('emr-cluster', lines.join('\n'), TABLE);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.verb).toBe('list-instance-groups');
    expect(violations[0]!.line).toBe(11);
    expect(formatAwsCommandViolation(violations[0]!)).toContain(
      'tests/integration/emr-cluster/verify.sh:11'
    );
  });
});

function collectStats() {
  const services = new Set<string>();
  const verbs = new Set<string>();
  const shapes = {
    plain: 0,
    substitution: 0,
    helperArgument: 0,
    condition: 0,
    // Currently 0 in the tree. Asserted `toBe(0)` rather than floored, so the
    // day a fixture DOES use `aws --region ... <service> <verb>` this fails and
    // the shape is converted into a real floor instead of silently regressing.
    globalOption: 0,
  };
  let total = 0;

  // Drive off the LINT's own enumeration, not a private copy: measuring a
  // re-implemented walk means a broken filter in the real one leaves every
  // floor green while the lint silently scans nothing.
  const scripts = readFixtureScripts(INTEG_ROOT);

  for (const { content } of scripts) {
    for (const inv of extractAwsInvocations(content)) {
      total++;
      services.add(inv.service);
      verbs.add(inv.verb);
      if (/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*aws\s/.test(inv.raw)) shapes.plain++;
      if (inv.raw.includes('$(')) shapes.substitution++;
      if (/^(?:assert_gone|gone_probe)\b/.test(inv.raw)) shapes.helperArgument++;
      if (/^(?:if|while|until)\b|^!\s/.test(inv.raw)) shapes.condition++;
      if (/\baws\s+-/.test(inv.raw)) shapes.globalOption++;
    }
  }

  return { fixtures: scripts.length, total, services, verbs, shapes };
}
