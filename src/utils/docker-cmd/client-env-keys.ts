/**
 * The env vars the container CLIENT reads, and the malformed-key predicate.
 * Part of the `docker-cmd.ts` split (go-to-k/cdkd#5835); import from
 * `../docker-cmd.js`, not from here.
 */

/**
 * Env vars the container CLI itself reads to decide how / where to run — the
 * binary {@link getDockerCmd} resolves, i.e. `docker` or whatever `CDK_DOCKER`
 * names (podman / nerdctl / finch). A resolved ECS secret (or SecureString)
 * whose NAME collides with one of these must NOT override it in the client's
 * own process environment: a secret named `DOCKER_HOST` (or podman's
 * `CONTAINER_HOST`) would redirect the client to a different daemon, and `PATH`
 * would break locating the binary. See issues
 * https://github.com/go-to-k/cdkd/issues/2183 and
 * https://github.com/go-to-k/cdkd/issues/2188.
 *
 * RULE for additions: anything a supported container CLIENT (or a credential /
 * connection helper it execs) reads to decide WHAT CODE IT LOADS, WHAT IT
 * TRUSTS, or WHERE / HOW IT CONNECTS. The docker CLI's documented set is kept
 * whole, behaviour toggles included; beyond it, a var that only tunes
 * behaviour (a storage driver, a snapshotter, a temp dir, an experimental
 * toggle) is OUT, because dropping a colliding secret costs the user that
 * secret. The operator's OWN value is never touched — the spawn
 * env starts from `process.env` — so adding a key costs only a secret of that
 * name.
 */
