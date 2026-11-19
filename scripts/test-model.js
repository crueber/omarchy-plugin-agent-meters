#!/usr/bin/env node
'use strict'

// Round-trip the Agent Meters model helpers without network or QML.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const repo = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(repo, 'Model.js'), 'utf8')
  .replace(/^\.pragma library\s*$/m, '')
const context = {
  console, Date, JSON, Math, String, Number, Array, Object, isFinite, RegExp
}
vm.createContext(context)
vm.runInContext(source, context)

const M = context
const now = Date.UTC(2026, 10, 15, 12, 0, 0)
const cycleEnd = Date.UTC(2026, 11, 1, 0, 0, 0)

function provider(overrides) {
  return Object.assign({
    id: 'claude',
    name: 'Claude',
    available: true,
    tier: 'Max 5x',
    status: '',
    error: '',
    source: 'test',
    limits: [],
    activity: { period: 'today', prompts: 0, tokens: 0, totalPrompts: 0, accounts: 0 },
    money: null,
    budgets: []
  }, overrides || {})
}

function limit(key, percent, resetsAt, extra) {
  return Object.assign({
    key: key,
    label: key,
    short: key === 'session' ? '5h' : key === 'weekly' ? '7d' : key,
    detail: key,
    percent: percent,
    resetsAt: resetsAt || 0,
    stale: false
  }, extra || {})
}

function result(providers) {
  return JSON.stringify({ ok: true, fetchedAt: now, providers: providers })
}

function test(name, fn) {
  fn()
  process.stdout.write('ok — ' + name + '\n')
}

test('parses and sanitises a collector result', function() {
  const parsed = M.parseResult(result([
    provider({
      id: 'claude',
      limits: [limit('session', 12, cycleEnd), limit('weekly', 45, cycleEnd), limit('fable', 8, cycleEnd)],
      tier: '<b>Max</b>'
    }),
    { id: 'nope' },
    provider({ id: 'opencode', limits: [limit('session', 1, cycleEnd)] })
  ]))
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.providers.length, 2)
  assert.strictEqual(parsed.providers[0].tier, '\u2039b\u203aMax\u2039/b\u203a')
  assert.strictEqual(parsed.providers[0].limits.length, 3)
  assert.strictEqual(parsed.providers[0].limits[2].key, 'fable')
})

test('rejects an unreadable or failed result', function() {
  assert.strictEqual(M.parseResult('not json'), null)
  assert.strictEqual(M.parseResult(JSON.stringify({ ok: false, error: 'boom' })).ok, false)
})

test('orders and filters the visible providers', function() {
  const list = [
    provider({ id: 'claude' }),
    provider({ id: 'codex' }),
    provider({ id: 'grok' }),
    provider({ id: 'opencode' }),
    provider({ id: 'openrouter' }),
    provider({ id: 'grok', available: false })
  ]
  const order = M.visibleProviders(list, {}).map(function(p) { return p.id }).join(',')
  assert.strictEqual(order, 'openrouter,opencode,grok,codex,claude')
  const hidden = M.visibleProviders(list, { claude: false, openrouter: false }).map(function(p) { return p.id }).join(',')
  assert.strictEqual(hidden, 'opencode,grok,codex')
})

test('honours a saved agent order and moves within it', function() {
  const list = [
    provider({ id: 'claude' }),
    provider({ id: 'codex' }),
    provider({ id: 'grok' }),
    provider({ id: 'opencode' }),
    provider({ id: 'openrouter' })
  ]
  const ordered = M.orderedProviders(list, {}, 'grok,claude').map(function(p) { return p.id }).join(',')
  assert.strictEqual(ordered, 'grok,claude,openrouter,opencode,codex')
  assert.strictEqual(M.parseOrder('grok, bogus, grok, claude').join(','), 'grok,claude')
  assert.strictEqual(M.moveOrder('grok,claude,opencode,openrouter', 'claude', -1).join(','), 'claude,grok,opencode,openrouter')
  assert.strictEqual(M.moveOrder('claude,grok', 'claude', -1).join(','), 'claude,grok')
  assert.strictEqual(M.moveOrder('claude,grok', 'claude', 1).join(','), 'grok,claude')
})

