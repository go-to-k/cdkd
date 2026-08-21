import { describe, it, expect } from 'vite-plus/test';
import {
  describeStateKey,
  STATE_FILE_SUFFIX,
  LOCK_FILE_SUFFIX,
  DEFAULT_STATE_PREFIX,
} from '../../../src/cli/commands/state-file-keys.js';
import { LEGACY_KEY_DEPTH } from '../../../src/state/s3-state-backend.js';

/**
 * Issue #2001 — `REGION_SEGMENT` required a prefix of EXACTLY two letters, so
 * it rejected every region in the European Sovereign Cloud partition, whose
 * prefix is four (`eusc-de-east-1`).
 *
 * The regex is one line; the reason it was worth auditing rather than swapping
 * is which WAY the mismatch fails. `describeStateKey` falls back to the LAST
 * segment, which for a `{prefix}/{stack}/{region}/state.json` key is the
 * REGION — so a rejected region does not degrade to "region omitted", it
 * reports the region string AS the stack name. Both call sites then name a
 * stack that does not exist, and `cdkd gc` builds a recovery COMMAND out of it
 * (pinned end-to-end in `gc.test.ts`, since a pin here would only re-run this
 * function).
 */
describe('DIFFERENTIAL vs the pre-fix behaviour — the change is exactly three classes', () => {
  // The fence whose ABSENCE let a blocker through green. Every case-by-case
  // test in this file asserts a value someone chose to write down, so a
  // revision that broke a shape nobody had thought of stayed green — six of
  // them did, all under foreign or nested prefixes where the depth rule cannot
  // reach and only the pattern defends.
  //
  // This walks the input space instead and pins the DELTA. Three classes of key
  // may differ from the pre-fix implementation: (1) a `eusc-*` region, now
  // recognised; (2) a legacy key under a KNOWN prefix whose stack name is
  // region-shaped, now read as the stack; (3) a key with an empty segment
  // before the region, which no longer pairs onto nothing. Anything else
  // differing is a regression by construction, whatever it is.
  //
  // **Each arm asserts the VALUE, not just that the key has the right shape.**
  // A first cut classified by key shape alone and a probe walked straight
  // through it: mutating the legacy repair to `return prefix` — a total
  // regression of the thing this PR adds — kept every differing cell inside the
  // `legacyRepair` bucket and the fence stayed GREEN, while nine ordinary
  // case-by-case tests caught it. A fence that only counts which keys changed
  // cannot tell a repair from a corruption.
  const PRE_FIX_REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
  function preFixDescribe(key: string, suffix: string): string {
    const segments = key.slice(0, -suffix.length).split('/');
    const last = segments[segments.length - 1] ?? key;
    const secondLast = segments[segments.length - 2];
    if (secondLast !== undefined && PRE_FIX_REGION.test(last)) return `${secondLast} (${last})`;
    return last;
  }

  // `cdkd/` (trailing empty segment) is in the pool on purpose: it is the only
  // way the walk reaches class 3, and its absence is why an earlier revision of
  // this test could describe the delta as two classes and still pass.
  const PREFIXES = ['cdkd', 'cdkd/team-a', 'myteam', 'myteam/sub', 'cdkd-backup', 'cdkd/'];
  const TAILS = [
    'MyStack',
    'demo-app-1',
    'api-prod-1',
    'db-prod-1',
    'mystack-foo-1',
    'us-east-1',
    'eusc-de-east-1',
    'us-gov-west-1',
    'not-a-region',
  ];

  it('differs from pre-fix ONLY on eusc regions, known-prefix legacy repairs and empty segments', () => {
    const unexpected: string[] = [];
    let eusc = 0;
    let legacyRepair = 0;
    let emptySegment = 0;

    for (const suffix of [STATE_FILE_SUFFIX, LOCK_FILE_SUFFIX]) {
      for (const prefix of PREFIXES) {
        for (const tail of TAILS) {
          for (const key of [`${prefix}/${tail}${suffix}`, `${prefix}/Stack/${tail}${suffix}`]) {
            const now = describeStateKey(key, suffix, DEFAULT_STATE_PREFIX);
            const before = preFixDescribe(key, suffix);
            if (now === before) continue;

            const segments = key.slice(0, -suffix.length).split('/');
            const last = segments[segments.length - 1];
            const secondLast = segments[segments.length - 2];
            const record = `${key}: ${JSON.stringify(before)} -> ${JSON.stringify(now)}`;

            if (tail === 'eusc-de-east-1' && secondLast !== undefined && secondLast !== '') {
              // Class 1. The VALUE must be the pair the pattern now recognises.
              if (now === `${secondLast} (${last})`) eusc += 1;
              else unexpected.push(record);
            } else if (key === `${DEFAULT_STATE_PREFIX}/${tail}${suffix}`) {
              // Class 2. A legacy key directly under the known prefix: the depth
              // rule must return the STACK ITSELF, not merely something other
              // than what the pattern used to say.
              if (now === tail) legacyRepair += 1;
              else unexpected.push(record);
            } else if (secondLast === '') {
              // Class 3. The empty-segment guard: no longer pairs onto nothing,
              // so the answer is the last segment alone.
              if (now === last) emptySegment += 1;
              else unexpected.push(record);
            } else {
              unexpected.push(record);
            }
          }
        }
      }
    }

    expect(unexpected).toEqual([]);
    // Floors, so a future change that makes the walk vacuous (an empty matrix,
    // a describeStateKey that throws, a prefix pool that stops reaching a
    // class) cannot pass as "no regressions".
    expect(eusc).toBeGreaterThan(0);
    expect(legacyRepair).toBeGreaterThan(0);
    expect(emptySegment).toBeGreaterThan(0);
  });
});

