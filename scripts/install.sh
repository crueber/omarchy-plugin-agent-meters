#!/usr/bin/env bash
set -euo pipefail

# Deploy the runtime files to the live Omarchy plugin directory.
# Usage: ./scripts/install.sh [bar-section]   (default: right)

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
plugin_id="crueber.agent-meters"
section="${1:-right}"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/$plugin_id"

command -v omarchy >/dev/null 2>&1 || {
  echo "omarchy is not on PATH; this script is for an Omarchy install" >&2
  exit 1
}

install -d "$dest" "$dest/marks" "$dest/scripts"
for file in manifest.json Panel.qml ProviderMark.qml Model.js README.md LICENSE preview.png; do
  test -f "$repo_dir/$file" || continue
  install -m 0644 "$repo_dir/$file" "$dest/$file"
done
for file in "$repo_dir"/marks/*.qml; do
  install -m 0644 "$file" "$dest/marks/"
done
install -m 0755 "$repo_dir/scripts/collect.js" "$dest/scripts/collect.js"
install -m 0755 "$repo_dir/scripts/grok.js" "$dest/scripts/grok.js"
install -m 0755 "$repo_dir/scripts/set-management-key.sh" "$dest/scripts/set-management-key.sh"

omarchy plugin validate "$dest"
omarchy-shell -q shell rescanPlugins || true

if ! omarchy plugin list --json | jq -e --arg id "$plugin_id" \
  'any(.[]; .id == $id and .enabled)' >/dev/null 2>&1; then
  omarchy plugin enable "$plugin_id" --section "$section"
else
  echo "$plugin_id is already enabled"
fi

echo "Installed $plugin_id to $dest"
