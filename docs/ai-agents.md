---
title: Use with AI Coding Agents
description: "Install the cdkd skill so AI coding agents such as Claude Code, Codex and Cursor deploy dev and test CDK stacks with cdkd safely."
---

# Use with AI Coding Agents

An AI coding agent deploys, checks the result, and tears the stack down many
times in one session. cdkd keeps each of those turns short, with fast deploys
and an equally fast `cdkd destroy`.

The cdkd repository ships a
[`cdkd` skill](https://github.com/go-to-k/cdkd/blob/main/plugins/cdkd-skills/skills/cdkd/SKILL.md)
that teaches an agent to use cdkd safely. It covers installing cdkd, checking
AWS credentials before acting, previewing and deploying, choosing a wait
mode, verifying the result, the boundary with CloudFormation-managed stacks,
and confirming before destructive operations.

| Your agent | Install with |
| --- | --- |
| Claude Code | The plugin marketplace |
| Codex, Cursor, or any agent that reads `SKILL.md` | `gh skill` or `npx skills` |

## Claude Code

Run these inside a Claude Code session. This is a one-time setup, and the
skill is then available in every session:

```text
/plugin marketplace add go-to-k/cdkd
/plugin install cdkd-skills@cdkd
```

Then ask Claude to deploy a dev or test CDK stack with cdkd. The skill
triggers on its own. You can also invoke it directly with `/cdkd`.

## Other agents (Codex, Cursor, and more)

Install the skill with the
[GitHub CLI](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)
(v2.90 or later) or
[`npx skills`](https://github.com/vercel-labs/agent-skills):

```bash
gh skill install go-to-k/cdkd cdkd
# or
npx skills add go-to-k/cdkd --skill cdkd
```

## Let an agent read these docs

Agents can read this documentation as Markdown:

- The site publishes an `llms.txt` index, so an agent can find every page
  from one entry point.
- Every page has a raw-Markdown version, advertised by a
  `<link rel="alternate" type="text/markdown">` tag in the page head. An
  agent can fetch the exact source of the page it is reading.

## Contributors

To test a cdkd checkout against another CDK project, add the cloned
repository to a Claude Code session:

```bash
claude --add-dir /path/to/cdkd
```

The project-scoped
[`/use-cdkd`](https://github.com/go-to-k/cdkd/blob/main/.claude/skills/use-cdkd/SKILL.md)
skill then covers building and linking the checkout.
