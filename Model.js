.pragma library

// Pure helpers for the Agent Meters widget: parsing the collector's provider
// list, window/state computation, OpenRouter cycle comparison, cache handling
// and the multi-monitor poll coordination. No QML imports and no I/O, so the
// whole file is unit-testable with plain Node.

var CACHE_VERSION = 1
var PROVIDER_ORDER = ["openrouter", "opencode", "grok", "codex", "claude"]
var AUTO_MIN_MS = 60000
var FORCE_MIN_MS = 30000
var FAILURE_CAP_MS = 600000
var MAX_COMPLETED_CYCLES = 12
var MAX_AVERAGE_MONTHS = 12
var DEFAULT_AVERAGE_MONTHS = 2
var DEFAULT_KEY_ROWS = 3
var MAX_KEY_ROWS = 12
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
var ACCOUNT_LABEL = "All keys"
var MANAGEMENT_HELPER = "scripts/set-management-key.sh"

// ----------------------------------------------------------------- sanitizers

function number(value) {
  if (value === null || value === undefined || value === '') return null
  var n = Number(value)
  return isFinite(n) ? n : null
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function clampInt(value, low, high, fallback) {
  var n = Number(value)
  if (!isFinite(n)) return fallback
  return Math.round(clamp(n, low, high))
}

function text(value, max) {
  if (typeof value !== "string") return ""
  return value.slice(0, max || 200)
}

// Omarchy-owned components render plain text only when told to; neutralise
// markup-shaped data at the boundary instead of trusting every sink.
function plain(value, max) {
  return text(value, max).replace(/</g, "\u2039").replace(/>/g, "\u203a")
}

function dateMs(value) {
  var n = Number(value)
  if (isFinite(n) && n > 0) return n <= 1e12 ? Math.round(n * 1000) : Math.round(n)
  var parsed = Date.parse(String(value || ""))
  return isFinite(parsed) ? parsed : 0
}

function parseJson(raw) {
  if (typeof raw !== "string") return null
  var value = raw.replace(/^\uFEFF/, "").trim()
  if (value === "" || value.length > 400000) return null
  try {
    return JSON.parse(value)
  } catch (e) {}
  var start = value.indexOf("{")
  var end = value.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(value.slice(start, end + 1))
    } catch (e) {}
  }
  return null
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// --------------------------------------------------------------- window model

function percent(value, maxValue) {
  var n = number(value)
  return n === null ? 0 : clamp(n, 0, maxValue === undefined ? 100 : maxValue)
}

function stateOf(value, warnPercent, criticalPercent) {
  var n = number(value) || 0
  if (n >= criticalPercent) return "critical"
  if (n >= warnPercent) return "warning"
  return "normal"
}

function highest(list) {
  var best = null
  for (var i = 0; i < (list || []).length; i++) {
    var item = list[i]
    if (!item) continue
    if (best === null || (number(item.percent) || 0) > (number(best.percent) || 0)) best = item
  }
  return best
}

// `cap` (default 100) lets the account-wide month say "120%" over its average.
function percentText(value, cap) {
  var n = number(value)
  if (n === null) return "\u2014"
  var rounded = Math.round(clamp(n, 0, cap === undefined ? 100 : cap) * 10) / 10
  return (rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded)) + "%"
}

function formatCurrency(value) {
  var n = number(value)
  if (n === null) return "\u2014"
  var sign = n < 0 ? "-" : ""
  var fixed = Math.abs(n).toFixed(2)
  var parts = fixed.split(".")
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return sign + "$" + parts.join(".")
}

function formatCount(value) {
  var n = number(value)
  if (n === null) return "\u2014"
  var abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  if (abs >= 1e4) return Math.round(n / 1e3) + "K"
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K"
  return String(Math.round(n))
}

function resetText(resetsAt, nowMs) {
  var at = number(resetsAt) || 0
  if (at <= 0) return ""
  var delta = at - (Number(nowMs) || Date.now())
  if (delta <= 0) return "Reset is due"
  var minutes = Math.round(delta / 60000)
  if (minutes < 60) return "Resets in " + Math.max(1, minutes) + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 48) return "Resets in " + hours + "h " + (minutes % 60) + "m"
  var days = Math.floor(hours / 24)
  return "Resets in " + days + "d " + (hours % 24) + "h"
}

function updatedText(lastFetchMs, nowMs) {
  var at = number(lastFetchMs) || 0
  if (at <= 0) return ""
  var seconds = Math.max(0, Math.round(((Number(nowMs) || Date.now()) - at) / 1000))
  if (seconds < 15) return "Updated just now"
  if (seconds < 90) return "Updated " + seconds + "s ago"
  var minutes = Math.round(seconds / 60)
  if (minutes < 90) return "Updated " + minutes + "m ago"
  return "Updated " + Math.round(minutes / 60) + "h ago"
}

function tokensText(value) {
  var n = number(value) || 0
  if (n <= 0) return ""
  return formatCount(n) + " tokens"
}