test('computes a drag-and-drop insertion order', function() {
  const all = ['openrouter', 'opencode', 'grok', 'codex', 'claude']
  assert.strictEqual(M.reorderInsert('', all, 'claude', 0).join(','), 'claude,openrouter,opencode,grok,codex')
  assert.strictEqual(M.reorderInsert('', all, 'openrouter', 4).join(','), 'opencode,grok,codex,claude,openrouter')
  assert.strictEqual(M.reorderInsert('', all, 'grok', 2).join(','), 'openrouter,opencode,grok,codex,claude')
  // A hidden agent keeps its slot when a visible agent moves around it.
  assert.strictEqual(M.reorderInsert('openrouter,opencode,grok,codex,claude', ['opencode', 'claude'], 'claude', 0).join(','), 'openrouter,claude,opencode,grok,codex')
  assert.strictEqual(M.reorderInsert('', all, 'claude', 99).join(','), 'openrouter,opencode,grok,codex,claude')
  assert.strictEqual(M.reorderInsert('', all, 'claude', -5).join(','), 'claude,openrouter,opencode,grok,codex')
})

test('filters shown agents without changing their order', function() {
  const list = [
    provider({ id: 'opencode' }),
    provider({ id: 'claude' }),
    provider({ id: 'openrouter' })
  ]
  assert.strictEqual(M.shownProviders(list, {}).map(function(p) { return p.id }).join(','), 'opencode,claude,openrouter')
  assert.strictEqual(M.shownProviders(list, { claude: false }).map(function(p) { return p.id }).join(','), 'opencode,openrouter')
  assert.strictEqual(M.shownProviders(list, { claude: false, opencode: false, openrouter: false }).length, 0)
})

test('maps percentages to states at the configured thresholds', function() {
  assert.strictEqual(M.stateOf(12, 70, 90), 'normal')
  assert.strictEqual(M.stateOf(70, 70, 90), 'warning')
  assert.strictEqual(M.stateOf(90, 70, 90), 'critical')
  assert.strictEqual(M.percentText(45.5), '45.5%')
  assert.strictEqual(M.percentText(0), '0%')
})

test('formats money, counts and resets', function() {
  assert.strictEqual(M.formatCurrency(1234.5), '$1,234.50')
  assert.strictEqual(M.formatCurrency(null), '\u2014')
  assert.strictEqual(M.formatCount(1074715), '1.1M')
  assert.strictEqual(M.formatCount(135), '135')
  assert.strictEqual(M.resetText(now + 3 * 3600000, now), 'Resets in 3h 0m')
  assert.strictEqual(M.resetText(now - 1, now), 'Reset is due')
})

test('builds a meter window for a limited OpenRouter key', function() {
  const report = provider({
    id: 'openrouter',
    money: {
      label: 'sk-or-v1-123...abc',
      limit: 20,
      spend: 10,
      resetInterval: 'monthly',
      resetsAt: cycleEnd,
      credits: { total: 50, used: 20, remaining: 30 }
    }
  })
  const window = M.openrouterWindow(report, M.emptyHistory(), 70, 90)
  assert.strictEqual(window.mode, 'meter')
  assert.strictEqual(window.percent, 50)
  assert.strictEqual(window.effectiveLimit, 20)
  assert.strictEqual(window.color, 'normal')
})

test('uses the previous cycle as the limit for an unlimited key', function() {
  const report = provider({
    id: 'openrouter',
    money: { label: 'key', limit: null, spend: 8, resetInterval: 'monthly', resetsAt: cycleEnd, credits: null }
  })
  const history = M.normalizeHistory({
    current: { key: 'c', end: cycleEnd, spend: 8, lastObservedAt: now },
    previous: { key: 'p', end: cycleEnd - 30 * 86400000, spend: 12, lastObservedAt: cycleEnd - 30 * 86400000 }
  })
  const window = M.openrouterWindow(report, history, 70, 90)
  assert.strictEqual(window.mode, 'meter')
  assert.strictEqual(window.effectiveLimit, 12)
  assert.strictEqual(window.percent, 66.66666666666666)

  const over = M.openrouterWindow(Object.assign({}, report, {
    money: Object.assign({}, report.money, { spend: 13 })
  }), history, 70, 90)
  assert.strictEqual(over.mode, 'dollars')
  assert.strictEqual(over.color, 'yellow')
})

