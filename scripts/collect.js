#!/usr/bin/env node
'use strict'

// One collector for every agent the widget can show. Each provider keeps its
// own source, but they all leave here in the same shape so the QML side stays
// small:
//
//   { id, name, available, tier, status, error, source,
//     limits: [{ key, label, short, detail, percent, resetsAt, stale }],
//     activity: { todayPrompts, todayTokens, totalPrompts, accounts },
//     money: { label, limit, spend, credits, resetInterval, resetsAt } | null,
//     budgets: [...] }
//
// `available` is what makes the widget automatic: an agent with no plan, no
// key and no usage is simply left out of the bar. The collector always prints
// one JSON object and exits 0, like the collectors it replaces.

const { execFileSync } = require('child_process')
const fs = require('fs')
const https = require('https')
const path = require('path')

const MAX_BODY = 1024 * 1024
const HTTP_TIMEOUT_MS = 15000
const EXEC_TIMEOUT_MS = 25000
const MAX_EXEC_BUFFER = 8 * 1024 * 1024

function argValue(name) {
  const i = process.argv.indexOf(name)
  if (i < 0) return ''
  return process.argv[i + 1] || ''
}

function number(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.slice(0, max || 200)
}

function plain(value, max) {
  return text(value, max).replace(/</g, '\u2039').replace(/>/g, '\u203a')
}

