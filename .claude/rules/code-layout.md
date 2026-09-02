---
description: Index of cdkd's directory layout - one row per area, pointing at the per-area detail file
paths:
  - 'src/**/*.ts'
---

# Key Files and Directories

Per-area detail lives in the satellite files below. Each one is loaded only when a file matching its `paths:` glob enters context, so touching one area no longer pays for every other area's notes.

| area | detail file | covers |
| --- | --- | --- |
| `src/cli/**` | [layout-cli.md](layout-cli.md) | CLI command tree, config + stack matching, `cdkd state`, events, gc, rollback |
| `src/cli/commands/{import,export}.ts`, `src/cli/yaml-cfn.ts` | [layout-cli-import-export.md](layout-cli-import-export.md) | `cdkd import` modes + upstream parity, `cdkd export`, CFn migration |
| `src/cli/commands/drift.ts`, `src/analyzer/drift-*.ts`, `src/utils/ip-protocol.ts` | [layout-drift.md](layout-drift.md) | `cdkd drift` and every normalizer it compares through |
| `src/deployment/**` | [layout-deployment.md](layout-deployment.md) | DeployEngine, WorkGraph, DAG executor, retry, rollback executor |
| `src/deployment/secret-redaction.ts` and siblings | [layout-deployment-secrets.md](layout-deployment-secrets.md) | dynamic-reference secret redaction, masking retry loggers, the mask-only channel |
| `src/cli/commands/scrub.ts` | [layout-scrub.md](layout-scrub.md) | `cdkd scrub` — the state secret-hygiene command |
| `src/provisioning/**` | [layout-provisioning.md](layout-provisioning.md) | provider registry, shared provider helpers, pre-flight rejection tables |
| `src/local/**` | [layout-local.md](layout-local.md) | `cdkd local invoke` / `start-api` / `run-task` / `start-service` |
| `src/utils/**` | [layout-utils.md](layout-utils.md) | logger, colors, `displaySafe`, shared helpers |
| `src/analyzer/**` | [layout-analyzer.md](layout-analyzer.md) | DAG builder, template parser, Outputs diff |
| `src/synthesis/**`, `src/state/**`, `src/assets/**`, `src/types/**` | [layout-misc.md](layout-misc.md) | synthesis, S3 state backend, asset publishing, type definitions |
| `scripts/**`, `docs/_generated/**` | [layout-scripts.md](layout-scripts.md) | coverage generators, their generated docs, CI critics |

Provider contract, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).