test('advances one previous cycle only when it was observed near its end', function() {
  const first = M.advanceHistory(M.emptyHistory(), {
    label: 'key', limit: 20, spend: 3, resetInterval: 'monthly', resetsAt: cycleEnd, credits: null
  }, now)
  assert.strictEqual(first.current.end, cycleEnd)

  const same = M.advanceHistory(first, {
    label: 'key', limit: 20, spend: 5, resetInterval: 'monthly', resetsAt: cycleEnd, credits: null
  }, now + 1000)
  assert.strictEqual(same.current.spend, 5)

  const observedLate = M.advanceHistory({ current: Object.assign({}, same.current, { lastObservedAt: cycleEnd }), previous: null }, {
    label: 'key', limit: 20, spend: 0, resetInterval: 'monthly', resetsAt: cycleEnd + 30 * 86400000, credits: null
  }, cycleEnd + 1000)
  assert.ok(observedLate.previous)
  assert.strictEqual(observedLate.previous.spend, 5)
})

test('round-trips the cache with no key material', function() {
  const providerList = [
    provider({ id: 'claude', limits: [limit('session', 12, cycleEnd)] }),
    provider({
      id: 'openrouter',
      money: {
        label: 'sk-or-v1-123...abc',
        limit: 20,
        spend: 4,
        resetInterval: 'monthly',
        resetsAt: cycleEnd,
        credits: null
      }
    })
  ]
  const raw = M.serializeCache(providerList, M.emptyHistory(), now, now, 0, '')
  assert.ok(raw.length < 8000)
  assert.strictEqual(raw.indexOf('Bearer'), -1)
  const parsed = M.parseCache(raw, now)
  assert.strictEqual(parsed.providers.length, 2)
  assert.strictEqual(parsed.providers[1].money.limit, 20)
  assert.strictEqual(M.parseCache('{"version":99}', now), null)
})

test('writes compact bar text and a multi-line tooltip', function() {
  const grok = provider({
    id: 'grok',
    name: 'Grok',
    tier: 'SuperGrok',
    limits: [limit('weekly', 2, cycleEnd), limit('bot', 42, cycleEnd, { short: 'bot', stale: true })]
  })
  assert.strictEqual(M.compactText(grok, M.emptyHistory(), 70, 90), '7d 2% · bot —')
  const tip = M.providerTooltip(grok, M.emptyHistory(), now, 70, 90)
  assert.ok(tip.indexOf('Grok · SuperGrok') === 0)
  assert.ok(tip.indexOf('stale') > 0)
})

test('intervalName knows daily', function() {
  assert.strictEqual(M.intervalName('daily'), 'Daily')
  assert.strictEqual(M.intervalName('day'), 'Daily')
  assert.strictEqual(M.intervalName('weekly'), 'Weekly')
  assert.strictEqual(M.intervalName('monthly'), 'Monthly')
  assert.strictEqual(M.intervalName(''), 'Monthly')
})

// ------------------------------------------------- OpenRouter account-wide

const nov19 = Date.UTC(2026, 10, 19, 12)
const dec1 = Date.UTC(2026, 11, 1)
const nov1 = Date.UTC(2026, 10, 1)
const oct1 = Date.UTC(2026, 9, 1)
const sep1 = Date.UTC(2026, 8, 1)

