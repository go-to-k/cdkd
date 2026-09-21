/**
 * Issue go-to-k/cdkd#3313: every S3 listing in `src/` omitted `EncodingType`,
 * so the XML round-trip turned a CARRIAGE RETURN in a key into a LINE FEED and
 * anything addressing that key afterwards addressed one that does not exist.
 *
 * MEASURED against real S3 (us-east-1, 2026-09-17) before the fix:
 *
 *     PutObject  key containing CR    -> stored
 *     ListObjectsV2, no EncodingType  -> the CR comes back as \n
 *     ListObjectsV2, EncodingType=url -> ...%0D..., decoding to the real CR
 *     PutObject  key containing NUL   -> REFUSED by S3
 *     ESC                             -> survives verbatim, both ways
 *
 * The request and the decode are ONE decision — a site that asks for encoding
 * without decoding corrupts every legitimate `%` in a key — so the fence below
 * checks both halves together at every call site, not the helper alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';

import { LISTING_ENCODING_TYPE, decodeListingKey } from '../../../src/utils/s3-listing-keys.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every file in `src/` that constructs a listing command. Derived, not listed. */
const LISTING_FILES = [
  'src/state/s3-state-backend.ts',
  'src/state/s3-noncurrent-version-purge.ts',
  'src/cli/commands/gc.ts',
  'src/cli/commands/bootstrap-destroy.ts',
  'src/cli/commands/state-migrate.ts',
  'src/cli/config-loader.ts',
  'src/provisioning/providers/s3-bucket-provider.ts',
  'src/provisioning/providers/s3-directory-bucket-provider.ts',
  'src/deployment/recreate-targets.ts',
  'src/cli/commands/state.ts',
];

/**
 * The two that deliberately do NOT ask for encoding, each because it reads no
 * KEY at all — `config-loader.ts` reads `KeyCount`, `recreate-targets.ts` is an
 * emptiness probe. Asking there would be inert, and asking WITHOUT decoding is
 * the shape that corrupts a real `%`.
 *
 * `state.ts` is the one site this change does NOT fix: go-to-k/cdkd#3226 holds
 * it. Listed here so the exemption is explicit and fails when that lands.
 */
const NO_KEY_READ = ['src/cli/config-loader.ts', 'src/deployment/recreate-targets.ts'];
const HELD_BY_ANOTHER_PR: string[] = [];

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');

describe('decodeListingKey', () => {
  it('recovers the CR that the un-encoded listing would have turned into an LF', () => {
    const CR = String.fromCharCode(13);
    expect(decodeListingKey('cdkd/Cr%0Dx/us-east-1/state.json')).toBe(
      `cdkd/Cr${CR}x/us-east-1/state.json`
    );
  });

  it('passes an ordinary key through byte-identically', () => {
    // The half that makes adoption safe: every legitimate key must survive
    // unchanged, or the decode costs more than the defect.
    for (const k of ['cdkd/MyStack/us-east-1/state.json', 'cdkd/Parent~Child/us-east-1/lock.json']) {
      expect(decodeListingKey(k)).toBe(k);
    }
  });

  it('decodes a literal percent rather than mangling it', () => {
    // A key may legitimately contain `%`. S3 encodes it as `%25`; decoding that
    // yields the single character back. A site that decoded a response it did
    // NOT ask to be encoded would turn a real `%25` into `%`, which is the
    // failure mode of asking for one half of this pair.
    expect(decodeListingKey('cdkd/a%2525b/us-east-1/state.json')).toBe(
      'cdkd/a%25b/us-east-1/state.json'
    );
  });

  it('decodes FORM-style, which is what S3 actually sends', () => {
    // MEASURED against real S3, and the reason this is not a bare
    // `decodeURIComponent`: a key `a b` comes back `a+b` and a key `a+b` comes
    // back `a%2Bb`. Decoding without the `+` step maps BOTH onto `a+b` — two
    // distinct keys collapsing onto one value, so a delete addresses the wrong
    // object. A space is far commoner in a key than the CR this module was
    // written for, which makes this the load-bearing half.
    expect(decodeListingKey('cdkd/a+b/us-east-1/state.json')).toBe('cdkd/a b/us-east-1/state.json');
    expect(decodeListingKey('cdkd/a%2Bb/us-east-1/state.json')).toBe(
      'cdkd/a+b/us-east-1/state.json'
    );
    // And the two must not collide, which is the property the defect broke.
    expect(decodeListingKey('cdkd/a+b/x/state.json')).not.toBe(
      decodeListingKey('cdkd/a%2Bb/x/state.json')
    );
  });

  it('decodes a multi-byte UTF-8 key', () => {
    // Measured in the same run: a key of Japanese text comes back percent-encoded
    // per UTF-8 byte.
    expect(decodeListingKey('cdkd/%E3%81%82/us-east-1/state.json')).toBe(
      'cdkd/\u3042/us-east-1/state.json'
    );
  });

  it('passes undefined through so an optional field needs no branch', () => {
    expect(decodeListingKey(undefined)).toBeUndefined();
  });

  it('REFUSES a value it cannot decode rather than guessing', () => {
    // This is the one place a raw response value is trusted. A key that will
    // not decode is one a later delete would address wrongly.
    expect(() => decodeListingKey('cdkd/bad%ZZ/us-east-1/state.json')).toThrow(
      /not valid URL encoding/
    );
  });

  it('LISTING_ENCODING_TYPE is the value S3 accepts', () => {
    expect(LISTING_ENCODING_TYPE).toBe('url');
  });
});

