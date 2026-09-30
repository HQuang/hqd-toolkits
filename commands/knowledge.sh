#!/usr/bin/env bash
DESCRIPTION="Cài/gỡ knowledge workflow Codex + MCP Memory + Obsidian an toàn"

run() {
  local manager="$USER_SCRIPTS_DIR/knowledge/knowledge-manager.sh"

  if [[ ! -f "$manager" ]]; then
    manager="$PACKAGE_SCRIPTS_DIR/knowledge/knowledge-manager.sh"
  fi

  if [[ ! -f "$manager" ]]; then
    echo "hqd-toolkits knowledge: thiếu bundled manager tại $manager" >&2
    return 1
  fi

  bash "$manager" "$@"
}