function accountProvider(overrides, moneyOverrides) {
  const limits = [
    { key: 'credits', label: 'Credits', short: 'cr', detail: 'Credits', percent: 0, resetsAt: 0, stale: false, amount: 20.81, limited: false },
    { key: 'key-aaaa', label: 'hermes', short: 'key', detail: 'hermes', percent: 40, resetsAt: dec1, stale: false, amount: null, limited: false },
    { key: 'key-bbbb', label: 'Unlimited', short: 'key', detail: 'Unlimited', percent: 0, resetsAt: 0, stale: false, amount: 3.1, limited: false },
    { key: 'key-cccc', label: 'Weekly bot', short: 'key', detail: 'Weekly bot', percent: 95, resetsAt: dec1, stale: false, amount: null, limited: false },
    { key: 'key-dddd', label: 'Fourth', short: 'key', detail: 'Fourth', percent: 10, resetsAt: dec1, stale: false, amount: null, limited: false }
  ]
  const raw = provider(Object.assign({
    id: 'openrouter',
    name: 'OpenRouter',
    tier: 'Management key',
    status: '6 keys',
    source: 'openrouter-management',
    keySource: 'secret-service',
    limits: limits,
    money: Object.assign({
      scope: 'account', label: 'All keys', limit: null, spend: 49.93, resetInterval: 'monthly', resetsAt: dec1,
      credits: { remaining: 20.81 },
      baseline: { month: '2026-11', months: 2, average: 61.2, checkedAt: nov19 }
    }, moneyOverrides || {})
  }, overrides || {}))
  return M.parseResult(result([raw])).providers[0]
}

function accountHistory(cycles) {
  // cycles: [{ end, spend }] most recent first
  return M.normalizeHistory({
    scope: 'account',
    current: { key: 'c', end: dec1, spend: 49.93, lastObservedAt: nov19 },
    completed: cycles.map(function(c) { return { key: 'k' + c.end, end: c.end, spend: c.spend, lastObservedAt: c.end } })
  })
}

test('account-wide: parsed rows keep amounts, flags and up to thirteen limits', function() {
  const p = accountProvider()
  assert.strictEqual(p.keySource, 'secret-service')
  assert.strictEqual(p.money.scope, 'account')
  assert.strictEqual(p.money.baseline.average, 61.2)
  assert.strictEqual(p.limits[0].amount, 20.81)
  assert.strictEqual(p.limits[1].amount, null)
  const many = []
  for (let i = 0; i < 20; i++) many.push({ key: 'key-' + i, label: 'k' + i, short: 'key', percent: 1, amount: null })
  assert.strictEqual(accountProvider({ limits: many }).limits.length, 13, 'credits + twelve keys')
  assert.strictEqual(M.parseResult(result([provider({ id: 'claude', limits: many })])).providers[0].limits.length, 6)
  assert.strictEqual(M.parseResult(result([provider({ id: 'openrouter', keySource: 'sk-or-v1-secret' })])).providers[0].keySource, '',
    'only a known source name survives')
})

test('account-wide: the month meter against the analytics average', function() {
  const p = accountProvider()
  const windows = M.windowsFor(p, M.emptyHistory(), 70, 90, { averageMonths: 2, keyRows: 3 })
  const w = windows[0]
  assert.strictEqual(w.detail, 'All keys · this month')
  assert.strictEqual(w.mode, 'meter')
  assert.ok(Math.abs(w.percent - 49.93 / 61.2 * 100) < 1e-9)
  assert.strictEqual(M.windowValueText(w), '81.6%')
  assert.strictEqual(M.windowCaption(w, Date.UTC(2026, 10, 19, 16, 30)), '$49.93 of $61.20 avg (Sep–Oct) · Resets in 11d 7h')
  assert.strictEqual(M.barDollarsText(p, M.emptyHistory(), 70, 90, {}), '$20.81')
  assert.strictEqual(M.barDollarsColor(p, M.emptyHistory(), 70, 90, {}), 'normal')
  assert.strictEqual(M.barWindows(p, M.emptyHistory(), 70, 90, {}).map(function(x) { return x.key }).join(','), 'cycle', 'only the month meter in the bar')
  assert.strictEqual(M.barText(p, M.emptyHistory(), 70, 90, {}), '$20.81 · 81.6%')
  assert.strictEqual(M.compactText(p, M.emptyHistory(), 70, 90, {}), '$20.81 credits left · $49.93 this month')
  const tip = M.providerTooltip(p, M.emptyHistory(), nov19, 70, 90, {})
  assert.strictEqual(tip, 'OpenRouter · Management key\n6 keys\n  $20.81 credits left · $49.93 this month')
  assert.strictEqual(M.moneySummary(p.money), '', 'no per-key money line account-wide')
  assert.strictEqual(M.baselineArg(p), '2026-11:2:61.2000:' + nov19)
})