function intervalName(value) {
  var text = String(value || "").toLowerCase()
  if (text.indexOf("week") >= 0) return "Weekly"
  if (text.indexOf("day") >= 0 || text.indexOf("daily") >= 0) return "Daily"
  if (text.indexOf("year") >= 0 || text.indexOf("annual") >= 0) return "Yearly"
  if (text === "total" || text === "lifetime" || text === "none") return "No reset"
  return "Monthly"
}

// ------------------------------------------------------------- provider model

function emptyActivity() {
  return { period: "today", prompts: 0, tokens: 0, totalPrompts: 0, accounts: 0 }
}

function normalizeActivity(value) {
  var source = value && typeof value === "object" ? value : {}
  return {
    period: source.period === "week" ? "week" : "today",
    prompts: Math.max(0, Math.round(number(source.prompts) || 0)),
    tokens: Math.max(0, Math.round(number(source.tokens) || 0)),
    totalPrompts: Math.max(0, Math.round(number(source.totalPrompts) || 0)),
    accounts: Math.max(0, Math.round(number(source.accounts) || 0))
  }
}

function normalizeLimit(value) {
  if (!value || typeof value !== "object") return null
  var key = plain(value.key, 24)
  if (key === "") return null
  return {
    key: key,
    label: plain(value.label, 40) || key,
    short: plain(value.short, 12) || key,
    detail: plain(value.detail, 80) || plain(value.label, 40) || key,
    percent: percent(value.percent),
    resetsAt: dateMs(value.resetsAt),
    stale: value.stale === true,
    // A value row (OpenRouter credits, an unlimited key): a dollar figure, no meter.
    amount: number(value.amount) !== null ? Math.max(0, number(value.amount)) : null,
    limited: value.limited === true
  }
}

function normalizeBaseline(value) {
  if (!value || typeof value !== "object") return null
  var month = String(value.month || "")
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  var months = clampInt(value.months, 1, MAX_AVERAGE_MONTHS, 0)
  if (months < 1 || Number(value.months) !== months) return null
  var average = number(value.average)
  return {
    month: month,
    months: months,
    average: average !== null && average > 0 ? average : 0,
    checkedAt: Math.max(0, number(value.checkedAt) || 0)
  }
}

function normalizeMoney(value) {
  if (!value || typeof value !== "object") return null
  var credits = value.credits && typeof value.credits === "object"
    ? {
      total: Math.max(0, number(value.credits.total) || 0),
      used: Math.max(0, number(value.credits.used) || 0),
      remaining: Math.max(0, number(value.credits.remaining) || 0)
    }
    : null
  var account = value.scope === "account"
  return {
    scope: account ? "account" : "key",
    baseline: account ? normalizeBaseline(value.baseline) : null,
    label: plain(value.label, 80),
    limit: number(value.limit) !== null && number(value.limit) > 0 ? number(value.limit) : null,
    spend: Math.max(0, number(value.spend) || 0),
    resetInterval: String(value.resetInterval || "monthly").slice(0, 24),
    resetsAt: dateMs(value.resetsAt),
    credits: credits
  }
}

function normalizeBudget(value) {
  if (!value || typeof value !== "object") return null
  var limit = Math.max(0, number(value.limit) || 0)
  if (limit <= 0) return null
  var spent = Math.max(0, number(value.spent) || 0)
  return {
    id: plain(value.id, 60) || "budget",
    limit: limit,
    spent: spent,
    percent: clamp(spent / limit * 100, 0, 100),
    resetsAt: dateMs(value.resetsAt)
  }
}

function normalizeProvider(value) {
  if (!value || typeof value !== "object") return null
  var id = plain(value.id, 24)
  if (id === "" || PROVIDER_ORDER.indexOf(id) < 0) return null
  var limits = []
  var list = Array.isArray(value.limits) ? value.limits : []
  // OpenRouter account-wide: Credits plus up to twelve keys.
  var maxLimits = id === "openrouter" ? 1 + MAX_KEY_ROWS : 6
  for (var i = 0; i < list.length && limits.length < maxLimits; i++) {
    var limit = normalizeLimit(list[i])
    if (limit) limits.push(limit)
  }
  var budgets = []
  var rawBudgets = Array.isArray(value.budgets) ? value.budgets : []
  for (var j = 0; j < rawBudgets.length && budgets.length < 6; j++) {
    var budget = normalizeBudget(rawBudgets[j])
    if (budget) budgets.push(budget)
  }
  return {
    id: id,
    name: plain(value.name, 40) || id,
    available: value.available === true,
    tier: plain(value.tier, 60),
    status: plain(value.status, 120),
    hint: plain(value.hint, 240),
    error: plain(value.error, 240),
    source: plain(value.source, 40),
    keySource: keySourceOf(value.keySource),
    limits: limits,
    activity: normalizeActivity(value.activity),
    money: normalizeMoney(value.money),
    budgets: budgets
  }
}

// Where the OpenRouter management key came from; never the key itself.
function keySourceOf(value) {
  return value === "env" || value === "secret-service" || value === "file" ? value : ""
}