export const DOCKER_CLIENT_ENV_KEYS: ReadonlySet<string> = new Set([
  // Process-level vars the client needs to run at all (incl. Windows HOME).
  // `PATHEXT` is here for the same code-execution reason as `PATH`: on Windows
  // Go's executable lookup reads it to choose which extension of an adjacent
  // helper (credential helper, `ssh`) to run, so a colliding secret can pick a
  // different program.
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Windows system vars that decide WHAT CODE the client and its helpers run
  // (#2190). `ComSpec` names the command interpreter, so it is the `PATH` /
  // `PATHEXT` reason applied to a batch-file credential helper. `SystemRoot`
  // (and its legacy alias `windir`) is what `%SystemRoot%\System32` resolves
  // to, which is where Winsock providers and other system DLLs load from, the
  // `LD_*` / `DYLD_*` class. `SystemDrive` is the root those registry paths
  // expand against. `PSModulePath` is where PowerShell autoloads modules
  // from, so it chooses code in a credential helper written as a PowerShell
  // script, the `PYTHONPATH` class, and `PSExecutionPolicyPreference` sets
  // which scripts that helper trusts to run. `TEMP` / `TMP` are deliberately absent:
  // they only choose where temporary files go, which the RULE above keeps
  // OUT, as it keeps `TMPDIR` out on POSIX.
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'PSMODULEPATH',
  'PSEXECUTIONPOLICYPREFERENCE',
  // Connection / transport (docs.docker.com/reference/cli/docker) — a colliding
  // secret here could redirect the client to a different daemon or downgrade TLS.
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'DOCKER_AUTH_CONFIG',
  // Execution / behavior.
  'DOCKER_DEFAULT_PLATFORM',
  'DOCKER_CUSTOM_HEADERS',
  'DOCKER_CONTENT_TRUST',
  'DOCKER_CONTENT_TRUST_SERVER',
  'DOCKER_HIDE_LEGACY_COMMANDS',
  'BUILDKIT_PROGRESS',
  // Loader — a colliding secret injects code into the client process (and the
  // credential / connection helpers it execs, which inherit its env). The docker
  // CLI here is dynamically linked, so the loader vars are live. The WHOLE `LD_*`
  // / `DYLD_*` family is caught by PREFIX in `isDockerClientEnvKey` rather than
  // enumerated here — an exact list of loader vars is always one release behind
  // (glibc `LD_*`, macOS `DYLD_ROOT_PATH` / `DYLD_IMAGE_SUFFIX` / ...); the
  // non-prefixed loader vars are named individually: `GLIBC_TUNABLES` (glibc
  // tuning) and `GCONV_PATH` (glibc loads gconv shared objects from it — a
  // code-load vector of the same class, ignored only for setuid binaries,
  // which the docker CLI is not).
  'GLIBC_TUNABLES',
  'GCONV_PATH',
  // `BASH_ENV` is sourced by bash in NON-interactive shells, so it bites when
  // a `docker-credential-*` helper is a shell-script wrapper (common for
  // `aws ecr get-login-password` wrappers). `ENV` is interactive-only and is
  // deliberately absent.
  'BASH_ENV',
  // bash imports `SHELLOPTS` at startup, even as `/bin/sh`, and `xtrace`
  // expands `PS4` before every command, so the pair runs a command
  // substitution in any helper written as a shell script (`docker-credential-
  // gcloud` is one) (#3599). Exported functions (`BASH_FUNC_<name>%%`) are
  // caught by PREFIX in `isDockerClientEnvKey`: one named after a command
  // the script calls replaces it. `BASHOPTS` is absent, because no shopt
  // option runs code by itself.
  'SHELLOPTS',
  'PS4',
  // Interpreter variables of a credential helper written in a scripting
  // language (#3599). The template chooses the image, so it chooses the
  // registry, and so which `credHelpers` entry docker execs. Exact names, not
  // `PYTHON` / `NODE_` / `RUBY` / `PERL` prefixes: those families carry
  // realistic secrets (`NODE_AUTH_TOKEN`, `RUBYGEMS_API_KEY`), and each
  // runtime's code-loading set is small and documented. Interactive-only vars
  // (`PYTHONSTARTUP`, `PYTHONINSPECT`) stay off, as `ENV` does: a helper's
  // stdin is docker's pipe, not a terminal.
  // Python: the module search path and prefixes it loads code from.
  // `PYTHONWARNINGS` imports the module a warning category names, and
  // `antigravity` then opens `BROWSER`, which runs a command even under `-S`.
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'PYTHONPYCACHEPREFIX',
  'PYTHONPLATLIBDIR',
  'PYTHONWARNINGS',
  'BROWSER',
  // CA bundles that Python's `requests` (gcloud keeps `trust_env` on) and
  // gcloud's bundled httplib2 read: WHAT IT TRUSTS. `SSLKEYLOGFILE` is where
  // urllib3 (gcloud's TLS context) and curl write the session keys, so the
  // TLS of gcloud's refresh-token exchange becomes decryptable: the
  // `AWS_ECR_CACHE_DIR` class.
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTPLIB2_CA_CERTS',
  'SSLKEYLOGFILE',
  // Where gcloud fetches the operator's credentials on GCE: the metadata-server
  // twin of `AWS_EC2_METADATA_SERVICE_ENDPOINT` below. The rest of gcloud's
  // env surface is the `CLOUDSDK_` prefix family.
  'GCE_METADATA_HOST',
  'GCE_METADATA_ROOT',
  'GCE_METADATA_IP',
  // Node: `NODE_OPTIONS` takes `--import=data:...`, which runs code with no file
  // on disk; the rest decide which code it loads (`NODE_COMPILE_CACHE` is
  // V8 code cache it loads unverified, the `PYTHONPYCACHEPREFIX` class) and
  // which CAs it trusts.
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // Ruby and Perl: `PERL5OPT=-d` plus `PERL5DB` runs code with no file on disk.
  // `GEM_PATH` / `GEM_HOME` are where RubyGems resolves a `require`, the
  // `NODE_PATH` class. `RUBYGEMS_GEMDEPS=-` makes older RubyGems evaluate a
  // `Gemfile` found by walking up from the cwd, which is the CDK app's.
  'RUBYOPT',
  'RUBYLIB',
  'GEM_PATH',
  'GEM_HOME',
  'RUBYGEMS_GEMDEPS',
  'PERL5OPT',
  'PERL5LIB',
  'PERLLIB',
  'PERL5DB',
  // OpenSSL 3 as linked by Python (and so gcloud) reads `OPENSSL_CONF` when
  // it builds a TLS context, and a config there can activate a provider
  // module, a shared object it dlopens: the `GCONV_PATH` class.
  // `OPENSSL_MODULES` / `OPENSSL_ENGINES` are the directories it loads those
  // from.
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES',
  // SSH — the `ssh://`-context connection helper's exec/trust-bearing vars,
  // enumerated EXACTLY rather than by an `SSH_` prefix (#2186 review round 3):
  // the client-side exec/trust set is CLOSED (last addition
  // `SSH_ASKPASS_REQUIRE`, OpenSSH 8.4, 2020), while an `SSH_` prefix breaks
  // realistic secrets — `SSH_PRIVATE_KEY` is GitLab CI's canonical deploy-key
  // spelling. `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` /
  // `SSH_ORIGINAL_COMMAND` are sshd-SET, never client-read, and stay off the
  // list. The attack also needs the operator to already be on ssh transport
  // (`DOCKER_HOST` / `DOCKER_CONTEXT` are exact-denylisted above), so unlike
  // `LD_PRELOAD` it is not self-bootstrapping.
  'SSH_AUTH_SOCK', // agent hijack
  'SSH_ASKPASS', // OpenSSH execs the named program
  'SSH_ASKPASS_REQUIRE',
  'SSH_SK_HELPER', // security-key helper — OpenSSH execs it
  'SSH_SK_PROVIDER', // FIDO provider LIBRARY path — OpenSSH dlopens it (Codex review)
  'SSH_PKCS11_HELPER', // PKCS#11 helper — OpenSSH execs it
  'SSH_AGENT_PID', // not load-bearing, kept for completeness of the closed set
  // Credential-helper reach (#2186 review rounds 3-4): `docker run` on a
  // missing image pulls, the pull auths, and the auth execs
  // `docker-credential-ecr-login` — whose AWS SDK reads these to decide WHERE
  // to send a request signed with the OPERATOR's real credentials
  // (`dockerSpawnEnvWithSensitive` starts from `{ ...process.env }`, so those
  // credentials are in the client's env unless a same-named container secret —
  // they are in `SENSITIVE_ENV_KEYS` — overrides them). A secret named
  // `AWS_ENDPOINT_URL` would make the helper sign with them and send the
  // result to an attacker-chosen host — the `DOCKER_HOST` class, one helper
  // over. The file/profile vars repoint which credentials it loads;
  // `AWS_ROLE_ARN` is `AWS_WEB_IDENTITY_TOKEN_FILE`'s mandatory partner (an
  // attacker-set role ARN plus the operator's own token file assumes a
  // different identity), and `AWS_EC2_METADATA_SERVICE_ENDPOINT` redirects the
  // IMDS credential source. The per-service `AWS_ENDPOINT_URL_<SERVICE>` forms
  // (aws-sdk-go-v2 honours them) are caught by PREFIX in
  // `isDockerClientEnvKey`, since an exact list per service cannot keep up.
  'AWS_ENDPOINT_URL',
  'AWS_CA_BUNDLE',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_ROLE_ARN',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  // `docker-credential-ecr-login` WRITES the ECR auth token it mints with the
  // operator's credentials into this directory (and reads a cached one back),
  // so a colliding secret chooses where that token lands (#2188).
  'AWS_ECR_CACHE_DIR',
  // podman / containers tooling (#2188; podman(1) "Environment Variables",
  // containers.conf(5), containers/common `pkg/auth`). Connection:
  // `CONTAINER_HOST` is podman's `DOCKER_HOST` (it also switches the client to
  // remote mode), `CONTAINER_CONNECTION` picks a named remote from
  // `PODMAN_CONNECTIONS_CONF`, `CONTAINER_SSHKEY` is the ssh identity for it.
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
  'CONTAINER_SSHKEY',
  'PODMAN_CONNECTIONS_CONF',
  // `CONTAINER_PROXY` routes podman-remote's API traffic (registry auth
  // headers included) through a proxy — the `HTTP_PROXY` class.
  // `CONTAINERS_SSH_CONF` becomes `ssh -F <file>` for native-ssh remotes, and
  // an ssh config's `ProxyCommand` / `LocalCommand` executes code.
  'CONTAINER_PROXY',
  'CONTAINERS_SSH_CONF',
  // Config files that name executables (`conmon_path`, `runtime`,
  // `helper_binaries_dir`, `hooks_dir`, storage `mount_program`) or registry
  // routing (mirrors, insecure registries): `CONTAINERS_CONF` REPLACES the
  // whole config hierarchy and `CONTAINERS_CONF_OVERRIDE` is loaded last on
  // top of it; the shared config-file loader reads the same `<NAME>_OVERRIDE`
  // for registries.conf and storage.conf, so each override is listed beside
  // its base name. `REGISTRIES_CONFIG_PATH` is the legacy spelling of
  // `CONTAINERS_REGISTRIES_CONF`. `CONTAINERS_POLICY_JSON` picks the
  // signature-verification policy (WHAT IT TRUSTS; that loader reads no
  // override for it). `STORAGE_OPTS` takes the same options as
  // storage.conf, `overlay.mount_program` (an executable) included.
  // `CONTAINERS_HELPER_BINARY_DIR` is searched FIRST for conmon / netavark /
  // pasta and the other helper binaries.
  'CONTAINERS_CONF',
  'CONTAINERS_CONF_OVERRIDE',
  'CONTAINERS_REGISTRIES_CONF',
  'CONTAINERS_REGISTRIES_CONF_OVERRIDE',
  'REGISTRIES_CONFIG_PATH',
  'CONTAINERS_STORAGE_CONF',
  'CONTAINERS_STORAGE_CONF_OVERRIDE',
  'CONTAINERS_POLICY_JSON',
  'STORAGE_OPTS',
  'CONTAINERS_HELPER_BINARY_DIR',
  // Which registry credentials are sent (and which `credHelpers` entry is
  // exec'd): podman reads this before `DOCKER_CONFIG`.
  'REGISTRY_AUTH_FILE',
  // Rootless podman connects to the session bus to place the container in a
  // systemd scope, and passes the host's `NOTIFY_SOCKET` on so conmon writes
  // the container's sd_notify datagrams to that path.
  'DBUS_SESSION_BUS_ADDRESS',
  'NOTIFY_SOCKET',
  // Base directories BOTH podman and nerdctl derive the above from when the
  // specific var is unset: rootless config files (containers.conf,
  // registries.conf, storage.conf, nerdctl.toml, CNI net.d) under
  // `XDG_CONFIG_HOME`, and the rootless auth file, podman API socket
  // and nerdctl RootlessKit state dir under `XDG_RUNTIME_DIR`. `APPDATA` /
  // `PROGRAMDATA` are where containers/common reads the user / system
  // containers.conf on Windows, `PROGRAMFILES` is where nerdctl on Windows
  // looks for the CNI plugin binaries it execs, and `LOCALAPPDATA` is finch's
  // root directory on Windows (its `finch.yaml` configures the credential
  // helpers).
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'LOCALAPPDATA',
  // finch on macOS / Windows runs `limactl shell finch sudo -E nerdctl ...`
  // with the client's environment, and Lima splits `SSH` into shell words
  // and EXECS the result in place of `ssh` — code execution with no ssh
  // transport configured first, unlike the `SSH_*` entries above.
  'SSH',
  // nerdctl / containerd (#2188; nerdctl docs/config.md). `CONTAINERD_ADDRESS`
  // is nerdctl's `DOCKER_HOST`; `CONTAINERD_NAMESPACE` decides whose containers
  // and images it acts on; `NERDCTL_TOML` repoints the whole config
  // (address, namespace, CNI paths); nerdctl EXECS the CNI plugins found under
  // `CNI_PATH` (as root when rootful), which the net.d configs under
  // `NETCONFPATH` name. `ROOTLESSKIT_STATE_DIR` is where rootless nerdctl reads
  // the `child_pid` it `nsenter`s into. `NERDCTL_LOG_FILE` makes nerdctl
  // APPEND its log to the named path, as root when rootful.
  'CONTAINERD_ADDRESS',
  'CONTAINERD_NAMESPACE',
  'NERDCTL_TOML',
  'CNI_PATH',
  'NETCONFPATH',
  'ROOTLESSKIT_STATE_DIR',
  'NERDCTL_LOG_FILE',
  // Trust — a colliding secret repoints the client's trusted CA bundle for the
  // daemon / registry TLS handshake (Go's x509 honours these on Linux) or tunes
  // the Go runtime.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GODEBUG',
  // Proxy vars the client honors for registry connections — a colliding secret
  // could route the client's traffic (incl. image pulls) through an attacker.
  // Only the upper-case spellings are listed: matching is case-insensitive
  // (`DOCKER_CLIENT_ENV_KEYS_UPPER`), so lower-case duplicates were unreachable.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
  'ALL_PROXY',
]);