test('account-wide: credits row, top N keys, value rows', function() {
  const p = accountProvider()
  const windows = M.windowsFor(p, M.emptyHistory(), 70, 90, { averageMonths: 2, keyRows: 3 })
  assert.strictEqual(windows.map(function(w) { return w.key }).join(','), 'cycle,credits,key-aaaa,key-bbbb,key-cccc')
  assert.strictEqual(windows[1].mode, 'dollars')
  assert.strictEqual(M.windowValueText(windows[1]), '$20.81 left')
  assert.strictEqual(windows[1].meterVisible, false, 'credits: no meter')
  assert.strictEqual(M.windowValueText(windows[3]), '$3.10 this month')
  assert.strictEqual(windows[2].mode, 'meter')
  assert.strictEqual(M.windowValueText(windows[2]), '40%')
  assert.strictEqual(windows[4].color, 'critical')
  assert.strictEqual(M.windowsFor(p, M.emptyHistory(), 70, 90, { keyRows: 0 }).length, 2, 'no key rows')
  assert.strictEqual(M.windowsFor(p, M.emptyHistory(), 70, 90, { keyRows: 12 }).length, 6)
  assert.strictEqual(M.windowsFor(p, M.emptyHistory(), 70, 90, {}).length, 5, 'default three key rows')
  assert.strictEqual(M.providerColor(p, M.emptyHistory(), 70, 90, {}), 'critical', 'a key at 95% wins')
  const limited = accountProvider({ limits: [{ key: 'key-x', label: 'x', short: 'key', percent: 20, limited: true }] })
  assert.strictEqual(M.isAlarming(limited, M.emptyHistory(), 70, 90, {}), true, 'an exhausted key alarms')
})

test('account-wide: over the average is yellow with an honest percent', function() {
  const p = accountProvider({}, { spend: 73.44 })
  const w = M.windowsFor(p, M.emptyHistory(), 70, 90, { keyRows: 0 })[0]
  assert.strictEqual(w.over, true)
  assert.strictEqual(w.color, 'yellow')
  assert.strictEqual(M.windowValueText(w), '120%')
  assert.strictEqual(w.fillPercent, 100, 'the bar fill is capped')
  assert.ok(M.windowCaption(w, nov19).indexOf('over the 2-month average') > 0)
  assert.strictEqual(M.providerColor(p, M.emptyHistory(), 70, 90, { keyRows: 0 }), 'yellow')
  const one = accountProvider({}, { spend: 50, baseline: { month: '2026-11', months: 1, average: 40, checkedAt: nov19 } })
  const w1 = M.windowsFor(one, M.emptyHistory(), 70, 90, { averageMonths: 1, keyRows: 0 })[0]
  assert.strictEqual(M.windowCaption(w1, dec1 - 3600000), '$50.00 of $40.00 (Oct) · Resets in 1h 0m · over last month')
})