function parseResult(raw) {
  var doc = parseJson(raw)
  if (!doc || typeof doc !== "object") return null
  if (doc.ok === false) return { ok: false, error: plain(doc.error, 240) || "collector failed" }
  var list = Array.isArray(doc.providers) ? doc.providers : []
  var providers = []
  for (var i = 0; i < list.length; i++) {
    var provider = normalizeProvider(list[i])
    if (provider) providers.push(provider)
  }
  return { ok: true, fetchedAt: dateMs(doc.fetchedAt), providers: providers }
}

function visibleProviders(providers, visibility) {
  var out = []
  var seen = {}
  var order = PROVIDER_ORDER
  for (var o = 0; o < order.length; o++) {
    var id = order[o]
    if (visibility && visibility[id] === false) continue
    for (var i = 0; i < (providers || []).length; i++) {
      var provider = providers[i]
      if (!provider || provider.id !== id || !provider.available || seen[id]) continue
      seen[id] = true
      out.push(provider)
    }
  }
  return out
}

// The user's bar order, persisted in the widget's `providerOrder` setting.
// Unknown or duplicate ids are dropped; agents not named there follow in the
// default order, so a new provider still appears without a settings edit.
function parseOrder(value) {
  var out = []
  var parts = String(value || "").split(",")
  for (var i = 0; i < parts.length; i++) {
    var id = String(parts[i] || "").trim()
    if (id === "" || PROVIDER_ORDER.indexOf(id) < 0 || out.indexOf(id) >= 0) continue
    out.push(id)
  }
  return out
}

function orderedProviders(providers, visibility, orderValue) {
  var visible = visibleProviders(providers, visibility)
  var order = parseOrder(orderValue)
  if (order.length === 0) return visible
  var out = []
  for (var i = 0; i < order.length; i++) {
    var provider = findVisible(visible, order[i])
    if (provider) out.push(provider)
  }
  for (var j = 0; j < visible.length; j++) {
    if (out.indexOf(visible[j]) < 0) out.push(visible[j])
  }
  return out
}

function findVisible(list, id) {
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i] && list[i].id === id) return list[i]
  }
  return null
}

function moveOrder(orderValue, id, delta) {
  var order = parseOrder(orderValue)
  if (order.length === 0 || order.indexOf(id) < 0) return order
  var index = order.indexOf(id)
  var target = index + delta
  if (target < 0 || target >= order.length) return order
  var moved = order[index]
  order[index] = order[target]
  order[target] = moved
  return order
}

// Full saved order after dropping `id` at `insertIndex` in the list of
// visible agents. Agents that are hidden right now keep their place.
function reorderInsert(orderValue, visibleIds, id, insertIndex) {
  var order = parseOrder(orderValue)
  if (order.length === 0) order = PROVIDER_ORDER.slice()
  for (var i = 0; i < PROVIDER_ORDER.length; i++) {
    if (order.indexOf(PROVIDER_ORDER[i]) < 0) order.push(PROVIDER_ORDER[i])
  }
  var from = visibleIds.indexOf(id)
  if (from < 0) return order
  var without = visibleIds.slice()
  without.splice(from, 1)
  var to = clamp(insertIndex, 0, without.length)
  if (to === from) return order
  var at = order.indexOf(id)
  if (at < 0) return order
  order.splice(at, 1)
  if (to >= without.length) {
    order.splice(order.indexOf(without[without.length - 1]) + 1, 0, id)
  } else {
    order.splice(order.indexOf(without[to]), 0, id)
  }
  return order
}

// Filter an already-ordered list by the per-agent show switches, keeping the
// order intact (visibleProviders re-sorts by the default provider order).
function shownProviders(list, visibility) {
  var out = []
  for (var i = 0; i < (list || []).length; i++) {
    var provider = list[i]
    if (!provider) continue
    if (visibility && visibility[provider.id] === false) continue
    out.push(provider)
  }
  return out
}

function providerById(providers, id) {
  for (var i = 0; i < (providers || []).length; i++) {
    if (providers[i] && providers[i].id === id) return providers[i]
  }
  return null
}

// ---------------------------------------------------------- OpenRouter cycle
//
// The history keeps one current and up to twelve completed cycles, most
// recent first. A completed cycle is kept only when it was observed within six
// hours of its end; a missed end breaks the chain (a misleading baseline is
// worse than none). `previous` is the first completed cycle, kept as a field
// for the per-key view and for caches written before 1.2. `scope` separates
// the per-key ("key") and account-wide ("account") series, so switching modes
// never compares one key's spend with the whole account's.

function emptyHistory() {
  return { scope: "key", current: null, completed: [], previous: null }
}

function normalizeCycle(value) {
  if (!value || typeof value !== "object") return null
  var end = dateMs(value.end)
  if (end <= 0) return null
  return {
    key: plain(value.key, 60) || String(end),
    end: end,
    spend: Math.max(0, number(value.spend) || 0),
    lastObservedAt: dateMs(value.lastObservedAt)
  }
}

