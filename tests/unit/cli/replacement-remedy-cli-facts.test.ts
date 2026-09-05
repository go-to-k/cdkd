/**
 * The CLI facts eleven user-facing messages now ASSERT, fenced against the real
 * Commander tree.
 *
 * Issue [#2610] is precisely about a message naming a flag or a re-run whose
 * precondition the emitting code never checks. Its fix replaced eleven such
 * messages with sentences that assert three CLI facts:
 *
 *   1. `cdkd deploy` registers no `--remove-protection` (so a deploy-side
 *      replacement cannot clear a protection flag);
 *   2. `cdkd destroy` and `cdkd state destroy` DO register it (the messages
 *      name them as the commands that "act on one");
 *   3. `--replace` takes no value, and `cdkd deploy` takes `[stacks...]` (so
 *      `cdkd deploy --replace <LogicalId>` parsed the id as a STACK NAME).
 *
 * Nothing fenced any of them. The review of PR go-to-k/cdkd#2662 named that as
 * the fix re-committing the issue's own defect one level up: the messages would
 * keep asserting the facts long after a `deployOptions` edit falsified them,
 * and no test anywhere would go red. This file is that fence.
 *
 * It walks `buildProgram()` — the SAME Commander tree the CLI builds — rather
 * than grepping `src/cli/options.ts`, because what a message asserts is what
 * the parser DOES, not what an array literal looks like. `tests/unit/scripts/
 * integ-cli-flags.test.ts` takes the same approach for fixture flags.
 */
import { describe, it, expect } from 'vite-plus/test';
import type { Command, Option } from 'commander';
import { buildProgram } from '../../../src/cli/program.js';
import {
  DELETION_PROTECTION_DOC_POINTER,
  protectedReplacementAdvice,
} from '../../../src/provisioning/replacement-protection-advice.js';

/** Resolve a command by its `cdkd <a> <b>` path, failing loudly if it moved. */
function command(...path: string[]): Command {
  let node: Command = buildProgram();
  for (const name of path) {
    const next = node.commands.find((c) => c.name() === name);
    expect(next, `command \`cdkd ${path.join(' ')}\` not found`).toBeDefined();
    node = next as Command;
  }
  return node;
}

const optionsOf = (cmd: Command): readonly Option[] => cmd.options;
const longFlags = (cmd: Command): string[] => optionsOf(cmd).map((o) => o.long ?? '');

describe('the CLI facts the #2610 remedy messages assert', () => {
  it('`cdkd deploy` registers NO --remove-protection', () => {
    // The load-bearing fact. Every family-(a) message says
    // "cdkd deploy has no --remove-protection flag to clear it".
    expect(longFlags(command('deploy'))).not.toContain('--remove-protection');
  });

  it('`cdkd destroy` and `cdkd state destroy` DO register it', () => {
    // The other half of the same sentence — "only cdkd destroy and cdkd state
    // destroy act on one". Without this arm the fence above is satisfied by a
    // tree where the flag exists nowhere at all, and the message would be
    // wrong in the other direction.
    expect(longFlags(command('destroy'))).toContain('--remove-protection');
    expect(longFlags(command('state', 'destroy'))).toContain('--remove-protection');
  });

  it('`--replace` is a BOOLEAN on deploy: it takes no value', () => {
    // Family (b) sites 12 / 13 pasted `cdkd deploy --replace <LogicalId>`.
    const replace = optionsOf(command('deploy')).find((o) => o.long === '--replace');
    expect(replace, '`cdkd deploy --replace` no longer exists').toBeDefined();
    expect(replace!.required).toBe(false); // no `<value>`
    expect(replace!.optional).toBe(false); // no `[value]`
  });

  it('`cdkd deploy` takes variadic STACK arguments, which is what swallowed the id', () => {
    const args = command('deploy').registeredArguments;
    expect(args.length).toBeGreaterThan(0);
    expect(args[0]!.variadic).toBe(true);
    expect(args[0]!.name()).toBe('stacks');
  });

  it('the contrast case still holds: --recreate-via-cc-api DOES take a value', () => {
    // The shape sites 12 / 13 were copied from. Pinning it keeps the "takes no
    // resource id" wording honest about WHY the two differ, and stops this file
    // passing on a tree where no option takes a value at all.
    const recreate = optionsOf(command('deploy')).find(
      (o) => o.long === '--recreate-via-cc-api'
    );
    expect(recreate, '`--recreate-via-cc-api` no longer exists').toBeDefined();
    expect(recreate!.required).toBe(true);
  });

  it('`cdkd force-unlock` is a SUBCOMMAND, and no --force-unlock flag exists anywhere', () => {
    // Site 14's fact. Walk the WHOLE tree rather than the commands the message
    // happens to name — the claim is "registered nowhere in src/".
    expect(command('force-unlock').name()).toBe('force-unlock');
    const offenders: string[] = [];
    const walk = (cmd: Command, path: string): void => {
      if (longFlags(cmd).includes('--force-unlock')) offenders.push(path);
      for (const child of cmd.commands) walk(child, `${path} ${child.name()}`);
    };
    walk(buildProgram(), 'cdkd');
    expect(offenders).toEqual([]);
  });
});

