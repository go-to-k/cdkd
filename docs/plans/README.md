# cdkd PR Roadmap

This directory holds deferred / future implementation plans. Each file is a
self-contained plan for one PR.

The 2025 Region & State refactor (PRs 1–7) shipped and the plan files were
removed; see `git log -- docs/plans/` for the historical plans, and
[../changelog-cdkd.md](../changelog-cdkd.md) for the per-PR landing record
(default bucket name flip, region-prefixed state keys, dynamic region
resolution, `--region` flag cleanup, `cdkd state destroy`, etc.).

## Open plans

| #  | Title                                              | Status                                                                            | Plan                            |
| -- | -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| 99 | Backwards-compat removal + final migration command | ⏳ deferred until `cdkd state migrate` has been in production use for 1–2 releases | [99](./99-future-bc-removal.md) |