const DOCKER_CLIENT_ENV_KEYS_UPPER: ReadonlySet<string> = new Set(
  [...DOCKER_CLIENT_ENV_KEYS].map((k) => k.toUpperCase())
);

/**
 * Env-var prefixes whose WHOLE family the docker client (or a helper it execs)
 * reads, so a NAMED list is always one release behind and a colliding secret in
 * ANY member is a hazard. `LD_*` / `DYLD_*` are the dynamic loader (code
 * injection, glibc + macOS); `AWS_ENDPOINT_URL_*` is the per-service endpoint
 * family aws-sdk-go-v2 (and so `docker-credential-ecr-login`) honours — a
 * secret named `AWS_ENDPOINT_URL_ECR` walks around the exact
 * `AWS_ENDPOINT_URL` entry and redirects a request signed with the operator's
 * real credentials (#2186 round 4). `CLOUDSDK_` is gcloud's (#3599): every
 * gcloud property is settable as `CLOUDSDK_<SECTION>_<NAME>`, which covers
 * its token host, API endpoint overrides, proxy, CA bundle and account, and
 * the `docker-credential-gcloud` wrapper execs `$CLOUDSDK_PYTHON
 * $CLOUDSDK_PYTHON_ARGS`. `BASH_FUNC_` is bash's exported-function family.
 * No plausible secret name collides with these, apart from the one listed in
 * {@link DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS}. Matched by prefix rather than
 * enumerated (issue #2183 review). `SSH_` was a prefix here and was demoted to
 * an EXACT enumeration in {@link DOCKER_CLIENT_ENV_KEYS} (#2186 review round
 * 3): the family is not
 * uniformly dangerous and is not growing, while the prefix broke realistic,
 * currently-working secrets (`SSH_PRIVATE_KEY`, GitLab CI's canonical
 * deploy-key spelling). Exported so the test fence can assert the EXACT
 * contents — a hardcoded copy in the test made the anti-shadowing fence
 * one-directional (#2186 round 4 finding 2).
 */
