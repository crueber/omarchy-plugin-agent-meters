# Changelog

## 1.1.0 — 2026-11-15

- Codex support: session and weekly limits, code-review windows, model-scoped
  allowances and a Business seat's spend cap, read through Omarchy's Codex
  app-server collector.
- Default bar order is now OpenRouter, OpenCode, Grok, Codex, Claude.
- Per-agent switches in the panel hide an agent from the bar while keeping its
  row and limits readable.
- Drag a row by its grip to reorder the bar; the order is saved with the
  widget.
- Agent marks stay in the theme foreground; meters and percentages keep their
  warning and critical colours.

## 1.0.0 — 2026-11-15

- One bar widget for every AI agent in use: Claude, Grok, OpenCode and
  OpenRouter, each with its own mark and limit meters.
- Automatic selection: an agent appears only when it has a plan, a key or
  usage; per-agent toggles can hide it anyway.
- Claude support with the session (5-hour), weekly (7-day) and Fable weekly
  allowance, read through Omarchy's Claude collector.
- Unified panel with per-agent windows, reset clocks, local activity,
  OpenRouter credits and cycle comparison, and OpenCode Console budgets.
- Provider reads are isolated: one failing endpoint keeps the last good
  numbers and reports its error without blanking the other agents.
- Keys are never cached, logged or passed on a command line.