function normalizeHistory(value) {
  var source = value && typeof value === "object" ? value : {}
  var scope = source.scope === "account" ? "account" : "key"
  var current = normalizeCycle(source.current)
  if (!current) return { scope: scope, current: null, completed: [], previous: null }
  // 1.1 caches have only `previous`.
  var raw = Array.isArray(source.completed) ? source.completed : (source.previous ? [source.previous] : [])
  var completed = []
  var limit = current.end
  for (var i = 0; i < raw.length && completed.length < MAX_COMPLETED_CYCLES; i++) {
    var cycle = normalizeCycle(raw[i])
    if (!cycle) break
    if (completed.length === 0 ? cycle.end > limit : cycle.end >= limit) break
    completed.push(cycle)
    limit = cycle.end
  }
  return { scope: scope, current: current, completed: completed, previous: completed.length > 0 ? completed[0] : null }
}

function moneyScope(money) {
  return money && money.scope === "account" ? "account" : "key"
}

function advanceHistory(history, money, nowMs) {
  var h = normalizeHistory(history)
  if (!money || !money.resetsAt) return h
  var scope = moneyScope(money)
  if (h.scope !== scope) h = { scope: scope, current: null, completed: [], previous: null }
  var now = Number(nowMs) || Date.now()
  var end = Math.round(money.resetsAt)
  var next = { key: "cycle:" + end, end: end, spend: Math.max(0, number(money.spend) || 0), lastObservedAt: now }
  if (!h.current) return { scope: scope, current: next, completed: [], previous: null }
  if (h.current.end === next.end) {
    return {
      scope: scope,
      current: { key: next.key, end: next.end, spend: Math.max(h.current.spend, next.spend), lastObservedAt: now },
      completed: h.completed,
      previous: h.previous
    }
  }
  if (next.end > h.current.end) {
    var observedNearEnd = h.current.lastObservedAt >= h.current.end - 6 * 3600000
    var completed = observedNearEnd ? [h.current].concat(h.completed).slice(0, MAX_COMPLETED_CYCLES) : []
    return { scope: scope, current: next, completed: completed, previous: completed.length > 0 ? completed[0] : null }
  }
  return h
}

// Display options from the widget settings: how many months the account-wide
// meter averages (0 = no meter) and how many key rows the panel lists.
function openrouterOptions(options) {
  var source = options && typeof options === "object" ? options : {}
  return {
    averageMonths: clampInt(source.averageMonths === undefined ? DEFAULT_AVERAGE_MONTHS : source.averageMonths,
      0, MAX_AVERAGE_MONTHS, DEFAULT_AVERAGE_MONTHS),
    keyRows: clampInt(source.keyRows === undefined ? DEFAULT_KEY_ROWS : source.keyRows, 0, MAX_KEY_ROWS, DEFAULT_KEY_ROWS)
  }
}

function isAccountWide(provider) {
  return !!(provider && provider.id === "openrouter" && provider.money && provider.money.scope === "account")
}

function monthKeyOf(ms) {
  var d = new Date(ms)
  var month = d.getUTCMonth() + 1
  return d.getUTCFullYear() + "-" + (month < 10 ? "0" : "") + month
}

// "Oct" for a cycle that resets on 1 November.
function cycleMonthLabel(cycle) {
  return MONTH_NAMES[new Date(cycle.end - 1).getUTCMonth()]
}

// "Oct" (one month) or "Sep–Oct": the `months` months before `month` ("2026-11").
function baselineRangeLabel(month, months) {
  var parts = String(month).split("-")
  var index = Number(parts[1]) - 1
  var first = MONTH_NAMES[((index - months) % 12 + 12) % 12]
  var last = MONTH_NAMES[((index - 1) % 12 + 12) % 12]
  return months <= 1 ? last : first + "–" + last
}

// The account-wide baseline: the average of the last N months, from
// analytics when the collector has it for this month and this N, else from
// the observed history (the most recent min(N, known) completed cycles).
// null when N is 0 or nothing is known.
function accountBaseline(money, history, options) {
  var n = openrouterOptions(options).averageMonths
  if (n <= 0 || !money) return null
  var moneyMonth = money.resetsAt > 0 ? monthKeyOf(money.resetsAt - 1) : ""
  var b = money.baseline
  if (b && b.months === n && b.average > 0 && (moneyMonth === "" || moneyMonth === b.month)) {
    var label = baselineRangeLabel(b.month, n)
    return { average: b.average, months: n, text: n === 1 ? "(" + label + ")" : "avg (" + label + ")" }
  }
  var h = normalizeHistory(history)
  if (h.scope !== "account") return null
  var cycles = h.completed.slice(0, n)
  if (cycles.length === 0) return null
  var sum = 0
  for (var i = 0; i < cycles.length; i++) sum += cycles[i].spend
  var average = sum / cycles.length
  if (!isFinite(average) || average <= 0) return null
  var k = cycles.length
  var text
  if (k < n) text = "avg (" + k + " of " + n + " months)"
  else if (n === 1) text = "(" + cycleMonthLabel(cycles[0]) + ")"
  else text = "avg (" + cycleMonthLabel(cycles[k - 1]) + "–" + cycleMonthLabel(cycles[0]) + ")"
  return { average: average, months: k, text: text }
}

