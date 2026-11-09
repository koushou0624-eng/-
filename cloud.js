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
  let user = null, company = null, pushTimer = null, pushing = false, again = false, pulling = false;

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

  // LINE から入ったマニフェストのうち、この端末にまだないもの（前回の同期以降に増えたもの）を足す
  function mergeLine(localCase, remoteCase, syncedJ) {
    let known = new Set();
    try { known = new Set(((JSON.parse(syncedJ || 'null') || {}).manifests || []).map((m) => m.id)); } catch (_) { /* noop */ }
    const have = new Set((localCase.manifests || []).map((m) => m.id));
    const add = (remoteCase.manifests || []).filter((m) => m.via === 'line' && !have.has(m.id) && !known.has(m.id));
    if (!add.length) return false;
    localCase.manifests = (localCase.manifests || []).concat(add);
    return true;
  }

  // ---------- 送る ----------
  async function push() {
    if (!user || !company) return;
    if (pushing) { again = true; return; }
    pushing = true; again = false;
    try {
      const docs = docsOf(KJApp.getState());
      const rows = [];
      Object.entries(docs).forEach(([k, d]) => {
        const j = stable(d.data);
        if (meta.synced[k] !== j) rows.push({ k, j, row: { company_id: company.id, kind: d.kind, id: d.id, data: d.data, deleted: false } });
      });
      Object.keys(meta.synced).forEach((k) => {
        if (docs[k]) return;
        const i = k.indexOf(':');
        rows.push({ k, del: true, row: { company_id: company.id, kind: k.slice(0, i), id: k.slice(i + 1), data: {}, deleted: true } });
      });
      // 送る前に：送ろうとしている現場に、LINE から新しい記録が入っていないか確かめて取り込む
      const caseIds = rows.filter((r) => !r.del && r.row.kind === 'case').map((r) => r.row.id);
      if (caseIds.length) {
        const { data: remote } = await sb.from('kj_docs').select('id,data,updated_at').eq('company_id', company.id).eq('kind', 'case').in('id', caseIds);
        let merged = false;
        const st = KJApp.getState();
        (remote || []).forEach((rc) => {
          const lc = st.cases.find((c) => c.id === rc.id);
          if (lc && mergeLine(lc, rc.data, meta.synced['case:' + rc.id])) merged = true;
        });
        if (merged) {
          KJApp.replaceState(JSON.parse(JSON.stringify(st)));
          const fresh = docsOf(KJApp.getState());
          rows.forEach((r) => { if (!r.del && fresh[r.k]) { r.row.data = fresh[r.k].data; r.j = stable(fresh[r.k].data); } });
        }
      }
      if (rows.length) {
        status('保存中…', 'busy');
        const { error } = await sb.from('kj_docs').upsert(rows.map((r) => r.row), { onConflict: 'company_id,kind,id' });
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
    if (!user || !company || pulling) return;
    pulling = true;
    try {
      let q = sb.from('kj_docs').select('kind,id,data,deleted,updated_at').eq('company_id', company.id).order('updated_at', { ascending: true });
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
          if (!untouched) {
            // この端末で編集中でも、LINE から入った記録は取り込む（送るときに一緒に送る）
            if (local && r.kind === 'case' && !r.deleted && mergeLine(local.data, r.data, meta.synced[k])) changed = true;
            return;
          }
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
    loadLine();
    await chooseCompany();
  }

  // ---------- 会社 ----------
  const INVITE_KEY = 'kaitai-jimu-invite';
  // 招待リンク（?invite=コード）で開かれたら、コードを覚えてアドレスから消す
  (function takeInvite() {
    const code = new URLSearchParams(location.search).get('invite');
    if (!code) return;
    try { sessionStorage.setItem(INVITE_KEY, code); } catch (_) { /* noop */ }
    history.replaceState(null, '', location.pathname + location.hash);
    $('#inviteNote').hidden = false;
  })();
  const pendingInvite = () => { try { return sessionStorage.getItem(INVITE_KEY); } catch (_) { return null; } };
  const clearInvite = () => { try { sessionStorage.removeItem(INVITE_KEY); } catch (_) { /* noop */ } };

  async function myCompanies() {
    const { data, error } = await sb.from('kj_members').select('company_id, role, kj_companies(name)').eq('user_id', user.id).order('joined_at');
    if (error) throw error;
    return (data || []).map((m) => ({ id: m.company_id, role: m.role, name: (m.kj_companies && m.kj_companies.name) || '' }));
  }

  async function chooseCompany() {
    try {
      const code = pendingInvite();
      if (code) {
        const { error } = await sb.rpc('kj_join_company', { p_code: code });
        clearInvite(); $('#inviteNote').hidden = true;
        if (error) alertBox(/invalid_invite/.test(error.message) ? '招待リンクの期限が切れているか、正しくありません。会社の代表の人に新しいリンクをもらってください。' : '会社に参加できませんでした：' + error.message);
        else meta.companyId = null; // 参加した会社を開く
      }
      const list = await myCompanies();
      if (!list.length) { showCompanySetup(); return; }
      company = list.find((c) => c.id === meta.companyId) || (code ? list[list.length - 1] : list[0]);
      let migrated = false;
      if (meta.companyId === undefined && meta.lastPull) {
        // 会社のしくみができる前から使っていた端末：データはそのまま会社に引っ越し済みなので、同期の記録は引き継ぐ
        meta.companyId = company.id; saveMeta(); migrated = true;
      } else if (meta.companyId !== company.id) { meta.companyId = company.id; meta.synced = {}; meta.lastPull = null; saveMeta(); }
      $('#companyOverlay').hidden = true;
      renderCompanyBox(list);
      renderLineIn();
      await pull({ initial: !meta.lastPull });
      if (migrated) await push(); // 引っ越し中に送れなかった入力があれば送る
    } catch (e) {
      console.warn('company failed', e);
      status('⚠ オフライン', 'err');
    }
  }
  function alertBox(msg) { const el = $('#companyError'); el.textContent = msg; }

  function showCompanySetup() {
    $('#companyOverlay').hidden = false;
    $('#companyName').focus();
  }
  $('#companyCreate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#companyName').value.trim(); if (!name) return;
    const { error } = await sb.rpc('kj_create_company', { p_name: name });
    if (error) { alertBox('会社を作れませんでした：' + error.message); return; }
    meta.companyId = null; saveMeta();
    await chooseCompany();
  });
  $('#companyJoin').addEventListener('submit', async (e) => {
    e.preventDefault();
    let code = $('#joinCode').value.trim();
    const m = code.match(/invite=([0-9a-f]+)/); if (m) code = m[1]; // リンクごと貼ってもよい
    if (!code) return;
    try { sessionStorage.setItem(INVITE_KEY, code); } catch (_) { /* noop */ }
    await chooseCompany();
  });

  // ---------- LINEで入力（連携番号・連携一覧） ----------
  const botId = cfg.lineBotId || '';
  async function renderLineIn() {
    if (!botId) return;
    const box = $('#lineInBox'); box.hidden = false;
    const url = 'https://line.me/R/ti/p/' + encodeURIComponent(botId);
    $('#lineAddLink').href = url; $('#lineAddLink').textContent = botId + '（押すとLINEが開きます）';
    $('#lineDriverArea').hidden = company.role !== 'owner';
    const { data } = await sb.from('kj_line_users').select('line_user_id, user_id, role, display_name, linked_at').eq('company_id', company.id).order('linked_at');
    const canRemove = (u) => company.role === 'owner' || u.user_id === user.id;
    $('#lineUserList').innerHTML = (data || []).map((u) => `<li>${escapeHtml(u.display_name || '（名前なし）')} <span class="chip">${u.role === 'driver' ? '運転手' : '社員'}</span>${u.user_id === user.id ? ' <span class="chip">あなた</span>' : ''}${canRemove(u) ? ` <button type="button" class="btn ghost small" data-unlink="${escapeHtml(u.line_user_id)}">連携を外す</button>` : ''}</li>`).join('') || '<li class="empty">まだありません</li>';
  }
  async function issueCode(role) {
    const label = role === 'driver' ? $('#lineDriverName').value.trim() : null;
    if (role === 'driver' && !label) { $('#lineInMsg').textContent = '運転手さんの名前を入れてください（一覧に出す名前です）。'; return; }
    const { data, error } = await sb.rpc('kj_create_line_code', { p_company: company.id, p_role: role, p_label: label });
    if (error) { $('#lineInMsg').textContent = '連携番号を出せませんでした：' + error.message; return; }
    const url = 'https://line.me/R/ti/p/' + encodeURIComponent(botId);
    const msg = role === 'driver'
      ? `${label}へ\nカイタイ事務の公式LINEを友だち追加して、この番号を送ってください（30分以内）。\n${url}\n連携番号：${data}`
      : '';
    $('#lineCodeOut').hidden = false;
    $('#lineCodeOut').innerHTML = `<div class="code">${data}</div><div class="hint">30分以内に、公式LINEにこの6桁を送ってください。</div>`
      + (msg ? `<textarea id="lineShareText" rows="4" readonly>${escapeHtml(msg)}</textarea><button type="button" class="btn ghost small" id="lineShareCopy">運転手さんに送る文をコピー</button>` : '');
    $('#lineInMsg').textContent = '';
  }
  $('#lineCodeSelf').addEventListener('click', () => issueCode('member'));
  $('#lineCodeDriver').addEventListener('click', () => issueCode('driver'));
  $('#lineCodeOut').addEventListener('click', async (e) => {
    if (e.target.id !== 'lineShareCopy') return;
    const el = $('#lineShareText');
    try { await navigator.clipboard.writeText(el.value); $('#lineInMsg').textContent = 'コピーしました。LINEなどで運転手さんに送ってください。'; }
    catch (_) { el.select(); $('#lineInMsg').textContent = '選択しました。コピーしてください。'; }
  });
  $('#lineUserList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-unlink]'); if (!b) return;
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'もう一度押すと外す'; setTimeout(() => { b.dataset.armed = ''; b.textContent = '連携を外す'; }, 3000); return; }
    const { error } = await sb.from('kj_line_users').delete().eq('line_user_id', b.dataset.unlink);
    $('#lineInMsg').textContent = error ? '外せませんでした：' + error.message : '連携を外しました。';
    renderLineIn();
  });

  // 設定画面の「会社」欄
  async function renderCompanyBox(list) {
    const box = $('#companyBox'); box.hidden = false;
    const owner = company.role === 'owner';
    $('#companyNameEdit').value = company.name; $('#companyNameEdit').disabled = !owner;
    $('#companyRename').hidden = !owner; $('#inviteArea').hidden = !owner;
    $('#companySwitch').closest('label').hidden = list.length < 2;
    $('#companySwitch').innerHTML = list.map((c) => `<option value="${c.id}" ${c.id === company.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    const { data } = await sb.from('kj_members').select('user_id, email, role, joined_at').eq('company_id', company.id).order('joined_at');
    $('#memberList').innerHTML = (data || []).map((m) => `<li>${escapeHtml(m.email || '（メール不明）')} <span class="chip">${m.role === 'owner' ? '代表' : 'メンバー'}</span>${m.user_id === user.id ? ' <span class="chip">あなた</span>' : ''}${owner && m.user_id !== user.id ? ` <button type="button" class="btn ghost small" data-remove="${m.user_id}">外す</button>` : ''}</li>`).join('');
  }
  const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  $('#companyRename').addEventListener('click', async () => {
    const name = $('#companyNameEdit').value.trim(); if (!name) return;
    const { error } = await sb.from('kj_companies').update({ name }).eq('id', company.id);
    $('#companyMsg').textContent = error ? '変更できませんでした：' + error.message : '会社名を変更しました。';
    if (!error) company.name = name;
  });
  $('#inviteMake').addEventListener('click', async () => {
    const { data, error } = await sb.rpc('kj_create_invite', { p_company: company.id });
    if (error) { $('#companyMsg').textContent = '招待リンクを作れませんでした：' + error.message; return; }
    const url = location.origin + location.pathname + '?invite=' + data;
    $('#inviteUrl').value = url; $('#inviteUrlRow').hidden = false;
    $('#companyMsg').textContent = 'このリンクを、同じ会社の人にLINEなどで送ってください（7日間有効）。';
  });
  $('#inviteCopy').addEventListener('click', async () => {
    const el = $('#inviteUrl');
    try { await navigator.clipboard.writeText(el.value); $('#companyMsg').textContent = 'コピーしました。'; }
    catch (_) { el.select(); $('#companyMsg').textContent = '選択しました。コピーしてください。'; }
  });
  const removeArmed = {};
  $('#memberList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]'); if (!b) return;
    const id = b.dataset.remove;
    if (!removeArmed[id]) { b.textContent = 'もう一度押すと外す'; removeArmed[id] = setTimeout(() => { b.textContent = '外す'; delete removeArmed[id]; }, 3000); return; }
    clearTimeout(removeArmed[id]); delete removeArmed[id];
    const { error } = await sb.from('kj_members').delete().eq('company_id', company.id).eq('user_id', id);
    $('#companyMsg').textContent = error ? '外せませんでした：' + error.message : 'メンバーから外しました。';
    renderCompanyBox(await myCompanies());
  });
  $('#companySwitch').addEventListener('change', async (e) => {
    await push();
    meta.companyId = e.target.value; meta.synced = {}; meta.lastPull = null; saveMeta();
    await chooseCompany();
  });

  let signupMode = false;
  function setMode(signup) {
    signupMode = signup;
    $('#loginTitle').textContent = signup ? '新規登録' : 'ログイン';
    $('#loginSubmit').textContent = signup ? '登録する' : 'ログイン';
    $('#loginPassword2Row').hidden = !signup;
    $('#loginPassword').autocomplete = signup ? 'new-password' : 'current-password';
    $('#loginToggle').textContent = signup ? 'アカウントをお持ちの方はこちら（ログイン）' : 'はじめての方はこちら（新規登録）';
    $('#loginError').textContent = '';
  }
  $('#loginToggle').addEventListener('click', () => setMode(!signupMode));
  if (pendingInvite()) setMode(true);

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginSubmit'), err = $('#loginError');
    const email = $('#loginEmail').value.trim(), password = $('#loginPassword').value;
    err.textContent = '';
    if (signupMode) {
      if (password.length < 8) { err.textContent = 'パスワードは8文字以上にしてください。'; return; }
      if (password !== $('#loginPassword2').value) { err.textContent = '確認用のパスワードが一致しません。'; return; }
    }
    btn.disabled = true; btn.textContent = signupMode ? '登録中…' : 'ログイン中…';
    const { data, error } = signupMode ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = signupMode ? '登録する' : 'ログイン';
    if (error) {
      const m = error.message || '';
      err.textContent = /invalid login/i.test(m) ? 'メールアドレスかパスワードが違います。'
        : /already registered|already exists/i.test(m) ? 'このメールアドレスは登録済みです。ログインしてください。'
        : /signups? not allowed|signup_disabled/i.test(m) ? '今は新規登録を受け付けていません。'
        : /fetch|network/i.test(m) ? 'インターネットにつながっていません。'
        : (signupMode ? '登録できませんでした：' : 'ログインできませんでした：') + m;
      return;
    }
    if (signupMode && !data.session) { err.textContent = '確認メールを送りました。メールのリンクを開いてから、ログインしてください。'; setMode(false); return; }
    $('#loginPassword').value = ''; $('#loginPassword2').value = '';
    onLogin(data.user);
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await sb.auth.signOut();
    user = null; company = null;
    $('#cloudBox').hidden = true;
    $('#lineBox').hidden = true;
    $('#companyBox').hidden = true;
    $('#lineInBox').hidden = true;
    showLogin();
  });

  // ---------- LINE 通知の設定（端末には保存せず、Supabase の kj_notify にだけ置く） ----------
  let lineHasToken = false, lineSavedUid = '';
  const lineMsg = (t, bad) => { const el = $('#lineMsg'); el.textContent = t; el.style.color = bad ? '#e03131' : ''; };
  async function loadLine() {
    // 読み込みが終わってから欄を出す（先に入力した内容を上書きしないため）
    const { data, error } = await sb.from('kj_notify').select('line_token,line_user_id,enabled').maybeSingle();
    $('#lineBox').hidden = false;
    if (error) { lineMsg('LINEの設定を読み込めませんでした。', true); return; }
    lineHasToken = !!(data && data.line_token);
    $('#lineToken').value = '';
    $('#lineToken').placeholder = lineHasToken ? '保存済み（変えるときだけ貼り付け）' : '貼り付けてください';
    lineSavedUid = (data && data.line_user_id) || '';
    $('#lineUserId').value = lineSavedUid;
    $('#lineEnabled').checked = data ? data.enabled !== false : true;
    lineMsg(lineHasToken && data.line_user_id ? '設定済みです。「テスト送信」で届くか確かめられます。' : '');
  }
  async function saveLine() {
    const token = $('#lineToken').value.trim(), uidLine = $('#lineUserId').value.trim();
    if (!token && !lineHasToken) { lineMsg('チャネルアクセストークンを貼り付けてください。', true); return false; }
    if (!/^U[0-9a-f]{32}$/.test(uidLine)) { lineMsg('ユーザーIDは「U」から始まる33文字です。もう一度コピーしてください。', true); return false; }
    const row = { user_id: user.id, line_user_id: uidLine, enabled: $('#lineEnabled').checked, updated_at: new Date().toISOString() };
    if (token) row.line_token = token;
    const { error } = await sb.from('kj_notify').upsert(row, { onConflict: 'user_id' });
    if (error) { lineMsg('保存できませんでした：' + error.message, true); return false; }
    lineHasToken = lineHasToken || !!token; lineSavedUid = uidLine;
    $('#lineToken').value = ''; $('#lineToken').placeholder = '保存済み（変えるときだけ貼り付け）';
    lineMsg('保存しました。');
    return true;
  }
  $('#lineSave').addEventListener('click', () => { if (user) saveLine(); });
  $('#lineTest').addEventListener('click', async () => {
    if (!user) return;
    if ($('#lineToken').value.trim() || $('#lineUserId').value.trim() !== lineSavedUid) { if (!(await saveLine())) return; }
    lineMsg('送信中…');
    const { data, error } = await sb.functions.invoke('daily-alerts', { body: { test: true } });
    if (error) { lineMsg('送れませんでした：' + error.message, true); return; }
    if (data && data.sent) lineMsg('LINEに送りました。届いているか確認してください。');
    else lineMsg('送れませんでした：' + ((data && data.reason) || '原因不明') + '（トークンとユーザーID、公式アカウントを友だち追加しているかを確認してください）', true);
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
