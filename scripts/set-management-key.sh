#!/usr/bin/env bash
# Store, inspect or remove the OpenRouter management key Agent Meters uses for
# its account-wide view.
#
#   scripts/set-management-key.sh            prompt (no echo) and store it
#   scripts/set-management-key.sh --file     store it in the 0600 file instead
#   scripts/set-management-key.sh --status   say where a key is stored
#   scripts/set-management-key.sh --remove   delete it from both places
#
# The key is read from the terminal without echo, or from stdin when piped
# (`wl-paste | scripts/set-management-key.sh`). It is never accepted as an
# argument, never printed, and only handed to `secret-tool` on its stdin by a
# shell builtin, so it never appears on any process's command line.
#
# Where it goes:
#   1. the freedesktop Secret Service (gnome-keyring on Omarchy), through
#      `secret-tool store service agent-meters account openrouter-management`;
#   2. with --file, or when no Secret Service answers:
#      ${XDG_DATA_HOME:-~/.local/share}/agent-meters/openrouter-management-key
#      (directory 0700, file 0600, never a symlink). It is kept out of
#      ~/.config on purpose: that tree is often synced as dotfiles.
set -euo pipefail
umask 077

attributes=(service agent-meters account openrouter-management)
label="Agent Meters: OpenRouter management key"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
key_dir="$data_home/agent-meters"
key_file="$key_dir/openrouter-management-key"

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

have_secret_tool() {
  command -v secret-tool >/dev/null 2>&1
}

secret_service_has_key() {
  have_secret_tool || return 1
  # The lookup prints the secret; discard it, only the exit status matters.
  timeout 5 secret-tool lookup "${attributes[@]}" >/dev/null 2>&1
}

refresh_widget() {
  if command -v omarchy-shell >/dev/null 2>&1; then
    omarchy-shell -q agent-meters refresh >/dev/null 2>&1 || true
  fi
}

remove_file() {
  if [[ -L $key_file ]]; then
    rm -f -- "$key_file"
  elif [[ -f $key_file ]]; then
    # Overwrite before unlinking; best effort on copy-on-write filesystems.
    if command -v shred >/dev/null 2>&1; then shred -u -- "$key_file" 2>/dev/null || rm -f -- "$key_file"
    else rm -f -- "$key_file"
    fi
  fi
}

remove_secret() {
  have_secret_tool || return 0
  timeout 5 secret-tool clear "${attributes[@]}" >/dev/null 2>&1 || true
}

status() {
  local found=0
  if [[ -n ${OPENROUTER_MANAGEMENT_KEY:-} ]]; then
    echo "OPENROUTER_MANAGEMENT_KEY is set in this shell (it wins over stored keys)"
    found=1
  fi
  if secret_service_has_key; then
    echo "Stored in the Secret Service (service=agent-meters account=openrouter-management)"
    found=1
  fi
  if [[ -e $key_file || -L $key_file ]]; then
    echo "Stored in $key_file"
    found=1
  fi
  [[ $found -eq 1 ]] || echo "No OpenRouter management key is stored"
}

read_key() {
  local key=""
  if [[ -t 0 ]]; then
    echo "Create a management key at https://openrouter.ai/settings/management-keys" >&2
    IFS= read -r -s -p "OpenRouter management key (input hidden): " key
    echo >&2
  else
    IFS= read -r key || true
  fi
  # Trim surrounding whitespace.
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  REPLY_KEY="$key"
}

valid_key() {
  local key="$1"
  [[ ${#key} -ge 16 && ${#key} -le 512 && $key =~ ^[A-Za-z0-9._~+/=:-]+$ ]]
}

store_file() {
  local key="$1" tmp
  if [[ -L $key_dir ]] || { [[ -e $key_dir ]] && [[ ! -d $key_dir ]]; }; then
    echo "$key_dir is not a plain directory; refusing to write there" >&2
    return 1
  fi
  install -d -m 700 "$key_dir"
  chmod 700 "$key_dir"
  if [[ -L $key_file ]]; then
    echo "$key_file is a symlink; refusing to write through it" >&2
    return 1
  fi
  tmp=$(mktemp "$key_dir/.openrouter-management-key.XXXXXX")
  chmod 600 "$tmp"
  printf '%s\n' "$key" >"$tmp"
  mv -f -- "$tmp" "$key_file"
  chmod 600 "$key_file"
}

store_secret() {
  local key="$1"
  have_secret_tool || return 1
  # printf is a bash builtin: the key reaches secret-tool on stdin only.
  printf '%s' "$key" | timeout 10 secret-tool store --label="$label" "${attributes[@]}" >/dev/null 2>&1
}

mode="store"
target="auto"
for arg in "$@"; do
  case "$arg" in
    --remove) mode="remove" ;;
    --status) mode="status" ;;
    --file) target="file" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument. The key is never passed as an argument; run without one and paste it at the prompt." >&2
      exit 2
      ;;
  esac
done

case "$mode" in
  status)
    status
    ;;
  remove)
    remove_secret
    remove_file
    echo "Removed the stored OpenRouter management key; OpenRouter returns to the per-key view."
    if [[ -n ${OPENROUTER_MANAGEMENT_KEY:-} ]]; then
      echo "Note: OPENROUTER_MANAGEMENT_KEY is still set in this environment." >&2
    fi
    refresh_widget
    ;;
  store)
    REPLY_KEY=""
    read_key
    key="$REPLY_KEY"
    REPLY_KEY=""
    if ! valid_key "$key"; then
      unset key
      echo "That does not look like an OpenRouter key (16-512 characters, no spaces); nothing was stored." >&2
      exit 1
    fi
    if [[ $target == "auto" ]] && store_secret "$key"; then
      remove_file
      echo "Stored in the Secret Service (service=agent-meters account=openrouter-management)."
    else
      if [[ $target == "auto" ]]; then
        echo "No Secret Service answered; storing the key in $key_file (mode 0600) instead." >&2
      fi
      if ! store_file "$key"; then
        unset key
        exit 1
      fi
      remove_secret
      echo "Stored in $key_file (mode 0600)."
    fi
    unset key
    refresh_widget
    ;;
esac
