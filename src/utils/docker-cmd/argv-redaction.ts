import { escapeRegExp } from '../regexp.js';

/**
 * Masking docker argv VALUES element by element. Part of the `docker-cmd.ts`
 * split (go-to-k/cdkd#5835); import from `../docker-cmd.js`, not from here.
 */

/** Replaces a redacted argv VALUE wherever this module masks one. */
export const REDACTED_ARGV_VALUE = '***';

/**
 * `docker` argv flags whose NEXT token is a `KEY=VALUE` pair built from
 * user-supplied template data, and whose VALUE therefore must not reach a
 * user-visible error string:
 *
 * - `-e` / `--env` — a container's `Environment.Variables` (Lambda) or
 *   `ContainerDefinition.Environment` (ECS), plus `--env-vars` overrides.
 *   Values that cdkd classifies as sensitive never get here at all
 *   ({@link partitionSensitiveEnv} emits those as a value-less `-e KEY`),
 *   but everything else does: connection strings, endpoints, API base URLs.
 * - `--opt` — `DockerVolumeConfiguration.DriverOpts`, which for the `local`
 *   driver carries mount options (`o=addr=…,username=…,password=…`).
 * - `--label` — `DockerVolumeConfiguration.Labels`, user-authored metadata.
 * - `--build-arg` — a `DockerImageAsset`'s `buildArgs`, forwarded by
 *   `src/assets/docker-build.ts` on BOTH the deploy-time ECR publish path and
 *   `cdkd local run-task`'s image build
 *   ([#2623](https://github.com/go-to-k/cdkd/issues/2623)). The value is
 *   frequently NOT a secret and IS diagnostic (a version pin, a base-image
 *   tag), which is why this one needed arguing rather than assuming — the
 *   argument that settles it is RECOVERABILITY, not likelihood. The build-arg
 *   values sit unredacted in `cdk.out/*.assets.json` on the operator's own
 *   disk, so a masked `--verbose` line costs one `jq` against a file they
 *   already have; the log line is the copy that travels into a CI archive and
 *   a pasted issue, where a build-time registry / package token
 *   (`NPM_TOKEN`, `GITHUB_TOKEN` — a common, if discouraged, use of
 *   `buildArgs`) is disclosed irreversibly. The KEY survives, so "which build
 *   arg" — the half of the diagnostic that identifies the failure — is
 *   unaffected.
 *
 * A flag NOT in this list keeps its value. For most of the argv that is
 * because the value is cdkd-authored or infrastructure-shaped — a container
 * id, an image ref, a `--subnet` CIDR, a `--format` template — and is the
 * diagnostic.
 *
 * That is NOT true of the whole remainder, and the residual is recorded here
 * rather than quietly implied: `--health-cmd`, `--ulimit`, `--link`,
 * `--entrypoint`, `--workdir` and the positional image + container command are
 * all template-supplied and still echoed. They stay unmasked deliberately —
 * each is a COMMAND or a structural knob whose text IS what an operator reads
 * the failure for, and none is a documented place to put a secret, unlike
 * `Environment` / `Secrets` / `DriverOpts`. Revisit per flag if a real leak is
 * found through one; do not widen the set on suspicion, since every addition
 * trades away diagnostic text.
 *
 * Two `docker build` flags were considered WITH `--build-arg` and deliberately
 * left out, because both carry a LOCATOR rather than a value
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623)):
 *
 * - `--secret id=<id>,src=<path>` (or `,env=<NAME>`) — BuildKit resolves the
 *   material itself at build time and docker has NO inline-value syntax, so
 *   cdkd never holds the secret to leak. Masking would also blank the `id`,
 *   since the mask keys on the first `=` and `id` is what sits there — trading
 *   the whole diagnostic ("which secret, sourced from where") for a path.
 * - `--build-context <name>=<path|image-ref|git-url>` — a path or a ref, like
 *   the positional image. A URL form CAN embed a credential, but so can the
 *   image ref; masking one of the two would be a guarantee this set does not
 *   make, and neither is a documented place to put one.
 *
 * `--cache-from` / `--cache-to` were in that second bullet for one review
 * round and the security reviewer was right to refuse it: their value is a
 * comma-separated PARAM LIST, and BuildKit's cache backends take real
 * credentials inline there — s3's `access_key_id` / `secret_access_key` /
 * `session_token`, azblob's `secret_access_key`, gha's `token`. Those are not
 * locators, so they get their own structural mask keyed on the PARAM name:
 * {@link ARGV_PARAM_LIST_FLAGS} / {@link ARGV_PARAM_LIST_LOCATOR_PARAMS}.
 */