function periodPhrase(interval) {
  var value = String(interval || "").toLowerCase()
  if (value.indexOf("week") >= 0) return "this week"
  if (value.indexOf("day") >= 0 || value.indexOf("daily") >= 0) return "today"
  return "this month"
}

// "All keys · this month": a meter of this month's spend against the N-month
// average when there is one (the percent stays honest above 100; over the
// average is yellow), else dollars.
function accountWindow(money, history, warnPercent, criticalPercent, options) {
  var spend = Math.max(0, number(money.spend) || 0)
  var base = accountBaseline(money, history, options)
  var percentValue = 0
  var over = false
  var color = "normal"
  if (base) {
    percentValue = Math.min(9999, spend / base.average * 100)
    over = spend > base.average
    color = over ? "yellow" : stateOf(percentValue, warnPercent, criticalPercent)
  }
  return {
    key: "cycle",
    label: money.label,
    short: "$",
    detail: ACCOUNT_LABEL + " · " + periodPhrase(money.resetInterval),
    percent: percentValue,
    fillPercent: clamp(percentValue, 0, 100),
    resetsAt: money.resetsAt,
    stale: false,
    limited: false,
    state: color === "yellow" ? "normal" : color,
    color: color,
    mode: base ? "meter" : "dollars",
    meterVisible: !!base,
    spend: spend,
    limit: null,
    effectiveLimit: base ? base.average : null,
    over: over,
    previous: null,
    credits: money.credits,
    resetInterval: money.resetInterval,
    baselineText: base ? base.text : "",
    overNote: !base || base.months <= 1 ? "over last month" : "over the " + base.months + "-month average",
    valueSuffix: "",
    percentCap: base ? 9999 : 100
  }
}

// The single bar/popup window OpenRouter's money contributes.
function openrouterWindow(provider, history, warnPercent, criticalPercent, options) {
  if (!provider || !provider.money) return null
  var money = provider.money
  if (money.scope === "account") return accountWindow(money, history, warnPercent, criticalPercent, options)
  var h = normalizeHistory(history)
  var previous = h.scope === "key" ? h.previous : null
  var limited = money.limit !== null && money.limit > 0
  var over = !!(previous && money.spend > previous.spend)
  var effectiveLimit = limited ? money.limit : (previous && previous.spend > 0 ? previous.spend : null)
  var usedPercent = effectiveLimit && effectiveLimit > 0 ? clamp(money.spend / effectiveLimit * 100, 0, 100) : 0
  var meterVisible = limited ? money.spend > 0 : !!(previous && previous.spend > 0 && money.spend <= previous.spend)
  var color = "normal"
  if (limited || meterVisible) {
    if (usedPercent >= criticalPercent) color = "critical"
    else if (usedPercent >= warnPercent) color = "warning"
  }
  if (over) color = "yellow"
  return {
    key: "cycle",
    label: money.label,
    short: "$",
    detail: limited ? "Key limit" : "Cycle spend",
    percent: usedPercent,
    fillPercent: usedPercent,
    resetsAt: money.resetsAt,
    stale: false,
    limited: false,
    state: color === "yellow" ? "normal" : color,
    color: color,
    mode: (limited || meterVisible) ? "meter" : "dollars",
    meterVisible: meterVisible,
    spend: money.spend,
    limit: money.limit,
    effectiveLimit: effectiveLimit,
    over: over,
    previous: previous,
    credits: money.credits,
    resetInterval: money.resetInterval,
    baselineText: "",
    overNote: "over the previous cycle",
    valueSuffix: "",
    percentCap: 100
  }
}

function limitWindow(limit, warnPercent, criticalPercent) {
  if (limit.amount !== null && limit.amount !== undefined) {
    // A value row: a dollar figure, no meter, no percent, never coloured.
    return {
      key: limit.key, label: limit.label, short: limit.short, detail: limit.detail,
      percent: 0, fillPercent: 0, resetsAt: limit.resetsAt, stale: limit.stale === true, limited: false,
      state: "normal", color: "normal", mode: "dollars", meterVisible: false,
      spend: limit.amount, limit: null, effectiveLimit: null, over: false, previous: null, credits: null,
      resetInterval: "", baselineText: "", overNote: "",
      valueSuffix: limit.key === "credits" ? "left" : "this month", percentCap: 100
    }
  }
  var state = limit.limited === true ? "critical" : stateOf(limit.percent, warnPercent, criticalPercent)
  return {
    key: limit.key,
    label: limit.label,
    short: limit.short,
    detail: limit.detail,
    percent: limit.percent,
    fillPercent: clamp(number(limit.percent) || 0, 0, 100),
    resetsAt: limit.resetsAt,
    stale: limit.stale === true,
    limited: limit.limited === true,
    state: state,
    color: state,
    mode: "meter",
    meterVisible: true,
    spend: null,
    limit: null,
    effectiveLimit: null,
    over: false,
    previous: null,
    credits: null,
    resetInterval: "",
    baselineText: "",
    overNote: "",
    valueSuffix: "",
    percentCap: 100
  }
}

