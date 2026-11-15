import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// One bar widget for the AI agents this machine actually uses. scripts/collect.js
// reads each provider's own source and keeps only the agents with a plan, a key
// or usage; the bar then draws their marks and limit meters side by side, and
// the panel explains every window.
Panel {
  id: root
  moduleName: "crueber.agent-meters"
  ipcTarget: "agent-meters"
  manageIpc: false

  // ------------------------------------------------------------------ theme

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false

  // --------------------------------------------------------------- settings

  readonly property string barStyle: {
    var value = String(setting("barStyle", "bars"))
    return value === "text" || value === "icon" ? value : "bars"
  }
  readonly property int refreshIntervalSec: Model.clampInt(setting("refreshIntervalSec", 300), 60, 3600, 300)
  readonly property int warnPercent: Model.clampInt(setting("warnPercent", 70), 0, 100, 70)
  readonly property int criticalPercent: Model.clampInt(setting("criticalPercent", 90), 0, 100, 90)
  readonly property string warningColor: String(setting("warningColor", "#f67400"))
  readonly property string criticalColor: String(setting("criticalColor", ""))
  readonly property string compareColor: "#d9b45b"
  readonly property string nodeCommand: String(setting("nodeCommand", ""))
  readonly property string authFile: String(setting("authFile", ""))
  readonly property string grokHome: String(setting("grokHome", ""))
  readonly property string botHome: String(setting("botHome", ""))
  readonly property string opencodeCommand: String(setting("opencodeCommand", ""))
  readonly property string codexCommand: String(setting("codexCommand", ""))
  readonly property bool showActivity: setting("showActivity", true) !== false
  readonly property string rightClickCommand: String(setting("onRightClick", ""))
  property var visibility: ({
    claude: setting("showClaude", true) !== false,
    grok: setting("showGrok", true) !== false,
    opencode: setting("showOpencode", true) !== false,
    openrouter: setting("showOpenrouter", true) !== false,
    codex: setting("showCodex", true) !== false
  })
  // Written by the panel's reorder controls; comma-separated agent ids. Kept
  // writable so a move repaints immediately, before shell.json reloads.
  property string providerOrder: String(setting("providerOrder", ""))

  readonly property string executable: nodeCommand !== "" ? nodeCommand : "node"
  readonly property string helperPath: {
    var value = String(Qt.resolvedUrl("scripts/collect.js"))
    if (value.indexOf("file://") === 0) value = value.slice(7)
    try { value = decodeURIComponent(value) } catch (e) {}
    return value
  }

  // ------------------------------------------------------------------- data

  property var providers: []
  property var history: Model.emptyHistory()
  property string errorText: ""
  property string lastErrorMessage: ""
  property string stderrText: ""
  property bool gotOutput: false
  property double lastFetchMs: 0
  property double lastAttemptMs: 0
  property int fetchFailures: 0
  property double nowMs: Date.now()

  property bool cacheLoadAttempted: false
  property bool pollLeader: false
  property int consumedSeq: 0

  readonly property var panelProviders: Model.orderedProviders(providers, {}, providerOrder)
  readonly property var visibleProviders: Model.shownProviders(panelProviders, visibility)
  readonly property int hiddenCount: panelProviders.length - visibleProviders.length

  // Drag-to-reorder state. The ghost and insertion line live in the panel's
  // Flickable content, in the same coordinates as the sections.
  property string dragProviderId: ""
  property real dragPointerY: 0
  property int dropIndex: -1
  readonly property bool dragging: dragProviderId !== ""
  readonly property bool busy: fetchProc.running
  readonly property bool hasData: visibleProviders.length > 0

  readonly property string cacheHome: {
    var xdg = Quickshell.env("XDG_CACHE_HOME")
    if (xdg) return xdg
    var home = Quickshell.env("HOME")
    return home ? home + "/.cache" : "/tmp"
  }
  readonly property string cacheDir: root.cacheHome + "/agent-meters"
  readonly property string cachePath: root.cacheDir + "/usage.json"

  readonly property string heroDetail: {
    var top = null
    for (var i = 0; i < visibleProviders.length; i++) {
      var list = Model.windowsFor(visibleProviders[i], history, warnPercent, criticalPercent)
      for (var j = 0; j < list.length; j++) {
        if (list[j].mode !== "meter") continue
        if (top === null || list[j].percent > top) top = list[j].percent
      }
    }
    return top === null ? "" : Model.percentText(top)
  }
  readonly property string heroMeta: {
    var parts = []
    if (panelProviders.length > 0) parts.push(panelProviders.length + (panelProviders.length === 1 ? " agent" : " agents"))
    if (hiddenCount > 0) parts.push(hiddenCount + " hidden")
    var updated = Model.updatedText(root.lastFetchMs, root.nowMs)
    if (updated !== "") parts.push(updated.replace(/^Updated /, ""))
    if (lastErrorMessage !== "") parts.push("read failed")
    return parts.join(" · ")
  }
  readonly property string footerText: {
    var parts = []
    var updated = Model.updatedText(root.lastFetchMs, root.nowMs)
    if (updated !== "") parts.push(updated)
    if (lastErrorMessage !== "") parts.push(lastErrorMessage)
    parts.push("local agent records")
    return parts.join(" · ")
  }
  readonly property string tooltipText: visibleProviders.length > 0
    ? Model.tooltip(visibleProviders, history, nowMs, warnPercent, criticalPercent)
    : (panelProviders.length > 0
      ? "All agents are hidden from the bar\nOpen Agent Meters to show one"
      : "No AI agents found")

  function stateColor(name) {
    if (name === "critical") return criticalColor !== "" ? criticalColor : urgent
    if (name === "warning") return warningColor !== "" ? warningColor : foreground
    if (name === "yellow") return compareColor
    return foreground
  }

  function isShown(id) {
    return !visibility || visibility[id] !== false
  }

  function showKey(id) {
    return "show" + id.charAt(0).toUpperCase() + id.slice(1)
  }

  // Flip one agent in the bar and persist the same setting the widget's
  // schema exposes, so the switch and the settings page stay in step.
  function setShown(id, shown) {
    if (id === "") return
    var next = {}
    for (var key in visibility) next[key] = visibility[key]
    next[id] = shown
    root.visibility = next
    orderProc.command = ["/bin/sh", "-lc",
      "omarchy bar set " + Model.shellQuote(root.moduleName) + " " + Model.shellQuote(showKey(id))
      + (shown ? " true" : " false") + " --json"]
    orderProc.running = true
  }

  function saveProviderOrder(order) {
    root.providerOrder = order.join(",")
    orderProc.command = ["/bin/sh", "-lc",
      "omarchy bar set " + Model.shellQuote(root.moduleName) + " providerOrder " + Model.shellQuote(root.providerOrder)]
    orderProc.running = true
  }

  // The saved order padded with every known agent, so agents that are hidden
  // right now keep their place when they come back.
  function fullOrder() {
    var order = Model.parseOrder(providerOrder)
    if (order.length === 0) order = Model.PROVIDER_ORDER.slice()
    for (var i = 0; i < Model.PROVIDER_ORDER.length; i++) {
      if (order.indexOf(Model.PROVIDER_ORDER[i]) < 0) order.push(Model.PROVIDER_ORDER[i])
    }
    return order
  }

  function moveProvider(id, delta) {
    var ids = []
    for (var i = 0; i < panelProviders.length; i++) ids.push(panelProviders[i].id)
    var from = ids.indexOf(id)
    if (from < 0) return
    var targetId = ids[from + delta]
    if (targetId === undefined) return
    var order = fullOrder()
    var a = order.indexOf(id)
    var b = order.indexOf(targetId)
    if (a < 0 || b < 0) return
    order[a] = targetId
    order[b] = id
    saveProviderOrder(order)
  }

  // Insert `id` at `insertIndex` in the list without the dragged agent.
  function reorderProvider(id, insertIndex) {
    var ids = []
    for (var i = 0; i < panelProviders.length; i++) ids.push(panelProviders[i].id)
    saveProviderOrder(Model.reorderInsert(providerOrder, ids, id, insertIndex))
  }

  function dropIndexAt(y) {
    var count = sectionsRepeater ? sectionsRepeater.count : 0
    for (var i = 0; i < count; i++) {
      var item = sectionsRepeater.itemAt(i)
      if (item && y < item.y + item.height / 2) return i
    }
    return count
  }

  function dropLineY() {
    var count = sectionsRepeater ? sectionsRepeater.count : 0
    if (count === 0) return 0
    if (dropIndex >= count) {
      var last = sectionsRepeater.itemAt(count - 1)
      return last ? last.y + last.height + Style.space(3) : 0
    }
    var item = sectionsRepeater.itemAt(Math.max(0, dropIndex))
    return item ? item.y - Style.space(3) : 0
  }

  function providerName(id) {
    for (var i = 0; i < panelProviders.length; i++) {
      if (panelProviders[i].id === id) return panelProviders[i].name
    }
    return id
  }

  function startSectionDrag(id, source, mouse) {
    if (id === "") return
    var point = source.mapToItem(panelColumn, mouse.x, mouse.y)
    root.dragProviderId = id
    root.dragPointerY = point.y
    root.dropIndex = 0
    for (var i = 0; i < panelProviders.length; i++) {
      if (panelProviders[i].id === id) { root.dropIndex = i; break }
    }
  }

  function updateSectionDrag(source, mouse) {
    if (!root.dragging) return
    var point = source.mapToItem(panelColumn, mouse.x, mouse.y)
    root.dragPointerY = point.y
    root.dropIndex = dropIndexAt(point.y)
  }

  function endSectionDrag() {
    if (!root.dragging) return
    var id = root.dragProviderId
    var from = -1
    for (var i = 0; i < panelProviders.length; i++) {
      if (panelProviders[i].id === id) from = i
    }
    if (from >= 0) {
      var to = root.dropIndex
      if (to > from) to -= 1
      reorderProvider(id, to)
    }
    cancelSectionDrag()
  }

  function cancelSectionDrag() {
    root.dragProviderId = ""
    root.dragPointerY = 0
    root.dropIndex = -1
  }

  // ------------------------------------------------------------ cache & fetch

  function findProvider(list, id) {
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i] && list[i].id === id) return list[i]
    }
    return null
  }

  // A failed provider read keeps its last good numbers and gains the error, so
  // one endpoint being down does not blank the whole widget.
  function mergeProviders(oldList, newList) {
    var out = []
    for (var i = 0; i < newList.length; i++) {
      var next = newList[i]
      var old = findProvider(oldList, next.id)
      if (next.error !== "" && old && old.available) {
        var merged = {
          id: old.id,
          name: old.name,
          available: old.available,
          tier: next.tier !== "" ? next.tier : old.tier,
          status: next.status !== "" ? next.status : old.status,
          error: next.error,
          source: old.source,
          limits: old.limits,
          activity: old.activity,
          money: old.money,
          budgets: old.budgets
        }
        out.push(merged)
      } else {
        out.push(next)
      }
    }
    return out
  }

  function loadCache(raw) {
    var cached = Model.parseCache(raw, Date.now())
    if (!cached) return
    root.lastFetchMs = Math.max(root.lastFetchMs, cached.fetchedAt)
    root.lastAttemptMs = Math.max(root.lastAttemptMs, cached.attemptedAt)
    root.fetchFailures = Math.max(root.fetchFailures, cached.failures)
    Model.pollSeed(cached.fetchedAt, cached.attemptedAt, cached.failures)
    if (cached.providers.length > 0) {
      root.providers = cached.providers
      root.history = cached.history
      root.lastErrorMessage = cached.error
      root.errorText = cached.error
      root.nowMs = Date.now()
    } else if (cached.error !== "") {
      root.lastErrorMessage = cached.error
      root.errorText = cached.error
    }
  }

  function writeCache() {
    if (!root.cacheLoadAttempted) return
    cacheFile.setText(Model.serializeCache(
      root.providers,
      root.history,
      root.lastFetchMs,
      root.lastAttemptMs,
      root.fetchFailures,
      root.lastErrorMessage
    ))
  }

  function nextAutoDelayMs() {
    var fetchedAt = Math.max(root.lastFetchMs, Model.pollState.fetchedAt)
    var attemptedAt = Math.max(root.lastAttemptMs, Model.pollState.attemptedAt)
    var failures = Math.max(root.fetchFailures, Model.pollState.failures)
    return Model.autoDelayMs(fetchedAt, attemptedAt, failures, root.refreshIntervalSec * 1000, Date.now())
  }

  function scheduleNextPoll(delayMs) {
    if (!root.pollLeader) return
    poll.interval = Math.max(250, Math.round(Number(delayMs) || 0))
    poll.restart()
  }

  function fetchCommand() {
    var command = Model.shellQuote(root.executable) + " " + Model.shellQuote(root.helperPath)
    if (root.authFile !== "") command += " --auth-file " + Model.shellQuote(root.authFile)
    if (root.grokHome !== "") command += " --grok-home " + Model.shellQuote(root.grokHome)
    if (root.botHome !== "") command += " --bot-home " + Model.shellQuote(root.botHome)
    if (root.opencodeCommand !== "") command += " --opencode " + Model.shellQuote(root.opencodeCommand)
    if (root.codexCommand !== "") command += " --codex " + Model.shellQuote(root.codexCommand)
    return command
  }

  function requestFetch(kind) {
    if (!root.pollLeader || fetchProc.running) return
    var last = Math.max(root.lastAttemptMs, Model.pollState.attemptedAt)
    var floor = kind === "manual" ? Model.FORCE_MIN_MS : Model.AUTO_MIN_MS
    if (last > 0 && Date.now() - last < floor) return
    spawnFetch()
  }

  function refreshNow() {
    if (root.lastAttemptMs > 0 && Date.now() - root.lastAttemptMs < Model.FORCE_MIN_MS) return
    requestFetch("manual")
  }

  function spawnFetch() {
    root.lastAttemptMs = Date.now()
    root.gotOutput = false
    root.stderrText = ""
    writeCache()
    fetchProc.command = ["/bin/sh", "-lc", root.fetchCommand()]
    fetchProc.running = true
  }

  function applyOutput(raw) {
    root.gotOutput = true
    var result = Model.parseResult(raw)
    if (!result) {
      handleFailure("Unreadable collector output")
      return
    }
    if (!result.ok) {
      handleFailure(result.error)
      return
    }
    var fetchedAt = result.fetchedAt > 0 ? result.fetchedAt : Date.now()
    root.providers = root.mergeProviders(root.providers, result.providers)
    root.history = Model.advanceHistory(root.history, (findProvider(root.providers, "openrouter") || {}).money, Date.now())
    root.lastFetchMs = fetchedAt
    root.fetchFailures = 0
    root.lastErrorMessage = ""
    root.errorText = ""
    root.nowMs = Date.now()
    Model.pollPublish(root, { fetchedAt: fetchedAt, providers: root.providers, history: root.history })
    writeCache()
    scheduleNextPoll(nextAutoDelayMs())
  }

  function handleFailure(message) {
    root.fetchFailures = Math.min(20, root.fetchFailures + 1)
    root.lastErrorMessage = String(message || "Collector failed").slice(0, 240)
    root.errorText = root.lastErrorMessage
    Model.pollPublish(root, { fetchedAt: root.lastFetchMs, providers: root.providers, history: root.history })
    writeCache()
    scheduleNextPoll(nextAutoDelayMs())
  }

  // --------------------------------------------------------------- lifecycle

  Component.onCompleted: {
    Model.pollClaim(root, Date.now())
    root.pollLeader = Model.pollLeaderInstance() === root
  }

  FileView {
    id: cacheFile
    path: root.cachePath
    blockLoading: true
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.cacheLoadAttempted = true
      root.loadCache(text())
      if (root.pollLeader) {
        if (root.providers.length === 0) {
          root.requestFetch("auto")
        } else {
          root.scheduleNextPoll(root.nextAutoDelayMs())
        }
      }
    }
    onLoadFailed: {
      root.cacheLoadAttempted = true
      if (root.pollLeader) root.requestFetch("auto")
    }
  }

  Process {
    id: orderProc
    onExited: function(exitCode) {
      if (exitCode !== 0) root.errorText = "Could not save the agent order"
    }
  }

  Process {
    id: cacheDirProc
    command: ["install", "-d", "-m", "700", root.cacheDir]
    running: true
  }

  Process {
    id: fetchProc
    onExited: function(exitCode) {
      if (!root.gotOutput) {
        var line = root.stderrText.trim().split("\n").filter(function(value) { return value !== "" }).pop()
        if (line) root.handleFailure(line)
        else root.handleFailure(exitCode === 127
          ? "node not found; set the Node executable in the widget settings"
          : "Collector failed (exit " + exitCode + ")")
      }
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyOutput(text)
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.stderrText = text
    }
  }

  Timer {
    id: poll
    repeat: true
    running: root.pollLeader
    interval: 300000
    onTriggered: {
      root.pollLeader = Model.pollClaim(root, Date.now())
      if (!root.pollLeader) return
      var result = Model.pollConsume(root)
      if (result) {
        root.nowMs = Date.now()
        return
      }
      root.requestFetch("auto")
    }
  }

  Timer {
    interval: 5000
    running: true
    repeat: true
    onTriggered: root.pollLeader = Model.pollClaim(root, Date.now())
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  onOpenedChanged: if (!opened) {
    root.cancelSectionDrag()
  } else {
    nowMs = Date.now()
    if (root.pollLeader && root.lastFetchMs > 0 && Date.now() - root.lastFetchMs > root.refreshIntervalSec * 1000) {
      root.requestFetch("auto")
    }
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function openDocs() {
    Qt.openUrlExternally("https://github.com/crueber/omarchy-plugin-agent-meters")
  }

  function handleClick(buttonCode) {
    if (buttonCode === Qt.MiddleButton) root.refreshNow()
    else if (buttonCode === Qt.RightButton) {
      if (rightClickCommand !== "" && root.bar) root.bar.run(rightClickCommand)
      else root.openDocs()
    } else {
      root.toggle()
    }
  }

  ShellIpc {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
    function text(): string {
      var parts = []
      for (var i = 0; i < root.visibleProviders.length; i++) {
        var provider = root.visibleProviders[i]
        parts.push(provider.name + ": " + Model.compactText(provider, root.history, root.warnPercent, root.criticalPercent))
      }
      return parts.length > 0 ? parts.join(" | ") : "no agents"
    }
    function providers(): string { return JSON.stringify(root.visibleProviders) }
    function move(id: string, delta: int): string { root.moveProvider(id, delta); return root.providerOrder }
  }

  // -------------------------------------------------------------------- bar

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  component BarMeter: Item {
    id: meter
    property var window: null
    width: Style.space(17)
    height: Style.space(3)

    Rectangle {
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      width: Math.max(height, parent.width * Math.min(100, Math.max(0, Number(meter.window ? meter.window.percent : 0))) / 100)
      height: parent.height
      radius: height / 2
      color: root.stateColor(meter.window ? meter.window.color : "normal")

      Behavior on width {
        NumberAnimation { duration: Style.duration(160); easing.type: Easing.OutCubic }
      }
    }
  }

  component ProviderChip: Row {
    id: chip
    property var provider: null
    spacing: Style.space(4)

    ProviderMark {
      anchors.verticalCenter: parent.verticalCenter
      providerId: chip.provider ? chip.provider.id : ""
      markSize: Style.bar.iconFont + 3
      color: root.foreground
    }

    Column {
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)
      visible: root.barStyle === "bars"

      Repeater {
        model: root.barStyle === "bars" && chip.provider
          ? Model.barWindows(chip.provider, root.history, root.warnPercent, root.criticalPercent)
          : []

        delegate: Item {
          width: Style.space(17)
          height: Style.space(3)
          visible: modelData.mode === "meter"
            ? (chip.provider.id !== "openrouter" || modelData.meterVisible !== false)
            : false

          Rectangle {
            anchors.fill: parent
            radius: height / 2
            color: root.track
          }

          Rectangle {
            width: Math.max(height, parent.width * modelData.percent / 100)
            height: parent.height
            radius: height / 2
            color: root.stateColor(modelData.color)

            Behavior on width {
              NumberAnimation { duration: Style.duration(160); easing.type: Easing.OutCubic }
            }
          }
        }
      }
    }

    Text {
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      visible: root.barStyle === "bars" && chip.provider && chip.provider.id === "openrouter"
      text: {
        var windows = chip.provider ? Model.windowsFor(chip.provider, root.history, root.warnPercent, root.criticalPercent) : []
        if (windows.length === 0 || windows[0].mode !== "dollars") return ""
        return Model.formatCurrency(windows[0].spend)
      }
      color: {
        var windows = chip.provider ? Model.windowsFor(chip.provider, root.history, root.warnPercent, root.criticalPercent) : []
        return windows.length > 0 ? root.stateColor(windows[0].color) : root.foreground
      }
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      renderType: Text.NativeRendering
    }

    Text {
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      visible: root.barStyle === "text"
      text: chip.provider ? Model.compactText(chip.provider, root.history, root.warnPercent, root.criticalPercent) : ""
      color: {
        var color = chip.provider ? Model.providerColor(chip.provider, root.history, root.warnPercent, root.criticalPercent) : "normal"
        return root.stateColor(color)
      }
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      renderType: Text.NativeRendering
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    dimmed: !root.hasData
    active: {
      for (var i = 0; i < root.visibleProviders.length; i++) {
        if (Model.isAlarming(root.visibleProviders[i], root.history, root.warnPercent, root.criticalPercent)) return true
      }
      return false
    }
    tooltipText: root.tooltipText
    fixedWidth: root.vertical ? -1 : Math.ceil(content.implicitWidth + button.scaledHorizontalMargin * 2)
    fixedHeight: root.vertical ? Math.ceil(content.implicitHeight + button.scaledVerticalPadding * 2) : -1

    onPressed: function(buttonCode) { root.handleClick(buttonCode) }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.space(7)

      Repeater {
        model: root.visibleProviders
        delegate: ProviderChip { provider: modelData }
      }

      Text {
        textFormat: Text.PlainText
        visible: root.visibleProviders.length === 0
        anchors.verticalCenter: parent.verticalCenter
        text: "󰚩"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.bar.iconFont
        renderType: Text.NativeRendering
      }
    }
  }

  // ------------------------------------------------------------------ popup

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight, Style.space(680))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTextKey: function(text) {
        if (text === "r") root.refreshNow()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: panelColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        Column {
          id: panelColumn
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Agent Meters"
            meta: root.heroMeta
            detail: root.heroDetail
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              Text {
                text: "󰚩"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
                renderType: Text.NativeRendering
              }
            }

            trailingControl: Component {
              PanelActionButton {
                iconText: "󰑐"
                tooltipText: root.busy ? "Refreshing…" : "Refresh (r)"
                foreground: root.foreground
                fontFamily: root.fontFamily
                enabled: !root.busy
                onClicked: root.refreshNow()
              }
            }
          }

          PanelSeparator { foreground: root.foreground }

          Column {
            visible: root.panelProviders.length === 0
            width: parent.width
            spacing: Style.space(4)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.errorText !== "" ? "No agent found" : "Looking for agents"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.errorText !== ""
                ? root.errorText
                : "Sign in to Claude Code, Grok or OpenCode, or add an OpenRouter key, and that agent appears here."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          Repeater {
            id: sectionsRepeater
            model: root.panelProviders
            delegate: ProviderSection { provider: modelData }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: root.footerText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        Rectangle {
          id: dropLine
          visible: root.dragging
          x: Style.space(4)
          width: panelFlick.width - Style.space(8)
          height: 2
          radius: 1
          color: Commons.Color.accent
          y: root.dropLineY()
          z: 20
        }

        Rectangle {
          id: dragGhost
          visible: root.dragging
          x: Style.space(4)
          width: panelFlick.width - Style.space(8)
          height: Style.space(34)
          radius: Style.cornerRadius
          color: Style.hoverFillFor(root.foreground, Commons.Color.accent)
          border.width: 1
          border.color: Commons.Color.accent
          y: Math.max(0, Math.min(panelColumn.height - height, root.dragPointerY - height / 2))
          z: 21

          Row {
            anchors.centerIn: parent
            spacing: Style.space(8)

            ProviderMark {
              anchors.verticalCenter: parent.verticalCenter
              providerId: root.dragProviderId
              markSize: Style.font.title
              color: root.foreground
            }

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: root.providerName(root.dragProviderId)
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }
        }
      }
    }
  }

  component MeterBar: Item {
    id: meter
    property real percent: 0
    property color fill: root.foreground
    width: parent ? parent.width : 0
    height: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

    Rectangle {
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      width: Math.max(height, parent.width * Math.min(100, Math.max(0, meter.percent)) / 100)
      height: parent.height
      radius: height / 2
      color: meter.fill

      Behavior on width {
        NumberAnimation { duration: Style.duration(160); easing.type: Easing.OutCubic }
      }
    }
  }

  component ProviderSection: Column {
    id: section
    property var provider: null
    width: parent ? parent.width : 0
    spacing: Style.space(8)

    function sectionWindows() {
      return section.provider
        ? Model.windowsFor(section.provider, root.history, root.warnPercent, root.criticalPercent)
        : []
    }

    function sectionSummary() {
      var live = sectionWindows().filter(function(window) { return window.stale !== true })
      return Model.highest(live.length > 0 ? live : sectionWindows())
    }

    PanelSeparator { foreground: root.foreground; visible: section.provider !== null }

    Item {
      id: sectionHeaderWrap
      width: parent.width
      implicitHeight: sectionHeader.implicitHeight

    MouseArea {
      id: sectionDrag
      anchors.fill: parent
      hoverEnabled: true
      preventStealing: true
      cursorShape: pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor
      onPressed: function(mouse) {
        root.startSectionDrag(section.provider ? section.provider.id : "", sectionDrag, mouse)
      }
      onPositionChanged: function(mouse) {
        if (pressed) root.updateSectionDrag(sectionDrag, mouse)
      }
      onReleased: function(mouse) { root.endSectionDrag() }
      onCanceled: root.cancelSectionDrag()
    }

    Row {
      id: sectionHeader
      width: parent.width
      spacing: Style.space(10)

      ProviderMark {
        id: sectionMark
        anchors.verticalCenter: parent.verticalCenter
        providerId: section.provider ? section.provider.id : ""
        markSize: Style.font.display
        color: root.foreground
      }

      Column {
        width: Math.max(0, sectionHeader.width - sectionMark.width - sectionValue.width
          - sectionToggle.width - sectionGrip.width - sectionHeader.spacing * 4)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: section.provider ? section.provider.name : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.subtitle
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          visible: text !== ""
          text: {
            if (!section.provider) return ""
            var parts = []
            if (section.provider.tier !== "") parts.push(section.provider.tier)
            if (section.provider.status !== "") parts.push(section.provider.status)
            if (!root.isShown(section.provider.id)) parts.push("Hidden from bar")
            return parts.join(" · ")
          }
          color: section.provider && section.provider.status !== "" && sectionWindows().length === 0
            ? root.stateColor("warning")
            : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Text {
        id: sectionValue
        textFormat: Text.PlainText
        visible: sectionSummary() !== null && sectionSummary().mode === "meter"
        text: sectionSummary() ? Model.percentText(sectionSummary().percent) : ""
        color: sectionSummary() ? root.stateColor(sectionSummary().color) : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
      }

      ToggleSwitch {
        id: sectionToggle
        anchors.verticalCenter: parent.verticalCenter
        checked: root.isShown(section.provider ? section.provider.id : "")
        trackHeight: Style.space(16)
        foreground: root.foreground
        accent: Commons.Color.accent
        onToggled: root.setShown(section.provider ? section.provider.id : "",
          !root.isShown(section.provider ? section.provider.id : ""))
      }

      Text {
        id: sectionGrip
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
        text: "⠿"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
    }


    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: section.provider && section.provider.hint !== "" && sectionWindows().length === 0
      text: section.provider ? section.provider.hint : ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: root.showActivity && text !== ""
      text: Model.activityText(section.provider)
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }

    Column {
      width: parent.width
      spacing: Style.space(8)

      Repeater {
        model: sectionWindows()

        delegate: Column {
          width: parent.width
          spacing: Style.space(3)

          Item {
            width: parent.width
            implicitHeight: Math.max(windowLabel.implicitHeight, windowValue.implicitHeight)

            Text {
              id: windowLabel
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - windowValue.width - Style.space(12)
              text: modelData.detail
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              id: windowValue
              textFormat: Text.PlainText
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: modelData.mode === "dollars"
                ? Model.formatCurrency(modelData.spend)
                : (modelData.stale ? "—" : Model.percentText(modelData.percent))
              color: root.stateColor(modelData.color)
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }

          MeterBar {
            visible: modelData.mode === "meter"
            percent: modelData.percent
            fill: root.stateColor(modelData.color)
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            visible: text !== ""
            text: {
              var parts = []
              if (modelData.mode === "meter" && modelData.effectiveLimit) {
                parts.push(Model.formatCurrency(modelData.spend) + " of " + Model.formatCurrency(modelData.effectiveLimit))
              }
              var reset = Model.resetText(modelData.resetsAt, root.nowMs)
              if (reset !== "") parts.push(reset)
              if (modelData.stale) parts.push("stale reading")
              if (modelData.over) parts.push("over the previous cycle")
              return parts.join(" · ")
            }
            color: modelData.over ? root.stateColor("yellow") : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }
      }
    }

    Row {
      width: parent.width
      visible: section.provider !== null && section.provider.money !== null
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: {
          if (!section.provider || !section.provider.money) return ""
          var money = section.provider.money
          var parts = []
          if (money.credits) parts.push(Model.formatCurrency(money.credits.remaining) + " credits left")
          if (money.limit !== null) parts.push(Model.formatCurrency(money.limit) + " " + Model.intervalName(money.resetInterval).toLowerCase() + " limit")
          else parts.push("No key limit")
          return parts.join(" · ")
        }
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    Column {
      width: parent.width
      spacing: Style.space(6)
      visible: section.provider !== null && section.provider.budgets.length > 0

      PanelSectionHeader {
        foreground: root.foreground
        fontFamily: root.fontFamily
        text: "Console budgets"
      }

      Repeater {
        model: section.provider ? section.provider.budgets : []

        delegate: Column {
          width: parent.width
          spacing: Style.space(3)

          Item {
            width: parent.width
            implicitHeight: Math.max(budgetLabel.implicitHeight, budgetValue.implicitHeight)

            Text {
              id: budgetLabel
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - budgetValue.width - Style.space(12)
              text: modelData.id
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              id: budgetValue
              textFormat: Text.PlainText
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: Model.formatCurrency(modelData.spent) + " / " + Model.formatCurrency(modelData.limit)
              color: root.stateColor(Model.stateOf(modelData.percent, root.warnPercent, root.criticalPercent))
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }

          MeterBar {
            percent: modelData.percent
            fill: root.stateColor(Model.stateOf(modelData.percent, root.warnPercent, root.criticalPercent))
          }
        }
      }
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: section.provider !== null && section.provider.error !== ""
      text: section.provider ? section.provider.error : ""
      color: root.stateColor("warning")
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }
}
