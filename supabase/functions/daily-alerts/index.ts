// カイタイ事務：毎朝の LINE 通知（Supabase Edge Function）
// - 毎朝（pg_cron）: x-cron-secret ヘッダーで呼ばれ、通知をオンにしている全員に送る
// - 画面の「テスト送信」: ログイン中の本人の JWT で呼ばれ、本人にだけ送る
import './core.js';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// deno-lint-ignore no-explicit-any
const KJCore = (globalThis as any).KJCore;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Edge Function は UTC で動くので、日本時間の「今日」を UTC の値として扱う（core.js は端末の時刻で日付を数える）
const jstNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);

async function pushLine(token: string, to: string, text: string) {
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  if (!r.ok) throw new Error(`LINE ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// deno-lint-ignore no-explicit-any
async function stateOf(admin: any, userId: string) {
  // その人が所属する会社（いちばん先に入った会社）のデータで注意を作る
  const { data: mem, error: me } = await admin.from('kj_members').select('company_id').eq('user_id', userId).order('joined_at').limit(1);
  if (me) throw me;
  if (!mem || !mem.length) return { settings: {}, cases: [] };
  const { data, error } = await admin.from('kj_docs').select('kind,data').eq('company_id', mem[0].company_id).eq('deleted', false);
  if (error) throw error;
  const state = { settings: {}, cases: [] as unknown[] };
  // deno-lint-ignore no-explicit-any
  (data ?? []).forEach((r: any) => { if (r.kind === 'settings') state.settings = r.data; else state.cases.push(r.data); });
  return state;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 呼び出し元の確認
  let onlyUser: string | null = null;
  let test = false;
  const isCron = CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET;
  if (!isCron) {
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data.user) return json({ error: 'unauthorized' }, 401);
    onlyUser = data.user.id;
    try { test = !!(await req.json()).test; } catch (_) { test = true; }
  }

  let q = admin.from('kj_notify').select('user_id,line_token,line_user_id,enabled');
  if (onlyUser) q = q.eq('user_id', onlyUser); else q = q.eq('enabled', true);
  const { data: targets, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const t of targets ?? []) {
    if (!t.line_token || !t.line_user_id) { results.push({ user: t.user_id, sent: false, reason: 'LINEの設定がありません' }); continue; }
    try {
      const state = await stateOf(admin, t.user_id);
      const now = jstNow();
      let text = KJCore.alertMessage(state, now);
      if (test) text = text || `【カイタイ事務】テスト送信です。\n今日（${now.getUTCMonth() + 1}月${now.getUTCDate()}日）の注意はありません。毎朝7時ごろ、注意があるときだけ届きます。`;
      if (!text) { results.push({ user: t.user_id, sent: false, reason: '注意なし' }); continue; }
      await pushLine(t.line_token, t.line_user_id, text);
      results.push({ user: t.user_id, sent: true });
    } catch (e) {
      results.push({ user: t.user_id, sent: false, reason: String((e as Error).message ?? e) });
    }
  }
  if (onlyUser) {
    const r = results[0];
    if (!r) return json({ sent: false, reason: 'LINEの設定がまだ保存されていません' });
    return json(r);
  }
  return json({ count: results.length, sent: results.filter((r) => r.sent).length });
});