describe('the doc pointer every #2610 message prints', () => {
  it('resolves to a real heading in docs/cli-deploy-safety.md', async () => {
    // `replacement-protection-advice.ts` sends five providers' users to this
    // section by name. A heading rename would dangle all five silently; the
    // only pre-existing heading fence reads `logs-loggroup-provider.ts` alone.
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync('docs/cli-deploy-safety.md', 'utf8');
    const quoted = DELETION_PROTECTION_DOC_POINTER.match(/^"(.+)" in (.+)$/);
    expect(quoted, 'the pointer is no longer `"<heading>" in <path>`').not.toBeNull();
    const [, heading, path] = quoted!;
    expect(path).toBe('docs/cli-deploy-safety.md');
    // The WHOLE heading, anchored as a markdown heading line — a substring
    // match would survive exactly the tail rename this fence exists to catch.
    const headings = doc
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .map((line) => line.replace(/^#+\s*/, '').trim());
    expect(headings).toContain(heading);
  });

  it('and every rendered message carries that pointer', () => {
    const message = protectedReplacementAdvice({
      evidence: "cdkd's recorded properties for this widget carry Protected: true",
      replaceFlags: 'cdkd deploy --replace',
      disable: { before: 'aws widgets unprotect --id', identifier: 'w-1' },
    });
    expect(message).toContain(DELETION_PROTECTION_DOC_POINTER);
  });
});

/**
 * The disable-command contract, enforced by the COMPILER.
 *
 * `renderDisableCommand` sanitizes, shell-quotes and suppresses the IDENTIFIER;
 * `before` / `after` / `caveat` are rendered VERBATIM. That split is safe only
 * while those three are cdkd-authored literals, and until issue [#2610]'s fifth
 * review round that was checked by a source-text sniff over `src/`. It was
 * broken by a probe three times running -- opening-character only, then the
 * operator-at-line-start continuation, then a builder module that exited the
 * scanned population entirely -- so the constraint moved to
 * `CdkdAuthoredLiteral`, which resolves a widened `string` to `never`.
 *
 * These cases are the fence. Each `@ts-expect-error` is SELF-VERIFYING: TS
 * reports an unused `@ts-expect-error` as an error of its own, so if the
 * constraint were relaxed, `vp run typecheck:test` fails here rather than
 * quietly passing. They are compile-time assertions, which is why several have
 * no runtime expectation.
 */
describe('the disable-command contract: only the ID is untrusted', () => {
  const derived: string = String(Date.now());
  const base = { evidence: 'e', replaceFlags: 'cdkd deploy --replace' } as const;

  it('ACCEPTS plain string literals (the shapes actually in use)', () => {
    const message = protectedReplacementAdvice({
      ...base,
      disable: {
        before: 'aws elbv2 modify-load-balancer-attributes --load-balancer-arn',
        identifier: derived, // the identifier is UNTRUSTED by design
        after: '--attributes Key=deletion_protection.enabled,Value=false',
        caveat: 'Note this API behaves per field.',
      },
    });
    expect(message).toContain('`aws elbv2 modify-load-balancer-attributes --load-balancer-arn');
  });

  it('ACCEPTS a call with no `after` and no `caveat`', () => {
    expect(
      protectedReplacementAdvice({
        ...base,
        disable: { before: 'aws widgets unprotect --id', identifier: 'w-1' },
      })
    ).toContain('`aws widgets unprotect --id w-1`');
  });

  it('REJECTS a template-derived `before` (the shape two reviewers used)', () => {
    protectedReplacementAdvice({
      ...base,
      disable: {
        // @ts-expect-error -- widens to `string`; the injection this closes
        before: 'aws elbv2 modify-load-balancer-attributes ' + String(derived),
        identifier: 'w-1',
      },
    });
  });

  it('REJECTS a template LITERAL carrying an interpolation', () => {
    protectedReplacementAdvice({
      ...base,
      // @ts-expect-error -- a `${...}` hole leaves a `string` tail
      disable: { before: `aws dynamodb update-table --table-name ${derived}`, identifier: 'w-1' },
    });
  });

  it('REJECTS a far-away `const` typed `string`', () => {
    protectedReplacementAdvice({
      ...base,
      // @ts-expect-error -- declared `: string`, so already widened
      disable: { before: derived, identifier: 'w-1' },
    });
  });

  it('REJECTS a SPREAD from a builder — the evasion that exited the old grep', () => {
    // The refactor `ProtectedReplacementDisableCommand` invites, and the one a
    // source-text scan cannot follow: the object is built in another module.
    const built: { before: string; identifier: string; after: string } = {
      before: 'aws elbv2 modify-load-balancer-attributes ' + derived,
      identifier: 'w-1',
      after: '--attributes Key=deletion_protection.enabled,Value=false',
    };
    // @ts-expect-error -- every widened member fails, however far away it was built
    protectedReplacementAdvice({ ...base, disable: { ...built } });
  });

  it('REJECTS a widened `after` and a widened `caveat` too, not just `before`', () => {
    protectedReplacementAdvice({
      ...base,
      disable: {
        before: 'aws widgets unprotect --id',
        identifier: 'w-1',
        // @ts-expect-error -- the cap must have its floor on every rendered field
        after: derived,
      },
    });
    protectedReplacementAdvice({
      ...base,
      disable: {
        before: 'aws widgets unprotect --id',
        identifier: 'w-1',
        // @ts-expect-error -- rendered beside the backticks, same rule
        caveat: derived,
      },
    });
  });

  it('leaves the IDENTIFIER deliberately unconstrained — it is the untrusted one', () => {
    // The inverse control. Constraining `identifier` too would be wrong: it is
    // a `state.json` value by construction, and the module's job is to sanitize
    // it rather than to refuse it.
    const message = protectedReplacementAdvice({
      ...base,
      disable: { before: 'aws widgets unprotect --id', identifier: derived },
    });
    expect(message).toContain('aws widgets unprotect --id');
  });
});