describe('the legacy-layout depth constant agrees with the state backend', () => {
  // `state-file-keys.ts` spells its own `LEGACY_SEGMENTS_UNDER_PREFIX` instead
  // of importing this one, because a VALUE import from `s3-state-backend.js`
  // breaks every suite that mocks that module (measured: it reds `gc.test.ts`
  // and `bootstrap-destroy.test.ts` with `No "LEGACY_KEY_DEPTH" export`). That
  // trade is only safe if the two cannot drift, which is this test's whole job.
  //
  // The backend counts the `state.json` segment; the descriptor counts what is
  // left after the prefix and suffix are stripped. So the relationship is fixed
  // at exactly one, and it is asserted through the OBSERVABLE rather than by
  // re-declaring the private constant: a key with `LEGACY_KEY_DEPTH` segments
  // under the prefix must take the legacy arm.
  it('a key at LEGACY_KEY_DEPTH takes the legacy arm', () => {
    const underPrefix = LEGACY_KEY_DEPTH - 1;
    expect(underPrefix).toBe(1);
    const stack = 'demo-app-1';
    const key = `cdkd/${'/'.repeat(0)}${stack}${STATE_FILE_SUFFIX}`;
    expect(key.slice('cdkd/'.length, -STATE_FILE_SUFFIX.length).split('/')).toHaveLength(
      underPrefix
    );
    // Region-shaped on purpose: the heuristic would answer `cdkd (demo-app-1)`,
    // so agreement here is evidence the legacy arm ran.
    expect(describeStateKey(key, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)).toBe(stack);
  });
});

