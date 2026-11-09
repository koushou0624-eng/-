// カイタイ事務：Supabase とのログイン・同期
// 画面は端末の中のデータ（localStorage）ですぐ動かし、変わった分だけ Supabase に送る／受け取る
(function () {
  'use strict';
  const cfg = window.KJ_CONFIG;
  if (!cfg || !cfg.supabaseUrl || !window.supabase || !window.KJApp) return;

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kaitai-jimu-auth' },
  });
  const SYNC_KEY = 'kaitai-jimu-sync-v1';
  const $ = (s) => document.querySelector(s);

  // キーの順番に左右されない JSON（Supabase の jsonb はキーの順番を並べ替えるため）
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }

  let meta = loadMeta(); // { userId, lastPull, synced: { 'kind:id': 内容 } }
  let user = null, pushTimer = null, pushing = false, again = false, pulling = false;

  function loadMeta() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || { synced: {} }; } catch (_) { return { synced: {} }; } }
  function saveMeta() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(meta)); } catch (_) { /* noop */ } }

  function status(text, cls) {
    const el = $('#syncStatus'); if (!el) return;
    el.hidden = false; el.textContent = text; el.className = 'sync ' + (cls || '');
  }

  // 1つの設定と、案件1件ずつを、それぞれ1行として扱う（端末ごとの「開いている案件」は送らない）
  function docsOf(state) {
    const out = { 'settings:main': { kind: 'settings', id: 'main', data: state.settings } };
    state.cases.forEach((c) => { out['case:' + c.id] = { kind: 'case', id: c.id, data: c }; });
    return out;
  }

  // ---------- 送る ----------
  async function push() {
    if (!user) return;
    if (pushing) { again = true; return; }
    pushing = true; again = false;
    try {
      const docs = docsOf(KJApp.getState());
      const rows = [];
      Object.entries(docs).forEach(([k, d]) => {
        const j = stable(d.data);
        if (meta.synced[k] !== j) rows.push({ k, j, row: { user_id: user.id, kind: d.kind, id: d.id, data: d.data, deleted: false } });
      });
      Object.keys(meta.synced).forEach((k) => {
        if (docs[k]) return;
        const i = k.indexOf(':');
        rows.push({ k, del: true, row: { user_id: user.id, kind: k.slice(0, i), id: k.slice(i + 1), data: {}, deleted: true } });
      });
      if (rows.length) {
        status('保存中…', 'busy');
        const { error } = await sb.from('kj_docs').upsert(rows.map((r) => r.row), { onConflict: 'user_id,kind,id' });
        if (error) throw error;
        rows.forEach((r) => { if (r.del) delete meta.synced[r.k]; else meta.synced[r.k] = r.j; });
        saveMeta();
      }
      status('☁ 保存済み', 'ok');
    } catch (e) {
      console.warn('push failed', e);
      status('⚠ 未送信（つながったら自動で送ります）', 'err');
      setTimeout(schedulePush, 30000);
    } finally {
      pushing = false;
      if (again) schedulePush();
    }
  }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(push, 1000); }

  // ---------- 受け取る ----------
  async function pull({ initial = false } = {}) {
    if (!user || pulling) return;
    pulling = true;
    try {
      let q = sb.from('kj_docs').select('kind,id,data,deleted,updated_at').order('updated_at', { ascending: true });
      if (!initial && meta.lastPull) {
        const since = new Date(new Date(meta.lastPull).getTime() - 5000).toISOString(); // 少し重ねて取りこぼしを防ぐ
        q = q.gte('updated_at', since);
      }
      const { data: rows, error } = await q;
      if (error) throw error;
      const last = rows.length ? rows[rows.length - 1].updated_at : meta.lastPull;

      if (initial) {
        const live = rows.filter((r) => !r.deleted);
        if (!live.some((r) => r.kind === 'case')) {
          // Supabase にまだ案件がない → この端末のデータを送る
          meta.synced = {}; meta.lastPull = last; saveMeta();
          await push();
          return;
        }
        // Supabase のデータでこの端末を置き換える
        const cur = KJApp.getState();
        const next = { settings: cur.settings, cases: [], currentId: cur.currentId };
        meta.synced = {};
        live.forEach((r) => {
          if (r.kind === 'settings') next.settings = r.data; else next.cases.push(r.data);
          meta.synced[r.kind + ':' + r.id] = stable(r.data);
        });
        meta.lastPull = last; saveMeta();
        KJApp.replaceState(next);
        status('☁ 最新', 'ok');
        return;
      }

      if (rows.length) {
        const next = JSON.parse(JSON.stringify(KJApp.getState()));
        let changed = false;
        rows.forEach((r) => {
          const k = r.kind + ':' + r.id;
          const local = docsOf(next)[k];
          const localJ = local ? stable(local.data) : undefined;
          const remoteJ = r.deleted ? undefined : stable(r.data);
          if (localJ === remoteJ) { if (remoteJ !== undefined) meta.synced[k] = remoteJ; return; }
          // この端末でまだ送っていない変更がある → この端末を優先（あとで送る）
          const untouched = local ? localJ === meta.synced[k] : !(k in meta.synced);
          if (!untouched) return;
          if (r.deleted) {
            if (local && r.kind === 'case') { next.cases = next.cases.filter((c) => c.id !== r.id); changed = true; }
            delete meta.synced[k];
          } else {
            if (r.kind === 'settings') next.settings = r.data;
            else {
              const i = next.cases.findIndex((c) => c.id === r.id);
              if (i >= 0) next.cases[i] = r.data; else next.cases.push(r.data);
            }
            meta.synced[k] = remoteJ; changed = true;
          }
        });
        meta.lastPull = last; saveMeta();
        if (changed) KJApp.replaceState(next);
      }
      status('☁ 最新', 'ok');
    } catch (e) {
      console.warn('pull failed', e);
      status('⚠ オフライン', 'err');
    } finally {
      pulling = false;
    }
  }

  // ---------- ログイン ----------
  function showLogin() { $('#loginOverlay').hidden = false; $('#loginEmail').focus(); }
  function hideLogin() { $('#loginOverlay').hidden = true; }

  async function onLogin(u) {
    if (meta.userId && meta.userId !== u.id) meta = { synced: {} }; // 別の人でログインし直した
    meta.userId = u.id; saveMeta();
    user = u;
    hideLogin();
    $('#cloudBox').hidden = false;
    $('#cloudEmail').textContent = u.email || '';
    await pull({ initial: !meta.lastPull });
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginForm button'), err = $('#loginError');
    err.textContent = ''; btn.disabled = true; btn.textContent = 'ログイン中…';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value });
    btn.disabled = false; btn.textContent = 'ログイン';
    if (error) {
      err.textContent = /invalid login/i.test(error.message) ? 'メールアドレスかパスワードが違います。' : /fetch|network/i.test(error.message) ? 'インターネットにつながっていません。' : 'ログインできませんでした：' + error.message;
      return;
    }
    $('#loginPassword').value = '';
    onLogin(data.user);
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await sb.auth.signOut();
    user = null;
    $('#cloudBox').hidden = true;
    showLogin();
  });

  // ---------- きっかけ ----------
  window.KJCloud = { onLocalSave: () => { if (user) schedulePush(); }, pull: () => pull(), push };
  const typing = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); else if (user) push(); });
  window.addEventListener('focus', () => pull());
  window.addEventListener('online', () => { push(); pull(); });
  setInterval(() => { if (!typing()) pull(); }, 2 * 60 * 1000);

  (async () => {
    const { data } = await sb.auth.getSession();
    if (data.session) onLogin(data.session.user); else showLogin();
  })();
})();
