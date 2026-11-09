#!/usr/bin/env bash
# tests/company-flow.js が作った仮のアカウントと会社を消す（Supabase のアクセストークンが api.supabase.com に送られる環境で実行）
set -euo pipefail
REF=bheudvidpcbfrerugnkg
cd "$(dirname "$0")"
python3 - > /tmp/kj-cleanup.json <<'PY'
import json
emails = json.load(open('.last-test-users.json'))
assert all(e.startswith('kj-co-') and e.endswith('@example.com') for e in emails)
lst = ",".join("'%s'" % e for e in emails)
print(json.dumps({"query": f"delete from public.kj_companies where created_by in (select id from auth.users where email in ({lst})); delete from auth.users where email in ({lst});"}))
PY
curl -sS -X POST -H "Content-Type: application/json" --data @/tmp/kj-cleanup.json "https://api.supabase.com/v1/projects/$REF/database/query"; echo
rm -f /tmp/kj-cleanup.json .last-test-users.json