describe('describeStateKey region-segment recognition (issue #2001)', () => {
  const key = (stack: string, region: string): string =>
    `cdkd/${stack}/${region}/${'state.json'}`;

  // The partitions the issue tabulated, plus the newer commercial regions its
  // table cites. Every one of these is a REAL region: the point of the fix is
  // that the pattern must cover the whole region space, not that it accepts
  // more shapes.
  const REGIONS = [
    'us-east-1',
    'ap-northeast-1',
    'ap-southeast-7',
    'mx-central-1',
    'il-central-1',
    'us-gov-west-1',
    'cn-north-1',
    'us-iso-east-1',
    'us-isob-east-1',
    'eu-isoe-west-1',
    'us-isof-south-1',
    // THE regression. Four-letter prefix; the `^[a-z]{2}` form rejected it.
    'eusc-de-east-1',
  ];

  it.each(REGIONS)('%s is recognised as the region segment', (region) => {
    expect(describeStateKey(key('MyStack', region))).toBe(`MyStack (${region})`);
  });

  it('names the STACK, not the region, for a European Sovereign Cloud key', () => {
    // The defect stated as the user sees it. Pre-fix this returned the bare
    // string 'eusc-de-east-1' — the region reported as the stack name.
    const described = describeStateKey(key('PaymentsApi', 'eusc-de-east-1'));
    expect(described).toContain('PaymentsApi');
    expect(described).not.toBe('eusc-de-east-1');
  });

  it('recognises the region under a custom --state-prefix, at any depth', () => {
    // The prefix is arbitrary, which is why the pair is derived from the key's
    // TAIL. A fix keyed on segment position rather than shape would pass the
    // cases above and fail here.
    expect(describeStateKey('team/infra/prod/Api/eusc-de-east-1/state.json')).toBe(
      'Api (eusc-de-east-1)'
    );
  });

  it('describes a lock key with the same recognition', () => {
    expect(describeStateKey(`cdkd/MyStack/eusc-de-east-1/lock.json`, LOCK_FILE_SUFFIX)).toBe(
      'MyStack (eusc-de-east-1)'
    );
  });

  describe('NEGATIVE — what must still NOT be read as a region', () => {
    it('a legacy region-less key returns the stack name alone', () => {
      // `{prefix}/{stack}/state.json` — the v1 layout, stack in the last
      // position.
      //
      // What defends this one, MEASURED rather than reasoned: the hyphen-group
      // requirement and the `-\d+$` anchor. `MyStack` has neither a `-[a-z]+`
      // group nor a trailing `-<digits>`, so the pattern cannot match it at any
      // prefix bound. It is therefore a regression guard on the base pattern,
      // and NOT evidence about the widening or about the case rule. Two earlier
      // revisions of this comment named the wrong defender (first the widening,
      // then the uppercase rule); the uppercase rule is fenced by its own case
      // below, which is the only one a case-insensitive pattern reds.
      expect(describeStateKey('cdkd/MyStack/state.json')).toBe('MyStack');
    });

    it.each([
      'mystack-foo-1',
      'demo-app-1',
      'api-prod-1',
      'dev-api-1',
      'core-api-1',
      'test-stack-2',
      'data-eu-west-2',
    ])('stack name %s is not region-shaped — NO known prefix, so the pattern alone must hold', (stack) => {
      // The cases that decide the pattern's SHAPE, and the ones a length class
      // gets wrong. Every first token here (`mystack`, `demo`, `api`, `dev`,
      // `core`, `test`, `data`) is neither two letters nor `eusc`.
      //
      // These are asserted WITHOUT a known prefix on purpose: it is the
      // configuration the depth rule cannot reach, and therefore the one that
      // measures the pattern by itself. A `{2,4}` bound passes every case in
      // this file that supplies a prefix and fails most of these — which is
      // exactly how a revision of this fix shipped six regressions against
      // `main` before review enumerated them.
      expect(describeStateKey(`anyprefix/${stack}/state.json`)).toBe(stack);
      expect(describeStateKey(`team/nested/${stack}/state.json`)).toBe(stack);
    });

    it('a segment with no trailing number is not a region', () => {
      expect(describeStateKey('cdkd/MyStack/not-a-region/state.json')).toBe('not-a-region');
    });

    it('a segment with no hyphen group is not a region', () => {
      expect(describeStateKey('cdkd/MyStack/useast1/state.json')).toBe('useast1');
    });

    it('an uppercase segment is not a region', () => {
      // Regions reach this function through S3 keys written by cdkd, which are
      // lowercase-canonical. An upper-cased segment is a stack name.
      expect(describeStateKey('cdkd/Stack/EUSC-DE-EAST-1/state.json')).toBe('EUSC-DE-EAST-1');
    });
  });

  describe('EXACT classification when the caller knows its prefix', () => {
    // The shape heuristic above cannot be made exact, and the widening made one
    // of its two failure directions materially worse: `{2,4}` reads an ordinary
    // lowercase stack name like `demo-app-1` as a region, which `{2}` did not,
    // because `demo` / `prod` / `data` / `core` are idiomatic first tokens
    // while two-letter ones are rare. Callers scanning their OWN bucket know
    // where the prefix ends, so they get the same segment-DEPTH rule
    // `S3StateBackend.listStacks` uses and never consult the shape at all.

    it('reads the legacy layout correctly for a TWO-LETTER region-shaped stack name', () => {
      // The narrowing this rule buys, stated against a name the pattern cannot
      // help with. `db-` is a real two-letter token, so `db-prod-1` is
      // region-shaped by any pattern that accepts `us-east-1` — and in the
      // legacy layout it sits exactly where a region would. `main` describes
      // this key as `cdkd (db-prod-1)`, and `cdkd gc` turns that into
      // `cdkd state show cdkd --stack-region db-prod-1`, wrong in both
      // arguments.
      const key = 'cdkd/db-prod-1/state.json';
      expect(describeStateKey(key, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)).toBe('db-prod-1');
      // ...and the heuristic really does get it wrong, so the assertion above
      // is not passing for free. Both directions of the same call.
      expect(describeStateKey(key)).toBe('cdkd (db-prod-1)');
    });

    it.each(['prod-api-1', 'api-gw-2', 'data-eu-west-2', 'core-api-1', 'demo-app-1'])(
      'legacy stack name %s is not mistaken for a region, with OR without a known prefix',
      (stack) => {
        // Both mechanisms, deliberately. The PATTERN rejects these (their first
        // token is neither two letters nor `eusc`), which is what protects them
        // under a foreign prefix the depth rule cannot reach; the depth rule
        // then also covers them under a known one. Asserting both is what
        // caught a revision where only the second held.
        expect(
          describeStateKey(`cdkd/${stack}/state.json`, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
        ).toBe(stack);
        expect(describeStateKey(`cdkd/${stack}/state.json`)).toBe(stack);
      }
    );

    it('still pairs stack and region in the v2 layout', () => {
      expect(
        describeStateKey('cdkd/MyStack/eusc-de-east-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('MyStack (eusc-de-east-1)');
    });

    it('does NOT claim the two-segment case — a nested custom prefix is legacy there', () => {
      // The reason the depth rule stops at ONE segment. `--state-prefix
      // cdkd/team-a` nests INSIDE the default prefix, so this is a LEGACY key
      // two segments deep. A first cut took the two-segment case, reasoning
      // that the last segment must be the region at that depth, and split it as
      // `team-a (MyStack)` where `main` correctly says `MyStack` — shipping a
      // regression of the very class this fix removes. Depth cannot tell that
      // apart from a real {stack}/{region}; only the tail's shape can.
      expect(
        describeStateKey('cdkd/team-a/MyStack/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('MyStack');
      // ...and the same depth WITH a region-shaped tail is still paired — by
      // the heuristic, not by depth. The two rules have disjoint jobs.
      expect(
        describeStateKey(
          'cdkd/MyStack/eusc-de-east-1/state.json',
          STATE_FILE_SUFFIX,
          DEFAULT_STATE_PREFIX
        )
      ).toBe('MyStack (eusc-de-east-1)');
    });

    it('applies to lock keys in both layouts', () => {
      expect(
        describeStateKey('cdkd/demo-app-1/lock.json', LOCK_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('demo-app-1');
      expect(
        describeStateKey('cdkd/MyStack/eusc-de-east-1/lock.json', LOCK_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('MyStack (eusc-de-east-1)');
    });

    it('a FOREIGN-prefix legacy key is protected by the pattern, not by this rule', () => {
      // The gap that let a blocker through green: the suite had no legacy case
      // under a prefix the caller does NOT know, which is precisely where the
      // depth rule is powerless and the pattern is the only defence. `main`
      // answers `demo-app-1` for all of these; a widened pattern answered
      // `myteam (demo-app-1)` / `sub (api-prod-1)` and no test noticed.
      expect(
        describeStateKey('myteam/demo-app-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('demo-app-1');
      expect(
        describeStateKey('myteam/sub/api-prod-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('api-prod-1');
      expect(
        describeStateKey('cdkd-backup/demo-app-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('demo-app-1');
      // Lock keys take the same path — the regression hit those too.
      expect(
        describeStateKey('myteam/api-prod-1/lock.json', LOCK_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('api-prod-1');
      // ...and the NESTED-under-known-prefix spelling of the same shape, which
      // an earlier revision fixed only for a non-region-shaped stack name.
      expect(
        describeStateKey('cdkd/team-a/demo-app-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('demo-app-1');
    });

    it('FALLS BACK to shape for a key under a FOREIGN prefix', () => {
      // This is why the regex widening is still load-bearing and was not
      // superseded by the depth branch. The listings deliberately span the
      // whole bucket, so a stack deployed with a custom --state-prefix cannot
      // slip past a teardown guard — and for those keys the depth is unknown.
      const key = 'team/infra/prod/Api/eusc-de-east-1/state.json';
      expect(describeStateKey(key, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)).toBe(
        'Api (eusc-de-east-1)'
      );
    });

    it('falls back to shape at a depth cdkd never writes', () => {
      // Three segments under the prefix is not a layout; inventing a pair from
      // it would be a third guess rather than an exact answer.
      expect(
        describeStateKey('cdkd/a/b/c/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('c');
    });

    it('tolerates a knownPrefix spelled with a trailing slash', () => {
      // The doc on this parameter says a drifted prefix silently demotes every
      // key back to the guess. A trailing slash is the cheapest way to spell
      // that drift, so the tolerance is fenced rather than merely documented.
      expect(describeStateKey('cdkd/demo-app-1/state.json', STATE_FILE_SUFFIX, 'cdkd/')).toBe(
        'demo-app-1'
      );
      expect(
        describeStateKey('cdkd/MyStack/eusc-de-east-1/state.json', STATE_FILE_SUFFIX, 'cdkd/')
      ).toBe('MyStack (eusc-de-east-1)');
    });

    it('an empty knownPrefix does not disable the whole-bucket fallback', () => {
      // Documents the CONTRACT; it does not fence the `prefix !== ''` guard,
      // which is redundant on its own (no key starts with `/`, so an empty
      // prefix already falls through). Kept because the guard states intent at
      // the seam, and stated here so the case is not mistaken for a fence.
      expect(describeStateKey('cdkd/MyStack/us-east-1/state.json', STATE_FILE_SUFFIX, '')).toBe(
        'MyStack (us-east-1)'
      );
    });

    it('a NESTED custom prefix still pairs via the shape heuristic', () => {
      // The realistic foreign-prefix shape: someone running with
      // `--state-prefix cdkd/team`. The depth branch does not apply (three
      // segments under `cdkd`), so this is the fall-through actually producing
      // a PAIR rather than a bare segment — which the `cdkd/a/b/c` case cannot
      // show, since its tail is not region-shaped.
      expect(
        describeStateKey('cdkd/team/Api/eusc-de-east-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('Api (eusc-de-east-1)');
    });

    it('an empty segment falls through rather than pairing onto nothing', () => {
      // Pins the non-empty `secondLast` guard in the heuristic. Without it a
      // malformed `cdkd//us-east-1/state.json` pairs as ` (us-east-1)` with a
      // leading space, which `gc.ts`'s re-parse of this string then fails to
      // match — so the recovery command it builds names an empty stack.
      expect(
        describeStateKey('cdkd//us-east-1/state.json', STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX)
      ).toBe('us-east-1');
    });
  });

  it('STATE_FILE_SUFFIX is the default suffix', () => {
    expect(describeStateKey(`cdkd/S/eusc-de-east-1${STATE_FILE_SUFFIX}`)).toBe(
      'S (eusc-de-east-1)'
    );
  });
});