// Every window a provider contributes, in display order. OpenRouter's money
// becomes one synthetic window first; account-wide it is followed by Credits
// and the first `options.keyRows` keys the collector ranked.
function windowsFor(provider, history, warnPercent, criticalPercent, options) {
  if (!provider) return []
  if (provider.id === "openrouter") {
    var cycle = openrouterWindow(provider, history, warnPercent, criticalPercent, options)
    var windows = cycle ? [cycle] : []
    if (!isAccountWide(provider)) return windows
    var keysLeft = openrouterOptions(options).keyRows
    for (var k = 0; k < (provider.limits || []).length; k++) {
      var row = provider.limits[k]
      if (String(row.key).indexOf("key-") === 0) {
        if (keysLeft <= 0) continue
        keysLeft -= 1
      }
      windows.push(limitWindow(row, warnPercent, criticalPercent))
    }
    return windows
  }
  var out = []
  for (var i = 0; i < (provider.limits || []).length; i++) {
    out.push(limitWindow(provider.limits[i], warnPercent, criticalPercent))
  }
  return out
}

// The bar's windows. Account-wide OpenRouter draws at most the month's meter
// (never Credits or key rows); everything else its first three windows.
function barWindows(provider, history, warnPercent, criticalPercent, options) {
  var windows = windowsFor(provider, history, warnPercent, criticalPercent, options)
  if (isAccountWide(provider)) {
    return windows.filter(function(window) { return window.key === "cycle" && window.mode === "meter" })
  }
  var out = []
  for (var i = 0; i < windows.length && out.length < 3; i++) out.push(windows[i])
  return out
}

function creditsLeft(provider) {
  if (!isAccountWide(provider)) return null
  for (var i = 0; i < (provider.limits || []).length; i++) {
    if (provider.limits[i].key === "credits" && provider.limits[i].amount !== null) return provider.limits[i].amount
  }
  return null
}

// OpenRouter's dollar figure beside its mark ("bars" style), or "".
// Account-wide: credits left, else this month's spend.
function barDollarsText(provider, history, warnPercent, criticalPercent, options) {
  if (!provider || provider.id !== "openrouter") return ""
  if (isAccountWide(provider)) {
    var credits = creditsLeft(provider)
    if (credits !== null) return formatCurrency(credits)
    var spend = provider.money ? number(provider.money.spend) || 0 : 0
    return spend > 0 ? formatCurrency(spend) : ""
  }
  var windows = windowsFor(provider, history, warnPercent, criticalPercent, options)
  if (windows.length === 0 || windows[0].mode !== "dollars") return ""
  return formatCurrency(windows[0].spend)
}

function barDollarsColor(provider, history, warnPercent, criticalPercent, options) {
  if (isAccountWide(provider)) return "normal"
  var windows = windowsFor(provider, history, warnPercent, criticalPercent, options)
  return windows.length > 0 ? windows[0].color : "normal"
}

var COLOR_RANK = { normal: 0, yellow: 1, warning: 2, critical: 3 }

function providerColor(provider, history, warnPercent, criticalPercent, options) {
  var windows = windowsFor(provider, history, warnPercent, criticalPercent, options)
  if (isAccountWide(provider)) {
    // The most severe colour among the live windows, so a month at 120% of its
    // average (yellow) never masks a key at 95% of its limit.
    var best = "normal"
    for (var i = 0; i < windows.length; i++) {
      if (windows[i].stale) continue
      var color = windows[i].limited ? "critical" : windows[i].color
      if ((COLOR_RANK[color] || 0) > (COLOR_RANK[best] || 0)) best = color
    }
    return best
  }
  var top = highest(windows)
  return top ? top.color : "normal"
}

function isAlarming(provider, history, warnPercent, criticalPercent, options) {
  return providerColor(provider, history, warnPercent, criticalPercent, options) === "critical"
}

// --------------------------------------------------------------- bar text

// Account-wide OpenRouter: "$20.81 credits left · $49.93 this month".
function accountWideText(provider) {
  var parts = []
  var credits = creditsLeft(provider)
  if (credits !== null) parts.push(formatCurrency(credits) + " credits left")
  parts.push(formatCurrency(provider.money ? Math.max(0, number(provider.money.spend) || 0) : 0) + " this month")
  return parts.join(" · ")
}

function compactText(provider, history, warnPercent, criticalPercent, options) {
  if (isAccountWide(provider)) return accountWideText(provider)
  var windows = windowsFor(provider, history, warnPercent, criticalPercent, options)
  if (windows.length === 0) return provider && provider.status ? provider.status : ""
  var parts = []
  for (var i = 0; i < windows.length; i++) {
    var window = windows[i]
    if (window.key === "cycle") {
      parts.push(window.mode === "dollars" ? formatCurrency(window.spend) : percentText(window.percent))
    } else if (window.stale) {
      parts.push(window.short + " —")
    } else {
      parts.push(window.short + " " + percentText(window.percent))
    }
  }
  return parts.join(" · ")
}

