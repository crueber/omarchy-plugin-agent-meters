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

  if (raw && raw.ok === true) {
    provider.tier = plain(raw.tier, 60)
    const weekly = raw.weekly
    if (weekly && number(weekly.usedPercent) !== null) {
      provider.limits.push({
        key: 'weekly',
        label: 'Weekly',
        short: 'wk',
        detail: weekly.periodType === 'USAGE_PERIOD_TYPE_MONTHLY' ? 'Monthly limit' : 'Weekly limit',
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
      stale: entry.limited === true
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

function getJson(url, key) {
  return new Promise(function(resolve, reject) {
    const req = https.get(url, {
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        'User-Agent': 'omarchy-agent-meters/1.0'
      }
    }, function(res) {
      let size = 0
      const chunks = []
      res.on('data', function(chunk) {
        size += chunk.length
        if (size > MAX_BODY) {
          req.destroy()
          reject(new Error('response too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', function() {
        let doc
        try {
          doc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (e) {
          reject(new Error('invalid JSON from OpenRouter'))
          return
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(doc)
          return
        }
        const message = doc && doc.error && doc.error.message
        reject(new Error(message ? String(message).slice(0, 240) : 'HTTP ' + res.statusCode))
      })
    })
    req.setTimeout(HTTP_TIMEOUT_MS, function() { req.destroy(new Error('request timed out')) })
    req.on('error', reject)
  })
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
    else if (interval.indexOf('day') >= 0) spend = number(source.usage_daily)
    else spend = number(source.usage_monthly) !== null ? number(source.usage_monthly) : number(source.usage)
  }
  return {
    label: plain(source.label, 80),
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
    limits: [],
    activity: activityOf(record),
    money: null,
    budgets: []
  }

  const key = resolveOpenRouterKey()
  if (key === '') return provider

  provider.available = true
  let keyDoc
  try {
    keyDoc = await getJson('https://openrouter.ai/api/v1/key', key)
  } catch (e) {
    provider.error = e && e.message ? e.message : 'could not read the OpenRouter key'
    return provider
  }
  const money = pickMoney(keyDoc)
  if (!money) {
    provider.error = 'OpenRouter returned no key data'
    return provider
  }
  try {
    money.credits = pickCredits(await getJson('https://openrouter.ai/api/v1/credits', key))
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
        error: e && e.message ? e.message : 'collector failed', source: 'openrouter-api',
        limits: [], activity: activityOf(usageRecord('openrouter')), money: null, budgets: []
      }
    })
  ])

  process.stdout.write(JSON.stringify({
    ok: true,
    fetchedAt: Date.now(),
    providers: providers.filter(Boolean)
  }) + '\n')
}

main().catch(function(e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e && e.message ? String(e.message).slice(0, 300) : 'collector failed' }) + '\n')
})