export const DOCKER_CLIENT_ENV_PREFIXES: readonly string[] = [
  'LD_',
  'DYLD_',
  'AWS_ENDPOINT_URL_',
  'CLOUDSDK_',
  'BASH_FUNC_',
];

/**
 * Exact names inside a {@link DOCKER_CLIENT_ENV_PREFIXES} family that are still
 * delivered. An entry must be a realistic secret name AND harmless to the
 * helper that reads it. `CLOUDSDK_AUTH_ACCESS_TOKEN` is gcloud's own variable
 * for a caller-supplied access token (#3599). Given to `docker-credential-gcloud`,
 * it only changes which token gcloud hands docker, with no network call of its
 * own. gcloud's `auth docker-helper` answers only for a registry in its own
 * supported list unless `artifacts/allow_unrecognized_registry` is set, and
 * that property, the token host, the universe domain and every other variable
 * that could redirect or weaken the exchange stay refused by the `CLOUDSDK_`
 * prefix. Stored upper-case and matched case-insensitively. Never exempt an
 * exact {@link DOCKER_CLIENT_ENV_KEYS} member: the exact list wins.
 */
export const DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS: ReadonlySet<string> = new Set([
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
]);

/**
 * Is `key` the name of a var the docker client reads? Case-INSENSITIVE, because
 * Windows environment lookups are, so a lowercase `docker_host` must be caught
 * too (issue #2183). Matches the exact denylist OR a prefixed family — the
 * prefix families are fail-closed on the whole prefix, so an unlisted `LD_*` /
 * `DYLD_*` / `AWS_ENDPOINT_URL_*` / `CLOUDSDK_*` / `BASH_FUNC_*` secret is
 * dropped (with a rename warning) rather than reaching the client, except for
 * a name in {@link DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS}.
 */
