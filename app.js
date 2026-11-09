// カイタイ事務 — 試作版（データはブラウザの localStorage に保存）
(() => {
  'use strict';
  const STORE_KEY = 'kaitai-jimu-v1';
  const STRUCT = { wood: '木造', steel: '鉄骨造', rc: '鉄筋コンクリート造' };
  const ASB = {
    none: '含有なし', level3: 'あり（レベル3）', level12: 'あり（レベル1・2）', unknown: '未調査',
  };
  // 相場の目安（必ず自社単価に変更する前提）
  const DEFAULT_SETTINGS = {
    name: '', rep: '', address: '', tel: '', permit: '', validDays: 30,
    pWood: 35000, pSteel: 45000, pRc: 60000, pManual: 30, pNarrow: 10,
    pDebris: 12000, pBlock: 8000, pConcrete: 3000, pTree: 15000,
    pAsb3: 3000, pAsb12: 30000, pScaffold: 800, pOverhead: 5,
  };
  // 延床1㎡あたりの廃棄物量の目安（トン）
  const WASTE_FACTOR = {
    wood: { c: 0.35, w: 0.12, a: 0.05 },
    steel: { c: 0.6, w: 0.03, a: 0.05 },
    rc: { c: 1.2, w: 0.02, a: 0.05 },
  };

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const yen = (n) => Math.round(n).toLocaleString('ja-JP');
  const blank = (v, w = '　　　　　　') => (v ? esc(v) : `<span class="blank">${w}</span>`);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- 保存 ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
        if (d.cases?.length) return d;
      }
    } catch (_) { /* 保存領域が使えない場合は初期状態 */ }
    const first = newCase();
    return { settings: { ...DEFAULT_SETTINGS }, cases: [first], currentId: first.id };
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* noop */ } }

  function newCase() {
    const d = new Date();
    const no = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(Math.floor(Math.random() * 900) + 100)}`;
    return {
      id: uid(), estimateNo: no, createdAt: d.toISOString(),
      clientName: '', clientAddress: '', clientTel: '', siteAddress: '',
      structure: 'wood', floors: 2, floorArea: '', use: '専用住宅', builtYear: '',
      noHeavy: false, narrowRoad: false, debrisM3: 0, blockM: 0, concreteM2: 0, trees: 0,
      asbestos: 'none', asbestosM2: 0, startDate: '', endDate: '',
      wConcrete: 0, wWood: 0, wAsphalt: 0, notes: '',
    };
  }

  let state = load();
  const cur = () => state.cases.find((c) => c.id === state.currentId) || state.cases[0];

  // ---------- フォーム <-> データ ----------
  function fillForm(form, obj) {
    $$('input, select, textarea', form).forEach((el) => {
      if (!el.name || !(el.name in obj)) return;
      if (el.type === 'checkbox') el.checked = !!obj[el.name];
      else el.value = obj[el.name] ?? '';
    });
  }
  function bindForm(form, getObj) {
    form.addEventListener('input', (e) => {
      const el = e.target; if (!el.name) return;
      getObj()[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      save(); renderAll();
    });
  }

  // ---------- 計算 ----------
  function calcEstimate(c, s) {
    const area = num(c.floorArea);
    const tsubo = area * 0.3025;
    const unit = { wood: num(s.pWood), steel: num(s.pSteel), rc: num(s.pRc) }[c.structure];
    const lines = [];
    const add = (name, qty, u, price, note = '') => { if (qty > 0 && price > 0) lines.push({ name, qty, u, price, amount: qty * price, note }); };
    add(`建物本体解体工事（${STRUCT[c.structure]}・${c.floors || '-'}階建）`, +tsubo.toFixed(2), '坪', unit, `延床 ${area}㎡`);
    add('仮設工事（養生シート・足場）', area, '㎡', num(s.pScaffold));
    const base = tsubo * unit;
    if (c.noHeavy) add('手壊し作業割増', 1, '式', base * num(s.pManual) / 100, `本体の${s.pManual}%`);
    if (c.narrowRoad) add('小運搬・狭小道路割増', 1, '式', base * num(s.pNarrow) / 100, `本体の${s.pNarrow}%`);
    add('残置物撤去・処分', num(c.debrisM3), '㎥', num(s.pDebris));
    add('ブロック塀撤去', num(c.blockM), 'm', num(s.pBlock));
    add('土間コンクリート撤去', num(c.concreteM2), '㎡', num(s.pConcrete));
    add('庭木伐採・抜根', num(c.trees), '本', num(s.pTree));
    if (c.asbestos === 'level3') add('アスベスト含有建材 除去（レベル3）', num(c.asbestosM2), '㎡', num(s.pAsb3));
    if (c.asbestos === 'level12') add('アスベスト 除去（レベル1・2）', num(c.asbestosM2), '㎡', num(s.pAsb12));
    const sub = lines.reduce((a, l) => a + l.amount, 0);
    const overhead = sub * num(s.pOverhead) / 100;
    if (overhead > 0) lines.push({ name: '諸経費（届出代行・近隣対応・現場管理）', qty: 1, u: '式', price: overhead, amount: overhead, note: '' });
    const net = Math.round(sub + overhead);
    const tax = Math.floor(net * 0.1);
    return { lines, net, tax, total: net + tax, tsubo };
  }

  const addDays = (iso, n) => { if (!iso) return null; const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d; };
  const addMonths = (iso, n) => { if (!iso) return null; const d = new Date(iso + 'T00:00:00'); d.setMonth(d.getMonth() + n); return d; };
  const fmtDate = (d) => (d ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : '');
  const fmtIso = (iso) => (iso ? fmtDate(new Date(iso + 'T00:00:00')) : '');
  const wareki = (d) => {
    if (!d) return '';
    const y = d.getFullYear();
    return y >= 2019 ? `令和${y - 2018 === 1 ? '元' : y - 2018}年${d.getMonth() + 1}月${d.getDate()}日` : fmtDate(d);
  };
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

  // ---------- 描画 ----------
  function renderCaseSelect() {
    const sel = $('#caseSelect');
    sel.innerHTML = state.cases.map((c) => `<option value="${c.id}" ${c.id === state.currentId ? 'selected' : ''}>${esc(c.estimateNo)} ${esc(c.clientName || '（施主未入力）')} 様</option>`).join('');
  }

  function renderSchedule(c) {
    const area = num(c.floorArea);
    const items = [];
    const status = (due) => {
      if (!due) return '';
      const diff = Math.round((due - today()) / 86400000);
      if (diff < 0) return `<span class="badge late">${-diff}日超過</span>`;
      if (diff <= 7) return `<span class="badge soon">あと${diff}日</span>`;
      return `<span class="badge">あと${diff}日</span>`;
    };
    const item = (need, title, due, sub) => items.push(`<div class="deadline ${need ? 'need' : 'ok'}"><div class="when">${need ? '要' : '不要'}｜${title} ${due ? `— 期限 ${fmtDate(due)}` : ''} ${need ? status(due) : ''}</div><div class="sub">${sub}</div></div>`);

    if (!c.startDate) items.push('<p class="hint">着工予定日を入力すると、各届出の期限を自動計算します。</p>');
    item(area >= 80, '建設リサイクル法 事前届出', addDays(c.startDate, -7),
      `延床面積80㎡以上の解体は、発注者（施主）が着工7日前までに届出（業者が委任を受けて代行するのが一般的）。現在の延床：${area || '-'}㎡。→「④ 届出下書き」タブ`);
    item(area >= 80, '石綿（アスベスト）事前調査結果報告（電子報告）', addDays(c.startDate, -1),
      '解体部分の床面積80㎡以上は、元請業者が工事開始前に「石綿事前調査結果報告システム」で労働基準監督署・自治体へ報告。調査は有資格者が実施。');
    if (c.asbestos === 'unknown') item(true, 'アスベスト事前調査の実施', addDays(c.startDate, -14), '調査結果が「未調査」です。面積にかかわらず事前調査は必須です。');
    if (c.asbestos === 'level12') item(true, '特定粉じん排出等作業 実施届出', addDays(c.startDate, -14), 'レベル1・2の除去は、作業開始14日前までに都道府県等へ届出が必要。');
    item(true, '近隣挨拶', addDays(c.startDate, -7), '着工1週間〜10日前が目安。→「⑤ 近隣挨拶文」タブ');
    item(!!c.narrowRoad, '道路使用許可（所轄警察署）', addDays(c.startDate, -7), '道路上に車両を止めて作業する場合に必要。処理に数日かかるため早めに申請。');
    item(true, '建物取毀証明書の発行 → 施主の滅失登記', addMonths(c.endDate, 1), '解体完了後、施主が1か月以内に法務局へ建物滅失登記。→「⑥ 取毀証明書」タブ');
    item(true, 'マニフェスト（産業廃棄物管理票）の交付・回収', null, '搬出ごとに交付。紙の場合はB2・D票90日、E票180日以内の返送を確認。');
    $('#scheduleOut').innerHTML = `<h2>期限・やることチェック</h2>${items.join('')}`;
  }

  function companyBlock(s) {
    return `<div>${blank(s.name, '（会社名：設定タブで入力）')}<br>${blank(s.address)}<br>TEL ${blank(s.tel)}<br>${s.permit ? esc(s.permit) : ''}<br>${blank(s.rep)}　印</div>`;
  }

  function renderEstimate(c, s) {
    const e = calcEstimate(c, s);
    const issued = new Date(c.createdAt || Date.now());
    const valid = new Date(issued); valid.setDate(valid.getDate() + num(s.validDays || 30));
    const rows = e.lines.map((l) => `<tr><td>${esc(l.name)}${l.note ? `<br><span class="small">${esc(l.note)}</span>` : ''}</td><td class="num">${l.u === '式' ? 1 : l.qty.toLocaleString('ja-JP')}</td><td>${l.u}</td><td class="num">${l.u === '式' ? '' : yen(l.price)}</td><td class="num">${yen(l.amount)}</td></tr>`).join('');
    $('#estimateOut').innerHTML = `
      <h1>御見積書</h1>
      <div class="two">
        <div><div style="font-size:18px;border-bottom:1px solid #000;padding:0 8px">${blank(c.clientName, '　　　　　　　　')} 様</div>
          <p class="small">下記の通りお見積り申し上げます。</p>
          <div class="total">御見積金額　¥${yen(e.total)}－（税込）</div>
          <table><tr><th>工事名</th><td>${blank(c.clientName, '')}様邸 解体工事</td></tr>
            <tr><th>工事場所</th><td>${blank(c.siteAddress)}</td></tr>
            <tr><th>工期</th><td>${fmtIso(c.startDate) || '別途協議'} 〜 ${fmtIso(c.endDate)}</td></tr>
            <tr><th>有効期限</th><td>${fmtDate(valid)}</td></tr></table></div>
        <div class="small right">No. ${esc(c.estimateNo)}<br>${fmtDate(issued)}<br><br>${companyBlock(s)}</div>
      </div>
      <table><thead><tr><th>項目</th><th>数量</th><th>単位</th><th>単価</th><th>金額</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="blank">延床面積を入力すると明細が作られます</td></tr>'}</tbody>
        <tfoot><tr><th colspan="4" class="right">小計（税抜）</th><td class="num">${yen(e.net)}</td></tr>
          <tr><th colspan="4" class="right">消費税（10%）</th><td class="num">${yen(e.tax)}</td></tr>
          <tr><th colspan="4" class="right">合計（税込）</th><td class="num"><b>${yen(e.total)}</b></td></tr></tfoot></table>
      <p class="small"><b>備考</b><br>
        ・産業廃棄物は分別解体のうえ、許可業者にて適正に処理し、マニフェストで管理いたします。<br>
        ・アスベスト事前調査結果：${ASB[c.asbestos]}${c.asbestos === 'unknown' ? '（調査後に金額が変わる場合があります）' : ''}<br>
        ・地中埋設物（浄化槽・ガラ等）が発見された場合は別途お見積りとなります。<br>
        ${c.notes ? '・' + esc(c.notes).replace(/\n/g, '<br>・') : ''}</p>`;
  }

  function renderRecycle(c, s) {
    const area = num(c.floorArea);
    const total = num(c.wConcrete) + num(c.wWood) + num(c.wAsphalt);
    $('#recycleOut').innerHTML = `
      <h1 style="letter-spacing:.1em">届出書（下書き）</h1>
      <p class="small">建設工事に係る資材の再資源化等に関する法律 第10条第1項に基づく届出（建築物に係る解体工事）</p>
      <p class="right small">届出日：${wareki(addDays(c.startDate, -10)) || '　年　月　日'}（提出期限：${wareki(addDays(c.startDate, -7)) || '着工7日前'}）</p>
      <table>
        <tr><th>発注者 氏名</th><td>${blank(c.clientName)}</td></tr>
        <tr><th>発注者 住所・電話</th><td>${blank(c.clientAddress)}　${esc(c.clientTel)}</td></tr>
        <tr><th>工事の名称</th><td>${blank(c.clientName, '')}様邸 解体工事</td></tr>
        <tr><th>工事の場所</th><td>${blank(c.siteAddress)}</td></tr>
        <tr><th>工事の種類</th><td>建築物に係る解体工事</td></tr>
        <tr><th>工事の規模（延床面積）</th><td>${area || '　'} ㎡　${area && area < 80 ? '<b>※80㎡未満のため届出対象外</b>' : ''}</td></tr>
        <tr><th>建築物の構造・用途・階数</th><td>${STRUCT[c.structure]}／${esc(c.use)}／${esc(c.floors)}階建　${c.builtYear ? `（${esc(c.builtYear)}年築）` : ''}</td></tr>
        <tr><th>工期</th><td>${wareki(c.startDate ? new Date(c.startDate + 'T00:00:00') : null) || '　'} 〜 ${wareki(c.endDate ? new Date(c.endDate + 'T00:00:00') : null) || '　'}</td></tr>
        <tr><th>元請業者（受注者）</th><td>${blank(s.name)}　${esc(s.rep)}<br>${esc(s.address)}　TEL ${esc(s.tel)}<br>${esc(s.permit)}</td></tr>
        <tr><th>分別解体等の方法</th><td>${c.noHeavy ? '手作業' : '手作業・機械作業の併用'}（建築設備・内装材等 → 屋根ふき材 → 外装材・上部構造部分 → 基礎の順で分別解体）</td></tr>
        <tr><th>特定建設資材廃棄物の量の見込み</th><td>コンクリート塊 ${num(c.wConcrete)} t ／ 木材 ${num(c.wWood)} t ／ アスファルト・コンクリート塊 ${num(c.wAsphalt)} t　（計 ${total.toFixed(1)} t）</td></tr>
        <tr><th>石綿（アスベスト）の有無</th><td>${ASB[c.asbestos]}${num(c.asbestosM2) ? `（${num(c.asbestosM2)}㎡）` : ''}</td></tr>
      </table>
      <p class="small">添付書類の目安：別表1（分別解体等の計画等）、案内図、設計図または現況写真、工程表、委任状（業者が代理で届け出る場合）</p>
      <h3>委任状</h3>
      <p>私は、${blank(s.name, '（受任者）')}に対し、上記工事に係る建設リサイクル法第10条第1項の届出に関する一切の権限を委任します。</p>
      <p class="right">${wareki(today())}<br>委任者 住所　${blank(c.clientAddress)}<br>氏名　${blank(c.clientName)}　印</p>`;
  }

  function renderGreeting(c, s) {
    $('#greetingOut').innerHTML = `
      <h1 style="letter-spacing:.2em">解体工事のお知らせ</h1>
      <p class="right">${wareki(addDays(c.startDate, -10)) || wareki(today())}</p>
      <p>近隣の皆様へ</p>
      <p>拝啓　時下ますますご清栄のこととお慶び申し上げます。<br>
      このたび、下記の通り ${blank(c.clientName, '　　')} 様邸の解体工事を行うこととなりました。
      工事期間中は騒音・振動・車両の出入り等により、皆様には大変ご迷惑をおかけいたしますが、
      安全には十分に配慮して作業いたしますので、何卒ご理解とご協力を賜りますようお願い申し上げます。</p>
      <p class="right">敬具</p>
      <p style="text-align:center">記</p>
      <table>
        <tr><th>工事場所</th><td>${blank(c.siteAddress)}</td></tr>
        <tr><th>工事期間</th><td>${fmtIso(c.startDate) || '　'} 〜 ${fmtIso(c.endDate) || '　'}（天候により変更の場合あり）</td></tr>
        <tr><th>作業時間</th><td>午前8時30分 〜 午後5時30分（日曜・祝日は休工）</td></tr>
        <tr><th>工事内容</th><td>${STRUCT[c.structure]}${esc(c.floors)}階建 建物の解体${num(c.blockM) ? '、ブロック塀撤去' : ''}${c.asbestos === 'level3' || c.asbestos === 'level12' ? '（アスベスト含有建材は法令に従い飛散防止措置のうえ除去します）' : ''}</td></tr>
        <tr><th>施工業者</th><td>${blank(s.name)}<br>${esc(s.address)}<br>連絡先 TEL ${blank(s.tel)}（担当：${blank(s.rep, '　　　')}）</td></tr>
      </table>
      <p>ご不明な点やお気づきの点がございましたら、お気軽に上記までご連絡ください。</p>
      <p class="right">以上</p>`;
  }

  function renderCertificate(c, s) {
    const end = c.endDate ? new Date(c.endDate + 'T00:00:00') : null;
    $('#certificateOut').innerHTML = `
      <h1>建物取毀証明書</h1>
      <table>
        <tr><th>所在</th><td>${blank(c.siteAddress)}</td></tr>
        <tr><th>家屋番号</th><td><span class="blank">（登記簿のとおり記入）</span></td></tr>
        <tr><th>種類</th><td>${esc(c.use.replace('専用', '') || '居宅')}</td></tr>
        <tr><th>構造</th><td>${STRUCT[c.structure]}　${esc(c.floors)}階建</td></tr>
        <tr><th>床面積</th><td>延床 ${num(c.floorArea) || '　'} ㎡　<span class="small">（各階の面積は登記簿のとおり）</span></td></tr>
        <tr><th>所有者 住所</th><td>${blank(c.clientAddress)}</td></tr>
        <tr><th>所有者 氏名</th><td>${blank(c.clientName)}</td></tr>
        <tr><th>取毀年月日</th><td>${wareki(end) || '　年　月　日'}</td></tr>
      </table>
      <p>上記の建物は、当社が取り毀したことに相違ないことを証明します。</p>
      <p class="right">${wareki(end) || '　年　月　日'}</p>
      <div class="right">${companyBlock(s)}</div>
      <p class="small">※ 印鑑証明書（または資格証明書）と合わせて施主様にお渡しください。</p>`;
  }

  function renderAll() {
    const c = cur(), s = state.settings;
    renderCaseSelect(); renderSchedule(c); renderEstimate(c, s); renderRecycle(c, s); renderGreeting(c, s); renderCertificate(c, s);
  }

  // ---------- イベント ----------
  const caseForm = $('#caseForm'), settingsForm = $('#settingsForm');
  bindForm(caseForm, cur);
  bindForm(settingsForm, () => state.settings);

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  });
  document.addEventListener('click', (e) => { if (e.target.closest('.print')) window.print(); });

  $('#caseSelect').addEventListener('change', (e) => { state.currentId = e.target.value; save(); fillForm(caseForm, cur()); renderAll(); });
  $('#newCase').addEventListener('click', () => {
    const c = newCase(); state.cases.unshift(c); state.currentId = c.id; save(); fillForm(caseForm, c); renderAll();
    $('#tabs button[data-tab=input]').click();
  });
  $('#deleteCase').addEventListener('click', () => {
    if (!confirm('この案件を削除しますか？')) return;
    state.cases = state.cases.filter((c) => c.id !== state.currentId);
    if (!state.cases.length) state.cases.push(newCase());
    state.currentId = state.cases[0].id; save(); fillForm(caseForm, cur()); renderAll();
  });
  $('#autoWaste').addEventListener('click', () => {
    const c = cur(), f = WASTE_FACTOR[c.structure], a = num(c.floorArea);
    c.wConcrete = +(a * f.c + num(c.concreteM2) * 0.15 + num(c.blockM) * 0.2).toFixed(1);
    c.wWood = +(a * f.w + num(c.trees) * 0.1).toFixed(1);
    c.wAsphalt = +(a * f.a).toFixed(1);
    save(); fillForm(caseForm, c); renderAll();
  });
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kaitai-jimu-backup.json'; a.click();
  });
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.cases) || !d.cases.length) throw new Error('bad');
      state = { settings: { ...DEFAULT_SETTINGS, ...d.settings }, cases: d.cases, currentId: d.cases[0].id };
      save(); fillForm(caseForm, cur()); fillForm(settingsForm, state.settings); renderAll();
    } catch (_) { alert('読み込めないファイルです'); }
  });

  fillForm(caseForm, cur()); fillForm(settingsForm, state.settings); renderAll();
})();
