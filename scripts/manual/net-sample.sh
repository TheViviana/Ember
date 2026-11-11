#!/usr/bin/env bash
# 手动网络采样：列出一个 Ember 进程当前的已建立 TCP 连接，并单独标出非回环地址。
#
# 用法：
#   scripts/manual/net-sample.sh                # 采样 1 次
#   scripts/manual/net-sample.sh 10 2           # 采样 10 次，间隔 2 秒
#   EMBER_PID=12345 scripts/manual/net-sample.sh
#
# 说明：正式门禁是 scripts/gates/offline.mjs + runtime-network.mjs；
# 这个脚本只用于人工核对，比如确认某次对话期间除了用户配置的 AI 端点外没有别的外连。

set -euo pipefail

rounds="${1:-1}"
interval="${2:-1}"
pid="${EMBER_PID:-}"

if [[ -z "$pid" ]]; then
  # -x 精确匹配进程名：-f 会命中任何命令行里含该路径的进程（编辑器、tail -f 等）
  pid="$(pgrep -x 'ember' | head -n 1 || true)"
fi
if [[ -z "$pid" ]]; then
  echo "未找到 Ember 进程；可用 EMBER_PID=<pid> 指定" >&2
  exit 1
fi

echo "采样 PID ${pid}，共 ${rounds} 轮，间隔 ${interval}s"
external_total=0

for ((round = 1; round <= rounds; round += 1)); do
  if [[ "$round" -gt 1 ]]; then
    sleep "$interval"
  fi

  raw="$(lsof -nP -a -p "$pid" -iTCP -sTCP:ESTABLISHED 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    echo "[$round/$rounds] 无已建立连接"
    continue
  fi

  external="$(printf '%s\n' "$raw" | awk 'NR > 1 {
    n = split($9, parts, "->");
    peer = (n > 1) ? parts[2] : $9;
    if (peer !~ /^(127\.|\[::1\]|::1|localhost):/) print "  ✗ " $9;
  }')"
  inner="$(printf '%s\n' "$raw" | awk 'NR > 1 {
    n = split($9, parts, "->");
    peer = (n > 1) ? parts[2] : $9;
    if (peer ~ /^(127\.|\[::1\]|::1|localhost):/) print "  · " $9;
  }')"

  echo "[$round/$rounds]"
  [[ -n "$inner" ]] && printf '%s\n' "$inner"
  if [[ -n "$external" ]]; then
    printf '%s\n' "$external"
    external_total=$((external_total + $(printf '%s\n' "$external" | wc -l | tr -d ' ')))
  else
    echo "  （无非回环连接）"
  fi
done

if [[ "$external_total" -gt 0 ]]; then
  echo "结果：发现 ${external_total} 条非回环连接"
  exit 1
fi
echo "结果：全部为回环连接"
