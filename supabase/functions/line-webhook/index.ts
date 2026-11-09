// カイタイ事務：LINE 公式アカウントに届いたメッセージを受け取る（Supabase Edge Function）
// ・6桁の連携番号 → その LINE アカウントを会社に結びつける
// ・「ヒラヤマ 住吉区 シバ 3t」のような記録 → 現場（案件）にマニフェストを1枚追加して返事をする
// ・「取消」→ 自分が LINE で入れた直前の記録を消す ／「使い方」→ 送り方を返す
import './core.js';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// deno-lint-ignore no-explicit-any
const K = (globalThis as any).KJCore;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') ?? '';
const CHANNEL_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Edge Function は UTC で動くので、日本時間の「今日」を UTC の値として扱う（core.js と同じ考え方）
const jstNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);

async function validSignature(body: string, signature: string | null) {
  if (!CHANNEL_SECRET || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

const sentReplies: string[] = []; // テストで返事の内容を確かめるため、レスポンスにも入れる
async function reply(replyToken: string, text: string) {
  sentReplies.push(text);
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  if (!r.ok) console.error('reply failed', r.status, await r.text());
}

async function displayName(lineUserId: string) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, { headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` } });
    if (r.ok) return (await r.json()).displayName as string;
  } catch (_) { /* 名前が取れなくても続ける */ }
  return null;
}

// deno-lint-ignore no-explicit-any
async function companyState(companyId: string): Promise<any> {
  const { data, error } = await admin.from('kj_docs').select('kind,data').eq('company_id', companyId).eq('deleted', false);
  if (error) throw error;
  const state = { settings: {}, cases: [] as unknown[] };
  // deno-lint-ignore no-explicit-any
  (data ?? []).forEach((r: any) => { if (r.kind === 'settings') state.settings = r.data; else state.cases.push(r.data); });
  return state;
}

// deno-lint-ignore no-explicit-any
async function saveCase(companyId: string, c: any) {
  const { error } = await admin.from('kj_docs').update({ data: c }).eq('company_id', companyId).eq('kind', 'case').eq('id', c.id);
  if (error) throw error;
}

// deno-lint-ignore no-explicit-any
async function addRecord(link: any, r: any, state: any) {
  const m = K.manifestFromRecord(r, state, link.line_user_id);
  const c = r.target;
  c.manifests = Array.isArray(c.manifests) ? c.manifests : [];
  c.manifests.push(m);
  await saveCase(link.company_id, c);
  await admin.from('kj_line_users').update({ pending: null }).eq('line_user_id', link.line_user_id);
  return K.recordReply(r, state);
}

// deno-lint-ignore no-explicit-any
async function handleText(ev: any) {
  const uid: string = ev.source?.userId;
  const text: string = String(ev.message?.text ?? '').trim();
  const plain = text.normalize('NFKC').replace(/\s+/g, '');
  const { data: link } = await admin.from('kj_line_users').select('*').eq('line_user_id', uid).maybeSingle();

  // 連携番号（6桁）
  const code = plain.match(/^(?:連携)?(\d{6})$/);
  if (code) {
    const { data: row } = await admin.from('kj_line_codes').select('*').eq('code', code[1]).gt('expires_at', new Date().toISOString()).maybeSingle();
    if (!row) return '連携番号が見つからないか、期限（30分）が切れています。カイタイ事務の「⚙ 会社・単価設定」→「LINEで入力」で、新しい番号を出してもらってください。';
    const name = await displayName(uid);
    await admin.from('kj_line_users').upsert({ line_user_id: uid, company_id: row.company_id, user_id: row.user_id, role: row.role, display_name: row.label || name, pending: null, linked_at: new Date().toISOString() });
    await admin.from('kj_line_codes').delete().eq('code', row.code);
    const { data: co } = await admin.from('kj_companies').select('name').eq('id', row.company_id).maybeSingle();
    return `「${co?.name ?? '会社'}」と連携しました。\nここに捨てた記録を送ると、カイタイ事務に自動で入ります。\n\n${K.LINE_HELP}`;
  }

  if (!link) return 'このLINEはまだ会社と連携していません。\n会社の代表の人から「連携番号（6桁）」をもらって、ここに送ってください。';
  if (/^(使い方|使いかた|ヘルプ|help|\?|？)$/i.test(plain)) return K.LINE_HELP;

  const state = await companyState(link.company_id);

  // 取消：自分が LINE で入れた記録のうち、いちばん新しいもの（24時間以内）を消す
  if (/^(取消|取り消し|取りけし|とりけし|キャンセル)$/.test(plain)) {
    // deno-lint-ignore no-explicit-any
    let last: any = null;
    // deno-lint-ignore no-explicit-any
    state.cases.forEach((c: any) => (c.manifests || []).forEach((m: any) => {
      if (m.lineBy === uid && m.lineAt && Date.now() - Date.parse(m.lineAt) < 24 * 3600 * 1000 && (!last || m.lineAt > last.m.lineAt)) last = { c, m };
    }));
    if (!last) return '取り消せる記録がありません（LINEで送った24時間以内の記録だけ取り消せます）。';
    // deno-lint-ignore no-explicit-any
    last.c.manifests = last.c.manifests.filter((m: any) => m.id !== last.m.id);
    await saveCase(link.company_id, last.c);
    const w = K.WT[last.m.type];
    return `取り消しました：${K.caseLabel(last.c)} ${w ? w.name : ''} ${last.m.qty}t（${last.m.disposer || '処分場未入力'}）`;
  }

  // 「どの現場ですか？」への番号の返事
  const pick = plain.match(/^(\d{1,2})$/);
  if (pick && link.pending && Array.isArray(link.pending.candidates)) {
    const id = link.pending.candidates[Number(pick[1]) - 1];
    // deno-lint-ignore no-explicit-any
    const target = state.cases.find((c: any) => c.id === id);
    if (!target) return '番号が見つかりませんでした。もう一度、記録を全部まとめて送ってください。';
    return await addRecord(link, { ...link.pending.record, target }, state);
  }

  const r = K.parseRecord(text, state, jstNow());
  if (r.missing.includes('type') || r.missing.includes('qty')) return K.askReply(r);
  if (!r.target) {
    // deno-lint-ignore no-explicit-any
    const candidates = (r.candidates || []).slice(0, 9).map((c: any) => c.id);
    await admin.from('kj_line_users').update({ pending: { record: { ...r, target: null, candidates: null }, candidates } }).eq('line_user_id', uid);
    return K.askReply(r);
  }
  return await addRecord(link, r, state);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const body = await req.text();
  if (!(await validSignature(body, req.headers.get('x-line-signature')))) return new Response('bad signature', { status: 401 });
  sentReplies.length = 0;
  let events = [];
  try { events = JSON.parse(body).events ?? []; } catch (_) { return new Response('bad body', { status: 400 }); }
  for (const ev of events) {
    try {
      if (ev.type === 'follow') {
        await reply(ev.replyToken, '友だち追加ありがとうございます。カイタイ事務の公式アカウントです。\n会社の代表の人からもらった「連携番号（6桁）」を、ここに送ってください。');
      } else if (ev.type === 'message' && ev.message?.type === 'text') {
        const text = await handleText(ev);
        if (text) await reply(ev.replyToken, text);
      }
    } catch (e) {
      console.error('event failed', e);
      if (ev.replyToken) await reply(ev.replyToken, 'うまく登録できませんでした。少し時間をおいて、もう一度送ってください。');
    }
  }
  return new Response(JSON.stringify({ ok: true, replies: sentReplies }), { headers: { 'Content-Type': 'application/json' } });
});
