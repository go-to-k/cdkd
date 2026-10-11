---
title: Use with AI Coding Agents
description: "Install the cdkd skill so AI coding agents such as Claude Code, Codex and Cursor deploy dev and test CDK stacks with cdkd safely."
---

# Use with AI Coding Agents

An AI coding agent such as Claude Code, Codex or Cursor can deploy your dev
and test stacks with cdkd. To make it do so safely, install the cdkd skill: a
set of instructions the agent loads when a task involves cdkd.

cdkd suits this work because an agent deploys, checks the result, and tears
the stack down many times in one session. Fast deploys and an equally fast
`cdkd destroy` keep each of those turns short.

## What the skill teaches the agent

The
[`cdkd` skill](https://github.com/go-to-k/cdkd/blob/main/plugins/cdkd-skills/skills/cdkd/SKILL.md)
ships in the cdkd repository. It tells the agent how to:

- install cdkd,
- check AWS credentials before acting,
- preview a deploy and then run it,
- choose a wait mode,
- verify the result,
- avoid deploying over a stack that CloudFormation manages,
- confirm with you before a destructive operation.

How you install the skill depends on the agent.

## Claude Code

Run these two commands inside a Claude Code session:

```text
/plugin marketplace add go-to-k/cdkd
/plugin install cdkd-skills@cdkd
```

This is a one-time setup, and the skill is then available in every session.
Ask Claude to deploy a dev or test CDK stack with cdkd, and the skill loads on
its own. You can also invoke it directly with `/cdkd`.

## Other agents (Codex, Cursor, and more)

Any agent that reads `SKILL.md` files can use the skill. Install it with the
[GitHub CLI](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)
(v2.90 or later) or with
[`npx skills`](https://github.com/vercel-labs/agent-skills):

```bash
gh skill install go-to-k/cdkd cdkd
# or
npx skills add go-to-k/cdkd --skill cdkd
```

## Let an agent read these docs

An agent can read this documentation as Markdown, in two ways:

- The site publishes an `llms.txt` index, which lists every page. An agent
  can start there and find the page it needs.
- Every page has a raw-Markdown version. The page head advertises it with a
  `<link rel="alternate" type="text/markdown">` tag, so an agent can fetch the
  exact source of the page it is reading.

## Testing a cdkd checkout with Claude Code

This section is for people who work on cdkd itself. To test a cdkd checkout
against another CDK project, add the cloned repository to a Claude Code
session:

```bash
claude --add-dir /path/to/cdkd
```

The repository's
[`/use-cdkd`](https://github.com/go-to-k/cdkd/blob/main/.claude/skills/use-cdkd/SKILL.md)
skill then covers building and linking the checkout.