const ARGV_VALUE_BEARING_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--env',
  '--opt',
  '--label',
  '--build-arg',
]);

/**
 * `docker` argv flags whose NEXT token is a COMMA-SEPARATED `key=value` param
 * list rather than one `KEY=VALUE` pair ([#2623](https://github.com/go-to-k/cdkd/issues/2623)
 * security review).
 *
 * Only the params in {@link ARGV_PARAM_LIST_LOCATOR_PARAMS} survive, and the
 * rest of the list is masked — `type=s3,region=us-east-1,bucket=b` IS the
 * diagnostic ("which backend, where"), and blanking the whole value would
 * destroy it to hide one field.
 */
const ARGV_PARAM_LIST_FLAGS: ReadonlySet<string> = new Set(['--cache-from', '--cache-to']);

/**
 * Param names inside an {@link ARGV_PARAM_LIST_FLAGS} value that are LOCATORS
 * and therefore survive. **Everything else in the list is masked** — this is
 * an ALLOWLIST, and it is one deliberately.
 *
 * The first cut was a denylist of the credential params BuildKit's backends
 * spell (`secret_access_key`, `access_key_id`, `session_token`, `token`), and
 * both round-2 reviewers broke it the same way:
 * `DockerCacheOption.params` is an arbitrary user map that
 * `cacheOptionToFlag` joins with a bare `,` and no quoting, so a value
 * CONTAINING a comma (`token=aa,bb`, or BuildKit's own legal
 * `secret_access_key="ab,cd"`) split into a masked head and a bare tail that
 * printed verbatim — output that LOOKS redacted. Patching that one shape is
 * the enumerate-bad-shapes treadmill; inverting the test ends it, because a
 * CSV continuation fragment has no recognised param name and so masks by
 * construction.
 *
 * The trade is the right way round for a leak fix: a param missing from this
 * list costs one degraded diagnostic, a param missing from a denylist costs a
 * printed credential. The list covers every backend BuildKit ships —
 * `registry` (`ref`), `local` (`dest` / `src` / `digest` / `tag`), `s3`
 * (`region` / `bucket` / `name` / the prefixes / `use_path_style`), `azblob`
 * (`account_name` / `name` / `prefix`), `gha` (`scope` / `timeout`),
 * `inline` (none) — plus the shared export options, so the common case masks
 * nothing.
 *
 * The four URL-valued locators live in {@link ARGV_PARAM_LIST_URL_PARAMS}
 * instead: they survive only after their userinfo and query are stripped. An
 * earlier revision kept them HERE, whole, arguing the repo's locator policy;
 * that paragraph is gone rather than softened, because azblob makes it false.
 *
 * Matched case-INSENSITIVELY on the trimmed param name — the comparison is
 * over a user-supplied key and BuildKit's own option parsing is
 * case-insensitive, so a `Secret_Access_Key` spelling must not walk past.
 */
const ARGV_PARAM_LIST_LOCATOR_PARAMS: ReadonlySet<string> = new Set([
  // shared / export options
  'type',
  'mode',
  'compression',
  'compression-level',
  'force-compression',
  'ignore-error',
  'image-manifest',
  'oci-mediatypes',
  'timeout',
  // registry
  'ref',
  // local
  'dest',
  'src',
  'digest',
  'tag',
  // s3
  'region',
  'bucket',
  'name',
  'prefix',
  'manifests_prefix',
  'blobs_prefix',
  'use_path_style',
  'upload_parallelism',
  'touch_refresh',
  // azblob
  'account_name',
  // gha
  'scope',
]);