export function isDockerClientEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DOCKER_CLIENT_ENV_KEYS_UPPER.has(upper)) return true;
  if (DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS.has(upper)) return false;
  return DOCKER_CLIENT_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * A well-formed `docker run -e` variable NAME: non-empty, and containing
 * neither `=` (the OS parses the environ entry's name as everything before the
 * first one) nor NUL (Node refuses to spawn). A newline IS accepted, because it
 * is inside the class — not because of the anchor: JS `$` without the `m` flag
 * matches only at end of input (`/^abc$/.test('abc\n') === false`). That
 * matches the clause list this replaced, i.e. deliberately not stricter.
 */
const WELL_FORMED_ENV_KEY = /^[^=\0]+$/;

/**
 * Is `key` a shape that cannot be a well-formed `docker run -e` variable NAME?
 * Defined POSITIVELY as {@link WELL_FORMED_ENV_KEY}'s complement (#2186 rounds
 * 5-6). Enumerating the bad spellings one at a time closed `=` in round 4 and
 * left the empty key (`-e ''` — docker rejects it with an opaque error naming
 * no secret) and a NUL-bearing key still open; the complement closes any
 * further bad shape without another clause. A sensitive key matching this
 * takes the same fail-closed
 * collision path as a docker-client-var name: no `-e` flag, no spawn-env entry,
 * reported in `collisions`. (This is the NAME only; a secret VALUE containing a
 * NUL is a separate pre-existing leak tracked in issue #2189.)
 */
export function isMalformedEnvKey(key: string): boolean {
  return !WELL_FORMED_ENV_KEY.test(key);
}
