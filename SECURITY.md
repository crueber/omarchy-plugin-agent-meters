# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability) instead of a public issue. Include the
plugin version, your Omarchy version, what you observed, and the smallest
reproduction you can. You should get an acknowledgement within a few days.

## Trust model

Omarchy shell plugins run as unsandboxed code inside the long-lived
`omarchy-shell` process. Install Agent Meters from this repository or the
Omarchy marketplace, and review changes like any other shell plugin.

## What this plugin reads

- `OPENROUTER_API_KEY`, the OpenCode credential file (`auth.json`), or the
  output of `opencode auth export`.
- OpenCode's local API through the `opencode` CLI.
- `~/.grok` billing logs and per-turn session ledgers, and the Grok Bot app's
  small cached JSON blob. `~/.grok/auth.json` is never opened.
- Omarchy's display-ready agent records under
  `~/.local/state/omarchy/agents/usage/`, and the output of
  `omarchy-agent-usage-claude` / `omarchy-agent-usage-codex`.

No prompt text, response text, session content, or account identity is read
into the widget's cache or displayed.

## Network access

This plugin makes exactly two kinds of request of its own:

- `GET https://openrouter.ai/api/v1/key`
- `GET https://openrouter.ai/api/v1/credits` (optional)

Both use the key only in an HTTPS `Authorization` header. Claude's OAuth usage
probe and Codex's app-server RPC are made by Omarchy's own collectors, with
their caching and rate-limit handling; the plugin only runs those commands.

There is no telemetry and no analytics.

## Secrets

- Keys are never printed, cached in the widget's cache, written to
  `shell.json`, or passed on a command line.
- The OpenRouter key is re-read at request time and dropped after the request.
- The cache at `~/.cache/agent-meters/usage.json` contains displayed numbers,
  reset times, the masked OpenRouter key label, and the OpenRouter cycle
  baseline. It is created in a mode-`0700` directory.

## Text and inputs

All strings that come from a file or a network response are neutralised before
display, percentages are clamped to 0–100, collection sizes are bounded, and
HTTP responses are size- and time-limited. Plugin settings are read through
Omarchy's widget API and never interpolated into a shell command without
quoting.

## Preview images

`preview.png` and `screenshots/bar.png` are composed offline from invented
data. No real key, account, workspace, spend, credit or usage figure appears in
them. The repository ships no demo or screenshot-capture script, so there is no
code path that copies live caches or settings into a temporary directory.

## Supported versions

Fixes land on `main` and in the latest release. The marketplace version is the
supported one; older checkouts should be updated with
`omarchy plugin update crueber.agent-meters`.