function dateMs(value) {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n <= 1e12 ? Math.round(n * 1000) : Math.round(n)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function stateHome() {
  const xdg = process.env.XDG_STATE_HOME || ''
  if (xdg) return xdg
  const home = process.env.HOME || ''
  return home ? path.join(home, '.local/state') : ''
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

function usageRecord(id) {
  const home = stateHome()
  return home ? readJson(path.join(home, 'omarchy/agents/usage', id + '.json')) : null
}

function runJson(command, args) {
  let output
  try {
    output = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_EXEC_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (e) {
    return null
  }
  try {
    return JSON.parse(output)
  } catch (e) {
    return null
  }
}

function activityOf(record) {
  if (!record || typeof record !== 'object') return { period: 'today', prompts: 0, tokens: 0, totalPrompts: 0, accounts: 0 }
  return {
    period: 'today',
    prompts: Math.max(0, Math.round(number(record.todayPrompts) || 0)),
    tokens: Math.max(0, Math.round(number(record.todayTotalTokens) || 0)),
    totalPrompts: Math.max(0, Math.round(number(record.totalPrompts) || 0)),
    accounts: Array.isArray(record.accounts) ? record.accounts.length : 0
  }
}

// ------------------------------------------------------------------- Claude

function claudeLimit(entry, scale) {
  const label = plain(entry && entry.label, 80)
  const lower = label.toLowerCase()
  const percent = clamp((number(entry && entry.percent) || 0) * scale, 0, 100)
  const resetsAt = dateMs(entry && entry.resetsAt)
  let key = 'other'
  let short = label || 'limit'
  let detail = label
  if (lower.indexOf('session') >= 0 || lower.indexOf('5-hour') >= 0) {
    key = 'session'
    short = '5h'
    detail = 'Session (5-hour)'
  } else if (lower.indexOf('fable') >= 0) {
    key = 'fable'
    short = 'fable'
    detail = label || 'Fable'
  } else if (lower.indexOf('week') >= 0) {
    key = 'weekly'
    short = '7d'
    detail = 'Weekly (7-day)'
  } else if (lower.indexOf('month') >= 0) {
    key = 'monthly'
    short = '1m'
    detail = label || 'Monthly'
  }
  return { key: key, label: detail, short: short, detail: detail, percent: percent, resetsAt: resetsAt, stale: entry && entry.stale === true }
}

const CLAUDE_ORDER = { session: 0, weekly: 1, fable: 2, monthly: 3, other: 4 }

function claudeRank(key) {
  const rank = CLAUDE_ORDER[key]
  return rank === undefined ? 9 : rank
}

function collectClaude() {
  const command = argValue('--claude') || 'omarchy-agent-usage-claude'
  let record = runJson(command, ['--limits-only'])
  if (!record) record = usageRecord('claude')

  const provider = {
    id: 'claude',
    name: 'Claude',
    available: false,
    tier: '',
    status: '',
    hint: '',
    error: '',
    source: 'omarchy-agent-usage',
    limits: [],
    activity: activityOf(record),
    money: null,
    budgets: []
  }
  if (!record) {
    provider.error = 'Claude usage record not found'
    return provider
  }

  const list = Array.isArray(record.limits) ? record.limits : []
  const scale = list.some(function(entry) { return (number(entry && entry.percent) || 0) > 1.5 }) ? 1 : 100
  const limits = list
    .filter(function(entry) { return entry && number(entry.percent) !== null })
    .map(function(entry) { return claudeLimit(entry, scale) })
    .sort(function(a, b) { return claudeRank(a.key) - claudeRank(b.key) })

  provider.tier = plain(record.tierLabel, 60)
  provider.status = plain(record.usageStatusText, 120)
  provider.hint = plain(record.authHelpText, 240)
  provider.limits = limits
  provider.activity = activityOf(record)
  // A plan with an expired sign-in still belongs in the bar: it tells you why
  // the meters are empty and where to fix it.
  provider.available = limits.length > 0 || provider.tier !== ''
  return provider
}

// -------------------------------------------------------------------- Codex

// Codex's windows come from its app-server RPC through Omarchy's collector.
// The general windows are titled "Session"/"Weekly" (or "5h window"), a
// model's own allowance carries its name ("o3 Weekly"), and a Business seat
// can report a "Spend limit" instead.
const CODEX_BASE_ORDER = { session: 0, weekly: 1, review: 2, spend: 3, monthly: 4, other: 5 }

function codexBase(title) {
  const lower = String(title || '').toLowerCase()
  if (lower.indexOf('review') >= 0) return 'review'
  if (lower.indexOf('session') >= 0 || lower.indexOf('5-hour') >= 0 ||
      lower.indexOf('5h') >= 0 || lower.indexOf('hour window') >= 0) return 'session'
  if (lower.indexOf('week') >= 0 || lower.indexOf('7-day') >= 0) return 'weekly'
  if (lower.indexOf('month') >= 0) return 'monthly'
  if (lower.indexOf('spend') >= 0) return 'spend'
  return 'other'
}

function codexLimit(entry, scale) {
  const label = plain(entry && entry.title, 80) || plain(entry && entry.label, 80) || 'Limit'
  const base = codexBase(label)
  const scoped = typeof (entry && entry.title) === 'string' && entry.title.trim() !== ''
  const short = base === 'session' ? '5h'
    : base === 'weekly' ? '7d'
      : base === 'monthly' ? '1m'
        : base === 'review' ? 'rev'
          : base === 'spend' ? '$'
            : (label.slice(0, 6) || 'limit')
  const detail = base === 'session' && !scoped ? 'Session (5-hour)'
    : base === 'weekly' && !scoped ? 'Weekly (7-day)'
      : label
  return {
    key: (scoped ? 'scoped-' : '') + base,
    label: detail,
    short: short,
    detail: detail,
    percent: clamp((number(entry && entry.percent) || 0) * scale, 0, 100),
    resetsAt: dateMs(entry && entry.resetsAt),
    stale: entry && entry.stale === true
  }
}

function codexRank(key) {
  const scoped = String(key || '').indexOf('scoped-') === 0
  const base = scoped ? String(key).slice(7) : String(key)
  return (scoped ? 10 : 0) + (CODEX_BASE_ORDER[base] === undefined ? 9 : CODEX_BASE_ORDER[base])
}

function collectCodex() {
  const command = argValue('--codex') || 'omarchy-agent-usage-codex'
  let record = runJson(command, ['--limits-only'])
  if (!record) record = usageRecord('codex')

  const provider = {
    id: 'codex',
    name: 'Codex',
    available: false,
    tier: '',
    status: '',
    hint: '',
    error: '',
    source: 'omarchy-agent-usage',
    limits: [],
    activity: activityOf(record),
    money: null,
    budgets: []
  }
  if (!record) {
    provider.error = 'Codex usage record not found'
    return provider
  }

  const list = Array.isArray(record.limits) ? record.limits : []
  const scale = list.some(function(entry) { return (number(entry && entry.percent) || 0) > 1.5 }) ? 1 : 100
  const limits = list
    .filter(function(entry) { return entry && number(entry.percent) !== null })
    .map(function(entry) { return codexLimit(entry, scale) })
    .sort(function(a, b) { return codexRank(a.key) - codexRank(b.key) })

  provider.tier = plain(record.tierLabel, 60)
  provider.status = plain(record.usageStatusText, 120)
  provider.hint = plain(record.authHelpText, 240)
  provider.limits = limits
  provider.activity = activityOf(record)
  provider.available = limits.length > 0 || provider.tier !== ''
  return provider
}

// --------------------------------------------------------------------- Grok

function grokPeriod(periodType) {
  const value = String(periodType || '').toUpperCase()
  if (value.indexOf('MONTH') >= 0) return { short: 'mo', detail: 'Monthly limit' }
  if (value.indexOf('DAY') >= 0) return { short: 'day', detail: 'Daily limit' }
  return { short: 'wk', detail: 'Weekly limit' }
}

function collectGrok() {
  const args = [path.join(__dirname, 'grok.js')]
  const grokHome = argValue('--grok-home')
  const botHome = argValue('--bot-home')
  if (grokHome) args.push('--home', grokHome)
  if (botHome) args.push('--bot-home', botHome)

  const raw = runJson(process.execPath, args)
  const record = usageRecord('grok')

  const provider = {
    id: 'grok',
    name: 'Grok',
    available: false,
    tier: '',
    status: '',
    hint: '',
    error: '',
    source: 'grok-log',
    limits: [],
    activity: { period: 'today', prompts: 0, tokens: 0, totalPrompts: 0, accounts: 0 },
    money: null,
    budgets: []
  }

  if (raw && raw.ok === true && raw.source === 'grok-bot') {
    // Grok Bot without the Grok CLI: Grok still shows both meters, the plan's
    // weekly window empty (only the CLI reports it) and the Bot's allowance.
    const bot = raw.bot
    if (bot && number(bot.percent) !== null) {
      const expired = (number(bot.expiresAt) || 0) > 0 && Date.now() > number(bot.expiresAt)
      provider.source = 'grok-bot'
      provider.tier = plain(bot.plan, 60)
      provider.limits.push({
        key: 'weekly', label: 'Weekly', short: 'wk', detail: 'Weekly limit', percent: 0, resetsAt: 0, stale: false
      })
      provider.limits.push({
        key: 'bot',
        label: 'Grok Bot',
        short: 'bot',
        detail: 'Grok Bot weekly',
        percent: clamp(number(bot.percent) || 0, 0, 100),
        resetsAt: dateMs(bot.resetsAt),
        stale: expired || ((number(bot.resetsAt) || 0) > 0 && Date.now() >= number(bot.resetsAt))
      })
      provider.available = true
    }
    return provider
  }

  if (raw && raw.ok === true) {
    provider.tier = plain(raw.tier, 60)
    const weekly = raw.weekly
    if (weekly && number(weekly.usedPercent) !== null) {
      const period = grokPeriod(weekly.periodType)
      provider.limits.push({
        key: 'weekly',
        label: 'Weekly',
        short: period.short,
        detail: period.detail,
        percent: clamp(number(weekly.usedPercent) || 0, 0, 100),
        resetsAt: dateMs(weekly.resetsAt),
        stale: weekly.expired === true
      })
    }
    const bot = raw.bot
    if (bot && number(bot.percent) !== null) {
      const expired = (number(bot.expiresAt) || 0) > 0 && Date.now() > number(bot.expiresAt)
      provider.limits.push({
        key: 'bot',
        label: 'Grok Bot',
        short: 'bot',
        detail: 'Grok Bot weekly',
        percent: clamp(number(bot.percent) || 0, 0, 100),
        resetsAt: dateMs(bot.resetsAt),
        stale: expired || ((number(bot.resetsAt) || 0) > 0 && Date.now() >= number(bot.resetsAt))
      })
    }
    const local = raw.local
    if (local) {
      provider.activity.period = 'week'
      provider.activity.prompts = Math.max(0, Math.round(number(local.turns) || 0))
      provider.activity.tokens = Math.max(0, Math.round(number(local.tokens) || 0))
    }
    provider.available = provider.limits.length > 0 || provider.tier !== ''
    return provider
  }

  // No log snapshot: fall back to the Omarchy record, which may carry limits
  // written by another collector run.
  if (record && Array.isArray(record.limits) && record.limits.length > 0) {
    provider.tier = plain(record.tierLabel, 60)
    provider.status = plain(record.usageStatusText, 120)
    provider.limits = record.limits.map(function(entry) {
      const label = plain(entry.label, 60)
      return {
        key: label.toLowerCase().indexOf('bot') >= 0 ? 'bot' : 'weekly',
        label: label || 'Weekly',
        short: 'wk',
        detail: label || 'Weekly limit',
        percent: clamp((number(entry.percent) || 0) * ((number(entry.percent) || 0) <= 1 ? 100 : 1), 0, 100),
        resetsAt: dateMs(entry.resetsAt),
        stale: record.limitsStale === true
      }
    })
    provider.activity = activityOf(record)
    provider.available = true
  }
  return provider
}

// ----------------------------------------------------------------- OpenCode

const OPENCODE_WINDOWS = [
  { key: 'session', label: 'Session', short: '5h', detail: '5-hour session', field: 'rolling' },
  { key: 'weekly', label: 'Week', short: '7d', detail: 'Weekly (7-day)', field: 'weekly' },
  { key: 'monthly', label: 'Month', short: '1m', detail: 'Monthly', field: 'monthly' }
]

function opencodeData(command) {
  let doc = runJson(command, ['api', 'GET', '/api/experimental/usage/limits'])
  if (!doc || !Object.prototype.hasOwnProperty.call(doc, 'data')) {
    doc = runJson(command, ['api', '--standalone', 'GET', '/api/experimental/usage/limits'])
  }
  if (!doc) return { error: 'opencode did not answer' }
  if (Object.prototype.hasOwnProperty.call(doc, 'data')) {
    if (doc.data === null) return { signedOut: true }
    if (doc.data && typeof doc.data === 'object') return { data: doc.data }
    return { error: 'opencode returned no usage data' }
  }
  return { data: doc }
}

function collectOpencode() {
  const command = argValue('--opencode') || 'opencode'
  const result = opencodeData(command)
  const record = usageRecord('opencode')

  const provider = {
    id: 'opencode',
    name: 'OpenCode',
    available: false,
    tier: '',
    status: '',
    hint: '',
    error: '',
    source: 'opencode-api',
    limits: [],
    activity: activityOf(record),
    money: null,
    budgets: []
  }

  if (result.error) {
    provider.error = result.error
    return provider
  }
  if (result.signedOut) {
    provider.status = 'Not signed in'
    return provider
  }
  const data = result.data

  const workspace = data.workspace && typeof data.workspace === 'object' ? data.workspace : null
  provider.tier = workspace ? plain(workspace.name, 60) : ''
  provider.status = 'Go'
  provider.hint = record ? plain(record.authHelpText, 240) : ''
  const go = data.go && typeof data.go === 'object' ? data.go : null
  if (!go) {
    provider.status = 'No Go plan'
    return provider
  }

  OPENCODE_WINDOWS.forEach(function(window) {
    const entry = go[window.field]
    const percent = entry ? number(entry.percent) : null
    if (percent === null) return
    provider.limits.push({
      key: window.key,
      label: window.label,
      short: window.short,
      detail: window.detail,
      percent: clamp(percent, 0, 100),
      resetsAt: dateMs(entry.resetsAt),
      stale: false
    })
  })

  if (Array.isArray(data.budgets)) {
    provider.budgets = data.budgets
      .filter(function(entry) { return entry && number(entry.limit) > 0 })
      .slice(0, 6)
      .map(function(entry) {
        const limit = number(entry.limit) || 0
        const spent = number(entry.spent) || 0
        return {
          id: plain(entry.id, 60),
          limit: limit,
          spent: spent,
          percent: limit > 0 ? clamp(spent / limit * 100, 0, 100) : 0,
          resetsAt: dateMs(entry.resetsAt)
        }
      })
  }

  provider.available = provider.limits.length > 0
  return provider
}

// --------------------------------------------------------------- OpenRouter
//
// Two modes. With a management key (account-wide) the collector lists every
// key on the account; without one it reads the inference key's own budget, as
// before. A management key can create and delete the account's API keys, so it
// is handled with more care than anything else here:
//
// - sources, in order: OPENROUTER_MANAGEMENT_KEY (captured at start-up and
//   removed from this process's environment so no child inherits it), the
//   freedesktop Secret Service through `secret-tool lookup` (attributes only on
//   argv; the secret arrives on stdout), then a 0600 file inside a 0700
//   directory under $XDG_DATA_HOME (symlinks refused);
// - it travels only in the HTTPS Authorization header to openrouter.ai;
// - it is never printed, never put in the output JSON or an error message
//   (`scrub`), and never on any command line.

const OPENROUTER_API = 'https://openrouter.ai/api/v1'
const MANAGEMENT_ENV = 'OPENROUTER_MANAGEMENT_KEY'
const MANAGEMENT_KEYS_PAGE = 'openrouter.ai/settings/management-keys'
const SECRET_ATTRIBUTES = ['service', 'agent-meters', 'account', 'openrouter-management']
const SECRET_TOOL_TIMEOUT_MS = 3000
// Omarchy keeps delete-capable credentials out of ~/.config (which people sync
// as dotfiles) and in mode-restricted files under ~/.local/share.
const MANAGEMENT_DIR_NAME = 'agent-meters'
const MANAGEMENT_FILE_NAME = 'openrouter-management-key'
const MANAGEMENT_FILE_MAX = 4096
const MANAGEMENT_KEY_MIN = 16
const MANAGEMENT_KEY_MAX = 512
const MANAGEMENT_KEY_SHAPE = /^[A-Za-z0-9\-_.~+/=:]+$/
const KEYS_PAGE_SIZE = 100
const MAX_KEY_PAGES = 10
const MAX_KEY_ROWS = 12
const MAX_AVERAGE_MONTHS = 12
const DEFAULT_AVERAGE_MONTHS = 2
const BASELINE_RETRY_MS = 24 * 3600000
const OPENROUTER_DEADLINE_MS = 45000
const MAX_REQUEST_BODY = 4096
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NO_FALLBACK_NOTE = "The inference key isn't used while a management key is set."

const managementFromEnv = String(process.env[MANAGEMENT_ENV] || '')
delete process.env[MANAGEMENT_ENV]

function nowMs() {
  return Date.now()
}

// Wall-clock deadlines use a monotonic clock, never the (testable) Date.
function monoMs() {
  return Number(process.hrtime.bigint() / 1000000n)
}

function homeTilde(file) {
  const home = process.env.HOME || ''
  return home && String(file).indexOf(home + '/') === 0 ? '~' + String(file).slice(home.length) : String(file)
}

// Display-safe error text that can never carry a key.
function scrub(message, key) {
  let m = String(message || '')
  if (key) m = m.split(key).join('…')
  if (managementFromEnv.trim()) m = m.split(managementFromEnv.trim()).join('…')
  m = m.replace(/sk-or-[A-Za-z0-9_\-]{6,}/g, 'sk-or-…').replace(/Bearer\s+\S+/gi, 'Bearer …')
  return plain(m.trim(), 240)
}

function authFile() {
  const explicit = argValue('--auth-file')
  if (explicit) return explicit
  const env = process.env.OPENROUTER_AUTH_FILE || ''
  if (env) return env
  const home = process.env.HOME || ''
  return home ? path.join(home, '.local/share/opencode/auth.json') : ''
}

function keyFromFile(file) {
  if (!file) return ''
  const doc = readJson(file)
  const entry = doc && doc.openrouter && typeof doc.openrouter === 'object' ? doc.openrouter : null
  if (!entry) return ''
  if (typeof entry.key === 'string') return entry.key.trim()
  if (typeof entry.apiKey === 'string') return entry.apiKey.trim()
  return ''
}

// OpenCode 2 moved credentials into SQLite and exposes them through
// `opencode auth export`; read that documented export rather than the schema.
function keyFromOpenCodeExport() {
  let exported
  try {
    exported = execFileSync('opencode', ['auth', 'export'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (e) {
    return ''
  }
  let list
  try {
    list = JSON.parse(exported)
  } catch (e) {
    return ''
  }
  if (!Array.isArray(list)) return ''
  for (const item of list) {
    if (!item || item.integrationID !== 'openrouter' || item.active === false) continue
    const value = item.value
    if (!value || typeof value !== 'object') continue
    if (typeof value.key === 'string' && value.key.trim() !== '') return value.key.trim()
    if (typeof value.apiKey === 'string' && value.apiKey.trim() !== '') return value.apiKey.trim()
  }
  return ''
}

function resolveOpenRouterKey() {
  const env = String(process.env.OPENROUTER_API_KEY || '').trim()
  if (env !== '') return env
  const explicit = argValue('--auth-file') || process.env.OPENROUTER_AUTH_FILE || ''
  if (explicit !== '') return keyFromFile(explicit)
  return keyFromFile(authFile()) || keyFromOpenCodeExport()
}

// ----------------------------------------------------- management key lookup

// Trimmed key when it has a plausible shape, else ''. Never echoes the key.
function normalizeManagementKey(raw) {
  const key = String(raw || '').trim()
  if (key.length < MANAGEMENT_KEY_MIN || key.length > MANAGEMENT_KEY_MAX) return ''
  return MANAGEMENT_KEY_SHAPE.test(key) ? key : ''
}

function dataHome() {
  const xdg = process.env.XDG_DATA_HOME || ''
  if (xdg) return xdg
  const home = process.env.HOME || ''
  return home ? path.join(home, '.local/share') : ''
}

function managementKeyFile() {
  const base = dataHome()
  return base ? path.join(base, MANAGEMENT_DIR_NAME, MANAGEMENT_FILE_NAME) : ''
}

// The documented file fallback. Refused unless the directory is a real 0700
// directory and the file a real 0600 (or stricter) regular file, both owned by
// this user. The file is opened with O_NOFOLLOW and checked through its fd, so
// a swapped-in symlink cannot redirect the read.
function readManagementKeyFile(file) {
  if (!file) return { none: true }
  const dir = path.dirname(file)
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  let dirStat
  try {
    dirStat = fs.lstatSync(dir)
  } catch (e) {
    return e && e.code === 'ENOENT' ? { none: true } : { error: 'Could not read ' + homeTilde(dir) }
  }
  if (!dirStat.isDirectory()) {
    return { error: homeTilde(dir) + ' is not a plain directory (symlinks are refused); management key file not used' }
  }
  if (uid >= 0 && dirStat.uid !== uid) return { error: homeTilde(dir) + ' is owned by another user; management key file not used' }
  if ((dirStat.mode & 0o077) !== 0) {
    return { error: homeTilde(dir) + ' must be mode 0700 (chmod 700 ' + homeTilde(dir) + '); management key file not used' }
  }

  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { none: true }
    if (e && e.code === 'ELOOP') return { error: homeTilde(file) + ' is a symlink; management key file refused' }
    return { error: 'Could not open ' + homeTilde(file) }
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return { error: homeTilde(file) + ' is not a regular file; management key file refused' }
    if (uid >= 0 && stat.uid !== uid) return { error: homeTilde(file) + ' is owned by another user; management key file refused' }
    if ((stat.mode & 0o077) !== 0) {
      return { error: homeTilde(file) + ' must be mode 0600 (chmod 600 ' + homeTilde(file) + '); management key file refused' }
    }
    if (stat.size > MANAGEMENT_FILE_MAX) return { error: homeTilde(file) + ' is too large to be a key; refused' }
    const buffer = Buffer.alloc(stat.size)
    const read = stat.size > 0 ? fs.readSync(fd, buffer, 0, stat.size, 0) : 0
    const key = normalizeManagementKey(buffer.toString('utf8', 0, read))
    buffer.fill(0)
    if (!key) return { error: homeTilde(file) + ' does not hold a valid management key' }
    return { key: key }
  } catch (e) {
    return { error: 'Could not read ' + homeTilde(file) }
  } finally {
    try { fs.closeSync(fd) } catch (e) {}
  }
}

// `secret-tool lookup` prints the secret on stdout; only the lookup
// attributes are on its command line. Missing secret-tool, no Secret Service,
// or no item all mean "not set" (secret-tool exits non-zero). Only a timeout
// is "unreadable": the keyring exists but did not answer.
function secretToolLookup() {
  let out
  try {
    out = execFileSync('secret-tool', ['lookup'].concat(SECRET_ATTRIBUTES), {
      encoding: 'utf8',
      timeout: SECRET_TOOL_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (e) {
    if (e && e.code === 'ENOENT') return { none: true }
    if (e && (e.code === 'ETIMEDOUT' || (e.signal && e.status === null))) {
      return { error: 'The Secret Service did not answer within 3 seconds (is the keyring locked?)' }
    }
    return { none: true }
  }
  const key = normalizeManagementKey(out)
  out = ''
  return key ? { key: key } : { none: true }
}

// { key, source } | { error, source } | { none: true }
function resolveManagementKey() {
  const env = normalizeManagementKey(managementFromEnv)
  if (env) return { key: env, source: 'env' }
  const secret = secretToolLookup()
  if (secret.key) return { key: secret.key, source: 'secret-service' }
  const file = readManagementKeyFile(managementKeyFile())
  if (file.key) return { key: file.key, source: 'file' }
  if (file.error) return { error: file.error, source: 'file' }
  if (secret.error) return { error: secret.error, source: 'secret-service' }
  return { none: true }
}

// ------------------------------------------------------------------ HTTP

// One bounded HTTPS request to openrouter.ai: response size, a wall-clock
// timeout (capped by `deadline`, a monotonic ms value) and the key only in the
// Authorization header. Resolves { status, doc } (doc null when not JSON) or
// { transport } with a scrubbed message; never rejects.
function requestJson(method, url, key, body, deadline) {
  return new Promise(function(resolve) {
    let settled = false
    let timer = null
    function done(value) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const remaining = deadline ? deadline - monoMs() : HTTP_TIMEOUT_MS
    if (remaining <= 0) {
      done({ transport: 'OpenRouter took too long to answer' })
      return
    }
    const timeout = Math.min(HTTP_TIMEOUT_MS, remaining)
    const headers = {
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
      'User-Agent': 'omarchy-agent-meters/1.2'
    }
    let payload = null
    if (body !== null && body !== undefined) {
      payload = Buffer.from(String(body), 'utf8')
      if (payload.length > MAX_REQUEST_BODY) {
        done({ transport: 'request too large' })
        return
      }
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = payload.length
    }
    let req
    try {
      req = https.request(url, { method: method, headers: headers }, function(res) {
        let size = 0
        const chunks = []
        res.on('data', function(chunk) {
          size += chunk.length
          if (size > MAX_BODY) {
            req.destroy()
            done({ transport: 'response too large' })
            return
          }
          chunks.push(chunk)
        })
        res.on('error', function() { done({ transport: 'could not read the OpenRouter response' }) })
        res.on('end', function() {
          let doc = null
          try {
            doc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch (e) {
            doc = null
          }
          done({ status: Number(res.statusCode) || 0, doc: doc })
        })
      })
    } catch (e) {
      done({ transport: 'could not reach OpenRouter' })
      return
    }
    timer = setTimeout(function() {
      try { req.destroy() } catch (e) {}
      done({ transport: 'request timed out' })
    }, timeout)
    req.on('error', function(e) {
      done({ transport: scrub(e && e.message ? e.message : 'could not reach OpenRouter', key) || 'could not reach OpenRouter' })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

function apiMessage(doc, key) {
  const message = doc && doc.error && typeof doc.error === 'object' ? doc.error.message : null
  return typeof message === 'string' ? scrub(message.slice(0, 240), key) : ''
}

async function jsonOrThrow(result, key) {
  if (result.transport) throw new Error(result.transport)
  if (result.status >= 200 && result.status < 300) {
    if (result.doc === null || typeof result.doc !== 'object') throw new Error('invalid JSON from OpenRouter')
    return result.doc
  }
  const message = apiMessage(result.doc, key)
  throw new Error(message || 'HTTP ' + result.status)
}

async function getJson(url, key, deadline) {
  return jsonOrThrow(await requestJson('GET', url, key, null, deadline), key)
}

async function postJson(url, key, body, deadline) {
  return jsonOrThrow(await requestJson('POST', url, key, body, deadline), key)
}

// ------------------------------------------------------------ per-key mode

// Never carry an OpenRouter key's label into the UI beyond a short tail; the
// API masks it, but even the surviving prefix is more than a screenshot needs.
function maskKeyLabel(value) {
  const raw = String(value || '').trim()
  const match = raw.match(/[A-Za-z0-9]{3,}$/)
  return match ? 'key …' + match[0].slice(-3) : 'OpenRouter key'
}

function pickMoney(doc) {
  const source = doc && doc.data && typeof doc.data === 'object' ? doc.data : doc
  if (!source || typeof source !== 'object') return null
  const eb = source.effective_budget && typeof source.effective_budget === 'object' ? source.effective_budget : null
  const limit = eb && number(eb.limit_usd) > 0 ? number(eb.limit_usd) : (number(source.limit) > 0 ? number(source.limit) : null)
  let spend = eb ? number(eb.spend_usd) : null
  if (spend === null) {
    const interval = String((eb && eb.reset_interval) || source.limit_reset || 'monthly').toLowerCase()
    if (interval.indexOf('week') >= 0) spend = number(source.usage_weekly)
    else if (interval.indexOf('day') >= 0 || interval.indexOf('daily') >= 0) spend = number(source.usage_daily)
    else spend = number(source.usage_monthly) !== null ? number(source.usage_monthly) : number(source.usage)
  }
  return {
    scope: 'key',
    label: maskKeyLabel(source.label),
    limit: limit,
    spend: spend === null ? 0 : spend,
    resetInterval: String((eb && eb.reset_interval) || source.limit_reset || 'monthly'),
    resetsAt: dateMs(eb && eb.resets_at)
  }
}

function pickCredits(doc) {
  const source = doc && doc.data && typeof doc.data === 'object' ? doc.data : doc
  if (!source || typeof source !== 'object') return null
  if (number(source.total_credits) === null && number(source.total_usage) === null) return null
  const total = number(source.total_credits) || 0
  const used = number(source.total_usage) || 0
  return { total: total, used: used, remaining: Math.max(0, total - used) }
}

// ------------------------------------------------------- reset dates (UTC)

function nextDailyReset(now) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

// The next Monday 00:00 UTC strictly after `now`.
function nextWeeklyReset(now) {
  const d = new Date(now)
  let ahead = (1 - d.getUTCDay() + 7) % 7
  if (ahead === 0) ahead = 7
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ahead)
}

function nextMonthlyReset(now) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

function nextReset(interval, now) {
  const value = String(interval || '').toLowerCase()
  if (value === 'daily') return nextDailyReset(now)
  if (value === 'weekly') return nextWeeklyReset(now)
  if (value === 'monthly') return nextMonthlyReset(now)
  return 0
}

// --------------------------------------------------------- account-wide mode

function managementFailure(result) {
  if (result.transport) return { transport: result.transport }
  if (result.status >= 200 && result.status < 300) return { invalid: true }
  return { status: result.status, message: apiMessage(result.doc, '') }
}

// Plain status and error for a failure. The error names the fix on its own,
// because a merged provider shows its last numbers and only the error line.
function describeFailure(failure, endpoint, key) {
  if (failure.status === 401) {
    return {
      status: 'Management key expired or invalid',
      error: 'OpenRouter rejected the management key (HTTP 401: expired or invalid). Create a new one at ' +
        MANAGEMENT_KEYS_PAGE + ' and store it with scripts/set-management-key.sh.'
    }
  }
  if (failure.status === 403) {
    return {
      status: 'Management key not allowed',
      error: "This management key isn't allowed to read " + (endpoint === 'keys' ? "the account's keys" : 'account credits') + ' (HTTP 403).'
    }
  }
  if (failure.status === 404) {
    return {
      status: "Management key can't list keys",
      error: endpoint === 'keys'
        ? "This management key can't list keys (personal accounts may need an organization)."
        : "This management key can't read account credits."
    }
  }
  if (failure.status) {
    const message = scrub(failure.message, key)
    return { status: '', error: message ? message + ' (HTTP ' + failure.status + ')' : 'HTTP ' + failure.status }
  }
  if (failure.transport) return { status: '', error: scrub(failure.transport, key) || 'could not reach OpenRouter' }
  return { status: '', error: 'invalid JSON from OpenRouter' }
}

function accountFailed(provider, failure, endpoint, key) {
  const described = describeFailure(failure, endpoint, key)
  if (described.status) provider.status = described.status
  provider.error = plain(described.error + ' ' + NO_FALLBACK_NOTE, 300)
  provider.money = null
  provider.limits = []
  return provider
}

// Every page of `/api/v1/keys` (100 per page, at most MAX_KEY_PAGES). The API
// leaves out disabled and expired keys by default.
async function listKeys(key, deadline) {
  const all = []
  let offset = 0
  for (let page = 0; page < MAX_KEY_PAGES; page++) {
    const result = await requestJson('GET', OPENROUTER_API + '/keys?offset=' + offset, key, null, deadline)
    if (result.transport || !(result.status >= 200 && result.status < 300)) return { failure: managementFailure(result) }
    const list = result.doc && Array.isArray(result.doc.data) ? result.doc.data : null
    if (!list) return { failure: { invalid: true } }
    for (const item of list) {
      if (item && typeof item === 'object' && !Array.isArray(item)) all.push(item)
    }
    if (list.length < KEYS_PAGE_SIZE) break
    offset += list.length
  }
  return { keys: all }
}

// Enabled keys whose `expires_at` (when given) is still ahead.
function activeKeys(keys, now) {
  return keys.filter(function(k) {
    if (k.disabled === true) return false
    const expires = dateMs(k.expires_at)
    return expires <= 0 || expires > now
  })
}

function rowKey(hash, index) {
  const clean = String(typeof hash === 'string' ? hash : '').replace(/[^A-Za-z0-9]/g, '')
  return clean === '' ? 'key-' + (index + 1) : 'key-' + clean.slice(0, 8).toLowerCase()
}

// The key's own name; else "Key …" and the label's last four letters or
// digits. Never OpenRouter's full label.
function keyName(k) {
  const name = plain(k.name, 60).trim()
  if (name !== '') return name
  const match = String(typeof k.label === 'string' ? k.label : '').trim().match(/[A-Za-z0-9]{4,}$/)
  return match ? 'Key …' + match[0].slice(-4) : 'Key'
}

// The keys used most this month: ranked by `usage_monthly`, zero usage left
// out, at most MAX_KEY_ROWS (the panel shows the first `openrouterKeyRows`).
// A key with a limit is a meter against it; one without is a value row
// (`amount` = this month's spend).
function keyRows(keys, now) {
  const rows = []
  keys.forEach(function(k, index) {
    const monthly = Math.max(0, number(k.usage_monthly) || 0)
    if (!(monthly > 0)) return
    const name = keyName(k)
    const id = rowKey(k.hash, index)
    const limit = number(k.limit)
    if (limit === null || !(limit > 0)) {
      rows.push({ monthly: monthly, index: index, limit: {
        key: id, label: name, short: 'key', detail: name, percent: 0, resetsAt: 0, stale: false, amount: monthly, limited: false
      } })
      return
    }
    const reset = typeof k.limit_reset === 'string' ? k.limit_reset.toLowerCase() : ''
    const remaining = number(k.limit_remaining)
    let used
    if (remaining !== null) {
      used = limit - remaining
    } else {
      const field = reset === 'daily' ? 'usage_daily' : reset === 'weekly' ? 'usage_weekly' : reset === 'monthly' ? 'usage_monthly' : 'usage'
      used = number(k[field]) || 0
    }
    rows.push({ monthly: monthly, index: index, limit: {
      key: id,
      label: name,
      short: 'key',
      detail: name,
      percent: clamp(used / limit * 100, 0, 100),
      resetsAt: nextReset(reset, now),
      stale: false,
      amount: null,
      limited: remaining !== null && remaining <= 0
    } })
  })
  rows.sort(function(a, b) { return a.monthly !== b.monthly ? b.monthly - a.monthly : a.index - b.index })
  return rows.slice(0, MAX_KEY_ROWS).map(function(row) { return row.limit })
}

// ------------------------------------------------------ analytics baseline

function monthKey(ms) {
  const d = new Date(ms)
  const month = d.getUTCMonth() + 1
  return d.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month
}

// The 1st of `now`'s month and of the month `months` before it, 00:00 UTC.
function baselineRange(now, months) {
  if (!(months >= 1 && months <= MAX_AVERAGE_MONTHS)) return null
  const d = new Date(now)
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1),
    end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  }
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// Metric names are put into the JSON body verbatim, so only plain ones.
function isPlainMetricName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && /^[A-Za-z0-9_.\-]+$/.test(name)
}

// The account's cost metric from /analytics/meta: currency, not a rate, not
// BYOK, about cost/usage/spend. null when none is clearly that.
function pickCostMetric(doc) {
  const source = doc && doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : doc
  const metrics = source && Array.isArray(source.metrics) ? source.metrics : null
  if (!metrics) return null
  let best = null
  for (const m of metrics.slice(0, 200)) {
    if (!m || typeof m !== 'object') continue
    if (!isPlainMetricName(m.name)) continue
    if (String(typeof m.display_format === 'string' ? m.display_format : '').toLowerCase() !== 'currency') continue
    if (m.is_rate === true) continue
    const name = m.name.toLowerCase()
    const label = String(typeof m.display_label === 'string' ? m.display_label : '').toLowerCase()
    const all = name + ' ' + label
    if (all.indexOf('byok') >= 0) continue
    let score
    if (['cost', 'total_cost', 'usage', 'total_usage', 'spend', 'total_spend'].indexOf(name) >= 0) score = 3
    else if (all.indexOf('cost') >= 0) score = 2
    else if (all.indexOf('usage') >= 0 || all.indexOf('spend') >= 0) score = 1
    else continue
    if (best === null || score > best.score) best = { score: score, name: m.name }
  }
  return best ? best.name : null
}

// The exact request body for the `months` full months before `now`'s month.
function queryBody(metric, now, months) {
  const range = baselineRange(now, months)
  if (!isPlainMetricName(metric) || !range) return null
  return '{"metrics":["' + metric + '"],"granularity":"month","time_range":{"start":"' +
    isoSeconds(range.start) + '","end":"' + isoSeconds(range.end) + '"}}'
}

// "2026-10", "2026-10-01" or an ISO date-time (UTC when no zone) → epoch ms,
// else null. Strict on purpose: Date.parse alone accepts almost anything.
function bucketDateMs(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  const m = t.match(/^(\d{4})-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?)?$/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = m[3] ? Number(m[3]) : 1
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (!m[4]) return Date.UTC(year, month - 1, day)
  const parsed = Date.parse(m[7] ? t.replace(' ', 'T') : t.replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) ? parsed : null
}

// The `months` months' total spend, or null when the answer is not clearly that:
// - `data.data` rows, at most `months`; each carries the metric as a number ≥ 0;
// - a row's time bucket (any string field that reads as a date) must fall in
//   the range, one row per month;
// - fewer rows than months count the missing months as 0 only when the answer
//   says it is complete (`metadata.row_count` equals the rows, `truncated`
//   false) and every row has a bucket;
// - `truncated` true → null.
function parseTotal(doc, metric, start, end, months) {
  const data = doc && doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : null
  const rows = data && Array.isArray(data.data) ? data.data : null
  if (!rows || rows.length > months) return null
  const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : null
  if (meta && meta.truncated === true) return null
  let total = 0
  let allBucketed = true
  const seen = {}
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null
    const value = number(row[metric])
    if (value === null || value < 0) return null
    total += value
    let bucket = null
    for (const field of Object.keys(row)) {
      if (field === metric) continue
      const ms = bucketDateMs(row[field])
      if (ms !== null) { bucket = ms; break }
    }
    if (bucket !== null) {
      if (bucket < start || bucket >= end) return null
      const month = monthKey(bucket)
      if (seen[month]) return null
      seen[month] = true
    } else {
      allBucketed = false
    }
  }
  if (!Number.isFinite(total)) return null
  if (rows.length === months) return total
  const complete = meta !== null && meta.truncated === false && number(meta.row_count) === rows.length
  return complete && allBucketed ? total : null
}

// Average monthly spend of the `months` full months before `now`, or 0 when
// analytics cannot say. Never an error: the panel falls back to history.
async function queryBaseline(key, months, now, deadline) {
  const range = baselineRange(now, months)
  if (!range) return 0
  const meta = await requestJson('GET', OPENROUTER_API + '/analytics/meta', key, null, deadline)
  if (meta.transport || !(meta.status >= 200 && meta.status < 300)) return 0
  const metric = pickCostMetric(meta.doc)
  const body = metric ? queryBody(metric, now, months) : null
  if (!body) return 0
  const query = await requestJson('POST', OPENROUTER_API + '/analytics/query', key, body, deadline)
  if (query.transport || !(query.status >= 200 && query.status < 300)) return 0
  const total = parseTotal(query.doc, metric, range.start, range.end, months)
  if (total === null) return 0
  const average = total / months
  return Number.isFinite(average) && average > 0 ? Math.round(average * 10000) / 10000 : 0
}

// "2026-11:2:61.2:1794571200000" — month, N, average (0 = unavailable),
// checkedAt — as the widget passes back the baseline it cached. Strict.
function parseBaselineArg(value) {
  const m = String(value || '').match(/^(\d{4}-\d{2}):(\d{1,2}):(\d{1,9}(?:\.\d{1,6})?):(\d{1,15})$/)
  if (!m) return null
  const months = Number(m[2])
  const average = Number(m[3])
  const checkedAt = Number(m[4])
  if (!(months >= 1 && months <= MAX_AVERAGE_MONTHS) || !Number.isFinite(average) || !Number.isFinite(checkedAt)) return null
  return { month: m[1], months: months, average: average, checkedAt: checkedAt }
}

// This month's baseline for N: the widget's cached one when it is for this
// (month, N) — a failed attempt is retried after a day — else one meta + query
// round trip. null when N is 0 (no meter, no analytics request).
async function accountBaseline(key, options, deadline) {
  const months = options.averageMonths
  if (!(months >= 1 && months <= MAX_AVERAGE_MONTHS)) return null
  const now = nowMs()
  const month = monthKey(now)
  const cached = options.baseline
  if (cached && cached.month === month && cached.months === months) {
    if (cached.average > 0) return cached
    if (cached.checkedAt <= now && now - cached.checkedAt < BASELINE_RETRY_MS) return cached
  }
  const average = await queryBaseline(key, months, now, deadline)
  return { month: month, months: months, average: average, checkedAt: now }
}

async function collectAccount(key, source, provider, options) {
  const deadline = monoMs() + OPENROUTER_DEADLINE_MS
  const now = nowMs()
  provider.available = true
  provider.tier = 'Management key'
  provider.source = 'openrouter-management'
  provider.keySource = source

  const listed = await listKeys(key, deadline)
  if (listed.failure) return accountFailed(provider, listed.failure, 'keys', key)

  let credits = null
  const creditsResult = await requestJson('GET', OPENROUTER_API + '/credits', key, null, deadline)
  if (creditsResult.status >= 200 && creditsResult.status < 300 && !creditsResult.transport) {
    credits = pickCredits(creditsResult.doc)
  } else if (creditsResult.status !== 404) {
    // Some accounts can't read credits (404); everything else is a real failure.
    return accountFailed(provider, managementFailure(creditsResult), 'credits', key)
  }

  const enabled = activeKeys(listed.keys, now)
  const spend = enabled.reduce(function(sum, k) { return sum + Math.max(0, number(k.usage_monthly) || 0) }, 0)
  const limits = []
  if (credits) {
    // Credits left only: purchases and usage are lifetime totals, not shown.
    limits.push({ key: 'credits', label: 'Credits', short: 'cr', detail: 'Credits', percent: 0, resetsAt: 0, stale: false, amount: credits.remaining, limited: false })
  }
  keyRows(enabled, now).forEach(function(row) { limits.push(row) })

  provider.money = {
    scope: 'account',
    label: 'All keys',
    limit: null,
    spend: Math.round(spend * 1e6) / 1e6,
    resetInterval: 'monthly',
    resetsAt: nextMonthlyReset(now),
    credits: credits ? { remaining: credits.remaining } : null,
    baseline: await accountBaseline(key, options, deadline)
  }
  provider.limits = limits
  provider.status = enabled.length === 1 ? '1 key' : enabled.length + ' keys'
  return provider
}

function openrouterOptions() {
  const raw = argValue('--openrouter-average-months')
  const n = raw === '' ? DEFAULT_AVERAGE_MONTHS : Number(raw)
  return {
    averageMonths: Number.isInteger(n) && n >= 0 && n <= MAX_AVERAGE_MONTHS ? n : DEFAULT_AVERAGE_MONTHS,
    baseline: parseBaselineArg(argValue('--openrouter-baseline'))
  }
}

async function collectOpenRouter() {
  const record = usageRecord('openrouter')
  const provider = {
    id: 'openrouter',
    name: 'OpenRouter',
    available: false,
    tier: '',
    status: '',
    hint: '',
    error: '',
    source: 'openrouter-api',
    keySource: '',
    limits: [],
    activity: activityOf(record),
    money: null,
    budgets: []
  }

  // A management key covers the whole account and wins over the inference key.
  const management = resolveManagementKey()
  if (management.key) return collectAccount(management.key, management.source, provider, openrouterOptions())
  if (management.error) {
    // A key that is configured but refused is shown with its reason; the
    // inference key is not used instead.
    provider.available = true
    provider.tier = 'Management key'
    provider.status = 'Management key not readable'
    provider.source = 'openrouter-management'
    provider.keySource = management.source
    provider.error = plain(management.error + ' ' + NO_FALLBACK_NOTE, 300)
    return provider
  }

  const key = resolveOpenRouterKey()
  if (key === '') return provider

  provider.available = true
  let keyDoc
  try {
    keyDoc = await getJson(OPENROUTER_API + '/key', key)
  } catch (e) {
    provider.error = scrub(e && e.message ? e.message : '', key) || 'could not read the OpenRouter key'
    return provider
  }
  const money = pickMoney(keyDoc)
  if (!money) {
    provider.error = 'OpenRouter returned no key data'
    return provider
  }
  try {
    money.credits = pickCredits(await getJson(OPENROUTER_API + '/credits', key))
  } catch (e) {
    // Account credits are optional; the key's own budget is the primary read.
    money.credits = null
  }
  provider.money = money
  provider.tier = money.label
  provider.status = money.limit !== null ? 'Key limit' : 'No key limit'
  return provider
}

// --------------------------------------------------------------------- main

async function main() {
  const providers = await Promise.all([
    Promise.resolve().then(collectClaude).catch(function(e) { return null }),
    Promise.resolve().then(collectCodex).catch(function(e) { return null }),
    Promise.resolve().then(collectGrok).catch(function(e) { return null }),
    Promise.resolve().then(collectOpencode).catch(function(e) { return null }),
    collectOpenRouter().catch(function(e) {
      return {
        id: 'openrouter', name: 'OpenRouter', available: false, tier: '', status: '', hint: '',
        error: scrub(e && e.message ? e.message : '', '') || 'collector failed', source: 'openrouter-api', keySource: '',
        limits: [], activity: activityOf(usageRecord('openrouter')), money: null, budgets: []
      }
    })
  ])

  process.stdout.write(JSON.stringify({
    ok: true,
    fetchedAt: nowMs(),
    providers: providers.filter(Boolean)
  }) + '\n')
}

if (require.main === module) {
  main().catch(function(e) {
    process.stdout.write(JSON.stringify({ ok: false, error: scrub(e && e.message ? e.message : '', '') || 'collector failed' }) + '\n')
  })
} else {
  module.exports = {
    normalizeManagementKey: normalizeManagementKey,
    readManagementKeyFile: readManagementKeyFile,
    scrub: scrub,
    pickMoney: pickMoney,
    nextDailyReset: nextDailyReset,
    nextWeeklyReset: nextWeeklyReset,
    nextMonthlyReset: nextMonthlyReset,
    nextReset: nextReset,
    monthKey: monthKey,
    baselineRange: baselineRange,
    pickCostMetric: pickCostMetric,
    queryBody: queryBody,
    bucketDateMs: bucketDateMs,
    parseTotal: parseTotal,
    parseBaselineArg: parseBaselineArg,
    keyRows: keyRows,
    keyName: keyName,
    activeKeys: activeKeys,
    MONTH_NAMES: MONTH_NAMES
  }
}
