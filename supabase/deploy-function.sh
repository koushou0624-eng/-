#!/usr/bin/env bash
# 毎朝の通知（Edge Function）を Supabase に配置する。core.js は画面と同じものを一緒に送る
# 使い方: SUPABASE_ACCESS_TOKEN が api.supabase.com に送られる環境で bash supabase/deploy-function.sh
set -euo pipefail
REF=bheudvidpcbfrerugnkg
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
cp supabase/functions/daily-alerts/index.ts "$tmp/index.ts"
cp core.js "$tmp/core.js"
cd "$tmp"
curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=daily-alerts" \
  -F 'metadata={"entrypoint_path":"index.ts","name":"daily-alerts","verify_jwt":false};type=application/json' \
  -F "file=@index.ts;filename=index.ts" -F "file=@core.js;filename=core.js"
echo
