#!/bin/bash
# 编排会话导出与精简脚本
# 用法: ./export-session.sh <sessionID> [depth]
# 输出: 精简 JSON 文件路径 + 摘要文件路径（.summary.jsonl）
# 精简：删除 tool part 的 .state.output + reasoning part 的 .text
# 摘要：每消息一行的结构化概览，供 optimizer 快速查询，无需解析完整 JSON

set -o pipefail

SESSION_ID="$1"
DEPTH="${2:-0}"
MAX_DEPTH=5
RAW="/tmp/opencode-session-${SESSION_ID}-raw.json"
OUTPUT="/tmp/opencode-session-${SESSION_ID}.json"
SUMMARY="/tmp/opencode-session-${SESSION_ID}.summary.jsonl"
CHILDREN_LIST="/tmp/opencode-session-${SESSION_ID}-children.txt"

if [ -z "$SESSION_ID" ]; then
  echo "Usage: $0 <sessionID>" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found. Install with: brew install jq" >&2
  exit 1
fi

# 导出原始 session
opencode export "$SESSION_ID" 2>/dev/null > "$RAW" || {
  echo "Error: failed to export session $SESSION_ID" >&2
  exit 1
}

# 提取子 session ID（从 tool output 和 metadata.sessionId 中的 ses_xxx 模式）
jq -r '
  [.messages[].parts[]
    | select(.type == "tool" and .state)
    | [(.state.output // ""), (.state.metadata.sessionId // "")]
    | join(" ")
    | match("ses_[a-zA-Z0-9]+"; "g").string
  ] | unique | .[]
' "$RAW" > "$CHILDREN_LIST" 2>/dev/null || true

# 精简：删除 tool output + reasoning text
jq '
  .messages[].parts[] |= (
    if .type == "tool" and .state then .state.output = "[stripped]"
    elif .type == "reasoning" then .text = "[stripped]"
    else . end
  )
' "$RAW" > "$OUTPUT"

rm -f "$RAW"

# 递归处理子 session（深度上限 MAX_DEPTH）
if [ "$DEPTH" -lt "$MAX_DEPTH" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  while IFS= read -r CHILD_ID; do
    [ -z "$CHILD_ID" ] && continue
    CHILD_FILE="/tmp/opencode-session-${CHILD_ID}.json"
    [ -f "$CHILD_FILE" ] && continue  # 已处理过，避免重复
    "$SELF" "$CHILD_ID" "$((DEPTH + 1))" > /dev/null 2>&1 || true
    if [ -f "$CHILD_FILE" ] && [ -s "$CHILD_FILE" ]; then
      jq --slurpfile child "$CHILD_FILE" '
        .messages += $child[0].messages
      ' "$OUTPUT" > "${OUTPUT}.tmp" && mv "${OUTPUT}.tmp" "$OUTPUT"
    fi
  done < "$CHILDREN_LIST"
fi

rm -f "$CHILDREN_LIST"

# 生成摘要文件（每消息一行 JSONL，供 optimizer 快速查询）
jq -r '
  .messages | to_entries[] |
  {
    idx: (.key + 1),
    session: (.value.info.sessionID // "?" | .[0:24]),
    role: (.value.info.role // "?"),
    agent: (.value.info.agent // "."),
    tools: ([.value.parts[] | select(.type == "tool") | .tool] | join(",")),
    text: ([.value.parts[] | select(.type == "text") | .text] | join(" ") | .[0:80])
  } | @json
' "$OUTPUT" > "$SUMMARY" 2>/dev/null || true

echo "$OUTPUT"
