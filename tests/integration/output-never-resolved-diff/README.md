# output-never-resolved-diff

Integration test for issue
[#2740](https://github.com/go-to-k/cdkd/issues/2740): an Output whose
resolution fails INSIDE a secret lookup on every deploy — a JSON key the
secret does not hold — is skipped by the deploy (default, non-`--strict-getatt`
arm) and never lands in `state.outputs`. `cdkd diff` resolves outputs with
`skipDynamicReferences`, so the same reference assembles into its token there
instead of failing, and before the fix `cdkd diff --fail` reported an `ADD`
the deploy would never perform, on every run of the unchanged stack.

The fix records what the deploy skipped (`StackState.skippedOutputs`, the key
mapped to a digest of the template inputs its resolution reads) and lets the
diff preview a still-absent key with an unchanged digest as absent — exactly
what the next deploy will leave in state.

## Stack

`CdkdOutputNeverResolvedDiffExample`:

- One SecretsManager secret with a **known JSON value** holding `username`
  only.
- `NeverResolves` — `{{resolve:secretsmanager:<secret>:SecretString:password}}`
  (the key does not exist). Under `CDKD_TEST_UPDATE=true` it is repaired to the
  `username` key.
- `Resolves` — the `username` key (a sibling that resolves).
- `RefMarker` — an SSM parameter whose value flips under
  `CDKD_TEST_RESOURCE_EDIT=true`. It exists so that a skipped output can
  REFERENCE a resource the diff reports as changing.
- `NeverResolvesViaRef` — the same missing key, reached through an `Fn::Sub`
  that also names `RefMarker`. It repairs under `CDKD_TEST_UPDATE=true`, and
  alone under `CDKD_TEST_PARTIAL_REPAIR=true`.
- `Plain` — a literal.
- `Plain2` — a literal declared only under `CDKD_TEST_ADD_OUTPUT=true`: the
  output [#2771](https://github.com/go-to-k/cdkd/issues/2771) is about, added
  beside the two that keep failing. Every later phase carries the toggle, so it
  is never removed before destroy.

## What `verify.sh` asserts

1. **Deploy** warns `Failed to resolve output <key>:` for both skipped
   outputs; state lacks both keys, holds the sibling as its expression, and
   carries `skippedOutputs` (64-hex digests) for those two keys and no
   others.
2. **`cdkd diff --fail` on the unchanged stack exits 0** with no
   `NeverResolves` row and no "could not be resolved" warning — the fix. Pre-fix
   this exits 1 with `[+] NeverResolves`. Then, with the `Plain` sibling
   changed (`CDKD_TEST_SIBLING=true`), `diff --fail` exits 1 and renders the
   sibling's row while `NeverResolves` still has none — the record previews the
   key as absent and does not suppress the section.
2c. **A referenced resource changes** (`CDKD_TEST_RESOURCE_EDIT=true` moves
   only `RefMarker`'s value): `diff --fail` exits 1, the resource's own row is
   the premise, `NeverResolvesViaRef` renders its row because the change map
   un-binds its record, and `NeverResolves` renders none — the un-bind is per
   output. A premise check compares the two synths and requires the edit to
   have moved nothing the digest reads, so the row cannot come from a changed
   digest. Without this phase a `referencedLogicalIds` that returns nothing
   at all passes the whole fixture.
3. A **no-change re-deploy** neither churns the record nor re-saves state
   (`lastModified` unchanged).
4. **Upgrade path**: the field is stripped from `state.json` out of band (a
   record written before the field existed) and a no-change deploy writes it
   back with the same digest; `diff --fail` exits 0 again.
4b. **An output added beside the broken ones lands**
   ([#2771](https://github.com/go-to-k/cdkd/issues/2771),
   `CDKD_TEST_ADD_OUTPUT=true`): `diff --fail` first exits 1 with the one
   `[+] Plain2` row; the no-change deploy still fails both broken outputs,
   does not keep the previous outputs bag whole, persists `Plain2`, and leaves
   the record unmoved; `diff --fail` then exits 0. Before the fix it stayed at
   exit 1 on every run.
4c. **A partial repair publishes** (`CDKD_TEST_PARTIAL_REPAIR=true` repairs
   `NeverResolvesViaRef` alone): the repaired key lands with its expected
   value while `NeverResolves` still fails, the record narrows to
   `NeverResolves`, and `diff --fail` exits 0.
5. **Repair** (`CDKD_TEST_UPDATE=true`, with the 4b / 4c toggles carried
   forward, repairs `NeverResolves` too): `diff --fail` exits 1 and renders
   its one ADD row (the record must not suppress a repaired output); the
   deploy publishes it as its expression and empties the record, keeping
   `Plain2`; `diff --fail` exits 0.
6. **Destroy**, then the secret is gone or scheduled for deletion, the state
   file is gone, and every state-object version is swept.

Nothing prints a resolved secret value: the deploy and diff outputs are
checked for the known `username` plaintext and failure diagnostics withhold
any text carrying it.

## Run

```bash
/run-integ output-never-resolved-diff
```
