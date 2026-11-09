#!/usr/bin/env bash
# Edge Function を Supabase に配置する。core.js は画面と同じものを一緒に送る
# 使い方: bash supabase/deploy-function.sh daily-alerts   または   bash supabase/deploy-function.sh line-webhook
# （Supabase のアクセストークンが api.supabase.com に送られる環境で実行）
set -euo pipefail
REF=bheudvidpcbfrerugnkg
SLUG=${1:-daily-alerts}
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
cp "supabase/functions/$SLUG/index.ts" "$tmp/index.ts"
cp core.js "$tmp/core.js"
cd "$tmp"
curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=$SLUG" \
  -F "metadata={\"entrypoint_path\":\"index.ts\",\"name\":\"$SLUG\",\"verify_jwt\":false};type=application/json" \
  -F "file=@index.ts;filename=index.ts" -F "file=@core.js;filename=core.js"
echo