test('account-wide: history fallback, fewer months, N=0 and stale baselines', function() {
  const noAnalytics = accountProvider({}, { baseline: { month: '2026-11', months: 2, average: 0, checkedAt: nov19 } })
  const h3 = accountHistory([{ end: nov1, spend: 60 }, { end: oct1, spend: 50 }, { end: sep1, spend: 10 }])
  let w = M.windowsFor(noAnalytics, h3, 70, 90, { averageMonths: 2, keyRows: 0 })[0]
  assert.strictEqual(w.effectiveLimit, 55)
  assert.strictEqual(w.baselineText, 'avg (Sep–Oct)')
  w = M.windowsFor(noAnalytics, h3, 70, 90, { averageMonths: 3, keyRows: 0 })[0]
  assert.strictEqual(w.baselineText, 'avg (Aug–Oct)')
  assert.strictEqual(w.effectiveLimit, 40)
  w = M.windowsFor(noAnalytics, h3, 70, 90, { averageMonths: 1, keyRows: 0 })[0]
  assert.strictEqual(w.baselineText, '(Oct)')
  assert.strictEqual(w.effectiveLimit, 60)
  w = M.windowsFor(noAnalytics, h3, 70, 90, { averageMonths: 5, keyRows: 0 })[0]
  assert.strictEqual(w.baselineText, 'avg (3 of 5 months)', 'fewer months known than asked for')
  assert.strictEqual(w.effectiveLimit, 40)
  w = M.windowsFor(accountProvider({}, { spend: 70, baseline: null }), h3, 70, 90, { averageMonths: 5, keyRows: 0 })[0]
  assert.strictEqual(w.overNote, 'over the 3-month average', 'the note names the months actually averaged')

  const off = M.windowsFor(accountProvider(), h3, 70, 90, { averageMonths: 0, keyRows: 0 })[0]
  assert.strictEqual(off.mode, 'dollars', 'N=0: no meter')
  assert.strictEqual(M.windowValueText(off), '$49.93')
  assert.strictEqual(M.barWindows(accountProvider(), h3, 70, 90, { averageMonths: 0 }).length, 0)

  const none = M.windowsFor(noAnalytics, M.emptyHistory(), 70, 90, { keyRows: 0 })[0]
  assert.strictEqual(none.mode, 'dollars', 'no baseline at all: dollars')

  const otherN = M.windowsFor(accountProvider(), M.emptyHistory(), 70, 90, { averageMonths: 3, keyRows: 0 })[0]
  assert.strictEqual(otherN.mode, 'dollars', 'analytics for N=2 is not used for N=3')

  const lastMonth = accountProvider({}, { resetsAt: Date.UTC(2027, 0, 1) })
  assert.strictEqual(M.windowsFor(lastMonth, M.emptyHistory(), 70, 90, { keyRows: 0 })[0].mode, 'dollars',
    'a baseline for November is not December\'s')

  const keyScoped = M.normalizeHistory({ current: { key: 'c', end: dec1, spend: 1, lastObservedAt: nov19 },
    previous: { key: 'p', end: nov1, spend: 30, lastObservedAt: nov1 } })
  assert.strictEqual(M.windowsFor(noAnalytics, keyScoped, 70, 90, { keyRows: 0 })[0].mode, 'dollars',
    'a per-key history is never an account baseline')
})

test('account-wide: no credits falls back to the month\'s spend in the bar', function() {
  const p = accountProvider({ limits: [] }, { credits: null })
  assert.strictEqual(M.barDollarsText(p, M.emptyHistory(), 70, 90, {}), '$49.93')
  assert.strictEqual(M.compactText(p, M.emptyHistory(), 70, 90, {}), '$49.93 this month')
})

test('history keeps twelve completed cycles and migrates the 1.1 shape', function() {
  const legacy = M.normalizeHistory({
    current: { key: 'c', end: dec1, spend: 3, lastObservedAt: 1 },
    previous: { key: 'p', end: nov1, spend: 4, lastObservedAt: nov1 }
  })
  assert.strictEqual(legacy.scope, 'key')
  assert.strictEqual(legacy.completed.length, 1)
  assert.strictEqual(legacy.previous.spend, 4)

  let h = M.emptyHistory()
  for (let i = 0; i < 15; i++) {
    const end = Date.UTC(2025, i, 1)
    h = M.advanceHistory(h, { scope: 'account', spend: i + 1, resetsAt: end }, end - 3600000)
  }
  assert.strictEqual(h.scope, 'account')
  assert.strictEqual(h.completed.length, 12, 'at most twelve')
  assert.strictEqual(h.previous.spend, 14)
  assert.strictEqual(h.completed[11].spend, 3)

  const unobserved = Object.assign({}, h, { current: Object.assign({}, h.current, { lastObservedAt: h.current.end - 10 * 86400000 }) })
  const gap = M.advanceHistory(unobserved, { scope: 'account', spend: 1, resetsAt: Date.UTC(2026, 6, 1) }, Date.UTC(2026, 5, 10))
  assert.strictEqual(gap.completed.length, 0, 'a missed end breaks the chain')

  const switched = M.advanceHistory(h, { scope: 'key', spend: 2, resetsAt: Date.UTC(2026, 3, 1) }, Date.UTC(2026, 2, 20))
  assert.strictEqual(switched.scope, 'key')
  assert.strictEqual(switched.completed.length, 0, 'switching modes starts a new series')

  const bad = M.normalizeHistory({ scope: 'account', current: { end: dec1, spend: 1 },
    completed: [{ end: nov1, spend: 1 }, { end: dec1, spend: 2 }, { end: oct1, spend: 3 }] })
  assert.strictEqual(bad.completed.length, 1, 'the chain is cut at the first out-of-order cycle')

  const raw = M.serializeCache([], h, now, now, 0, '')
  const back = M.parseCache(raw, now)
  assert.strictEqual(back.history.completed.length, 12)
  assert.strictEqual(back.history.scope, 'account')
})

