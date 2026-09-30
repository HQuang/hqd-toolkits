#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "check_multi_customers: jq is required to validate Stripe responses." >&2
  exit 127
fi

for CUSTOMER_ID in "$@"; do
  CURSOR=""
  SEEN_CURSORS=()
  RESULT="inactive"

  while true; do
    STRIPE_ARGS=(subscriptions list "--customer=$CUSTOMER_ID" --status=all --limit=100)
    if [[ -n "$CURSOR" ]]; then
      STRIPE_ARGS+=("--starting-after=$CURSOR")
    fi

    if ! RESPONSE="$(stripe "${STRIPE_ARGS[@]}")"; then
      echo "check_multi_customers: Stripe request failed for customer $CUSTOMER_ID." >&2
      exit 1
    fi

    if ! PAGE="$(jq -er '
      if type != "object" then error("response is not an object")
      elif (.data | type) != "array" then error("response data is not an array")
      elif (.has_more | type) != "boolean" then error("response has_more is not boolean")
      elif any(.data[]; type != "object" or (.id | type) != "string" or (.status | type) != "string") then error("subscription entry is incomplete")
      elif .has_more and (.data | length) == 0 then error("empty page claims more results")
      else
        [any(.data[]; .status == "active" or .status == "trialing"), .has_more, (.data[-1].id // "")] | @tsv
      end
    ' <<<"$RESPONSE")"; then
      echo "check_multi_customers: invalid Stripe response for customer $CUSTOMER_ID." >&2
      exit 1
    fi

    IFS=$'\t' read -r HAS_ACTIVE HAS_MORE NEXT_CURSOR <<<"$PAGE"
    if [[ "$HAS_ACTIVE" == "true" ]]; then
      RESULT="active"
      break
    fi
    if [[ "$HAS_MORE" == "false" ]]; then
      break
    fi
    SEEN_CURSOR=false
    for SEEN in "${SEEN_CURSORS[@]}"; do
      if [[ "$SEEN" == "$NEXT_CURSOR" ]]; then
        SEEN_CURSOR=true
        break
      fi
    done
    if [[ -z "$NEXT_CURSOR" || "$SEEN_CURSOR" == "true" || "$NEXT_CURSOR" == "$CURSOR" ]]; then
      echo "check_multi_customers: Stripe pagination cursor did not advance for customer $CUSTOMER_ID." >&2
      exit 1
    fi

    SEEN_CURSORS+=("$NEXT_CURSOR")
    CURSOR="$NEXT_CURSOR"
  done

  echo "$CUSTOMER_ID | $RESULT"
done