describe('every listing site asks for encoding AND decodes (go-to-k/cdkd#3313)', () => {
  it('the file list is complete — no listing site is missing from it', () => {
    // Derived rather than trusted: a new listing added anywhere in `src/` must
    // join this fence, and nothing else watches for one.
    // Enumerated with git rather than a hand-rolled walk: it is the same grep
    // the issue used, and it cannot drift from the working tree.
    const found = new Set<string>();
    const out = execFileSync(
      'git',
      ['grep', '-l', '-E', 'new (ListObjectsV2Command|ListObjectVersionsCommand)', '--', 'src/'],
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    for (const line of out.split('\n')) if (line.trim()) found.add(line.trim());
    expect([...found].sort()).toEqual([...LISTING_FILES].sort());
  });

  for (const rel of LISTING_FILES) {
    if (NO_KEY_READ.includes(rel) || HELD_BY_ANOTHER_PR.includes(rel)) continue;
    it(`${rel}: every listing asks, and every key read decodes`, () => {
      const src = read(rel);
      // PER OCCURRENCE, not per file. A `toContain` over the whole file was the
      // first version, and three real defects shipped GREEN under it — two
      // `DeleteMarkers[].Key` reads left raw beside a decoded `Versions[].Key`,
      // and one raw `NextKeyMarker` — each in a file whose OTHER listing
      // satisfied the string.
      const listings = [...src.matchAll(/new List(?:ObjectsV2|ObjectVersions)Command\(/g)].length;
      const asks = [...src.matchAll(/EncodingType: LISTING_ENCODING_TYPE/g)].length;
      expect(asks, `${listings} listing(s) but ${asks} EncodingType request(s)`).toBe(listings);

      // The DEFECT SHAPE, targeted directly rather than by a general read-scan.
      // Three real defects shipped green under the per-FILE `toContain` this
      // replaces, and all three were the same shape: a value the code goes on to
      // USE — pushed into a delete batch, tested for membership, or sent back as
      // a pagination marker — taken from a listing entry WITHOUT decoding.
      //
      // Deliberately narrow. A general "every `x.Key` must decode" scan needs an
      // exemption for every presence test (`if (x.Key)`, `=== undefined`,
      // `.filter((v) => v.Key)`), and piling up those exemptions is how a fence
      // stops meaning anything.
      // The variable set is DERIVED from the `for (const X of ...Versions)` /
      // `.Contents` bindings in this very file, not a hand-written whitelist —
      // a review round found `page.NextKeyMarker` invisible because `page` was
      // not on the list, which is exactly how a derived set cannot fail.
      const entryVars = new Set<string>(
        [
          ...src.matchAll(
            /for \(const (?:\{[^}]*\}|([A-Za-z_$][\w$]*))\s+of\s+[^)]*?\.(?:Versions|DeleteMarkers|Contents)\b/g
          ),
        ]
          .map((m) => m[1])
          .filter((v): v is string => v !== undefined)
      );
      // Plus the response bindings a pagination marker is read off.
      for (const m of src.matchAll(/const ([A-Za-z_$][\w$]*)\s*=\s*await [^;]*\.send\(/g)) {
        if (m[1] !== undefined) entryVars.add(m[1]);
      }
      const varAlt = [...entryVars].map((v) => v.replace(/\$/g, '\\$')).join('|') || 'NEVERMATCH';

      const usesRawKey = [
        // pushed into a batch: `{ Key: v.Key, ... }`
        new RegExp(`\\{\\s*Key:\\s*(?:${varAlt})\\.Key\\b`),
        // membership tested: the value decides a delete
        new RegExp(`\\.has\\((?:${varAlt})\\.Key\\)`),
        // BOUND for later use: `const objKey = obj.Key` — the shape a review
        // round found invisible, since the raw value then flows on unmarked.
        new RegExp(`=\\s*(?:${varAlt})\\.(?:Key|NextKeyMarker)\\b`),
      ];
      // A marker exempts the NEXT non-comment line only. A fixed 3-line window
      // silently exempted an unrelated neighbour two lines down (measured).
      const lines = src.split('\n');
      const exempt = new Set<number>();
      for (const [i, l] of lines.entries()) {
        if (!l.includes('listing-key-raw-ok')) continue;
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j]?.trimStart() ?? '';
          if (t.startsWith('//') || t === '') continue;
          exempt.add(j);
          break;
        }
      }
      const offenders = lines
        .map((l, i) => [l, i] as const)
        .filter(([, i]) => !exempt.has(i))
        .map(([l]) => l)
        .filter((l) => !l.trimStart().startsWith('//'))
        .filter((l) => !l.includes('decodeListingKey('))
        .filter((l) => usesRawKey.some((re) => re.test(l)));

      expect(
        offenders,
        `${rel}: a listing value is USED without decodeListingKey. This file asks for ` +
          `URL encoding, so a raw value mis-addresses the object — the delete SUCCEEDS ` +
          `and removes nothing.`
      ).toEqual([]);
    });
  }

  for (const rel of NO_KEY_READ) {
    it(`${rel} deliberately does NOT ask, and reads no key`, () => {
      const src = read(rel);
      expect(src, 'this site reads no KEY, so encoding would be inert').not.toContain(
        'EncodingType: LISTING_ENCODING_TYPE'
      );
      // And the exemption is only sound while that stays true.
      expect(src, 'the reason recorded at the site must still be there').toContain(
        'go-to-k/cdkd#3313'
      );
    });
  }

  it('no listing is deferred to another PR', () => {
    // This list held `state.ts` while go-to-k/cdkd#3226 owned that file, and the
    // case asserted the site had NOT been fixed — a reminder that would fail the
    // moment it was. It did its job: #3226 merged, the site was wired, and the
    // entry came out, which promoted `state.ts` into the real per-file loop
    // above rather than leaving it skipped.
    //
    // The list stays, EMPTY, as the fence for the next time. A deferral is
    // legitimate — a file another PR holds cannot be edited — but it must be
    // temporary and visible, so an entry added here has to be justified in the
    // same breath and removed when the holder lands.
    expect(
      HELD_BY_ANOTHER_PR,
      'a listing site is deferred. That is allowed while another PR holds the file, ' +
        'but the entry must name which PR and come out when that PR merges — ' +
        'otherwise it is a permanent exemption wearing a temporary label.'
    ).toEqual([]);
  });
});