// The "text" bar style. Account-wide OpenRouter: "$20.81 · 82%" (the percent
// only when the month has a baseline).
function barText(provider, history, warnPercent, criticalPercent, options) {
  if (!isAccountWide(provider)) return compactText(provider, history, warnPercent, criticalPercent, options)
  var parts = []
  var dollars = barDollarsText(provider, history, warnPercent, criticalPercent, options)
  if (dollars !== "") parts.push(dollars)
  var meters = barWindows(provider, history, warnPercent, criticalPercent, options)
  if (meters.length > 0) parts.push(windowValueText(meters[0]))
  return parts.join(" · ")
}

function providerTooltip(provider, history, nowMs, warnPercent, criticalPercent, options) {
  if (!provider) return ""
  var lines = []
  var head = provider.name
  if (provider.tier !== "") head += " · " + provider.tier
  lines.push(head)
  if (provider.status !== "") lines.push(provider.status)
  if (isAccountWide(provider)) {
    // The panel has the per-key rows; the tooltip keeps to the account.
    lines.push("  " + accountWideText(provider))
    if (provider.error !== "") lines.push(provider.error)
    return lines.join("\n")
  }
  var windows = windowsFor(provider, history, warnPercent, criticalPercent, options)
  for (var i = 0; i < windows.length; i++) {
    var window = windows[i]
    var value = window.mode === "dollars"
      ? formatCurrency(window.spend)
      : percentText(window.percent)
    var line = "  " + window.detail + ": " + value
    if (window.mode === "meter" && window.effectiveLimit) {
      line += " of " + formatCurrency(window.effectiveLimit)
    }
    var reset = resetText(window.resetsAt, nowMs)
    if (reset !== "") line += " · " + reset
    if (window.stale) line += " · stale"
    lines.push(line)
  }
  if (provider.error !== "") lines.push(provider.error)
  return lines.join("\n")
}

function tooltip(providers, history, nowMs, warnPercent, criticalPercent, options) {
  var visible = providers || []
  if (visible.length === 0) return "No AI agents found"
  var blocks = []
  for (var i = 0; i < visible.length; i++) {
    blocks.push(providerTooltip(visible[i], history, nowMs, warnPercent, criticalPercent, options))
  }
  return blocks.join("\n\n")
}

// --------------------------------------------------------------- panel text

// A panel row's value: "45%", "120%" (account month over its average), "—"
// (stale), "$4.20", "$20.81 left", "$3.10 this month".
function windowValueText(window) {
  if (!window) return ""
  if (window.mode === "dollars") {
    var value = formatCurrency(window.spend)
    return window.valueSuffix ? value + " " + window.valueSuffix : value
  }
  if (window.stale) return "—"
  return percentText(window.percent, window.percentCap || 100)
}

// "$49.93 of $61.20 avg (Sep–Oct) · Resets in 11d 7h · over the 2-month average"
function windowCaption(window, nowMs) {
  if (!window) return ""
  var parts = []
  if (window.mode === "meter" && window.effectiveLimit) {
    var of = formatCurrency(window.spend) + " of " + formatCurrency(window.effectiveLimit)
    parts.push(window.baselineText ? of + " " + window.baselineText : of)
  }
  var reset = resetText(window.resetsAt, nowMs)
  if (reset !== "") parts.push(reset)
  if (window.stale) parts.push("stale reading")
  if (window.over) parts.push(window.overNote || "over the previous cycle")
  return parts.join(" · ")
}

// The per-key money line; "" account-wide (Credits has its own row there).
function moneySummary(money) {
  if (!money || money.scope === "account") return ""
  var parts = []
  if (money.credits) parts.push(formatCurrency(money.credits.remaining) + " credits left")
  if (money.limit !== null) parts.push(formatCurrency(money.limit) + " " + intervalName(money.resetInterval).toLowerCase() + " limit")
  else parts.push("No key limit")
  return parts.join(" · ")
}

// The cached analytics baseline as the collector's --openrouter-baseline
// value ("2026-11:2:61.2000:1794571200000"; average 0 = a failed attempt), or "".
// Display numbers only: no key material.
function baselineArg(provider) {
  if (!isAccountWide(provider)) return ""
  var b = normalizeBaseline(provider.money.baseline)
  if (!b || !(b.average >= 0 && b.average < 1e9) || !(b.checkedAt > 0)) return ""
  return b.month + ":" + b.months + ":" + b.average.toFixed(4) + ":" + Math.round(b.checkedAt)
}

