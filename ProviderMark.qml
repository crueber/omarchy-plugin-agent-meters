import QtQuick

// Resolves the per-provider mark from marks/<Name>Mark.qml and forwards the
// size and colour, so every mark in the plugin follows the same theme colour
// and stays crisp at any bar size.
Item {
  id: root

  property string providerId: ""
  property real markSize: 16
  property color color: "white"

  implicitWidth: loader.item ? loader.item.implicitWidth : Math.round(markSize)
  implicitHeight: Math.round(markSize)

  function markFile(id) {
    if (id === "claude") return "Claude"
    if (id === "grok") return "Grok"
    if (id === "opencode") return "Opencode"
    if (id === "openrouter") return "OpenRouter"
    return ""
  }

  Loader {
    id: loader
    anchors.centerIn: parent
    source: root.providerId === ""
      ? ""
      : Qt.resolvedUrl("marks/" + root.markFile(root.providerId) + "Mark.qml")

    onLoaded: {
      loader.item.markSize = Qt.binding(function() { return root.markSize })
      loader.item.color = Qt.binding(function() { return root.color })
    }
  }
}