test('the cache keeps the account rows and baseline but never a key', function() {
  const p = accountProvider()
  const raw = M.serializeCache([p], M.emptyHistory(), now, now, 0, '')
  for (const secret of ['sk-or', 'Bearer']) assert.strictEqual(raw.indexOf(secret), -1)
  const back = M.parseCache(raw, now).providers[0]
  assert.strictEqual(back.limits.length, 5)
  assert.strictEqual(back.limits[0].amount, 20.81)
  assert.strictEqual(JSON.stringify(back.money.baseline), JSON.stringify({ month: '2026-11', months: 2, average: 61.2, checkedAt: nov19 }))
  assert.strictEqual(back.keySource, 'secret-service')
  const injected = accountProvider({}, { baseline: { month: '2026-11; rm -rf ~', months: 2, average: 1, checkedAt: 1 } })
  assert.strictEqual(injected.money.baseline, null)
  assert.strictEqual(M.baselineArg(injected), '')
})

test('management key status text names the source, never the key', function() {
  assert.strictEqual(M.managementKeyText(accountProvider()), 'Management key: set (Secret Service)')
  assert.strictEqual(M.managementKeyText(accountProvider({ keySource: 'file' })), 'Management key: set (file)')
  assert.strictEqual(M.managementKeyText(accountProvider({ keySource: 'env' })), 'Management key: set (env)')
  assert.ok(M.managementKeyText(provider({ id: 'openrouter' })).indexOf('Management key: not set') === 0)
  assert.strictEqual(M.managementKeyText(provider({ id: 'claude' })), '')
})

test('per-key mode keeps its caption and money line', function() {
  const report = provider({
    id: 'openrouter',
    money: { label: 'key', limit: null, spend: 13, resetInterval: 'monthly', resetsAt: cycleEnd, credits: { total: 50, used: 20, remaining: 30 } }
  })
  const history = M.normalizeHistory({
    current: { key: 'c', end: cycleEnd, spend: 13, lastObservedAt: now },
    previous: { key: 'p', end: cycleEnd - 30 * 86400000, spend: 12, lastObservedAt: cycleEnd - 30 * 86400000 }
  })
  const w = M.windowsFor(report, history, 70, 90, {})[0]
  assert.strictEqual(w.over, true)
  assert.strictEqual(M.windowCaption(w, now), 'Resets in 15d 12h · over the previous cycle')
  assert.strictEqual(M.moneySummary(M.normalizeMoney(report.money)), '$30.00 credits left · No key limit')
  assert.strictEqual(M.moneySummary(M.normalizeMoney({ label: 'k', limit: 20, spend: 1, resetInterval: 'daily' })), '$20.00 daily limit')
  assert.strictEqual(M.barDollarsText(report, history, 70, 90, {}), '$13.00')
  assert.strictEqual(M.barDollarsColor(report, history, 70, 90, {}), 'yellow')
})

process.stdout.write('all model tests passed\n')