// "Management key: set (Secret Service)" / "Management key: not set · …".
function managementKeyText(provider) {
  if (!provider || provider.id !== "openrouter") return ""
  var names = { "env": "env", "secret-service": "Secret Service", "file": "file" }
  var source = names[provider.keySource] || ""
  if (source === "") return "Management key: not set · " + MANAGEMENT_HELPER + " adds one"
  if (provider.source === "openrouter-management" && provider.money === null && provider.error !== "") {
    return "Management key: " + source + " (not usable)"
  }
  return "Management key: set (" + source + ")"
}

function activityText(provider) {
  if (!provider || !provider.activity) return ""
  var activity = provider.activity
  var parts = []
  if (activity.prompts > 0) parts.push(formatCount(activity.prompts) + " prompts")
  if (activity.tokens > 0) parts.push(tokensText(activity.tokens))
  if (activity.accounts > 1) parts.push(activity.accounts + " accounts")
  if (parts.length === 0) return ""
  return (activity.period === "week" ? "This week" : "Today") + " \u00b7 " + parts.join(" \u00b7 ")
}

// --------------------------------------------------------------- cache

function slimProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    available: provider.available,
    tier: provider.tier,
    status: provider.status,
    hint: provider.hint,
    error: provider.error,
    source: provider.source,
    keySource: provider.keySource || "",
    limits: provider.limits,
    activity: provider.activity,
    money: provider.money,
    budgets: provider.budgets
  }
}

function serializeCache(providers, history, fetchedAt, attemptedAt, failures, error) {
  return JSON.stringify({
    version: CACHE_VERSION,
    fetchedAt: number(fetchedAt) || 0,
    attemptedAt: number(attemptedAt) || 0,
    failures: Math.max(0, Math.round(number(failures) || 0)),
    error: plain(error, 240),
    data: { providers: (providers || []).map(slimProvider) },
    history: normalizeHistory(history)
  }) + "\n"
}

function parseCache(raw, nowMs) {
  var doc = parseJson(raw)
  if (!doc || doc.version !== CACHE_VERSION) return null
  var now = Number(nowMs) || Date.now()
  var fetchedAt = dateMs(doc.fetchedAt)
  var attemptedAt = dateMs(doc.attemptedAt)
  if (fetchedAt > now + 300000) fetchedAt = 0
  if (attemptedAt > now + 300000) attemptedAt = 0
  var providers = []
  var list = doc.data && Array.isArray(doc.data.providers) ? doc.data.providers : []
  for (var i = 0; i < list.length; i++) {
    var provider = normalizeProvider(list[i])
    if (provider) providers.push(provider)
  }
  return {
    fetchedAt: fetchedAt,
    attemptedAt: attemptedAt,
    failures: Math.max(0, Math.round(number(doc.failures) || 0)),
    error: plain(doc.error, 240),
    providers: providers,
    history: normalizeHistory(doc.history)
  }
}

// ---------------------------------------------------------- poll coordination

function autoDelayMs(fetchedAt, attemptedAt, failures, refreshMs, nowMs) {
  var now = Number(nowMs) || Date.now()
  var interval = Math.max(60000, Number(refreshMs) || 300000)
  var fails = Math.max(0, Math.round(Number(failures) || 0))
  if (fails > 0) {
    var backoff = Math.min(FAILURE_CAP_MS, 60000 * Math.pow(2, Math.min(fails - 1, 4)))
    return Math.max(250, Math.min(backoff, (Number(attemptedAt) || now) + backoff - now))
  }
  var last = Math.max(Number(fetchedAt) || 0, Number(attemptedAt) || 0)
  if (last <= 0) return 250
  return Math.max(250, last + interval - now)
}

var pollState = { leader: null, heartbeat: 0, fetchedAt: 0, attemptedAt: 0, failures: 0, seq: 0, result: null, expires: 0 }

function pollClaim(widget, nowMs) {
  var now = Number(nowMs) || Date.now()
  if (pollState.leader === widget && now - pollState.heartbeat < 20000) {
    pollState.heartbeat = now
    return true
  }
  if (pollState.leader !== widget && now < pollState.expires && pollState.leader !== null) return false
  pollState.leader = widget
  pollState.heartbeat = now
  pollState.expires = now + 20000
  return true
}

function pollRelease(widget) {
  if (pollState.leader === widget) {
    pollState.leader = null
    pollState.heartbeat = 0
    pollState.expires = 0
  }
}

function pollPublish(widget, result) {
  pollState.seq += 1
  pollState.result = result
  pollState.fetchedAt = result && result.fetchedAt ? result.fetchedAt : 0
  pollState.attemptedAt = Date.now()
}

function pollConsume(widget) {
  if (pollState.leader === widget || pollState.result === null) return null
  var result = pollState.result
  pollState.result = null
  return result
}

function pollLeaderInstance() {
  return pollState.leader
}

function pollSeed(fetchedAt, attemptedAt, failures) {
  pollState.fetchedAt = Math.max(pollState.fetchedAt, Number(fetchedAt) || 0)
  pollState.attemptedAt = Math.max(pollState.attemptedAt, Number(attemptedAt) || 0)
  pollState.failures = Math.max(pollState.failures, Math.round(Number(failures) || 0))
}
