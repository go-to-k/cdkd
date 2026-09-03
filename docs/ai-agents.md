---
title: Use with AI Coding Agents
description: Install the cdkd skill so AI coding agents — Claude Code, Codex, Cursor, and more — deploy dev/test CDK stacks with cdkd safely.
---

# Use with AI Coding Agents

cdkd is a natural fit for AI-driven development: agents iterate in tight spin-up / tear-down loops, and cdkd keeps each turn short with fast deploys and an equally fast `cdkd destroy`.

The cdkd repository ships a [`cdkd` skill](https://github.com/go-to-k/cdkd/blob/main/plugins/cdkd-skills/skills/cdkd/SKILL.md)
that teaches AI coding agents to use cdkd safely: install, AWS preflight
checks, preview and deployment, wait modes, verification, CloudFormation
migration boundaries, and destructive-operation safety.

## Claude Code

Install it as a plugin (one-time setup, available in every session) by
running these inside a Claude Code session:

```text
/plugin marketplace add go-to-k/cdkd
/plugin install cdkd-skills@cdkd
```

Then ask Claude to deploy a dev/test CDK stack with cdkd — the skill
triggers automatically — or invoke it directly with `/cdkd`.

## Other agents (Codex, Cursor, and more)

Any agent that supports the SKILL.md format can use the skill. Install it
with the [GitHub CLI](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)
(v2.90+) or [`npx skills`](https://github.com/vercel-labs/agent-skills):

```bash
gh skill install go-to-k/cdkd cdkd
# or
npx skills add go-to-k/cdkd --skill cdkd
```

## Contributors

To test the current checkout against another CDK project, clone the
repository and add it to a Claude Code session — the project-scoped
[`/use-cdkd`](https://github.com/go-to-k/cdkd/blob/main/.claude/skills/use-cdkd/SKILL.md)
skill covers building and linking the checkout:

```bash
claude --add-dir /path/to/cdkd
```

## This documentation site is AI-friendly too

Agents can consume these docs directly as Markdown:

- Every page on this site has a raw-Markdown companion, advertised via a
  `<link rel="alternate" type="text/markdown">` tag in the page head — an
  agent can fetch the exact source of the page it is reading.
- The site publishes an `llms.txt` index, so an agent can discover every
  page from a single well-known entry point.
