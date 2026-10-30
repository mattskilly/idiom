---
title: Overview
description: Idiom is an open-source design QA tool for apps built with AI coding agents. It opens your running app in a real browser, checks every state against your design, and tells the agent how to fix what it finds.
---

# What Idiom is

Idiom is open-source design QA for apps your AI agent builds. It uses your app in a real browser, in every state, finds the problems a person would notice, and gives your agent a fix it can prove.

Coding agents write UI quickly, and nobody looks at every screen in every condition: the empty list, the failed request, the phone in dark mode, the button that does nothing. Idiom does that looking on every change, and remembers what you decided.

## Three jobs

- **Sees every state.** Each state you declare, at each viewport, light and dark, plus what happens between states when someone clicks.
- **Finds what people notice.** More than 60 measured checks and a comparison with your intended design, ranked severity first.
- **Proves the fix.** Each finding has a *Done when* condition. Idiom renders the state again and confirms it. The exit code is the verdict.

It runs in your terminal, inside your coding agent over MCP, on pull requests as a GitHub Action, and as a verify step in Autobuild. It works on any web app that runs at a URL, and on Electron apps.

Design skills tell your agent what good looks like before it builds. Idiom checks what actually rendered and proves each fix. They work well together.

## What it is not

- **Not a design generator.** Figma, Claude Design or v0 decide what should exist. Idiom checks that what shipped matches it.
- **Not a grader.** There is no single number to game. It reports what it found, what it measured and what it could not see.
- **Not a cloud service.** A local CLI with documented file formats. Your evidence stays in your repo.

## Where to start

- [Getting started](/docs/getting-started): install and run your first review in five minutes.
- [Design QA for Claude Code](/docs/design-qa-for-claude-code): the full check, fix and verify loop with an agent.
- [Commands](/docs/commands): every command and flag.