/**
 * Locator params whose value is a URL, and which therefore survive only after
 * their USERINFO, QUERY and FRAGMENT are stripped — and only when the value
 * parses at all
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623) round-3 security
 * review).
 *
 * These were plain allowlist entries for one round, on the reasoning that a
 * credential-in-URL is an incidental hazard shared with `--build-context` and
 * the positional image ref. That reasoning does not survive contact with
 * azblob: BuildKit builds an UNAUTHENTICATED client from `account_url` when
 * `secret_access_key` is absent, so a SAS token in its query string is that
 * backend's SUPPORTED auth path, not an accident. With every other param now
 * fail-closed, leaving the whole URL was the one entry carrying credential
 * material by design.
 *
 * Scheme and host survive, which is what "which endpoint" needs — on the
 * ordinary path. FOUR things mask more than that, and every one of them also
 * masks each param after it in the same value, because they all set `masked`.
 * Three take the value WHOLE: no recognisable `//` authority; a host that is
 * really `user:password` with its `@` cut away; and a later param carrying
 * this URL's severed `@` (the caller's rule, since only it still holds the
 * parts). The fourth is milder in what it keeps, not in what it cascades — a
 * `@` in the PATH costs the host but keeps scheme and tail (`https://h/x@y`
 * -> `https://***@y`). Over-masking is the deliberate direction: see
 * {@link redactUrlLocator} for what each boundary rule leaked before this one.
 */
const ARGV_PARAM_LIST_URL_PARAMS: ReadonlySet<string> = new Set([
  'account_url',
  'endpoint_url',
  'url',
  'url_v2',
]);

/**
 * A URL locator with its credential-bearing parts removed: `userinfo@`, and
 * everything from `?` or `#` on.
 *
 * Returns the input UNCHANGED when there was nothing to strip, which is the
 * signal the caller keys "was this masked?" on — so every other branch must
 * differ from its input. An unparseable or implausible value returns `***`
 * rather than itself: these four params are the only ones exempt from the
 * allowlist's mask-by-default rule, so this function is their whole
 * protection and it fails CLOSED.
 */
