# Changelog

## 1.2.0 — 2026-11-19

- **OpenRouter account-wide with a management key.** Store a key from
  openrouter.ai/settings/management-keys with
  `scripts/set-management-key.sh` (or export `OPENROUTER_MANAGEMENT_KEY`) and
  OpenRouter covers every key on the account:
  - the bar shows the credits left (`$20.81`) and one meter — this month's
    spend against the average monthly spend of the previous N calendar months
    (UTC), yellow with the real percent when over; dollars only without a
    baseline, and this month's spend when OpenRouter reports no credits;
  - the panel shows **All keys · this month** (*$49.93 of $61.20 avg
    (Sep–Oct) · Resets in 11d 7h*), **Credits** (*$20.81 left*, no lifetime
    totals) and the top N keys by spend this month — a meter against a key's
    limit with its daily/weekly/monthly UTC reset, or *$X.XX this month*;
  - the average comes from OpenRouter's analytics, parsed strictly and asked
    at most once per month and window, else from up to twelve months the
    widget has observed itself;
  - new settings `openrouterKeyRows` (default 3, 0–12) and
    `openrouterAverageMonths` (default 2, 0–12; 0 = no meter and no analytics
    request);
  - a failing management key (expired, not allowed, cannot list keys,
    offline) is reported with the last numbers kept, and never silently
    replaced by the inference key.
- **The management key is handled as a credential.** It is read from the
  environment, the Secret Service (`secret-tool`, gnome-keyring on Omarchy),
  or a `0600` file in a `0700` directory under `~/.local/share/agent-meters`
  (loose modes, other owners and symlinks are refused). It is never on a
  command line, in `shell.json`, the cache, IPC output, the collector's JSON
  or error text; the collector removes it from its environment before starting
  any other program. The panel only says where it came from. There is no text
  field for it; the helper reads it with echo off and passes it on stdin.
- **Grok Bot without the Grok CLI.** Grok now appears when only the Grok Bot
  desktop app has a reading, with both meters: the plan's **Weekly limit**
  (empty) and **Grok Bot weekly**, and the plan label from the Bot's reading.
- A key with a daily reset is named *Daily* (it read *Monthly*), and a
  per-key daily limit now meters `usage_daily`.
- OpenRouter's cycle history keeps up to twelve completed cycles (a 1.1
  cache's previous cycle carries over) and is kept separately for the per-key
  and account-wide views.
- Every OpenRouter request shares an overall time budget; POST requests have
  the same size and time bounds as GET.
- Offline tests now stub OpenRouter over HTTPS and fake `secret-tool`.

## 1.1.1 — 2026-11-15

- An OpenCode window at its limit is no longer marked stale: it keeps its
  percentage and colour instead of turning into an em dash.
- Grok's plan window is labelled from its own period (daily, weekly or
  monthly) instead of always saying "Weekly limit".
- README rewritten as the full user guide, with predecessor links,
  troubleshooting and marketplace facts; SECURITY.md added.
- `claudeCommand` setting for an absolute path to the Claude collector.
- The OpenRouter key label is reduced to a three-character tail (`key …2eb`),
  including in the cache and screenshots; the API's masked prefix is no longer
  displayed.
- The panel can grow to fit four agents without scrolling on a normal screen.
- Preview is one unified image: the bar meters above the panel, in the style
  of the three predecessor plugins, and it uses invented data only.
- No demo or capture script ships, so there is no temporary copy of live
  caches or settings; marketplace capability notes document the installer and
  runtime scope.
- A fresh install with no cache now fetches as soon as leadership settles
  instead of waiting for the next five-minute poll.
- The panel height cap accommodates five agents on a large screen and still
  clamps to smaller ones.

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
