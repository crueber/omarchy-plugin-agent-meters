# Agent Meters

One Omarchy bar widget for every AI agent this machine actually uses.
OpenRouter, OpenCode, Grok, Codex and Claude each keep their own mark and their
own limit meters; an agent you have no plan, key or usage for simply stays out
of the bar. That is also the default bar order.

![Agent Meters in the bar and its panel](preview.png)

## What it shows

| Agent | Bar | Window rows |
| --- | --- | --- |
| **OpenRouter** | OpenRouter mark + meter, or dollars | This cycle's spend against the key's own limit, credits, reset |
| **OpenCode** | OpenCode mark + three bars | 5-hour session, weekly, monthly; Console budgets in the panel |
| **Grok** | Grok mark + weekly meter | Weekly and, when the desktop app caches one, Grok Bot's separate weekly allowance |
| **Codex** | Codex mark + session/weekly meters | Session and weekly limits, Code review, model-scoped allowances and a Business seat's spend cap when the app-server reports them |
| **Claude** | Anthropic asterisk + up to three bars | Session (5-hour), Weekly (7-day), Fable weekly |

The Claude rows come from Anthropic's own usage endpoint through Omarchy's
agent collector, so the **Fable weekly** allowance — the model-scoped window
that only Fable draws from — is the third bar, not a separate agent.

## Automatic selection

The collector runs once, on the widget's timer, and reports every provider it
can see. The bar then filters that list:

- **Claude** — appears when Claude Code has a plan or limits on this machine.
  An expired sign-in still appears, with *Sign-in expired* in the panel and a
  link-free hint to run `claude auth login`.
- **Grok** — appears when Grok's local snapshot has a weekly reading.
- **Codex** — appears when Codex CLI is signed in to a plan with rate limits.
  An API-key sign-in has no plan limits and stays out of the bar.
- **OpenCode** — appears when the installed OpenCode answers with a Go
  allowance.
- **OpenRouter** — appears when a key is found. Keys are read from
  `OPENROUTER_API_KEY`, the OpenCode `auth.json`, or OpenCode 2's
  `opencode auth export`; never from the widget's own cache.

Each agent has a switch in its panel row. It defaults to on; flip it off and
that agent stays in the panel (so you can read it or turn it back on) but
leaves the bar. The switch writes the same `showClaude`/`showGrok`/
`showOpencode`/`showOpenrouter` settings the widget exposes, so the two stay in
step. In the panel, drag a row by its grip handle to reorder it; the same order
is used for the icons in the bar and is saved with the widget. Dropping on the
last row's lower half moves the agent to the end.

## Install

From the Omarchy plugin marketplace (once listed):

```bash
omarchy plugin add https://github.com/crueber/omarchy-plugin-agent-meters.git --enable
```

From a checkout:

```bash
git clone https://github.com/crueber/omarchy-plugin-agent-meters.git
cd omarchy-plugin-agent-meters
./scripts/install.sh
```

The installer copies the runtime files to
`~/.config/omarchy/plugins/crueber.agent-meters/`, validates the manifest, and
enables the widget in the right bar section.

To remove:

```bash
omarchy plugin disable crueber.agent-meters
omarchy plugin remove crueber.agent-meters --yes
rm -rf ~/.cache/agent-meters
```

## Requirements

- Omarchy Quattro with the Omarchy shell bar
- Node.js for the collector
- At least one of:
  - Claude Code signed in (`omarchy agent account list claude` shows it)
  - Codex CLI signed in to a plan (`codex login`)
  - Grok used once, so `~/.grok/logs/unified.jsonl` exists
  - OpenCode signed in with a Go plan
  - An OpenRouter key in `OPENROUTER_API_KEY` or OpenCode

Claude and Codex readings use `omarchy-agent-usage-claude` and
`omarchy-agent-usage-codex`, the same collectors the built-in Agents panel
uses; they own the OAuth refresh, caching, account selection and Codex's
app-server RPC. If a command is unavailable, the widget falls back to the last
record in `~/.local/state/omarchy/agents/usage/`.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `barStyle` | `bars` | `bars`, `text` (highest percentage) or `icon` |
| `showClaude` / `showCodex` / `showGrok` / `showOpencode` / `showOpenrouter` | `true` | Show that agent in the bar; the panel switch flips the same keys |
| `providerOrder` | `""` | Saved by the panel's drag-and-drop order; comma-separated agent ids. Empty uses OpenRouter, OpenCode, Grok, Codex, Claude |
| `refreshIntervalSec` | `300` | How often to collect (60–3600) |
| `warnPercent` | `70` | Warning colour threshold |
| `criticalPercent` | `90` | Urgent colour threshold |
| `warningColor` | `#f67400` | Empty keeps the theme foreground |
| `criticalColor` | `""` | Empty uses the theme urgent colour |
| `nodeCommand` | `""` | Optional path to `node` |
| `authFile` | `""` | Optional OpenCode 1 auth file for the OpenRouter key |
| `grokHome` | `""` | Optional Grok home (`~/.grok`) |
| `botHome` | `""` | Optional Grok Bot cache directory |
| `opencodeCommand` | `""` | Optional path to `opencode` |
| `codexCommand` | `""` | Optional path to `omarchy-agent-usage-codex` |
| `showActivity` | `true` | Today's prompts/tokens per agent in the panel |
| `onRightClick` | `""` | Optional shell command |

## Privacy and safety

- API keys are read at request time and used only in an HTTPS `Authorization`
  header. They are never put in the cache, the settings, a command line or an
  error message.
- The cache at `~/.cache/agent-meters/usage.json` holds only displayed
  numbers, masked labels and the OpenRouter cycle baseline.
- Local reads: `~/.grok`, `~/.local/state/omarchy/agents/usage`, OpenCode's
  local API, and OpenCode's credential export. Network reads: OpenRouter's
  `/api/v1/key` and `/api/v1/credits`. Claude's OAuth probe and Codex's
  app-server RPC run inside Omarchy's own collectors.
- All downloaded and file-provided text is neutralised before display, and
  the meters bound every percentage to 0–100.

## Licence

MIT