function redactUrlLocator(value: string): string {
  // An EMPTY value carries nothing, so `***` would assert a secret that is not
  // there — and because a mask here also masks every LATER param, it would
  // take the rest of the diagnostic with it. Same rule the param walk applies
  // to an empty part; round 5 added it there and not here.
  if (value === '') return value;
  // FAIL CLOSED on anything without a recognisable `//` authority. These four
  // params are the ONLY ones exempt from the allowlist's mask-by-default rule,
  // so this parse is their sole protection and an unrecognised shape must not
  // pass through whole. The first cut required `scheme://` and returned the
  // input unchanged otherwise, which printed
  // `endpoint_url=user:pw@minio.local:9000` verbatim — a real spelling, and
  // the enumerate-bad-shapes failure this PR argues against, inverted.
  const authority = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.exec(value);
  if (authority === null) return REDACTED_ARGV_VALUE;
  const prefix = authority[0];
  let rest = value.slice(prefix.length);

  // USERINFO FIRST, and anchored on the LAST `@` in the whole remainder — not
  // on a computed authority boundary. Every boundary rule tried here leaked,
  // because each one trusts the value to be well-formed and docker prints
  // whatever it was handed:
  //
  //   - bounded by the first `/`  -> `AKIA:wJal/rX@host` passed through whole
  //     (a literal `/` in userinfo is invalid syntax, and still printable).
  //   - bounded by the first `?`  -> `user:p?w@h/x` read as "no userinfo" and
  //     printed the password up to the `?`. Measured on this branch.
  //
  // Taking the last `@` cannot leak: whatever precedes it is gone. The cost is
  // over-masking when a `@` sits in the PATH or QUERY (`h/x@y` -> `***@y`,
  // losing the host) AND — because any mask here sets `masked` — every param
  // AFTER this one in the same value. That is the safe direction and the only
  // rule here that does not depend on the value parsing.
  const lastAt = rest.lastIndexOf('@');
  if (lastAt >= 0) {
    rest = `${REDACTED_ARGV_VALUE}${rest.slice(lastAt)}`;
  } else {
    // No `@` at all — which is ALSO what a userinfo containing a COMMA looks
    // like, because `maskArgvFlagValue` splits the param list on `,` before
    // this function ever sees the URL: `endpoint_url=https://AKIAX:wJalr,XyZ@h`
    // arrives here as `https://AKIAX:wJalr`.
    //
    // DEFENCE IN DEPTH ONLY. This shape-based rule recognises just the
    // `user:password` sub-case, and round-6 review measured two it cannot see
    // (a bare-token userinfo with no `:`, and an all-digit password). The
    // severed-comma class is closed by the CALLER, which still holds the
    // parts the split produced and can see the orphaned `@`; this stays
    // because a `:`-bearing head is not a host either way. `h:9000` and
    // `[::1]:9000` keep working.
    const host = rest.split(/[/?#]/)[0]!;
    // Strip a bracketed IPv6 literal before the colon test: its own colons are
    // not a `user:password` separator, and matching them made
    // `endpoint_url=http://[::1]:9000` mask -- AND, because a mask cascades,
    // take every later param with it. A legitimate local-MinIO spelling,
    // measured as a regression this rule introduced (round-6 review).
    //
    // Gated on the bracket actually holding an IPv6 LITERAL, not merely on a
    // leading `[`. Exempting all bracket content re-opened exactly the case
    // this rule is kept for: `https://[AKIA:wJalrSecret]` has no `@` anywhere,
    // so the caller's severed-`@` scan cannot see it either, and it printed
    // verbatim (both round-7 reviewers measured it). The hex-and-colon charset
    // refuses it because `K`, `w` and `J` are not hex digits. An UNTERMINATED
    // bracket does not match, so the whole host is tested -- fails closed, the
    // right direction.
    const ipv6 = /^\[[0-9A-Fa-f:.]+\]/.exec(host);
    const bare = ipv6 ? host.slice(ipv6[0].length) : host;
    // `\d{1,5}` rather than `\d*`: a port is at most 65535, so a longer digit
    // run is not one. Narrower by exactly the shapes it should refuse.
    if (/:(?!\d{1,5}$)/.test(bare)) return REDACTED_ARGV_VALUE;
  }

  // Query AND fragment: azblob's SAS rides the query, and a fragment is just
  // as printable even though Go's URL parser drops it before BuildKit sees it.
  for (const delimiter of ['?', '#']) {
    const at = rest.indexOf(delimiter);
    if (at >= 0) rest = `${rest.slice(0, at)}${delimiter}${REDACTED_ARGV_VALUE}`;
  }
  return `${prefix}${rest}`;
}

/**
 * The masked rendering of `value` for `flag`, or `undefined` when this flag
 * carries nothing to mask.
 *
 * The single place every argv spelling converges — `--flag VALUE` (two
 * tokens), `--flag=VALUE` (one), and pflag's shorthand cluster in both forms,
 * which reach it through {@link maskAttachedShortFlag} and through
 * {@link trailingShortFlagOfCluster} in {@link redactDockerArgvValues}.
 *
 * The joined form is valid docker syntax for every long flag here, and it was
 * UNMASKED until the [#2623](https://github.com/go-to-k/cdkd/issues/2623)
 * review: harmless while every argv this repo builds emits two tokens, but
 * `src/assets/docker-build.ts`'s `executable` source mode renders a
 * USER-AUTHORED command line, and a wrapper script spelling
 * `--build-arg=NPM_TOKEN=…` leaked it verbatim into both the `--verbose` log
 * and a thrown error.
 */
function maskArgvFlagValue(flag: string, value: string): string | undefined {
  if (ARGV_VALUE_BEARING_FLAGS.has(flag)) {
    const eqIdx = value.indexOf('=');
    // `>= 0`, not `> 0`: an EMPTY key (`-e =value`) still carries a value.
    // `partitionSensitiveEnv` fail-closes a malformed key only on its
    // SENSITIVE branch, so a non-sensitive `{ Name: '', Value: <secret> }`
    // reaches the argv as a literal `-e =<secret>` — and a `> 0` guard walks
    // straight past it. Same fail-closed posture as `isMalformedEnvKey`
    // (#2186 rounds 4-5).
    return eqIdx >= 0
      ? `${value.substring(0, eqIdx)}=${REDACTED_ARGV_VALUE}`
      : // A value-less `-e KEY` (the form `partitionSensitiveEnv` emits for a
        // sensitive key) has nothing to mask.
        undefined;
  }
  if (ARGV_PARAM_LIST_FLAGS.has(flag)) {
    let masked = false;
    const rawParts = value.split(',');
    const parts = rawParts.map((part, index) => {
      // Everything AFTER the first masked part is masked too. The join is
      // lossy: `token=aa,name=bb` is indistinguishable from a `token` whose
      // value literally contains `,name=bb`, so once a part is known to have
      // carried credential material, no later part can be trusted to be a
      // param rather than its tail. The params BEFORE the first credential
      // survive whole, and BuildKit's own documented ordering puts `type=`
      // there — so the "which backend, where" diagnostic is what is kept.
      // An EMPTY part carries nothing, at any index. Rendering `,,` as
      // `,***,` would assert a secret that does not exist -- the same reason
      // the index-0 carve-out below gives, applied consistently.
      if (part === '') return part;
      if (masked) return REDACTED_ARGV_VALUE;
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) {
        // buildx's legacy shorthand: `--cache-from <NAME>` is a bare image
        // ref — a pure locator, and the WHOLE diagnostic. It can only be
        // first; a bare part anywhere else is a continuation of the value
        // before it (`token=aa,bb` splits into `token=aa` and `bb`, and `bb`
        // is half the credential), so only index 0 survives.
        //
        // An EMPTY value lands here too (`''.split(',')` is `['']`) and is
        // likewise returned unchanged, which is the right answer for a
        // different reason: rendering `--cache-to ''` as `***` would assert a
        // secret that does not exist. A separate `value === ''` early return
        // said so explicitly for one round and was DEAD — its mutation probe
        // could not discriminate, because this line already produced the same
        // result. Both behaviours are pinned by tests, so a future narrowing
        // of this carve-out reds the empty case too.
        if (index === 0) return part;
        masked = true;
        return REDACTED_ARGV_VALUE;
      }
      const name = part.substring(0, eqIdx);
      const normalized = name.trim().toLowerCase();
      if (ARGV_PARAM_LIST_URL_PARAMS.has(normalized)) {
        // A `@` in any LATER part can only be THIS url's severed userinfo
        // terminator: the split destroyed a comma that was inside the value,
        // and nothing downstream of a URL param legitimately carries one.
        // The caller knows what the split destroyed, which is why this lives
        // here and not in `redactUrlLocator` — the head handed to that
        // function has already lost the evidence.
        //
        // The previous guard inferred the severance from the HEAD's shape (a
        // `:` whose right side is not a port) and only recognised
        // `user:password`. Round-6 security review measured two shapes still
        // printing: a bare-token userinfo (`https://ghp_TOKEN,TAIL@github.com`
        // — the dominant registry / GHA spelling, no `:` at all, so the head
        // is indistinguishable from a hostname) and an all-DIGIT password
        // (`admin:12345`, which satisfies the port test). Both are closed by
        // asking the array instead of the string.
        //
        // Cost: a cache config carrying BOTH a URL param and a later digest
        // ref (`ref=repo@sha256:…`) masks the URL it did not need to. Safe
        // direction, and the two do not co-occur in any BuildKit backend.
        if (rawParts.slice(index + 1).some((later) => later.includes('@'))) {
          masked = true;
          return `${name}=${REDACTED_ARGV_VALUE}`;
        }
        const rawUrl = part.substring(eqIdx + 1);
        const safeUrl = redactUrlLocator(rawUrl);
        if (safeUrl === rawUrl) return part;
        masked = true;
        return `${name}=${safeUrl}`;
      }
      if (ARGV_PARAM_LIST_LOCATOR_PARAMS.has(normalized)) return part;
      masked = true;
      return `${name}=${REDACTED_ARGV_VALUE}`;
    });
    return masked ? parts.join(',') : undefined;
  }
  return undefined;
}

/**
 * The masked rendering of an ATTACHED short-flag element (`-eKEY=VALUE`), or
 * `undefined` when this element is not one.
 *
 * pflag — which docker uses — accepts a short flag's value glued to it, so
 * `-eNPM_TOKEN=secret` is `-e NPM_TOKEN=secret`, and neither the two-token nor
 * the `--flag=VALUE` branch can see it ([#2623](https://github.com/go-to-k/cdkd/issues/2623)
 * round-2 security review). No argv this repo BUILDS uses the form, but
 * `src/assets/docker-build.ts`'s `executable` source mode hands a user's own
 * command line straight to `spawn`, which is the whole reason the joined form
 * is masked too.
 *
 * This OVER-MASKS relative to pflag, and the earlier claim that it "follows
 * docker's own parse" was wrong: pflag stops at the first cluster letter that
 * consumes a value, so it reads `-file=a=b` as `-f` taking `ile=a=b` while
 * this masks at the `e`. Every such divergence costs a diagnostic and hides
 * nothing that was not already a `KEY=VALUE` pair, so the direction is the
 * safe one — but it is a divergence, not parity.
 */
function maskAttachedShortFlag(arg: string): string | undefined {
  // A long flag is the joined branch's business. No `length` guard: `at < 0`
  // and `at === arg.length - 1` below already reject `-`, `-x` and a bare
  // `-e`, so one would be a line no mutation can kill.
  if (arg.startsWith('--') || !arg.startsWith('-')) return undefined;
  // pflag processes a shorthand CLUSTER left to right, so the flag letter may
  // sit anywhere in the run and everything after it is its value: `-itdeK=v`
  // is `-i -t -d -e K=v`. Anchoring on `startsWith(flag)` saw only the
  // un-clustered spelling, and `docker run -itd` is the most common docker
  // shorthand there is ([#2623](https://github.com/go-to-k/cdkd/issues/2623)
  // round-3 review measured `-itdeNPM_TOKEN=…` printing verbatim).
  //
  // LEFTMOST letter wins, across all short flags — that is pflag's own rule.
  // Iterating the Set and taking the first HIT instead made the result depend
  // on insertion order, so a second short flag could slice at a stray letter
  // further right and print the head of the value (round-4 review).
  //
  // UNEXERCISED, and deliberately said so: `-e` is the only short flag in the
  // set, so leftmost-wins and first-hit-wins agree on every input and no
  // behavioural test can tell them apart (probed — green). The pointer that
  // arrives WITH the second short flag rather than after it is the
  // one-short-flag assertion in
  // `tests/unit/local/docker-argv-redaction-fence.test.ts`, which reds the
  // moment one is added and names the case to write.
  let chosen: { at: number; flag: string } | undefined;
  for (const flag of ARGV_VALUE_BEARING_FLAGS) {
    // Short flags only: `-e`, never `--env`.
    if (flag.length !== 2 || !flag.startsWith('-') || flag[1] === '-') continue;
    const at = arg.indexOf(flag[1]!, 1);
    if (at < 0 || at === arg.length - 1) continue;
    if (chosen === undefined || at < chosen.at) chosen = { at, flag };
  }
  if (chosen === undefined) return undefined;
  const masked = maskArgvFlagValue(chosen.flag, arg.slice(chosen.at + 1));
  return masked === undefined ? undefined : `${arg.slice(0, chosen.at + 1)}${masked}`;
}

/**
 * The value-bearing short flag a shorthand CLUSTER ENDS in, if any — the form
 * that takes its value from the NEXT argv element.
 *
 * pflag's `parseSingleShortArg` falls through to `value = args[0]` when the
 * cluster runs out, so `-itde K=v` is `-i -t -d -e K=v` with the value in a
 * separate token. {@link maskAttachedShortFlag} bails on a flag letter in last
 * position (there is nothing attached to mask) and the two-token branch looked
 * `-itde` up as a whole flag and missed, so this spelling printed verbatim
 * until [#2623](https://github.com/go-to-k/cdkd/issues/2623)'s round-4 review
 * measured it. Pass 2 cannot rescue it either: its alternation needs a
 * whitespace-preceded `-e`.
 */
function trailingShortFlagOfCluster(arg: string): string | undefined {
  // No `length` guard: only `'-'` could reach one, and its last character is
  // `-`, which the loop already requires a flag's letter NOT to be. Removing
  // the redundant `< 3` from the sibling scan and reintroducing `< 2` here was
  // half-applying the same argument.
  if (arg.startsWith('--') || !arg.startsWith('-')) return undefined;
  const last = arg[arg.length - 1]!;
  for (const flag of ARGV_VALUE_BEARING_FLAGS) {
    if (flag.length === 2 && flag.startsWith('-') && flag[1] !== '-' && flag[1] === last) {
      return flag;
    }
  }
  return undefined;
}

/**
 * Structural, whitespace-delimited form of {@link ARGV_VALUE_BEARING_FLAGS}
 * for scanning a STRING that embeds a space-joined argv. Keyed on the FLAG's
 * position — never on the secret's value, so an unrelated literal that merely
 * coincides with a value is left alone.
 *
 * Covers the SEPARATED and JOINED spellings of
 * {@link ARGV_VALUE_BEARING_FLAGS} only. Two gaps, recorded rather than
 * implied. pflag's shorthand cluster is not modelled here in EITHER form —
 * attached (`-eKEY=VALUE` / `-itdeKEY=VALUE`) or separated (`-itde KEY=VALUE`,
 * which this pass's alternation cannot see because it needs a
 * whitespace-preceded `-e`) — this pass has no argv to resolve
 * the cluster against, and a bare `-e` prefix scan over free text would fire
 * on any word starting with `-e`; {@link redactDockerArgvValues} and passes 1
 * / 1b handle it wherever an argv IS available, which is every composer. And
 * {@link ARGV_PARAM_LIST_FLAGS}
 * is deliberately absent: this pass runs with NO argv to key on, and picking a
 * param name out of a free-text comma list is where a structural match stops
 * being structural. The param mask therefore rides passes 1 and 1b, both of
 * which derive from {@link redactDockerArgvValues} and so have the real argv —
 * i.e. a cache credential is masked in every text composed through a composer,
 * and not in a bare text handed to {@link redactDockerArgvInText} with no
 * `args`. Recorded rather than implied.
 *
 * DERIVED from the Set rather than re-spelled beside it
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623)). Until then this was
 * a hand-written literal listing the same four flags, i.e. the shape where
 * adding a flag to one spelling and not the other masks it on the argv pass
 * and leaks it on the text pass — a divergence no behavioural test of either
 * one can see. Deriving is stronger than fencing the pair: there is nothing
 * left to diverge.
 *
 * What each piece actually buys, since one of them was mis-credited in review:
 * the `(^|\s)` lead is what stops `-e` matching inside `--env` (there is no
 * `m` flag, so `^` is start-of-INPUT), NOT the alternation order — reordering
 * the branches leaves every test green. The order is kept as belt and braces
 * only, which is why the derivation sorts longest-first. The separator group
 * IS load-bearing: `\s+` is what stops `-easy` / `--environment` matching, and
 * the `=` alternative is the joined `--build-arg=KEY=VALUE` spelling
 * {@link maskArgvFlagValue} handles on the argv side (the group can never be
 * empty, so `--build-argument=X=y` still cannot match). The KEY is `[^\s=]*`
 * rather than `+` so an EMPTY key (`-e =value`) is masked too.
 *
 * The alternation is asserted NON-EMPTY at construction. An empty
 * {@link ARGV_VALUE_BEARING_FLAGS} would collapse it to `(^|\s)()(\s+|=)…`,
 * which masks EVERY whitespace-preceded `k=v` in any docker text — a
 * fail-OPEN that destroys the diagnostic wholesale, and the one failure mode
 * deriving from the Set introduced.
 */
export const ARGV_VALUE_TOKEN_RE = ((): RegExp => {
  const alternation = [...ARGV_VALUE_BEARING_FLAGS]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|');
  // BOTH ways the alternation can carry an empty branch. `length === 0` catches
  // an empty Set; a Set holding `''` ALONGSIDE real flags yields
  // `-e|--env|...|` -- non-empty, no throw, and that trailing empty
  // alternative makes `(^|\s)()(\s+|=)...` match any whitespace-preceded
  // `k=v` while `maskArgvFlagValue('', v)` fires on every empty argv element.
  // Unreachable today (the Set is a literal), so this is an assertion that
  // stays true as the Set grows.
  // `.trim() === ''` rather than `.has('')`: a whitespace-only entry escapes a
  // bare empty-string check and still reaches the alternation as a branch that
  // matches nothing useful while `maskArgvFlagValue` compares against it.
  if (alternation.length === 0 || [...ARGV_VALUE_BEARING_FLAGS].some((f) => f.trim() === '')) {
    throw new Error(
      'ARGV_VALUE_BEARING_FLAGS is empty or holds an empty flag: the token scan would match every k=v'
    );
  }
  return new RegExp(`(^|\\s)(${alternation})(\\s+|=)([^\\s=]*)=\\S*`, 'g');
})();

/**
 * Return a copy of `args` with the VALUE of every
 * {@link ARGV_VALUE_BEARING_FLAGS} pair replaced by `***`, and the credential
 * PARAMS of every {@link ARGV_PARAM_LIST_FLAGS} value replaced likewise. The
 * KEY survives — "which variable" is the diagnostic, "what it was set to" is
 * the disclosure.
 *
 * All FOUR argv spellings are handled: `--flag VALUE` (two tokens, what every
 * argv this repo builds emits), `--flag=VALUE`, and pflag's shorthand cluster
 * in both its forms — attached (`-itdeKEY=VALUE`) and separated
 * (`-itde KEY=VALUE`, where the cluster ends in the flag letter and pflag
 * takes the NEXT token). The last three are handled because a user's own
 * build script may spell them
 * ([#2623](https://github.com/go-to-k/cdkd/issues/2623)).
 * A value-less `-e KEY` (the form {@link partitionSensitiveEnv} emits for a
 * sensitive key) has nothing to mask and is returned unchanged. `args` is
 * never mutated: the redacted copy is for DISPLAY only, never for `spawn`.
 */
export function redactDockerArgvValues(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]!;
    // Joined `--flag=VALUE` first. `> 0` here (not `>= 0`) because a leading
    // `=` means the element is not a flag at all — a bare `=value` positional
    // has no flag to key on, and treating `''` as one would consult the sets
    // for the empty string.
    const joinedEq = cur.indexOf('=');
    if (joinedEq > 0) {
      const maskedJoined = maskArgvFlagValue(
        cur.substring(0, joinedEq),
        cur.substring(joinedEq + 1)
      );
      if (maskedJoined !== undefined) {
        out.push(`${cur.substring(0, joinedEq)}=${maskedJoined}`);
        continue;
      }
    }
    // Attached short-flag form (`-eKEY=VALUE`), tried AFTER the joined form so
    // an exact long-flag match always wins over a two-character prefix.
    const maskedAttached = maskAttachedShortFlag(cur);
    if (maskedAttached !== undefined) {
      out.push(maskedAttached);
      continue;
    }
    const next = args[i + 1];
    if (typeof next === 'string') {
      // `cur` may be a whole flag (`-e`, `--build-arg`) OR a shorthand CLUSTER
      // ending in one (`-itde`), which pflag feeds from the next token.
      const pairFlag = ARGV_VALUE_BEARING_FLAGS.has(cur)
        ? cur
        : (trailingShortFlagOfCluster(cur) ?? cur);
      const maskedNext = maskArgvFlagValue(pairFlag, next);
      if (maskedNext !== undefined) {
        out.push(cur, maskedNext);
        i++;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}
