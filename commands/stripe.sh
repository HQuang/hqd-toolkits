#!/usr/bin/env bash
DESCRIPTION="Chạy các script .sh liên quan tới Stripe"

run() {
  local user_dir="$USER_SCRIPTS_DIR/stripe"
  local bundled_dir="$PACKAGE_SCRIPTS_DIR/stripe"

  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<EOF
Usage: hqd-toolkits stripe [script-name] [args...]

Ưu tiên script user tại: $user_dir
Fallback script bundled tại: $bundled_dir

Không truyền tham số -> liệt kê script hiện có.
Truyền script-name  -> chạy <script-name>.sh.
EOF
    return 0
  fi

  if [[ $# -eq 0 ]]; then
    echo "Các stripe script hiện có:"
    local found=0 name f
    declare -A seen=()
    for f in "$user_dir"/*.sh "$bundled_dir"/*.sh; do
      [[ -e "$f" ]] || continue
      name="$(basename "$f" .sh)"
      [[ -n "${seen[$name]:-}" ]] && continue
      seen[$name]=1
      found=1
      echo "  - $name"
    done
    [[ "$found" -eq 0 ]] && echo "  (chưa có script nào)"
    return 0
  fi

  local script_name="$1"; shift
  local script_path=""
  if [[ -f "$user_dir/$script_name.sh" ]]; then
    script_path="$user_dir/$script_name.sh"
  elif [[ -f "$bundled_dir/$script_name.sh" ]]; then
    script_path="$bundled_dir/$script_name.sh"
  else
    echo "hqd-toolkits stripe: không tìm thấy script '$script_name'" >&2
    return 1
  fi

  bash "$script_path" "$@"
}
