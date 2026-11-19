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
    pWood: 40000, pSteel: 50000, pRc: 65000, pManual: 30, pNarrow: 10,
    pDebris: 12000, pBlock: 8000, pConcrete: 3000, pTree: 15000,
    pAsb3: 3000, pAsb12: 30000, pScaffold: 800, pOverhead: 5,
    // 原価（利益チェック用）
    cLabor: 18000, cWorkers: 3, cMove: 35000, cMachine: 10000, cTruckLoad: 4, cTruck: 15000,
    cDispDebris: 8000,
    // 処分単価（円/t、アスベストは円/㎥）。相場の目安
    dispPrices: { wood: 12, concrete: 3000, concreteR: 4500, mixed: 25000, plastic: 35000, glass: 10000, gypsum: 20000, asphalt: 3000, metal: 5000, asb: 30000, asbsp: 80000 },
    cGuard: 18000, cOutsource: 70, cScrap: 30000, targetMargin: 30,
    defCarrier: '', defDisposer: '',
    // リースの機械：日額・月極・この日数を超えたら月極・回送費（往復）。相場の目安
    leasePresets: [
      { name: 'バックホー 0.25㎥（ユンボ）', daily: 15000, monthly: 250000, th: 20, transport: 60000 },
      { name: 'バックホー 0.45㎥（ユンボ）', daily: 25000, monthly: 400000, th: 20, transport: 80000 },
      { name: 'ミニユンボ 0.1㎥', daily: 8000, monthly: 130000, th: 20, transport: 30000 },
      { name: '4tダンプ', daily: 12000, monthly: 180000, th: 18, transport: 0 },
      { name: '2tダンプ', daily: 8000, monthly: 120000, th: 18, transport: 0 },
    ],
    sites: [], // 処分場ごとの単価 { id, name, prices: { 種類: 円 } }
    leaseMode: 'calendar', // 月極の区切り：calendar=リース会社の締め日ごと / anniv=借りた日から1か月 / days30=30日ごと
    leaseCompanies: [], // リース会社と締め日 { id, name, close: 1〜28 または '末' }
    alwaysTypes: ['wood', 'concrete', 'concreteR', 'mixed', 'plastic', 'glass', 'gypsum'], wasteVer: 2, customTypes: [], priceUnits: { wood: 'kg', gypsum: '㎥' }, unitVer: 1,
  };
  // マニフェストの廃棄物の種類（sp: 特別管理産業廃棄物 → B2・D票の期限が60日）
  const { WASTE_TYPES, WT } = KJCore;
  const EXPENSE_CATS = ['消耗品', '高速代', '燃料費', 'その他'];
  // 延床1㎡あたりの廃棄物量の目安（トン）
  // c:コンクリート塊 w:木材 a:アスファルト m:混合廃棄物 fe:鉄スクラップ
  const WASTE_FACTOR = {
    wood: { c: 0.25, w: 0.1, a: 0.02, m: 0.04, fe: 0.005 },
    steel: { c: 0.5, w: 0.03, a: 0.02, m: 0.04, fe: 0.08 },
    rc: { c: 1.0, w: 0.02, a: 0.02, m: 0.03, fe: 0.06 },
  };
  // 1日に解体できる坪数の目安（重機あり）
  const TSUBO_PER_DAY = { wood: 8, steel: 5, rc: 3 };

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const yen = (n) => Math.round(n).toLocaleString('ja-JP');
  const blank = (v, w = '　　　　　　') => (v ? esc(v) : `<span class="blank">${w}</span>`);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- 保存 ----------
  // 保存されていた設定に、新しく増えた項目の初期値を足す
  function normalizeSettings(s0) {
    let old = s0 || {};
    if ((old.wasteVer || 1) < 2) old = { ...old, alwaysTypes: DEFAULT_SETTINGS.alwaysTypes, wasteVer: 2 };
    const s = { ...DEFAULT_SETTINGS, ...old };
    // 処分単価：古いデータの「コンクリート塊・木くず・混合廃棄物」の単価を引き継ぐ
    const legacy = {};
    if (old.cDispConcrete != null) legacy.concrete = old.cDispConcrete;
    if (old.cDispWood != null) legacy.wood = old.cDispWood;
    if (old.cDispMixed != null) legacy.mixed = old.cDispMixed;
    s.dispPrices = { ...DEFAULT_SETTINGS.dispPrices, ...(old.dispPrices ? {} : legacy), ...(old.dispPrices || {}) };
    // 単価の単位（円/t・円/kg・円/㎥）：芝はkg、石膏ボードは㎥に。円/tで入っていた芝の単価はkgに直す
    if (!old.unitVer) {
      s.priceUnits = { ...DEFAULT_SETTINGS.priceUnits, ...(old.priceUnits || {}) };
      const toKg = (v) => (v !== '' && v != null && num(v) >= 1000 ? String(num(v) / 1000) : v);
      s.dispPrices = { ...s.dispPrices, wood: toKg(s.dispPrices.wood) };
      s.sites = (s.sites || []).map((st) => (st.prices && !(st.units || {}).wood ? { ...st, prices: { ...st.prices, wood: toKg(st.prices.wood) } } : st));
      s.unitVer = 1;
    }
    return s;
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        d.settings = normalizeSettings(d.settings);
        if (d.cases?.length) return d;
      }
    } catch (_) { /* 保存領域が使えない場合は初期状態 */ }
    const first = newCase();
    return { settings: { ...DEFAULT_SETTINGS }, cases: [first], currentId: first.id };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* noop */ }
    if (window.KJCloud) window.KJCloud.onLocalSave(); // ログインしていれば Supabase にも送る
  }

  function newCase() {
    const d = new Date();
    const no = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(Math.floor(Math.random() * 900) + 100)}`;
    return {
      id: uid(), estimateNo: no, createdAt: d.toISOString(),
      clientName: '', clientAddress: '', clientTel: '', siteAddress: '',
      structure: 'wood', floors: 2, floorArea: '', use: '専用住宅', builtYear: '',
      noHeavy: false, narrowRoad: false, debrisM3: 0, blockM: 0, concreteM2: 0, trees: 0,
      asbestos: 'none', asbestosM2: 0, startDate: '', endDate: '',
      wConcrete: 0, wWood: 0, wAsphalt: 0, wMixed: 0, workDays: '', notes: '', manifests: [], expenses: [], leases: [],
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

  // 廃棄物量：入力があればそれを、なければ構造別の目安を使う
  function wasteOf(c) {
    const f = WASTE_FACTOR[c.structure], a = num(c.floorArea);
    const est = {
      concrete: a * f.c + num(c.concreteM2) * 0.15 + num(c.blockM) * 0.2,
      wood: a * f.w + num(c.trees) * 0.1, asphalt: a * f.a, mixed: a * f.m,
    };
    const entered = num(c.wConcrete) + num(c.wWood) + num(c.wAsphalt) + num(c.wMixed) > 0;
    const w = entered ? { concrete: num(c.wConcrete), wood: num(c.wWood), asphalt: num(c.wAsphalt), mixed: num(c.wMixed) } : est;
    return { ...w, iron: a * f.fe, estimated: !entered };
  }

  // 作業日数（休工日を除く実働日）と工程の内訳
  function planOf(c) {
    const tsubo = num(c.floorArea) * 0.3025;
    let rate = TSUBO_PER_DAY[c.structure]; if (c.noHeavy) rate /= 2;
    const body = Math.max(1, Math.ceil(tsubo / rate));
    const phases = [
      { name: '足場・養生シート設置', days: 1 },
      { name: '残置物・内装材の撤去（手作業で分別）', days: Math.max(1, Math.ceil(num(c.debrisM3) / 10) + (num(c.floorArea) > 150 ? 1 : 0)) },
    ];
    if (c.asbestos === 'level3' || c.asbestos === 'level12') {
      phases.push({ name: `アスベスト含有建材の除去（${c.asbestos === 'level3' ? 'レベル3' : 'レベル1・2'}）`, days: Math.max(1, Math.ceil(num(c.asbestosM2) / (c.asbestos === 'level3' ? 60 : 15))) });
    }
    phases.push({ name: `上屋解体（${c.noHeavy ? '手壊し中心' : '重機'}）`, days: Math.max(1, Math.ceil(body * 0.7)) });
    phases.push({ name: '基礎・土間コンクリート撤去', days: Math.max(1, Math.ceil(body * 0.3 + num(c.concreteM2) / 60)) });
    if (num(c.blockM) > 0 || num(c.trees) > 0) phases.push({ name: '外構（ブロック塀・庭木）撤去', days: Math.max(1, Math.ceil(num(c.blockM) / 25 + num(c.trees) / 6)) });
    phases.push({ name: '整地・清掃・最終確認', days: 1 });
    let total = phases.reduce((a, p) => a + p.days, 0);
    const manual = num(c.workDays);
    if (manual > 0 && manual !== total) {
      // 手入力の日数に合わせて上屋解体の日数で調整
      const idx = phases.findIndex((p) => p.name.startsWith('上屋解体'));
      phases[idx].days = Math.max(1, phases[idx].days + (manual - total));
      total = phases.reduce((a, p) => a + p.days, 0);
    }
    return { phases, days: total, auto: !(manual > 0) };
  }

  function calcCost(c, s) {
    const e = calcEstimate(c, s), w = wasteOf(c), plan = planOf(c), d = plan.days;
    const workers = num(s.cWorkers) + (c.noHeavy ? 2 : 0);
    const tons = w.concrete + w.wood + w.asphalt + w.mixed;
    const trucks = Math.ceil(tons / Math.max(0.5, num(s.cTruckLoad))) + Math.ceil(num(c.debrisM3) / Math.max(1, num(s.cTruckLoad) * 2));
    const asbLine = e.lines.find((l) => l.name.startsWith('アスベスト'));
    const dp = (id) => num((s.dispPrices || {})[id]);
    const rows = [
      { name: '作業員（人工）', detail: `${workers}人 × ${d}日 × ${yen(s.cLabor)}円`, amount: workers * d * num(s.cLabor) },
      { name: '重機（回送・損料・燃料）', detail: c.noHeavy ? '重機なし（手壊し）' : `回送 往復 ${yen(num(s.cMove) * 2)}円 ＋ ${d}日 × ${yen(s.cMachine)}円`, amount: c.noHeavy ? 0 : num(s.cMove) * 2 + d * num(s.cMachine) },
      { name: 'ダンプ運搬', detail: `${trucks}台 × ${yen(s.cTruck)}円（${num(s.cTruckLoad)}t積み）`, amount: trucks * num(s.cTruck) },
      { name: '処分費 コンクリートガラ・アスファルトガラ', detail: `${w.concrete.toFixed(1)}t × ${yen(dp('concrete'))}円 ＋ ${w.asphalt.toFixed(1)}t × ${yen(dp('asphalt'))}円`, amount: w.concrete * dp('concrete') + w.asphalt * dp('asphalt') },
      { name: '処分費 木（シバ）', detail: `${w.wood.toFixed(1)}t × ${yen(dp('wood'))}円`, amount: w.wood * dp('wood') },
      { name: '処分費 ミンチ（混合廃棄物）', detail: `${w.mixed.toFixed(1)}t × ${yen(dp('mixed'))}円`, amount: w.mixed * dp('mixed') },
      { name: '処分費 残置物', detail: `${num(c.debrisM3)}㎥ × ${yen(s.cDispDebris)}円`, amount: num(c.debrisM3) * num(s.cDispDebris) },
      { name: 'アスベスト除去（外注）', detail: asbLine ? `見積額の${num(s.cOutsource)}%` : 'なし', amount: asbLine ? asbLine.amount * num(s.cOutsource) / 100 : 0 },
      { name: 'ガードマン（交通誘導）', detail: c.narrowRoad ? `1人 × ${d}日 × ${yen(s.cGuard)}円` : '不要（狭小道路でない）', amount: c.narrowRoad ? d * num(s.cGuard) : 0 },
      { name: '養生シート・資材', detail: `延床 ${num(c.floorArea)}㎡ × 300円`, amount: num(c.floorArea) * 300 },
      { name: '鉄スクラップ売却（差し引き）', detail: `約${w.iron.toFixed(2)}t × ${yen(s.cScrap)}円`, amount: -w.iron * num(s.cScrap) },
    ];
    const cost = Math.round(rows.reduce((a, r) => a + r.amount, 0));
    const sales = e.net, profit = sales - cost, margin = sales > 0 ? profit / sales * 100 : 0;
    const target = Math.min(90, num(s.targetMargin));
    const minPrice = Math.ceil(cost / (1 - target / 100) / 1000) * 1000;
    return { rows, cost, sales, profit, margin, target, minPrice, plan, w, trucks, e };
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
    sel.innerHTML = state.cases.map((c) => `<option value="${c.id}" ${c.id === state.currentId ? 'selected' : ''}>${esc(c.clientName ? c.clientName + '様邸' : '（名前未入力の現場）')}${c.siteAddress ? '（' + esc(c.siteAddress) + '）' : ''}</option>`).join('');
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
      `延床面積80㎡以上の解体は、発注者（施主）が着工7日前までに届出（業者が委任を受けて代行するのが一般的）。現在の延床：${area || '-'}㎡。→「書類 › 届出」`);
    item(area >= 80, '石綿（アスベスト）事前調査結果報告（電子報告）', addDays(c.startDate, -1),
      '解体部分の床面積80㎡以上は、元請業者が工事開始前に「石綿事前調査結果報告システム」で労働基準監督署・自治体へ報告。調査は有資格者が実施。');
    if (c.asbestos === 'unknown') item(true, 'アスベスト事前調査の実施', addDays(c.startDate, -14), '調査結果が「未調査」です。面積にかかわらず事前調査は必須です。');
    if (c.asbestos === 'level12') item(true, '特定粉じん排出等作業 実施届出', addDays(c.startDate, -14), 'レベル1・2の除去は、作業開始14日前までに都道府県等へ届出が必要。');
    const by = parseInt(String(c.builtYear).replace(/[^0-9]/g, ''), 10);
    if (by) {
      if (by <= 2006) items.unshift(`<div class="deadline need"><div class="when">アスベスト判定｜${by}年築：含有の可能性あり</div><div class="sub">2006年9月以前に着工した建物は、石綿含有建材が使われている可能性があります。有資格者による書面調査・目視調査、必要に応じて分析調査を行ってください。${by === 2006 ? '（2006年築は着工日が9月1日より前か後かを確認）' : ''}</div></div>`);
      else items.unshift(`<div class="deadline ok"><div class="when">アスベスト判定｜${by}年築：含有の可能性は低い</div><div class="sub">着工日が2006年9月1日以降であることを設計図書等で確認できれば、書面調査で「含有なし」と判断できます。事前調査と結果報告（80㎡以上）自体は必要です。</div></div>`);
    }
    item(true, '近隣挨拶', addDays(c.startDate, -7), '着工1週間〜10日前が目安。→「書類 › 挨拶文」');
    item(!!c.narrowRoad, '道路使用許可（所轄警察署）', addDays(c.startDate, -7), '道路上に車両を止めて作業する場合に必要。処理に数日かかるため早めに申請。');
    item(true, '建物取毀証明書の発行 → 施主の滅失登記', addMonths(c.endDate, 1), '解体完了後、施主が1か月以内に法務局へ建物滅失登記。→「書類 › 取毀証明」');
    const ms = manifestsOf(c), open = ms.filter((m) => m.kind === 'paper' && !(m.b2 && m.d && m.e)).length;
    item(true, 'マニフェスト（産業廃棄物管理票）の交付・回収', null, `搬出ごとに交付。紙の場合はB2・D票90日、E票180日以内の返送を確認。登録 ${ms.length}枚${open ? `（返送待ち ${open}枚）` : ''} →「処分」タブ`);
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

  function renderProfit(c, s) {
    const r = calcCost(c, s);
    const cls = r.margin >= r.target ? 'good' : r.margin >= r.target - 10 ? 'mid' : 'bad';
    const verdict = r.profit < 0 ? '✕ 赤字' : { good: '◎ 目標以上の利益', mid: '△ 利益が薄い', bad: '✕ 利益が少なすぎる' }[cls];
    const discount = r.sales - r.minPrice;
    const rows = r.rows.map((x) => `<tr><td>${esc(x.name)}<div class="sub">${esc(x.detail)}</div></td><td class="num ${x.amount < 0 ? 'minus' : ''}">${x.amount < 0 ? '−' : ''}${yen(Math.abs(x.amount))}</td></tr>`).join('');
    $('#profitOut').innerHTML = num(c.floorArea) <= 0 ? '<p class="hint">「情報」で延床面積を入れると、この現場の利益を計算します。</p>' : `
      <h2>この現場、いくら儲かる？</h2>
      <div class="kpis">
        <div class="kpi"><div class="k">見積金額（税抜）</div><div class="v">¥${yen(r.sales)}</div></div>
        <div class="kpi"><div class="k">原価の見込み</div><div class="v">¥${yen(r.cost)}</div></div>
        <div class="kpi ${cls}"><div class="k">粗利（利益）</div><div class="v">¥${yen(r.profit)}</div><div class="k">粗利率 ${r.margin.toFixed(1)}%　<b>${verdict}</b></div></div>
      </div>
      <div class="callout ${discount >= 0 ? '' : 'bad'}">
        ${discount >= 0
          ? `<b>値引きできるのは ¥${yen(discount)} まで</b>（税抜 ¥${yen(r.minPrice)} を下回ると、目標の粗利率${r.target}%を割ります）`
          : `<b>今の見積だと目標の粗利率${r.target}%に届きません。</b>税抜 ¥${yen(r.minPrice)} 以上にするか、原価を見直してください。`}
        <br><span class="sub">赤字ライン（これ以下は赤字）：税抜 ¥${yen(r.cost)}</span>
      </div>
      <div class="facts">
        <span>作業日数 <b>${r.plan.days}日</b>${r.plan.auto ? '（自動）' : ''}</span>
        <span>ダンプ <b>${r.trucks}台</b></span>
        <span>廃棄物 <b>${(r.w.concrete + r.w.wood + r.w.asphalt + r.w.mixed).toFixed(1)}t</b>${r.w.estimated ? '（目安）' : ''}</span>
        <span>鉄スクラップ <b>約${r.w.iron.toFixed(2)}t</b></span>
      </div>
      <div class="table-wrap"><table class="cost"><thead><tr><th>原価の内訳</th><th class="num">金額</th></tr></thead><tbody>${rows}</tbody>
        <tfoot><tr><th>原価 合計</th><td class="num"><b>¥${yen(r.cost)}</b></td></tr></tfoot></table></div>
      <p class="hint">原価の単価は「設定」の「原価」で自社の値に変えられます。数字は目安です。</p>
      ${actualHtml(c, r)}`;
  }

  // 実績（マニフェストの処分代・経費）で見た利益
  function actualHtml(c, r) {
    const disp = dispSummary(c), exp = expenseSummary(c), ls = leaseSummary(c);
    if (!disp.total && !exp.total && !ls.total) {
      return '<h2>実際の利益（実績）</h2><p class="hint">「処分」に数量、「お金 › 経費」に消耗品・高速代・燃料費、「お金 › リース」に借りた機械を入れると、見込みと実際の利益を比べられます。</p>';
    }
    const estMachine = r.rows.filter((x) => x.name.startsWith('重機') || x.name.startsWith('ダンプ運搬')).reduce((a, x) => a + x.amount, 0);
    const estDisp = r.rows.filter((x) => x.name.startsWith('処分費')).reduce((a, x) => a + x.amount, 0);
    const estSupply = r.rows.filter((x) => x.name.startsWith('養生シート')).reduce((a, x) => a + x.amount, 0);
    const actCost = Math.round(r.cost - (disp.total ? estDisp : 0) + disp.total - (exp.total ? estSupply : 0) + exp.total - (ls.total ? estMachine : 0) + ls.total);
    const profit = r.sales - actCost, margin = r.sales > 0 ? profit / r.sales * 100 : 0;
    const row = (name, est, act, note = '') => `<tr><td>${name}${note ? `<div class="sub">${note}</div>` : ''}</td><td class="num">${est == null ? '—' : '¥' + yen(est)}</td><td class="num">${act == null ? '—' : '¥' + yen(act)}</td></tr>`;
    return `
      <h2>実際の利益（実績）</h2>
      <div class="table-wrap"><table class="cost"><thead><tr><th>項目</th><th class="num">見込み</th><th class="num">実績</th></tr></thead><tbody>
        ${row('処分代', estDisp, disp.total || null, disp.total ? `マニフェスト ${disp.count}枚分` : 'マニフェスト未入力（見込みのまま計算）')}
        ${row('リース（重機・ダンプ）', estMachine, ls.total || null, ls.total ? `${ls.count}台分（回送費込み）` : 'リース未入力（見込みのまま計算）')}
        ${EXPENSE_CATS.map((k) => row(`経費：${k}`, k === '消耗品' ? estSupply : null, exp.byCat[k] || null)).join('')}
        ${row('原価 合計', r.cost, actCost, ls.total ? '人工・ガードマンは見込みのまま' : '人工・重機・ダンプ・ガードマンは見込みのまま')}
        <tr><th>粗利（利益）</th><td class="num">¥${yen(r.profit)}（${r.margin.toFixed(1)}%）</td><td class="num"><b class="${profit < 0 ? 'neg' : ''}">¥${yen(profit)}（${margin.toFixed(1)}%）</b></td></tr>
      </tbody></table></div>
      <p class="hint">${ls.total ? 'リースを入れた場合、見込みの重機・ダンプ代（燃料込み）をリース代に置き換えて計算します。' : '燃料費・高速代は見込みでは重機・ダンプの費用に含めているため、実績の利益は少し低めに出ます。'}</p>`;
  }

  // 日曜を休工日として、実働日を日付に割り当てる
  function workDates(startIso, n) {
    const out = []; if (!startIso) return out;
    const d = new Date(startIso + 'T00:00:00');
    while (out.length < n) { if (d.getDay() !== 0) out.push(new Date(d)); d.setDate(d.getDate() + 1); }
    return out;
  }

  function renderProcess(c, s) {
    const plan = planOf(c);
    const dates = workDates(c.startDate, plan.days);
    let i = 0;
    const spans = plan.phases.map((p) => { const from = i; i += p.days; return { ...p, from, to: i - 1 }; });
    const md = (d) => (d ? `${d.getMonth() + 1}/${d.getDate()}` : '');
    const head = Array.from({ length: plan.days }, (_, k) => `<th class="d">${dates[k] ? `${dates[k].getMonth() + 1}/${dates[k].getDate()}` : k + 1}</th>`).join('');
    const body = spans.map((p) => `<tr><td class="ph">${esc(p.name)}</td><td class="num">${p.days}日</td><td class="num">${md(dates[p.from])}〜${md(dates[p.to])}</td>${Array.from({ length: plan.days }, (_, k) => `<td class="d ${k >= p.from && k <= p.to ? 'on' : ''}"></td>`).join('')}</tr>`).join('');
    $('#processOut').innerHTML = `
      <h1 style="letter-spacing:.3em">工程表</h1>
      <div class="two small"><div>工事名：${blank(c.clientName, '')}様邸 解体工事<br>工事場所：${blank(c.siteAddress)}<br>構造：${STRUCT[c.structure]}　${esc(c.floors)}階建　延床 ${num(c.floorArea) || '　'}㎡</div>
        <div class="right">${esc(s.name)}<br>実働 ${plan.days}日（日曜休工）<br>${dates.length ? `${fmtDate(dates[0])} 〜 ${fmtDate(dates[dates.length - 1])}` : '着工予定日を入力すると日付が入ります'}</div></div>
      <div class="table-wrap"><table class="gantt"><thead><tr><th>工程</th><th>日数</th><th>期間</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="small">・作業時間 8:30〜17:30。天候等により工程が前後する場合があります。<br>・建設リサイクル法に基づき、分別解体（内装材 → 屋根・外装 → 躯体 → 基礎の順）で施工します。</p>`;
    if (dates.length && c.endDate !== dates[dates.length - 1].toISOString().slice(0, 10)) {
      const last = dates[dates.length - 1];
      const iso = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
      $('#processOut').insertAdjacentHTML('beforeend', `<p class="small no-print">完了予定日（${fmtIso(c.endDate) || '未入力'}）を工程表の最終日 ${fmtDate(last)} に合わせますか？ <button class="btn ghost" data-set-end="${iso}">合わせる</button></p>`);
    }
  }

  // ---------- マニフェスト ----------
  const manifestsOf = (c) => (Array.isArray(c.manifests) ? c.manifests : (c.manifests = []));
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = () => isoOf(new Date());
  const caseName = (c) => `${c.clientName || '（施主未入力）'}様邸`;

  const plus3BizDays = KJCore.plus3BizDays;
  // 返送・報告の期限と状態（計算は core.js）
  const manifestChecks = (m) => KJCore.manifestChecks(m, today());
  const chipsHtml = (m) => {
    const ch = manifestChecks(m);
    if (!ch.length) return '<span class="chip">交付日を入れると期限を計算します</span>';
    return ch.map((x) => `<span class="chip ${x.state}" title="${x.due ? '期限 ' + fmtDate(x.due) : ''}">${x.text}</span>`).join('');
  };

  // この案件で表示するゴミの種類：いつも出るもの＋アスベスト（調査結果による）＋登録済みのもの
  function typesShown(c) {
    const ids = new Set((state.settings.alwaysTypes || []).filter((id) => WT[id]));
    if (c.asbestos === 'level3') ids.add('asb');
    if (c.asbestos === 'level12') ids.add('asbsp');
    manifestsOf(c).forEach((m) => ids.add(m.type));
    (c.extraTypes || []).forEach((id) => ids.add(id));
    return WASTE_TYPES.filter((w) => ids.has(w.id)).map((w) => w.id);
  }
  const estimateFor = (c, type) => {
    const w = wasteOf(c);
    return { concrete: w.concrete, asphalt: w.asphalt, wood: w.wood, mixed: w.mixed }[type];
  };
  const estLabel = (type) => (type === 'concrete' ? '見込み（無筋・有筋の合計）' : '見込み');

  // ---------- 処分代 ----------
  const dispPrice = (type) => num((state.settings.dispPrices || {})[type]);
  const siteByName = (name) => (state.settings.sites || []).find((x) => x.name && x.name.trim() === String(name || '').trim());
  const sitePrice = (site, type) => { const v = site && site.prices ? site.prices[type] : ''; return v === '' || v == null ? null : num(v); };
  // 単価の出どころ（手入力していないとき）
  const stdUnitOf = (type) => (state.settings.priceUnits || {})[type] || ((WT[type] || {}).unit === '㎥' ? '㎥' : 't');
  const siteUnitOf = (site, type) => (site && (site.units || {})[type]) || stdUnitOf(type);
  function defaultPriceOf(m) {
    const site = siteByName(m.disposer), sp = sitePrice(site, m.type);
    return sp != null ? { price: sp, unit: siteUnitOf(site, m.type), label: `${site.name}の単価` } : { price: dispPrice(m.type), unit: stdUnitOf(m.type), label: '標準' };
  }
  const unitPriceOf = (m) => (m.price !== '' && m.price != null ? num(m.price) : defaultPriceOf(m).price);
  // 数量の単位（記録は t か ㎥）と、単価の単位（円/t・円/kg・円/㎥）
  const qUnitOf = (m) => (m.unit === '㎥' || m.unit === 't' ? m.unit : ((WT[m.type] || {}).unit === '㎥' ? '㎥' : 't'));
  const pUnitOf = (m) => defaultPriceOf(m).unit;
  const costOf = KJCore.costOf;
  const unitMismatch = (m) => num(m.qty) > 0 && costOf(1, qUnitOf(m), 1, pUnitOf(m)) == null;
  const qtyText = (m) => { const q = num(m.qty); if (qUnitOf(m) === '㎥') return `${+q.toFixed(3)}㎥`; return pUnitOf(m) === 'kg' ? `${Math.round(q * 1000).toLocaleString('ja-JP')}kg` : `${+q.toFixed(3)}t`; };
  // 単価を比べるときは t あたりにそろえる（㎥ は ㎥ どうしだけ）
  const perBase = (p, u) => (u === 'kg' ? p * 1000 : p);
  // その種類で一番安い処分場
  function cheapestSite(type) {
    let best = null;
    const isVol = stdUnitOf(type) === '㎥';
    (state.settings.sites || []).forEach((st) => {
      const p = sitePrice(st, type), u = siteUnitOf(st, type); if (p == null || !st.name || (u === '㎥') !== isVol) return;
      if (!best || perBase(p, u) < perBase(best.price, best.unit)) best = { name: st.name, price: p, unit: u };
    });
    return best;
  }
  // 重さの入れ間違い（kg を t に入れた）と思われる記録は、直すまで金額に入れない
  const dispOf = (m) => (tooHeavy(m) ? 0 : costOf(num(m.qty), qUnitOf(m), unitPriceOf(m), pUnitOf(m)) || 0);
  // マニフェストが入る請求（処分場の締め日。登録のない処分場は末日締め）
  function billOf(m) {
    const site = siteByName(m.disposer);
    const close = site && site.close != null && site.close !== '' ? site.close : '末';
    if (!m.date) return { ym: '', close };
    const d = new Date(m.date + 'T00:00:00');
    let end = closeDate(d.getFullYear(), d.getMonth(), close);
    if (d > end) end = closeDate(d.getFullYear(), d.getMonth() + 1, close);
    const prev = closeDate(end.getFullYear(), end.getMonth() - 1, close);
    const from = new Date(prev); from.setDate(from.getDate() + 1);
    return { ym: isoOf(end).slice(0, 7), from, to: end, close, label: `${end.getMonth() + 1}月分`, registered: !!site };
  }
  // 1回の搬出で100t以上はまずない → kg で入れた可能性が高い
  const tooHeavy = (m) => qUnitOf(m) !== '㎥' && num(m.qty) >= 100;
  const fixKgHtml = (m) => (tooHeavy(m) ? `<span class="chip late">⚠ ${m.qty}tは多すぎます</span><button type="button" class="btn small" data-fixkg="${m.id}">${Math.round(num(m.qty)) / 1000}tに直す（kgで入れた場合）</button>` : '');
  const mcostHtml = (m) => {
    if (!(num(m.qty) > 0)) return '';
    if (tooHeavy(m)) return fixKgHtml(m);
    if (unitMismatch(m)) return `<span class="chip late">単価は「円/${pUnitOf(m)}」です。数量を${pUnitOf(m) === '㎥' ? '㎥（立米）' : '重さ（t）'}で入れてください</span>`;
    const b = billOf(m);
    return `${m.via === 'line' ? '<span class="chip line">LINEから</span> ' : ''}処分代 <b>¥${yen(dispOf(m))}</b>${b.ym ? `<span class="billtag">${b.label}の請求（${closeLabel(b.close)}締め）</span>` : ''}`;
  };
  // 処分場ごとの請求（全現場・締めごと）
  let billMonth = null;
  function renderSiteInvoices() {
    const all = state.cases.flatMap((c) => manifestsOf(c).filter((m) => m.date && num(m.qty) > 0).map((m) => ({ c, m, b: billOf(m) })));
    const months = [...new Set(all.map((x) => x.b.ym))].sort().reverse();
    if (!months.length) { $('#siteInvoices').innerHTML = ''; return; }
    const mon = billMonth && months.includes(billMonth) ? billMonth : months[0];
    const bySite = {};
    all.filter((x) => x.b.ym === mon).forEach((x) => {
      const key = (x.m.disposer || '（処分業者 未入力）').trim();
      const g = bySite[key] || (bySite[key] = { b: x.b, n: 0, cost: 0, qty: {}, cases: {} });
      g.n++; g.cost += dispOf(x.m);
      const u = qUnitOf(x.m); g.qty[u] = (g.qty[u] || 0) + num(x.m.qty);
      const cc = g.cases[x.c.id] || (g.cases[x.c.id] = { name: caseName(x.c), n: 0, cost: 0 }); cc.n++; cc.cost += dispOf(x.m);
    });
    const now = today();
    const rows = Object.entries(bySite).sort().map(([name, g]) => `
      <tr><td><b>${esc(name)}</b><div class="sub">${closeLabel(g.b.close)}締め${g.b.registered ? '' : '（未登録のため末日締め）'}・${g.b.from.getMonth() + 1}/${g.b.from.getDate()}〜${g.b.to.getMonth() + 1}/${g.b.to.getDate()}</div>
        <div class="sub">${Object.values(g.cases).map((cc) => `${esc(cc.name)} ${cc.n}枚 ¥${yen(cc.cost)}`).join('／')}</div></td>
        <td class="num">${g.n}枚</td><td class="num">${Object.entries(g.qty).map(([u, q]) => `${q.toFixed(2)}${u}`).join('＋')}</td>
        <td class="num"><b>¥${yen(g.cost)}</b></td><td>${g.b.to < now ? '締め済み' : '締め前（途中）'}</td></tr>`).join('');
    const total = Object.values(bySite).reduce((a, g) => a + g.cost, 0);
    $('#siteInvoices').innerHTML = `
      <h2>処分場ごとの請求（全現場・締めごと）</h2>
      <label class="inline" for="billMonth">請求月 <select id="billMonth">${months.map((x) => `<option value="${x}" ${x === mon ? 'selected' : ''}>${x.replace('-', '年')}月分</option>`).join('')}</select></label>
      <div class="table-wrap"><table class="cost wide"><thead><tr><th>処分場（締め・期間・現場の内訳）</th><th class="num">枚数</th><th class="num">数量</th><th class="num">請求額（税抜）</th><th>状態</th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr><th colspan="3">合計</th><td class="num"><b>¥${yen(total)}</b></td><td></td></tr></tfoot></table></div>
      <p class="hint">処分場から届いた請求書と、枚数・金額を照らし合わせてください。締め日は「設定」の「処分場ごとの単価」で処分場ごとに変えられます。</p>`;
  }
  function gsumHtml(c, type) {
    const w = WT[type], list = manifestsOf(c).filter((m) => m.type === type);
    const totalTxt = sumText(list), cost = list.reduce((a, m) => a + dispOf(m), 0), est = estimateFor(c, type);
    const open = list.filter((m) => manifestChecks(m).some((x) => x.state === 'late')).length;
    const best = cheapestSite(type);
    return `${list.length}枚・合計 <b>${totalTxt}</b>・処分代 <b>¥${yen(cost)}</b>${est ? `（${estLabel(type)} ${est.toFixed(1)}t）` : ''}${best ? `<br><span class="best">一番安い処分場：${esc(best.name)} ¥${yen(best.price)}/${best.unit}</span>` : ''}${open ? `　<span class="chip late">期限超過 ${open}枚</span>` : ''}`;
  }
  // 数量の合計（t と ㎥ は分けて表示。単価がkgの種類はkgで表示）
  function sumText(list) {
    const t = list.filter((m) => qUnitOf(m) === 't').reduce((a, m) => a + num(m.qty), 0), v = list.filter((m) => qUnitOf(m) === '㎥').reduce((a, m) => a + num(m.qty), 0);
    const kg = list.length && list.every((m) => qUnitOf(m) === '㎥' || pUnitOf(m) === 'kg');
    const parts = [];
    if (t) parts.push(kg ? `${Math.round(t * 1000).toLocaleString('ja-JP')}kg` : `${+t.toFixed(2)}t`);
    if (v) parts.push(`${+v.toFixed(2)}㎥`);
    return parts.join('＋') || '0';
  }
  function dispSummary(c) {
    const ms = manifestsOf(c).filter((m) => num(m.qty) > 0), by = {};
    ms.forEach((m) => { const g = by[m.type] || (by[m.type] = { n: 0, qty: 0, cost: 0, list: [] }); g.n++; g.qty += num(m.qty); g.cost += dispOf(m); g.list.push(m); });
    return { by, total: Math.round(ms.reduce((a, m) => a + dispOf(m), 0)), count: ms.length };
  }
  function renderManifestCost(c) {
    const d = dispSummary(c);
    const rows = WASTE_TYPES.filter((w) => d.by[w.id]).map((w) => {
      const g = d.by[w.id];
      return `<tr><td>${esc(w.name)}</td><td class="num">${g.n}</td><td class="num">${sumText(g.list)}</td><td class="num">${(() => { const u = pUnitOf(g.list[0]), q = g.list.reduce((a, m) => a + num(m.qty), 0) * (u === 'kg' ? 1000 : 1); return q ? '¥' + yen(g.cost / q) + '/' + u : '—'; })()}</td><td class="num">¥${yen(g.cost)}</td></tr>`;
    }).join('');
    $('#manifestCost').innerHTML = `
      <h2>処分代（ゴミの種類ごと）</h2>
      <div class="table-wrap"><table class="cost"><thead><tr><th>種類</th><th class="num">枚数</th><th class="num">数量</th><th class="num">平均単価</th><th class="num">処分代</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="empty">マニフェストに数量を入れると、ここに処分代が出ます</td></tr>'}</tbody>
        <tfoot><tr><th colspan="4">処分代 合計</th><td class="num"><b>¥${yen(d.total)}</b></td></tr></tfoot></table></div>`;
  }

  function manifestCard(m, i) {
    return `
      <div class="mcard" data-mid="${m.id}">
        <div class="mhead"><b>${i + 1}枚目</b><span class="mcost" id="mcost-${m.id}">${mcostHtml(m)}</span><span class="chips" id="chips-${m.id}">${chipsHtml(m)}</span>
          <button class="btn ghost small" data-mdel="${m.id}">削除</button></div>
        <div class="mgrid">
          <label>種類<select data-f="kind"><option value="paper" ${m.kind !== 'electronic' ? 'selected' : ''}>紙</option><option value="electronic" ${m.kind === 'electronic' ? 'selected' : ''}>電子（JWNET）</option></select></label>
          <label>交付番号<input data-f="no" value="${esc(m.no)}" placeholder="例 1234567890"></label>
          <label>交付日（搬出日）<input data-f="date" type="date" value="${esc(m.date)}"></label>
          <label>数量<span class="qty-unit"><input data-f="qty" type="number" min="0" step="0.001" inputmode="decimal" value="${esc(m.qty)}" placeholder="${esc(m.hint || '')}"><select data-f="unit" aria-label="数量の単位"><option value="t" ${qUnitOf(m) === 't' ? 'selected' : ''}>t</option><option value="㎥" ${qUnitOf(m) === '㎥' ? 'selected' : ''}>㎥</option></select></span></label>
          <label>処分単価（円/${pUnitOf(m)}）<input data-f="price" type="number" min="0" value="${esc(m.price ?? '')}" placeholder="${esc(defaultPriceOf(m).label)} ${yen(defaultPriceOf(m).price)}"></label>
          <label>収集運搬業者<input data-f="carrier" list="carrierList" value="${esc(m.carrier)}"></label>
          <label>処分業者<input data-f="disposer" list="disposerList" value="${esc(m.disposer)}"></label>
          ${m.kind === 'electronic' ? `<label>JWNET登録日<input data-f="reg" type="date" value="${esc(m.reg)}"></label>` : ''}
          <label>${m.kind === 'electronic' ? '運搬終了報告日' : 'B2票 返送日'}<input data-f="b2" type="date" value="${esc(m.b2)}"></label>
          <label>${m.kind === 'electronic' ? '処分終了報告日' : 'D票 返送日'}<input data-f="d" type="date" value="${esc(m.d)}"></label>
          <label>${m.kind === 'electronic' ? '最終処分終了報告日' : 'E票 返送日'}<input data-f="e" type="date" value="${esc(m.e)}"></label>
        </div>
      </div>`;
  }

  function renderManifestList(c) {
    const ms = manifestsOf(c), always = new Set(state.settings.alwaysTypes || []);
    const shown = typesShown(c).filter((type) => ms.some((m) => m.type === type) || (type === 'asb' && c.asbestos === 'level3') || (type === 'asbsp' && c.asbestos === 'level12'));
    $('#manifestList').innerHTML = shown.map((type) => {
      const w = WT[type], list = ms.filter((m) => m.type === type);
      const total = list.reduce((a, m) => a + num(m.qty), 0), est = estimateFor(c, type);
      const open = list.filter((m) => manifestChecks(m).some((x) => x.state === 'late')).length;
      const tag = always.has(type) ? '' : type === 'asb' || type === 'asbsp' ? '<span class="tag2">アスベスト調査結果より</span>' : WT[type] && WT[type].custom ? '<span class="tag2">自分で足した種類</span>' : '<span class="tag2">追加したゴミ</span>';
      return `
      <section class="mgroup" data-type="${type}">
        <div class="ghead">
          <div class="gname">${esc(w.name)} <span class="legal">${esc(w.legal)}</span>${w.sp ? ' <span class="chip late">特別管理・期限60日</span>' : ''} ${tag}</div>
          <div class="gsum" id="gsum-${type}">${gsumHtml(c, type)}</div>
          <button class="btn small" data-addtype="${type}">＋ 1枚追加</button>
        </div>
        ${list.length ? list.map(manifestCard).join('') : '<p class="empty small-pad">まだありません。</p>'}
      </section>`;
    }).join('');
    if (!shown.length) $('#manifestList').innerHTML = '<p class="empty">まだ記録がありません。</p>';
    $('#rareType').innerHTML = WASTE_TYPES.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
    const names = (k) => [...new Set((k === 'disposer' ? (state.settings.sites || []).map((x) => x.name) : []).concat(state.cases.flatMap((x) => manifestsOf(x).map((m) => m[k]))).concat(k === 'carrier' ? state.settings.defCarrier : state.settings.defDisposer).filter(Boolean))];
    $('#carrierList').innerHTML = names('carrier').map((n) => `<option value="${esc(n)}">`).join('');
    $('#disposerList').innerHTML = names('disposer').map((n) => `<option value="${esc(n)}">`).join('');
  }

  // 全案件の返送漏れ・期限間近
  function renderManifestAlerts() {
    const late = [], soon = [];
    state.cases.forEach((c) => manifestsOf(c).forEach((m, i) => manifestChecks(m).forEach((x) => {
      const row = { c, m, i, x };
      if (x.state === 'late') late.push(row); else if (x.state === 'soon') soon.push(row);
    })));
    const line = ({ c, m, x }) => `<li><button class="link" data-goto="${c.id}">${esc(caseName(c))}</button> ${esc(WT[m.type]?.name || '')}（${m.date ? fmtIso(m.date) + '搬出' : ''}${m.no ? '・' + esc(m.no) : ''}）— <b>${x.label}</b> ${x.state === 'late' ? `期限 ${fmtDate(x.due)} を過ぎています。返送されない場合は状況を確認し、<b>${fmtDate(x.report)}</b>までに都道府県等へ措置内容等報告書を提出` : `期限 ${fmtDate(x.due)}`}</li>`;
    $('#manifestAlerts').innerHTML = `
      <div class="alertbox ${late.length ? 'bad' : soon.length ? 'mid' : 'good'}">
        <b>全案件のマニフェスト：</b>${late.length ? `期限超過 ${late.length}件` : '期限超過なし'}${soon.length ? `／2週間以内に期限 ${soon.length}件` : ''}
        ${late.length || soon.length ? `<ul>${late.concat(soon).map(line).join('')}</ul>` : ''}
      </div>`;
  }

  // 見込み（見積時）と実績（マニフェスト）の比較
  function renderManifestCompare(c) {
    const w = wasteOf(c), ms = manifestsOf(c);
    const act = (ids) => ms.filter((m) => ids.includes(m.type) && qUnitOf(m) === 't').reduce((a, m) => a + num(m.qty), 0);
    const rows = [
      ['コンクリートガラ（無筋＋有筋）', w.concrete, act(['concrete', 'concreteR'])],
      ['アスファルトガラ', w.asphalt, act(['asphalt'])],
      ['木（シバ）', w.wood, act(['wood'])],
      ['ミンチ・廃プラ・瓦など', w.mixed, act(['mixed', 'plastic', 'glass', 'gypsum'])],
    ];
    const tr = rows.map(([n, e, a]) => {
      const diff = a - e;
      return `<tr><td>${n}</td><td class="num">${e.toFixed(1)}</td><td class="num">${a ? a.toFixed(1) : '—'}</td><td class="num ${a && diff > 0.05 ? 'over' : ''}">${a ? (diff >= 0 ? '+' : '') + diff.toFixed(1) : ''}</td></tr>`;
    }).join('');
    // 実績が入っている品目だけで処分費のずれを出す
    const price = [dispPrice('concrete'), dispPrice('asphalt'), dispPrice('wood'), dispPrice('mixed')];
    const extra = rows.reduce((a, [, e, act], i) => a + (act > 0 ? (act - e) * price[i] : 0), 0);
    const any = rows.some(([, , act]) => act > 0);
    $('#manifestCompare').innerHTML = `
      <h2>見込みと実績</h2>
      <div class="table-wrap"><table class="cost"><thead><tr><th>品目</th><th class="num">見込み（t）</th><th class="num">実績（t）</th><th class="num">差</th></tr></thead><tbody>${tr}</tbody></table></div>
      <p class="hint">${any ? `実績にもとづく処分費は（実績を入れた品目だけで比べると）、見込みより <b>${extra >= 0 ? '¥' + yen(extra) + ' 多い' : '¥' + yen(-extra) + ' 少ない'}</b> 計算です。差が大きい品目は、次の見積の係数や単価を見直しましょう。` : 'マニフェストに数量を入れると、見積のときの見込みとの差と、処分費のずれが分かります。'}</p>`;
  }

  // 交付等状況報告書（年1回・6月30日まで・紙マニフェスト分）の集計
  function fiscalYearOf(iso) { const d = new Date(iso + 'T00:00:00'); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; }
  const prefOf = (addr) => (String(addr || '').match(/^(東京都|北海道|京都府|大阪府|.{2,3}?県)/) || [, '（都道府県不明）'])[1];
  let reportFy = null;
  function renderManifestReport() {
    const t = today();
    const defFy = t.getMonth() < 6 ? t.getFullYear() - 1 : t.getFullYear(); // 4〜6月は前年度分の提出時期
    const all = state.cases.flatMap((c) => manifestsOf(c).filter((m) => m.date && m.kind !== 'electronic').map((m) => ({ c, m })));
    const years = [...new Set(all.map(({ m }) => fiscalYearOf(m.date)).concat(defFy))].sort((a, b) => b - a);
    const fy = reportFy ?? defFy;
    const groups = {};
    all.filter(({ m }) => fiscalYearOf(m.date) === fy).forEach(({ c, m }) => {
      const key = [prefOf(c.siteAddress), WT[m.type]?.legal || m.type, m.carrier || '（未入力）', m.disposer || '（未入力）'].join('\u0001');
      const g = groups[key] || (groups[key] = { n: 0, qty: 0, unit: qUnitOf(m) });
      g.n++; g.qty += num(m.qty);
    });
    const keys = Object.keys(groups).sort();
    const rows = keys.map((k) => { const [p, ty, ca, di] = k.split('\u0001'); const g = groups[k]; return `<tr><td>${esc(p)}</td><td>${esc(ty)}</td><td class="num">${g.n}</td><td class="num">${g.qty.toFixed(2)} ${g.unit}</td><td>${esc(ca)}</td><td>${esc(di)}</td></tr>`; }).join('');
    $('#manifestReport').innerHTML = `
      <h2>交付等状況報告書の集計</h2>
      <p class="hint">紙マニフェストを交付した排出事業者（解体工事では元請業者）は、毎年<b>6月30日</b>までに前年度（4月〜翌3月）の交付状況を、現場がある都道府県等へ報告します。電子マニフェスト分はJWNETが報告するので不要です。</p>
      <label class="inline">年度 <select id="reportFy">${years.map((y) => `<option value="${y}" ${y === fy ? 'selected' : ''}>${y}年度（${y + 1}年6月30日まで）</option>`).join('')}</select></label>
      <div class="table-wrap"><table class="cost"><thead><tr><th>現場の都道府県</th><th>廃棄物の種類</th><th class="num">交付枚数</th><th class="num">排出量</th><th>運搬業者</th><th>処分業者</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty">この年度の紙マニフェストはありません</td></tr>'}</tbody></table></div>
      <p class="hint">提出は各自治体の様式（様式第三号）で行ってください。この表は転記用の集計です。</p>`;
  }

  // ---------- 処分の状況（マニフェスト画面のいちばん上） ----------
  let dispView = 'simple'; // simple＝合計だけ / case＝この現場の種類ごと / month＝今月の全現場
  const tFmt = (q) => (Math.round(q * 100) / 100).toLocaleString('ja-JP');
  function renderDispTop(c) {
    const box = $('#dispTop'); if (!box) return;
    if (dispView === 'simple') {
      const d = dispSummary(c), tt = manifestsOf(c).filter((m) => num(m.qty) > 0 && !tooHeavy(m) && qUnitOf(m) !== '㎥').reduce((a, m) => a + num(m.qty), 0);
      box.innerHTML = `<div class="total-card"><div><div class="lab">この現場の処分</div><div class="big">${Math.round(tt * 100) / 100}t</div></div><div class="r"><div class="lab">処分代</div><div class="big">¥${yen(d.total)}</div></div></div>
        <button type="button" class="link more" data-dview="case">種類ごと・今月の全現場を見る ›</button>`;
      return;
    }
    const tabs = `<div class="seg"><button type="button" data-dview="case" class="${dispView === 'case' ? 'on' : ''}">この現場</button><button type="button" data-dview="month" class="${dispView === 'month' ? 'on' : ''}">今月の全現場</button><button type="button" data-dview="simple">閉じる</button></div>`;
    if (dispView === 'month') {
      const ym = todayIso().slice(0, 7);
      const rows = state.cases.map((x) => {
        const ms = manifestsOf(x).filter((m) => num(m.qty) > 0 && String(m.date || '').slice(0, 7) === ym);
        const t = ms.filter((m) => qUnitOf(m) !== '㎥').reduce((a, m) => a + num(m.qty), 0);
        return { x, n: ms.length, t, cost: ms.reduce((a, m) => a + dispOf(m), 0) };
      }).filter((r) => r.n).sort((a, b) => b.cost - a.cost);
      const tt = rows.reduce((a, r) => a + r.t, 0), tc = rows.reduce((a, r) => a + r.cost, 0), tn = rows.reduce((a, r) => a + r.n, 0);
      const max = Math.max(1, ...rows.map((r) => r.cost));
      box.innerHTML = `<section class="disptop"><div class="dt-head"><h2>処分の状況</h2>${tabs}</div>
        <div class="dt-kpis"><div><span>重さ</span><b>${tFmt(tt)}<small>t</small></b></div><div><span>処分代</span><b><small>¥</small>${yen(tc)}</b></div><div><span>枚数</span><b>${tn}<small>枚</small></b></div></div>
        ${rows.length ? `<ul class="dt-rows">${rows.map((r) => `<li><div class="dt-line"><span class="dt-name">${esc(caseName(r.x))}</span><span class="dt-num">${tFmt(r.t)}t・<b>¥${yen(r.cost)}</b></span></div><div class="bar"><i style="width:${Math.round(r.cost / max * 100)}%"></i></div></li>`).join('')}</ul>`
          : '<p class="empty">今月の処分の記録はまだありません。</p>'}
        <p class="hint">${ym.replace('-', '年')}月に搬出した分（交付日の月）で数えています。</p></section>`;
      return;
    }
    const d = dispSummary(c), list = manifestsOf(c).filter((m) => num(m.qty) > 0);
    const tt = list.filter((m) => qUnitOf(m) !== '㎥').reduce((a, m) => a + num(m.qty), 0);
    const types = WASTE_TYPES.filter((w) => d.by[w.id]); // 捨てた種類だけ
    // 見込みは「コンクリートガラ」が無筋・有筋の合計なので、見込みとの比較はまとめて行う
    const est = (id) => (id === 'concreteR' ? 0 : estimateFor(c, id) || 0);
    const act = (id) => (id === 'concrete' ? ((d.by.concrete || {}).qty || 0) + ((d.by.concreteR || {}).qty || 0) : ((d.by[id] || {}).qty || 0));
    const rows = types.map((w) => {
      const g = d.by[w.id] || { qty: 0, cost: 0, n: 0 };
      const e = est(w.id), a = act(w.id);
      const pct = e ? Math.min(100, Math.round(a / e * 100)) : (g.qty ? 100 : 0);
      const over = e && a > e * 1.05;
      return `<li><div class="dt-line"><span class="dt-name">${esc(w.name)}</span><span class="dt-num"><b>${tFmt(g.qty)}</b>${w.unit}・¥${yen(g.cost)}</span></div>
        ${e ? `<div class="bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>` : ''}
        <div class="dt-sub">${e ? `見込み ${tFmt(e)}t${w.id === 'concrete' ? '（無筋・有筋の合計）' : ''}に対して ${tFmt(a)}t${over ? '：<b class="neg">見込みより多い</b>' : ''}` : (g.n ? `${g.n}枚` : '')}</div></li>`;
    }).join('');
    box.innerHTML = `<section class="disptop"><div class="dt-head"><h2>処分の状況</h2>${tabs}</div>
      <div class="dt-kpis"><div><span>重さ</span><b>${tFmt(tt)}<small>t</small></b></div><div><span>処分代</span><b><small>¥</small>${yen(d.total)}</b></div><div><span>枚数</span><b>${d.count}<small>枚</small></b></div></div>
      ${rows ? `<ul class="dt-rows">${rows}</ul>` : '<p class="empty">まだ処分の記録がありません。下の「＋ 1枚追加」か、公式LINEから記録すると、ここに出ます。</p>'}</section>`;
  }

  function renderManifest(c) { renderDispTop(c); renderManifestAlerts(); renderManifestList(c); renderManifestCost(c); renderSiteInvoices(); renderManifestCompare(c); renderManifestReport(); }
  function refreshManifestSummary(c) { renderDispTop(c); renderManifestAlerts(); renderManifestCost(c); renderSiteInvoices(); renderManifestCompare(c); renderManifestReport(); renderSchedule(c); renderProfit(c, state.settings); renderExpense(c); }

  // ---------- リース ----------
  const leasesOf = (c) => (Array.isArray(c.leases) ? c.leases : (c.leases = []));
  // リースの計算は core.js（毎朝の通知と同じ計算）
  const { LEASE_MODES, lastOfMonth, addMonthsClamp, closeLabel, closeDate, segEnd, dayCount, mLabel } = KJCore;
  const companyOf = (name) => KJCore.companyOf(state.settings, name);
  const closeOf = (l) => KJCore.closeOf(state.settings, l);
  const leaseCalc = (l, endOverride) => KJCore.leaseCalc(l, state.settings, endOverride, today());
  // 月ごとの請求額（回送費・その他は借りた月に計上）
  function leaseByMonth(l) {
    const r = leaseCalc(l); const out = {};
    (r.segs || []).forEach((g, i) => { out[g.ym] = (out[g.ym] || 0) + g.amount + (i === 0 ? num(l.transport) + num(l.other) : 0); });
    return out;
  }
  const DAY = 86400000;
  const dIso = (iso) => (iso ? new Date(iso + 'T00:00:00') : null);
  const dCount = (a, b) => Math.round((b - a) / DAY) + 1;
  const ownerOf = (l) => state.cases.find((c) => leasesOf(c).includes(l));
  // その機械がいた現場と期間（借りた現場 → 「この日から移した」ごと）
  function siteIntervals(l, owner) {
    if (!l.start || !owner) return [];
    const endD = l.end ? dIso(l.end) : today();
    const mv = (l.moves || []).filter((m) => m.date && m.caseId && m.date > l.start && (!l.end || m.date <= l.end) && state.cases.some((c) => c.id === m.caseId))
      .slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const pts = [{ caseId: owner.id, from: dIso(l.start) }].concat(mv.map((m) => ({ caseId: m.caseId, from: dIso(m.date), mid: m.id })));
    return pts.map((x, i) => ({ ...x, to: i < pts.length - 1 ? new Date(pts[i + 1].from.getTime() - DAY) : endD })).filter((x) => x.to >= x.from);
  }
  const overlap = (a1, a2, b1, b2) => { const st = a1 > b1 ? a1 : b1, en = a2 < b2 ? a2 : b2; return en < st ? 0 : dCount(st, en); };
  // 1台のリース代を現場ごとに分ける：締めごとの金額を、その区切りでいた日数で按分。回送費・その他は借りた現場
  function leaseAlloc(l, owner = ownerOf(l)) {
    const r = leaseCalc(l), iv = siteIntervals(l, owner), out = {};
    const get = (id) => out[id] || (out[id] = { cost: 0, days: 0, months: {} });
    const addM = (id, ym, v) => { const o = get(id); o.cost += v; if (ym) o.months[ym] = (o.months[ym] || 0) + v; };
    iv.forEach((x) => { get(x.caseId).days += dCount(x.from, x.to); });
    (r.segs || []).forEach((g, i) => {
      const per = iv.map((x) => overlap(g.from, g.to, x.from, x.to)), tot = per.reduce((a, b) => a + b, 0);
      if (!tot) addM(owner.id, g.ym, g.amount); else per.forEach((d, k) => { if (d) addM(iv[k].caseId, g.ym, g.amount * d / tot); });
      if (i === 0) addM(owner.id, g.ym, num(l.transport) + num(l.other));
    });
    if (owner && !out[owner.id]) get(owner.id);
    return { r, iv, out };
  }
  // この現場で使ったリース（ほかの現場から移ってきた機械も入る）
  function leaseShares(c) {
    const items = [];
    state.cases.forEach((o) => leasesOf(o).forEach((l) => {
      const a = leaseAlloc(l, o), mine = a.out[c.id]; if (!mine) return;
      const last = a.iv[a.iv.length - 1];
      items.push({ l, owner: o, ...mine, r: a.r, iv: a.iv, here: !!(a.r.ongoing && last && last.caseId === c.id) });
    }));
    return items;
  }
  function leaseSummary(c) {
    const it = leaseShares(c);
    return { total: Math.round(it.reduce((a, x) => a + x.cost, 0)), count: it.length, items: it };
  }
  function leaseCalcHtml(l, c = cur()) {
    const r = leaseCalc(l);
    if (!l.start) return '<span class="chip">借りた日を入れると金額を計算します</span>';
    if (r.state === 'bad') return '<span class="chip late">返した日が借りた日より前です</span>';
    const pct = Math.min(100, Math.round(r.rem / Math.max(1, num(l.th)) * 100));
    let note = '';
    if (r.toSwitch != null) note = `<span class="chip ${r.state === 'soon' ? 'soon' : 'wait'}">月極まで あと${r.toSwitch}日</span> <span class="sub">${!r.ongoing ? '日割りで計算' : r.tip ? `${fmtDate(addDays(isoOf(r.lastDaily), 1))}から月極` : `${fmtDate(r.lastDaily)}までに返せば日割りで済みます`}</span>`;
    else if (r.paidUntil) note = `<span class="chip done">月極に切替済み</span> <span class="sub">${r.ongoing ? `${fmtDate(r.paidUntil)}までは追加料金なし` : '月極で計算'}</span>`;
    else if (r.shortSeg) note = `<span class="chip">日割り</span> <span class="sub">${fmtDate(r.shortSeg.natEnd)}までは${r.shortSeg.len}日しかないため、この区切りは月極になりません</span>`;
    return `
      <div class="lsum"><span>使用 <b>${r.days}日</b>${r.ongoing ? '（借りている途中・今日まで）' : ''}</span><span>リース代 <b>¥${yen(r.cost)}</b></span><span class="sub">ルール：${r.mode === 'calendar' ? `${closeLabel(r.close)}締め${companyOf(l.company) ? '' : '（会社の登録なし）'}・` : ''}締めごとに${num(l.th)}日までは日割り、${num(l.th) + 1}日目から月極</span></div>
      <div class="lbar"><div style="width:${r.rem && r.rem <= num(l.th) ? pct : 100}%" class="${r.paidUntil ? 'm' : ''}"></div></div>
      <div>${note}</div>
      ${r.newMonth ? `<div class="sub monthline">📅 締め日を過ぎたので、${r.newMonth.cur.label}分は日割りに戻りました（${r.newMonth.cur.d}日目）。${r.newMonth.prev.label}分は¥${yen(r.newMonth.prev.amount)}で締め。</div>` : ''}
      ${r.tip ? `<div class="sub tipline">💡 ${r.tip}</div>` : ''}
      ${leaseMonthsHtml(l, r)}
      ${leaseForecastHtml(l, r, c)}`;
  }
  // 月ごと（リース会社の締めごと）の請求額
  function leaseMonthsHtml(l, r) {
    const now = today();
    const rows = r.segs.map((g, i) => {
      const status = !r.ongoing && i === r.segs.length - 1 ? '返却' : g.natEnd < now ? '締め済み' : '今回・途中';
      return `<tr><td>${g.label}分（${g.from.getMonth() + 1}/${g.from.getDate()}〜${g.to.getMonth() + 1}/${g.to.getDate()}）</td><td class="num">${g.d}日</td><td>${g.monthly ? '月極' : '日割り'}</td><td class="num">¥${yen(g.amount)}</td><td>${status}</td></tr>`;
    }).join('');
    const ex = num(l.transport) + num(l.other);
    return `<div class="table-wrap"><table class="cost wide mini"><thead><tr><th>請求（締めごと）</th><th class="num">日数</th><th>計算</th><th class="num">金額</th><th>状態</th></tr></thead><tbody>${rows}
      ${ex ? `<tr><td>回送費・その他</td><td></td><td></td><td class="num">¥${yen(ex)}</td><td></td></tr>` : ''}</tbody>
      <tfoot><tr><th colspan="3">${(l.moves || []).length ? 'この機械の合計（全部の現場' : 'この現場の合計（'}${(l.moves || []).length ? '・' : ''}${r.ongoing ? '今日まで' : '返却まで'}）</th><td class="num"><b>¥${yen(r.cost)}</b></td><td></td></tr></tfoot></table></div>`;
  }
  // 現場の完了予定日まで借り続けた場合の見込み
  function leaseForecastHtml(l, r, c0) {
    const iv = siteIntervals(l, ownerOf(l) || c0), at = iv.length ? state.cases.find((x) => x.id === iv[iv.length - 1].caseId) : null, c = at || c0;
    if (!r.ongoing || !c.endDate || c.endDate <= todayIso()) return '';
    const f = leaseCalc(l, c.endDate);
    const future = f.segs.filter((g) => g.to > today());
    const lastSeg = f.segs[f.segs.length - 1];
    let advice = '';
    if (!lastSeg.monthly && lastSeg.len > num(l.th)) advice = `最後の${lastSeg.label}は${lastSeg.d}日なので日割り（${num(l.th)}日以内に返せば日割りのまま）。`;
    else if (lastSeg.monthly) advice = `最後の${lastSeg.label}は${lastSeg.d}日使うので月極になります。`;
    return `<div class="forecast">🔮 <b>${c !== c0 ? `今いる${esc(caseName(c))}の` : ''}完了予定日（${fmtIso(c.endDate)}）まで借りた場合：合計 ¥${yen(f.cost)}</b>（今日から あと¥${yen(f.cost - r.cost)}）
      <div class="sub">${future.map((g) => `${g.label}：${g.d}日 ${g.monthly ? '月極' : '日割り'} ¥${yen(g.amount)}`).join('　')}</div>
      ${advice ? `<div class="sub">${advice}</div>` : ''}</div>`;
  }
  function renderLeaseList(c) {
    const ls = leasesOf(c);
    $('#leaseList').innerHTML = ls.length ? ls.map((l) => `
      <div class="mcard" data-lid="${l.id}">
        <div class="mhead"><b>${esc(l.name || '（名前なし）')}</b><span class="flex1"></span><button class="btn ghost small" data-ldel="${l.id}">削除</button></div>
        <div class="lcalc" id="lcalc-${l.id}">${leaseCalcHtml(l, c)}</div>
        ${movesHtml(l, c)}
        <div class="mgrid">
          <label>機械の名前<input data-lf="name" value="${esc(l.name)}"></label>
          <label>リース会社（締め日は設定で登録）<input data-lf="company" list="companyList" value="${esc(l.company)}" placeholder="〇〇リース"></label>
          <label>借りた日<input data-lf="start" type="date" value="${esc(l.start)}"></label>
          <label>返した日（借りている途中は空欄）<input data-lf="end" type="date" value="${esc(l.end)}"></label>
          <label>日額（円）<input data-lf="daily" type="number" min="0" value="${esc(l.daily)}"></label>
          <label>月極料金（円）<input data-lf="monthly" type="number" min="0" value="${esc(l.monthly)}"></label>
          <label class="thlabel">月極に切り替わる日数（この日数を超えたら月極）<input data-lf="th" type="number" min="1" value="${esc(l.th)}"></label>
          <label>回送費（円・往復）<input data-lf="transport" type="number" min="0" value="${esc(l.transport)}"></label>
          <label>その他（補償料など）<input data-lf="other" type="number" min="0" value="${esc(l.other ?? '')}"></label>
        </div>
      </div>`).join('') : '<p class="empty">この現場で借りた機械はまだありません。上の「借りた機械を追加」から選んでください。</p>';
    const incoming = leaseShares(c).filter((x) => x.owner.id !== c.id);
    if (incoming.length) $('#leaseList').innerHTML += `<h3 class="in-title">ほかの現場から移ってきた機械</h3>` + incoming.map((x) => `
      <div class="mcard incoming"><div class="mhead"><b>${esc(x.l.name || '（名前なし）')}</b><span class="flex1"></span><button type="button" class="link" data-openowner="${x.owner.id}">${esc(caseName(x.owner))}で直す ›</button></div>
        <div class="lsum"><span>この現場 <b>${x.days}日</b>${x.here ? '（今ここで使用中）' : ''}</span><span>この現場の分 <b>¥${yen(x.cost)}</b></span></div>${movesHtml(x.l, x.owner)}</div>`).join('');
    $('#companyList').innerHTML = (state.settings.leaseCompanies || []).filter((x) => x.name).map((x) => `<option value="${esc(x.name)}">${closeLabel(x.close)}締め</option>`).join('');
    const ps = state.settings.leasePresets || [];
    $('#leasePreset').innerHTML = ps.map((p, i) => `<option value="${i}">${esc(p.name)}（日額¥${yen(p.daily)}／月極¥${yen(p.monthly)}／${num(p.th) + 1}日目から月極）</option>`).join('') + '<option value="custom">その他（自分で入力）</option>';
  }
  // 使った現場（期間・日数・この現場の分）と、別の現場へ移す
  function movesHtml(l, c) {
    const a = leaseAlloc(l, c), others = state.cases.filter((x) => x.id !== c.id);
    const list = a.iv.map((x) => { const o = a.out[x.caseId] || {}; const cc = state.cases.find((y) => y.id === x.caseId);
      return `<li><span class="mv-site ${x.caseId === c.id ? 'me' : ''}">${esc(cc ? caseName(cc) : '？')}</span><span class="mv-when">${md(isoOf(x.from))}〜${x.to >= today() && !l.end ? '今' : md(isoOf(x.to))}（${dCount(x.from, x.to)}日）</span>${x.mid ? `<button type="button" class="mv-del" data-mvdel="${x.mid}" data-lid2="${l.id}" aria-label="この移動を取り消す">×</button>` : ''}</li>`; }).join('');
    const multi = a.iv.length > 1;
    return `<div class="moves">
      <div class="mv-title">使った現場${multi ? `<small>リース代は現場ごとにいた日数で分けます</small>` : ''}</div>
      ${l.start ? `<ul class="mv-list">${list}</ul>` : ''}
      ${multi ? `<div class="mv-split">${Object.entries(a.out).map(([id, o]) => { const cc = state.cases.find((y) => y.id === id); return `<span>${esc(cc ? caseName(cc) : '？')}：${o.days}日・¥${yen(o.cost)}</span>`; }).join('')}</div>` : ''}
      ${others.length && l.start ? `<details class="mv-add"><summary>別の現場へ移した</summary>
        <div class="mv-row"><label>移した現場<select data-mvcase>${others.map((x) => `<option value="${x.id}">${esc(caseName(x))}</option>`).join('')}</select></label>
        <label>移した日<input type="date" data-mvdate value="${todayIso()}" min="${esc(l.start)}"></label>
        <button type="button" class="btn go" data-mvadd="${l.id}">この日から移した</button></div></details>` : ''}
    </div>`;
  }
  function renderLeaseTotal(c) {
    const items = leaseShares(c), ls = items;
    const rows = items.map((x) => `<tr><td>${esc(x.l.name)}${x.owner.id !== c.id ? `<div class="sub">${esc(caseName(x.owner))}から移ってきた機械</div>` : ''}</td><td class="num">${x.days}日</td><td>${x.r.days ? (x.iv.length > 1 ? `全体${x.r.days}日のうち${x.days}日分` : x.r.summary) : '—'}</td><td class="num">¥${yen(x.cost)}</td></tr>`).join('');
    const total = leaseSummary(c).total;
    $('#leaseTotal').innerHTML = ls.length ? `
      <h2>この現場のリース代</h2>
      <div class="table-wrap"><table class="cost wide"><thead><tr><th>機械</th><th class="num">この現場の日数</th><th>計算</th><th class="num">リース代（回送費込み）</th></tr></thead><tbody>${rows}</tbody>
        <tfoot><tr><th colspan="3">合計</th><td class="num"><b>¥${yen(total)}</b></td></tr></tfoot></table></div>
      <p class="hint">月極の区切り：${LEASE_MODES[state.settings.leaseMode] || LEASE_MODES.calendar}（「設定」で変更できます）。締めごとに、使った日数が決めた日数を超えたら月極、超えなければ日割りで計算します。</p>` : '';
  }
  // 全案件の注意（月極が近い・月極になった）
  function renderLeaseAlerts() {
    const items = [];
    state.cases.forEach((c) => leasesOf(c).forEach((l) => {
      const r = leaseCalc(l);
      const who = `<button class="link" data-goto="${c.id}">${esc(caseName(c))}</button> ${esc(l.name)}`;
      if (r.state === 'soon' && r.tip) items.push({ o: 0, h: `<li>${who} — <b>あと${r.toSwitch}日で月極に切り替わります。</b>${r.tip}</li>` });
      else if (r.state === 'soon') items.push({ o: 0, h: `<li>${who} — <b>あと${r.toSwitch}日で月極に切り替わります。</b>返す予定なら${fmtDate(r.lastDaily)}までに返せば日割り（今の時点で¥${yen(r.rent)}）で済みます。</li>` });
      else if (r.state === 'monthly') items.push({ o: 1, h: `<li>${who} — 月極に切り替わりました（使用${r.days}日）。${fmtDate(r.paidUntil)}までは追加料金なしで使えます。</li>` });
      else if (r.tip && r.ongoing) items.push({ o: 2, h: `<li>${who} — ${r.tip}</li>` });
      if (r.newMonth) items.push({ o: 3, h: `<li>${who} — ${closeLabel(r.close)}の締め日を過ぎ、${r.newMonth.cur.label}分は日割りに戻りました（${r.newMonth.cur.d}日目）。現場は続いているので、次の締めまでに使った日数が${num(l.th)}日を超えると（${num(l.th) + 1}日目から）月極になります。</li>` });
    }));
    items.sort((a, b) => a.o - b.o);
    const soon = items.filter((x) => x.o === 0).length;
    $('#leaseAlerts').innerHTML = `
      <div class="alertbox ${soon ? 'mid' : 'good'}"><b>全案件のリース：</b>${soon ? `もうすぐ月極に切り替わる機械 ${soon}台` : '月極が近い機械はありません'}
        ${items.length ? `<ul>${items.map((x) => x.h).join('')}</ul>` : ''}</div>`;
  }
  function renderLease(c) { renderLeaseAlerts(); renderLeaseList(c); renderLeaseTotal(c); }

  // ---------- 経費 ----------
  const expensesOf = (c) => (Array.isArray(c.expenses) ? c.expenses : (c.expenses = []));
  function expenseSummary(c) {
    const byCat = {}; let total = 0;
    expensesOf(c).forEach((x) => { byCat[x.cat] = (byCat[x.cat] || 0) + num(x.amount); total += num(x.amount); });
    return { byCat, total };
  }
  let expMonth = null;
  function renderExpense(c) {
    if (!$('#expCat').options.length) $('#expCat').innerHTML = EXPENSE_CATS.map((k) => `<option>${k}</option>`).join('');
    if (!$('#expDate').value) $('#expDate').value = todayIso();
    const list = expensesOf(c).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const sum = expenseSummary(c);
    $('#expenseList').innerHTML = `
      <div class="sumlist">${EXPENSE_CATS.map((k) => `<div><span>${k}</span><b>¥${yen(sum.byCat[k] || 0)}</b></div>`).join('')}
        <div class="total"><span>この現場の経費 合計</span><b>¥${yen(sum.total)}</b></div></div>
      <div class="table-wrap"><table class="cost wide"><thead><tr><th>日付</th><th>項目</th><th class="num">金額</th><th>メモ</th><th></th></tr></thead>
        <tbody>${list.map((x) => `<tr><td>${fmtIso(x.date)}</td><td>${esc(x.cat)}</td><td class="num">¥${yen(x.amount)}</td><td>${esc(x.memo)}</td><td class="num"><button class="btn ghost small" data-expdel="${x.id}">削除</button></td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">まだ経費がありません</td></tr>'}</tbody></table></div>`;
    renderExpenseMonthly();
  }
  // 月ごとの全案件まとめ（経費＋処分代）
  function renderExpenseMonthly() {
    const ym = (iso) => String(iso || '').slice(0, 7);
    const withData = new Set();
    state.cases.forEach((c) => { expensesOf(c).forEach((x) => withData.add(ym(x.date))); manifestsOf(c).forEach((m) => m.date && num(m.qty) && withData.add(billOf(m).ym)); leasesOf(c).forEach((l) => Object.keys(leaseByMonth(l)).forEach((k) => withData.add(k))); });
    const sorted = [...new Set([...withData, ym(todayIso())])].filter(Boolean).sort().reverse();
    const latest = [...withData].filter(Boolean).sort().reverse()[0] || ym(todayIso());
    const mon = expMonth && sorted.includes(expMonth) ? expMonth : latest;
    const tot = { disp: 0, lease: 0 }; EXPENSE_CATS.forEach((k) => { tot[k] = 0; });
    const rows = state.cases.map((c) => {
      const r = { disp: manifestsOf(c).filter((m) => m.date && billOf(m).ym === mon).reduce((a, m) => a + dispOf(m), 0),
        lease: leaseShares(c).reduce((a, x) => a + (x.months[mon] || 0), 0) };
      EXPENSE_CATS.forEach((k) => { r[k] = expensesOf(c).filter((x) => ym(x.date) === mon && x.cat === k).reduce((a, x) => a + num(x.amount), 0); });
      const all = r.disp + r.lease + EXPENSE_CATS.reduce((a, k) => a + r[k], 0);
      if (!all) return '';
      tot.disp += r.disp; tot.lease += r.lease; EXPENSE_CATS.forEach((k) => { tot[k] += r[k]; });
      return `<tr><td>${esc(caseName(c))}</td><td class="num">¥${yen(r.disp)}</td><td class="num">¥${yen(r.lease)}</td>${EXPENSE_CATS.map((k) => `<td class="num">¥${yen(r[k])}</td>`).join('')}<td class="num"><b>¥${yen(all)}</b></td></tr>`;
    }).join('');
    const grand = tot.disp + tot.lease + EXPENSE_CATS.reduce((a, k) => a + tot[k], 0);
    $('#expenseMonthly').innerHTML = `
      <h2>月ごとのまとめ（全案件）</h2>
      <label class="inline" for="expMonth">月 <select id="expMonth">${sorted.map((m) => `<option value="${m}" ${m === mon ? 'selected' : ''}>${m.replace('-', '年')}月</option>`).join('')}</select></label>
      <div class="table-wrap"><table class="cost wide"><thead><tr><th>現場</th><th class="num">処分代</th><th class="num">リース</th>${EXPENSE_CATS.map((k) => `<th class="num">${k}</th>`).join('')}<th class="num">合計</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="${EXPENSE_CATS.length + 4}" class="empty">この月の処分代・リース・経費はありません</td></tr>`}</tbody>
        <tfoot><tr><th>合計</th><td class="num">¥${yen(tot.disp)}</td><td class="num">¥${yen(tot.lease)}</td>${EXPENSE_CATS.map((k) => `<td class="num">¥${yen(tot[k])}</td>`).join('')}<td class="num"><b>¥${yen(grand)}</b></td></tr></tfoot></table></div>
      <p class="hint">処分代は処分場の締めごとの請求の月、リース代は締めごとの請求の月（回送費は借りた月）で数えています。借りている途中の機械は今日までの金額です。</p>`;
  }

  function newManifest(c, extra = {}) {
    const s = state.settings;
    return { id: uid(), kind: 'paper', no: '', date: c.startDate || todayIso(), type: 'concrete', qty: '', carrier: s.defCarrier || '', disposer: s.defDisposer || '', reg: '', b2: '', d: '', e: '', ...extra };
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

  // ---------- スマホ：表を「1行＝1枚のカード」で見せるため、各マスに列の名前をつける ----------
  function labelTables(root) {
    root.querySelectorAll('table.cost').forEach((t) => {
      const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
      t.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
        let col = 0;
        [...tr.children].forEach((cell, i) => {
          if (i > 0 && !cell.dataset.label) cell.dataset.label = heads[col] || '';
          col += cell.colSpan || 1;
        });
      });
    });
  }
  let labelTimer = 0;
  new MutationObserver(() => { clearTimeout(labelTimer); labelTimer = setTimeout(() => labelTables(document), 30); })
    .observe(document.querySelector('main') || document.body, { childList: true, subtree: true });

  // ---------- 設定：見出しを押すと開く（最初は全部閉じる） ----------
  function foldSettings() {
    document.querySelectorAll('#tab-settings fieldset').forEach((fs) => {
      if (fs.dataset.fold) return; fs.dataset.fold = '1'; fs.classList.add('fold-fs', 'closed');
      const lg = fs.querySelector(':scope > legend'); if (!lg) return;
      lg.setAttribute('role', 'button'); lg.tabIndex = 0;
      const tog = () => fs.classList.toggle('closed');
      lg.addEventListener('click', tog); lg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tog(); } });
    });
  }
  window.KJOpenSetting = (id) => { const fs = document.getElementById(id); if (fs) fs.classList.remove('closed'); return fs; };

  function renderAll() {
    KJCore.setCustomTypes(state.settings.customTypes);
    const te = $('#typeEditor'); const ae = document.activeElement; if (te && !te.dataset.keep && !(te.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox')) renderTypeEditor();
    const c = cur(), s = state.settings;
    renderCaseSelect(); renderSchedule(c); renderEstimate(c, s); renderProfit(c, s); renderProcess(c, s); renderManifest(c); renderExpense(c); renderLease(c); renderWasteLog(); syncChoices(); renderSummary(c); renderMonthly(); if (curSec === 'home') renderHome(); if (curSec === 'line') renderLineLog(); renderSiteHead(); renderRecycle(c, s); renderGreeting(c, s); renderCertificate(c, s);
  }

  // ---------- イベント ----------
  const caseForm = $('#caseForm'), settingsForm = $('#settingsForm');
  bindForm(caseForm, cur);
  bindForm(settingsForm, () => state.settings);

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    const sec = secOf(b.dataset.tab);
    if (sec !== curSec) setSection(sec, false);
    lastTab[sec] = b.dataset.tab;
    try { localStorage.setItem('kaitai-jimu-nav', JSON.stringify({ sec, lastTab })); } catch (_) { /* noop */ }
    if (b.dataset.tab === 'home') renderHome();
    if (b.dataset.tab === 'linelog') renderLineLog(); if (b.dataset.tab === 'monthly') renderMonthly();
    renderSiteHead();
    window.scrollTo(0, 0);
  });

  // ---------- 画面の入口：ホーム（現場の一覧）→ 現場（処分・お金・書類・情報） ----------
  const GROUPS = {
    summary: { label: 'まとめ', tabs: ['summary'] },
    waste: { label: '処分', tabs: ['manifest'] },
    money: { label: 'お金', tabs: ['profit', 'expense', 'lease'] },
    docs: { label: '書類', tabs: ['estimate', 'process', 'recycle', 'greeting', 'certificate'] },
    info: { label: '情報', tabs: ['input', 'schedule'], hidden: true },
  };
  const SECTIONS = {
    home: ['home', 'monthly'],
    site: [].concat(...Object.values(GROUPS).map((g) => g.tabs)),
    line: ['linelog'],
    settings: ['settings'],
  };
  const TAB_LABELS = { monthly: '月ごとのお金', summary: 'まとめ', input: '現場の情報', schedule: '期限', estimate: '見積書', process: '工程表', recycle: '届出', greeting: '挨拶文', certificate: '取毀証明', profit: '利益', expense: '経費', lease: 'リース', manifest: '処分', settings: '設定', home: 'ホーム', linelog: 'LINEの記録' };
  const secOf = (tab) => Object.keys(SECTIONS).find((k) => SECTIONS[k].includes(tab)) || 'home';
  const groupOf = (tab) => Object.keys(GROUPS).find((g) => GROUPS[g].tabs.includes(tab));
  let curSec = 'home';
  const lastTab = {};
  $$('#tabs button').forEach((b) => { if (TAB_LABELS[b.dataset.tab]) b.textContent = TAB_LABELS[b.dataset.tab]; });
  function setSection(sec, openTab = true) {
    curSec = sec;
    $$('#mainNav button').forEach((b) => b.classList.toggle('active', b.dataset.sec === (sec === 'site' ? 'home' : sec)));
    document.body.dataset.section = sec;
    if (openTab) { const tabs = SECTIONS[sec]; const t = sec === 'home' ? 'home' : lastTab[sec] && tabs.includes(lastTab[sec]) ? lastTab[sec] : tabs[0]; $(`#tabs button[data-tab="${t}"]`).click(); }
    renderSiteHead();
  }
  $('#mainNav').addEventListener('click', (e) => { const b = e.target.closest('[data-sec]'); if (b) setSection(b.dataset.sec); });
  const go = (tab) => { setSection(secOf(tab), false); $(`#tabs button[data-tab="${tab}"]`).click(); };
  const lastOfGroup = {};
  function openCase(id, group = 'summary') {
    if (id && id !== state.currentId) { state.currentId = id; save(); fillForm(caseForm, cur()); renderAll(); }
    const tabs = GROUPS[group].tabs;
    go(lastOfGroup[group] && tabs.includes(lastOfGroup[group]) ? lastOfGroup[group] : tabs[0]);
  }
  // 現場の見出し：戻る・名前・状態・（処分・お金・書類・情報）の切り替え
  function renderSiteHead() {
    const box = $('#siteHead'); if (!box) return;
    if (curSec !== 'site') { box.hidden = true; return; }
    const c = cur(), active = $('#tabs button.active'), tab = active ? active.dataset.tab : 'manifest', g = groupOf(tab) || 'waste';
    lastOfGroup[g] = tab;
    const [, st] = caseStatus(c);
    const sub = [c.siteAddress, st + (c.startDate ? `（${md(c.startDate)}〜${md(c.endDate)}）` : '')].filter(Boolean).join('・');
    const chips = GROUPS[g].tabs.length > 1 ? `<div class="chips-row">${GROUPS[g].tabs.map((t) => `<button type="button" data-go="${t}" class="${t === tab ? 'on' : ''}">${TAB_LABELS[t]}</button>`).join('')}</div>` : '';
    box.hidden = false;
    box.innerHTML = `<button type="button" class="back" data-back>‹ 現場の一覧</button>
      <h1 class="site-name">${esc(c.clientName ? c.clientName + '様邸' : '名前未入力の現場')}</h1>
      <p class="site-sub">${esc(sub)}</p>
      <div class="seg4">${Object.keys(GROUPS).filter((k) => !GROUPS[k].hidden).map((k) => `<button type="button" data-group="${k}" class="${k === g ? 'on' : ''}">${GROUPS[k].label}</button>`).join('')}</div>${chips}`;
  }
  $('#siteHead').addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) { setSection('home'); return; }
    const gb = e.target.closest('[data-group]'); if (gb) { openCase(null, gb.dataset.group); return; }
    const t = e.target.closest('[data-go]'); if (t) go(t.dataset.go);
  });

  // 押したら返事：画面の下に短く出す
  let toastTimer = null;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }

  // ---------- ホーム：現場の一覧 ----------
  const WCOLOR = { wood: '#b07a3c', concrete: '#7a8794', concreteR: '#556270', mixed: '#c2410c', plastic: '#2f80ed', glass: '#8e6bbf', gypsum: '#9aa5b1', asphalt: '#3b3b3b', metal: '#4b7f52', asb: '#e03131', asbsp: '#e03131' };
  const CUSTOM_COLORS = ['#2b8a7e', '#7a5af5', '#c2255c', '#5c7cfa', '#e8590c', '#2f9e44'];
  const colorOf = (type) => WCOLOR[type] || (WT[type] && WT[type].custom ? CUSTOM_COLORS[Math.abs([...type].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % CUSTOM_COLORS.length] : '#888');
  const wchip = (type) => `<span class="wchip" style="--wc:${colorOf(type)}">${esc((WT[type] || {}).name || type)}</span>`;
  const md = (iso) => (iso ? iso.replace(/^\d+-0?(\d+)-0?(\d+)$/, '$1/$2') : '');
  function caseStatus(c) {
    const t = todayIso();
    if (c.status === 'done') return ['done', '完了'];
    if (c.status === 'live') return ['live', '工事中'];
    if (c.status === 'plan') return ['plan', c.startDate ? `${md(c.startDate)} 着工` : '着工前'];
    if (c.endDate && c.endDate < t) return ['done', '完了'];
    if (c.startDate && c.startDate > t) return ['plan', `${md(c.startDate)} 着工`];
    if (c.startDate) return ['live', '工事中'];
    return ['plan', '日程未定'];
  }
  const monthDisp = (c, ym) => {
    const ms = manifestsOf(c).filter((m) => num(m.qty) > 0 && !tooHeavy(m) && String(m.date || '').slice(0, 7) === ym);
    return { t: ms.filter((m) => qUnitOf(m) !== '㎥').reduce((a, m) => a + num(m.qty), 0), cost: ms.reduce((a, m) => a + dispOf(m), 0), n: ms.length };
  };
  const tTxt = (t) => `${Math.round(t * 10) / 10}t`;
  let alertsOpen = false;
  let homeFilter = 'live', homeFilterSet = false;
  try { const v = localStorage.getItem('kaitai-jimu-homefilter'); if (v) { homeFilter = v; homeFilterSet = true; } } catch (_) { /* noop */ }
  function renderHome() {
    const now = today(), ym = todayIso().slice(0, 7);
    const a = KJCore.collectAlerts(state, now);
    const heavy = state.cases.flatMap((c) => manifestsOf(c).filter(tooHeavy).map((m) => `${KJCore.caseLabel ? KJCore.caseLabel(c) : (c.clientName || '')}：${(WT[m.type] || {}).name || ''} ${m.qty}t は多すぎます（kgで入れた？ 現場を開いて直せます）`));
    const alerts = [].concat(heavy, a.lease, a.manifest, a.schedule);
    const wd = '日月火水木金土'[now.getDay()];
    const order = { live: 0, plan: 1, done: 2 };
    const cases = state.cases.slice().sort((x, y) => order[caseStatus(x)[0]] - order[caseStatus(y)[0]]);
    const allT = cases.reduce((s2, c) => s2 + monthDisp(c, ym).t, 0);
    const cnt = { live: 0, plan: 0, done: 0 }; cases.forEach((c) => cnt[caseStatus(c)[0]]++);
    if (!cnt[homeFilter] && !homeFilterSet) homeFilter = cnt.live ? 'live' : cnt.plan ? 'plan' : 'live';
    const shown = cases.filter((c) => caseStatus(c)[0] === homeFilter);
    const homeTabs = () => `<div class="htabs">${[['live', '工事中'], ['plan', 'これから'], ['done', '完了']].map(([k, l]) => `<button type="button" data-hf="${k}" class="${k === homeFilter ? 'on' : ''}">${l}<em>${cnt[k]}</em></button>`).join('')}</div>`;
    const allY = cases.reduce((s2, c) => s2 + monthDisp(c, ym).cost, 0);
    const liveN = cases.filter((c) => caseStatus(c)[0] === 'live').length;
    const hr = now.getHours(), hello = hr < 10 ? 'おはようございます' : hr < 18 ? 'おつかれさまです' : 'おつかれさまでした';
    $('#homeOut').innerHTML = `
      <section class="hero">
        <div class="hero-top"><span class="hero-hello">${hello}</span><span class="hero-date">${now.getMonth() + 1}月${now.getDate()}日（${wd}）</span></div>
        <button type="button" class="hero-main" data-act="monthly"><span class="hero-lab">${now.getMonth() + 1}月の処分代</span><b class="hero-big">¥${yen(allY)}</b><span class="hero-link">現場ごとに見る ›</span></button>
        <div class="hero-grid"><div><span>処分した量</span><b>${tTxt(allT)}</b></div><div><span>工事中の現場</span><b>${liveN}<small>件</small></b></div><div><span>全部の現場</span><b>${cases.length}<small>件</small></b></div></div>
      </section>
      ${alerts.length ? `<button type="button" class="alert-pill" data-alerts><span>⚠ 注意が ${alerts.length}件 あります</span><span>${alertsOpen ? '閉じる' : '見る ›'}</span></button>
        ${alertsOpen ? `<ul class="alert-list">${alerts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}` : '<p class="ok-line">✓ 今日の注意はありません</p>'}
      ${homeTabs(cases)}
      <ul class="rows site-rows">${shown.length ? shown.map((c) => {
        const [k, label] = caseStatus(c), d = monthDisp(c, ym), pr = period(c), nx = nextTodo(c);
        return `<li><button type="button" class="row" data-open="${c.id}"><span class="dot ${k}"></span>
          <span class="r-main"><span class="r-title">${esc(c.clientName ? c.clientName + '様邸' : '名前未入力の現場')}</span><span class="r-sub">${esc([c.siteAddress, label].filter(Boolean).join('・'))}</span>
          ${pr && k === 'live' ? `<span class="prog"><span class="pbar"><i style="width:${pr.pct}%"></i></span><span>${pr.day}日目／${pr.total}日</span></span>` : ''}
          <span class="rchips">${nx ? `<span class="rc ${nx.cls}">${esc(nx.title)} ${esc(nx.label)}</span>` : ''}${d.n ? `<span class="rc">処分 ${tTxt(d.t)}・¥${yen(d.cost)}</span>` : ''}</span></span>
          <span class="chev">›</span></button></li>`;
      }).join('') : `<li class="empty-row">${{ live: '工事中の現場はありません。', plan: 'これからの現場はありません。', done: '完了した現場はまだありません。' }[homeFilter]}</li>`}</ul>
      <button type="button" class="btn ghost wide" data-act="newcase">＋ 新しい現場を作る</button>
      ${homeLeaseHtml()}
      <button type="button" class="fab" data-act="record">＋ 記録する</button>`;
  }
  // 借りている途中の機械を、今いる現場ごとに
  function homeLeaseHtml() {
    const groups = {};
    state.cases.forEach((o) => leasesOf(o).forEach((l) => {
      const a = leaseAlloc(l, o); if (!a.r.ongoing || !a.iv.length) return;
      const at = a.iv[a.iv.length - 1].caseId; (groups[at] = groups[at] || []).push({ l, a, at });
    }));
    const ids = Object.keys(groups); if (!ids.length) return '';
    let n = 0;
    const html = ids.map((id) => {
      const c = state.cases.find((x) => x.id === id), list = groups[id];
      const siteTotal = Math.round(leaseShares(c).reduce((s2, x) => s2 + x.cost, 0)); n += list.length;
      return `<li><button type="button" class="row" data-lease-open="${id}"><span class="r-main"><span class="r-title">${esc(caseName(c))}</span>
        <span class="r-sub">${list.map(({ l, a }) => `${esc(l.name || '機械')}（${a.r.state === 'soon' ? `月極まで${a.r.toSwitch}日` : a.r.paidUntil ? '月極' : `${a.r.days}日目`}）`).join('・')}</span></span>
        <span class="r-num"><b>¥${yen(siteTotal)}</b><span class="r-sub">この現場のリース代</span></span><span class="chev">›</span></button></li>`;
    }).join('');
    const soon = ids.reduce((a, id) => a + groups[id].filter((x) => x.a.r.state === 'soon').length, 0);
    return `<p class="sec-label">リース中の機械（${n}台）${soon ? `<span class="rc soon">月極が近い ${soon}台</span>` : ''}</p><ul class="rows">${html}</ul>`;
  }
  $('#homeOut').addEventListener('click', (e) => {
    if (e.target.closest('[data-alerts]')) { alertsOpen = !alertsOpen; renderHome(); return; }
    const lo = e.target.closest('[data-lease-open]'); if (lo) { openCase(lo.dataset.leaseOpen, 'money'); go('lease'); return; }
    const open = e.target.closest('[data-open]'); if (open) { openCase(open.dataset.open, 'summary'); return; }
    const hf = e.target.closest('[data-hf]'); if (hf) { homeFilter = hf.dataset.hf; homeFilterSet = true; try { localStorage.setItem('kaitai-jimu-homefilter', homeFilter); } catch (_) { /* noop */ } renderHome(); return; }
    const act = e.target.closest('[data-act]'); if (!act) return;
    if (act.dataset.act === 'newcase') openCaseSheet();
    if (act.dataset.act === 'monthly') { monthlyYm = todayIso().slice(0, 7); go('monthly'); }
    if (act.dataset.act === 'record') {
      const live = state.cases.filter((c) => caseStatus(c)[0] === 'live');
      openRec((live.find((c) => c.id === state.currentId) || live[0] || cur()).id);
    }
  });

  // ---------- LINEの記録（全現場） ----------
  function renderLineLog() {
    const list = state.cases.flatMap((c) => manifestsOf(c).filter((m) => m.via === 'line').map((m) => ({ c, m })))
      .sort((x, y) => String(y.m.lineAt || y.m.date).localeCompare(String(x.m.lineAt || x.m.date)));
    $('#lineLogOut').innerHTML = `<h1 class="h-date">LINEの記録</h1>
      <p class="h-sub">公式LINEに送られた記録です（全部の現場）。押すとその現場が開きます。</p>
      <ul class="rows">${list.map(({ c, m }) => `<li><button type="button" class="row" data-open="${c.id}"><span class="r-main"><span class="r-title">${wchip(m.type)} ${qtyText(m)}</span><span class="r-sub">${md(m.date)}・${esc(c.clientName ? c.clientName + '様邸' : '名前未入力の現場')}・${esc(m.disposer || '処分場未入力')}</span></span><span class="r-num"><b>¥${yen(dispOf(m))}</b></span></button></li>`).join('')
        || '<li class="empty-row">まだありません。運転手さんが公式LINEに「ヒラヤマ 伏見 シバ 3t」のように送ると、ここに入ります。</li>'}</ul>
      <button type="button" class="btn ghost wide" data-tolink>LINEの連携・運転手さんの追加 ›</button>`;
  }
  $('#lineLogOut').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]'); if (open) { openCase(open.dataset.open, 'waste'); return; }
    if (e.target.closest('[data-tolink]')) { setSection('settings'); setTimeout(() => KJOpenSetting('lineInBox')?.scrollIntoView({ block: 'start' }), 50); }
  });

  // ---------- 処分：1行で記録 ----------
  // 前回の選び方（この端末だけ）を覚えておき、次は最初から選んだ状態にする
  const REC_KEY = 'kaitai-jimu-rec';
  const recMem = () => { try { return JSON.parse(localStorage.getItem(REC_KEY)) || {}; } catch (_) { return {}; } };
  const recRemember = (o) => { try { localStorage.setItem(REC_KEY, JSON.stringify({ ...recMem(), ...o })); } catch (_) { /* noop */ } };
  let R = null; // 入力中の記録
  const allMs = () => state.cases.flatMap((c) => manifestsOf(c).map((m) => ({ ...m, _c: c.id })));
  const ymdShift = (d) => { const x = today(); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  function recTypes() {
    const cnt = {}; allMs().forEach((m) => { cnt[m.type] = (cnt[m.type] || 0) + 1; });
    const base = [...new Set([...(state.settings.alwaysTypes || []), ...Object.keys(cnt)])].filter((t) => WT[t]);
    const order = (state.settings.alwaysTypes || []);
    base.sort((a, b) => (cnt[b] || 0) - (cnt[a] || 0) || order.indexOf(a) - order.indexOf(b));
    return { main: base, rest: WASTE_TYPES.map((w) => w.id).filter((t) => !base.includes(t)) };
  }
  function recDisposers() {
    const out = [];
    allMs().slice().reverse().forEach((m) => { if (m.disposer && !out.includes(m.disposer)) out.push(m.disposer); });
    (state.settings.sites || []).forEach((s) => { if (s.name && !out.includes(s.name)) out.push(s.name); });
    if (state.settings.defDisposer && !out.includes(state.settings.defDisposer)) out.push(state.settings.defDisposer);
    return out.slice(0, 8);
  }
  function recQtys(type, unit) {
    const out = [], vol = unit === '㎥';
    allMs().slice().reverse().forEach((m) => {
      if (m.type !== type || (qUnitOf(m) === '㎥') !== vol) return;
      let q = num(m.qty); if (!(q > 0) || (!vol && q >= 100)) return;
      if (unit === 'kg') q = Math.round(q * 1000); if (!out.includes(q)) out.push(q);
    });
    (unit === 'kg' ? [100, 200, 300, 500] : [2, 3, 4, 1]).forEach((q) => { if (out.length < 4 && !out.includes(q)) out.push(q); });
    return out.slice(0, 4).sort((a, b) => a - b);
  }
  function openRec(caseId) {
    const mem = recMem(), types = recTypes();
    const type = (mem.type && WT[mem.type]) ? mem.type : types.main[0] || 'concrete';
    const disp = recDisposers();
    R = { caseId: caseId || cur().id, type, qty: '', unit: 't', unitAuto: true, disposer: mem.disposer && disp.includes(mem.disposer) ? mem.disposer : (disp[0] || ''), date: todayIso(), more: false, typing: false };
    $('#recForm').hidden = false; $('#recDone').hidden = true; $('#recSheet').hidden = false;
    document.body.classList.add('sheet-open');
    renderRec();
  }
  function closeRec() { $('#recSheet').hidden = true; document.body.classList.remove('sheet-open'); R = null; }
  const chipBtn = (attr, v, label, on, extra = '') => `<button type="button" class="cbtn ${on ? 'on' : ''}" data-${attr}="${esc(String(v))}" ${extra}>${label}</button>`;
  function renderRec() {
    if (!R) return;
    const cases = state.cases.filter((c) => caseStatus(c)[0] !== 'done');
    const list = cases.length ? cases : state.cases;
    if (!list.some((c) => c.id === R.caseId)) list.unshift(state.cases.find((c) => c.id === R.caseId) || cur());
    const t = recTypes(), types = R.more ? [...t.main, ...t.rest] : t.main;
    const disp = recDisposers();
    // 単位：その種類（処分場）の単価が kg なら kg、㎥ なら ㎥ で入れる
    const pu = defaultPriceOf({ type: R.type, disposer: R.disposer }).unit;
    const units = pu === '㎥' ? ['㎥'] : ['t', 'kg'];
    if (R.unitAuto || !units.includes(R.unit)) R.unit = pu === '㎥' ? '㎥' : pu === 'kg' ? 'kg' : 't';
    const qtys = recQtys(R.type, R.unit);
    const dateIs = R.date === todayIso() ? 'today' : R.date === ymdShift(-1) ? 'yday' : 'other';
    $('#recBody').innerHTML = `
      <div class="field"><div class="flabel"><i>1</i>どの現場？</div>
        <div class="choice scroll">${list.map((c) => chipBtn('rcase', c.id, esc(caseName(c)), c.id === R.caseId)).join('')}</div></div>
      <div class="field"><div class="flabel"><i>2</i>なにを捨てた？</div>
        <div class="choice types">${types.map((id) => chipBtn('rtype', id, `<span class="sw" style="--wc:${colorOf(id)}"></span>${esc(WT[id].name)}`, id === R.type)).join('')}
        ${t.rest.length ? `<button type="button" class="cbtn more" data-rmore>${R.more ? '少なく表示' : '＋ ほかの種類'}</button>` : ''}</div></div>
      <div class="field"><div class="flabel"><i>3</i>${R.unit === '㎥' ? '量（立米）は？' : '重さは？'}<small class="unit-note">単価 ¥${yen(defaultPriceOf({ type: R.type, disposer: R.disposer }).price)}/${pu}</small></div>
        <div class="qty-row"><input id="recQty" class="qty-in" type="number" inputmode="decimal" min="0" step="0.001" placeholder="0" value="${esc(R.qty)}" aria-label="数量">
          <div class="unit ${units.length === 1 ? 'one' : ''}">${units.map((u) => `<button type="button" data-runit="${u}" class="${R.unit === u ? 'on' : ''}">${u}</button>`).join('')}</div></div>
        <div class="choice">${qtys.map((q) => chipBtn('rqty', q, `${q.toLocaleString('ja-JP')}${R.unit}`, String(q) === String(R.qty))).join('')}</div></div>
      <div class="field"><div class="flabel"><i>4</i>どこに捨てた？</div>
        <div class="choice">${disp.map((d) => chipBtn('rdisp', d, esc(d), d === R.disposer && !R.typing)).join('')}
          <button type="button" class="cbtn more ${R.typing ? 'on' : ''}" data-rtype-disp>${disp.length ? '＋ ほかの処分場' : '処分場を入れる'}</button></div>
        ${R.typing ? `<input id="recDisp" list="disposerList" placeholder="処分場の名前" value="${esc(R.disposer)}" autocomplete="off">` : ''}</div>
      <div class="field"><div class="flabel"><i>5</i>いつ？</div>
        <div class="choice">${chipBtn('rdate', 'today', '今日', dateIs === 'today')}${chipBtn('rdate', 'yday', '昨日', dateIs === 'yday')}
          <label class="cbtn date ${dateIs === 'other' ? 'on' : ''}">${dateIs === 'other' ? md(R.date) : '日付を選ぶ'}<input type="date" id="recDate" value="${R.date}"></label></div></div>`;
    recUpdate();
  }
  // 入れた数量 → 記録する数量（t か ㎥）
  function recQty() { const q = num(R.qty); return R.unit === '㎥' ? { q, qu: '㎥' } : { q: R.unit === 'kg' ? q / 1000 : q, qu: 't' }; }
  function recUpdate() {
    const { q, qu } = recQty(), w = WT[R.type] || {};
    const d = defaultPriceOf({ type: R.type, disposer: R.disposer }), cost = costOf(q, qu, d.price, d.unit);
    $('#recPreview').innerHTML = q > 0 ? `${esc(caseName(state.cases.find((c) => c.id === R.caseId) || cur()))}・${esc(R.disposer || '処分場なし')}${d.price && cost != null ? `<span>処分代の目安 <b>¥${yen(Math.round(cost))}</b></span>` : ''}` : `<span class="mut">${R.unit === '㎥' ? '量' : '重さ'}を入れると、処分代の目安が出ます</span>`;
    const b = $('#recSubmit'); b.disabled = !(q > 0);
    b.textContent = q > 0 ? `${w.name || ''} ${num(R.qty).toLocaleString('ja-JP')}${R.unit} を記録する` : `${R.unit === '㎥' ? '量' : '重さ'}を入れてください`;
  }
  $('#recSheet').addEventListener('click', (e) => {
    if (e.target.id === 'recSheet' || e.target.closest('[data-close]')) { closeRec(); return; }
    if (!R) return;
    const g = (k) => e.target.closest(`[data-${k}]`);
    let b;
    if ((b = g('rcase'))) R.caseId = b.dataset.rcase;
    else if ((b = g('rtype'))) { if (R.type !== b.dataset.rtype) { R.type = b.dataset.rtype; R.unitAuto = true; R.qty = ''; } }
    else if (g('rmore')) R.more = !R.more;
    else if ((b = g('runit'))) { R.unit = b.dataset.runit; R.unitAuto = false; }
    else if ((b = g('rqty'))) { R.qty = b.dataset.rqty; }
    else if ((b = g('rdisp'))) { R.disposer = b.dataset.rdisp; R.typing = false; R.unitAuto = true; }
    else if (g('rtype-disp')) { R.typing = true; R.disposer = ''; renderRec(); $('#recDisp')?.focus(); return; }
    else if ((b = g('rdate'))) R.date = b.dataset.rdate === 'today' ? todayIso() : ymdShift(-1);
    else return;
    renderRec();
  });
  $('#recSheet').addEventListener('input', (e) => {
    if (!R) return;
    if (e.target.id === 'recQty') { R.qty = e.target.value; document.querySelectorAll('#recBody [data-rqty]').forEach((x) => x.classList.toggle('on', x.dataset.rqty === R.qty)); recUpdate(); }
    if (e.target.id === 'recDisp') { R.disposer = e.target.value.trim(); recUpdate(); }
    if (e.target.id === 'recDate' && e.target.value) { R.date = e.target.value; renderRec(); }
  });
  $('#recForm').addEventListener('submit', (e) => {
    e.preventDefault(); if (!R) return;
    let { q, qu } = recQty(); if (!(q > 0)) { $('#recQty')?.focus(); return; }
    let kgNote = '';
    if (R.unit === 't' && q >= 100) { kgNote = `（${q}kg として ${q / 1000}t で記録しました）`; q = q / 1000; }
    q = Math.round(q * 1000) / 1000;
    const c = state.cases.find((x) => x.id === R.caseId) || cur();
    const m = newManifest(c, { type: R.type, qty: String(q), unit: qu, disposer: R.disposer, date: R.date || todayIso() });
    manifestsOf(c).push(m);
    recRemember({ type: R.type, disposer: R.disposer });
    save(); renderAll();
    try { navigator.vibrate && navigator.vibrate(18); } catch (_) { /* noop */ }
    $('#recDoneText').innerHTML = `<b>${esc(caseName(c))}</b><br>${esc((WT[R.type] || {}).name || '')} ${qtyText(m)}${dispOf(m) ? `・処分代 ¥${yen(dispOf(m))}` : ''}${kgNote ? `<br><span class="sub">${esc(kgNote)}</span>` : ''}`;
    $('#recForm').hidden = true; $('#recDone').hidden = false;
  });
  $('#recAgain').addEventListener('click', () => { if (!R) return; R.qty = ''; $('#recDone').hidden = true; $('#recForm').hidden = false; renderRec(); setTimeout(() => $('#recQty')?.focus(), 50); });
  $('#qwOpen').addEventListener('click', () => openRec(cur().id));

  // ---------- 新しい現場（最低限だけ入れて始める） ----------
  function openCaseSheet() {
    $('#caseQuick').reset(); $('#cqStart').value = todayIso();
    document.querySelectorAll('#cqStruct button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'wood'));
    $('#caseSheet').hidden = false; document.body.classList.add('sheet-open');
    setTimeout(() => $('#cqName').focus(), 60);
  }
  const closeCaseSheet = () => { $('#caseSheet').hidden = true; document.body.classList.remove('sheet-open'); };
  $('#caseSheet').addEventListener('click', (e) => {
    if (e.target.id === 'caseSheet' || e.target.closest('[data-close]')) { closeCaseSheet(); return; }
    const b = e.target.closest('#cqStruct button'); if (b) document.querySelectorAll('#cqStruct button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#caseQuick').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = newCase();
    Object.assign(c, {
      clientName: $('#cqName').value.trim().replace(/様邸$|様$/, ''), siteAddress: $('#cqAddr').value.trim(),
      structure: (document.querySelector('#cqStruct button.on') || {}).dataset?.v || 'wood',
      floorArea: $('#cqArea').value, startDate: $('#cqStart').value, endDate: $('#cqEnd').value,
    });
    state.cases.unshift(c); state.currentId = c.id; save(); fillForm(caseForm, c); renderAll();
    closeCaseSheet(); openCase(c.id, 'summary');
    toast(`「${caseName(c)}」を作りました`);
  });


  // ---------- 月ごとのお金（現場ごと） ----------
  let monthlyYm = null, monthlyKey = 'disp';
  function monthData(ym) {
    const rows = state.cases.map((c) => {
      const ms = manifestsOf(c).filter((m) => num(m.qty) > 0 && !tooHeavy(m) && String(m.date || '').slice(0, 7) === ym);
      const disp = ms.reduce((a, m) => a + dispOf(m), 0), t = ms.filter((m) => qUnitOf(m) !== '㎥').reduce((a, m) => a + num(m.qty), 0);
      const exp = expensesOf(c).filter((x) => String(x.date || '').slice(0, 7) === ym).reduce((a, x) => a + num(x.amount), 0);
      const lease = leaseShares(c).reduce((a, x) => a + (x.months[ym] || 0), 0);
      return { c, disp: Math.round(disp), exp: Math.round(exp), lease: Math.round(lease), t, n: ms.length, total: Math.round(disp + exp + lease) };
    }).filter((r) => r.total > 0 || r.n > 0);
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    return { rows, disp: sum('disp'), exp: sum('exp'), lease: sum('lease'), total: sum('total'), t: sum('t') };
  }
  function monthsWithData() {
    const set = new Set([todayIso().slice(0, 7)]);
    state.cases.forEach((c) => {
      manifestsOf(c).forEach((m) => m.date && set.add(m.date.slice(0, 7)));
      expensesOf(c).forEach((x) => x.date && set.add(x.date.slice(0, 7)));
      leaseShares(c).forEach((x) => Object.keys(x.months).forEach((k) => set.add(k)));
    });
    return [...set].sort();
  }
  function renderMonthly() {
    const box = $('#monthlyOut'); if (!box || curSec !== 'home') return;
    const months = monthsWithData(); if (!monthlyYm || !months.includes(monthlyYm)) monthlyYm = months[months.length - 1];
    const i = months.indexOf(monthlyYm), d = monthData(monthlyYm);
    const [y, mo] = monthlyYm.split('-').map(Number);
    const KEYS = [['disp', '処分代'], ['exp', '経費'], ['lease', 'リース'], ['total', '合計']];
    const rows = d.rows.slice().sort((a, b) => b[monthlyKey] - a[monthlyKey] || b.total - a.total);
    const max = Math.max(1, ...rows.map((r) => r[monthlyKey]));
    box.innerHTML = `
      <button type="button" class="back" data-mgo="home">‹ ホーム</button>
      <div class="mon-nav">
        <button type="button" class="mon-arrow" data-mym="${months[i - 1] || ''}" ${i > 0 ? '' : 'disabled'} aria-label="前の月">‹</button>
        <h1 class="mon-title">${y}年${mo}月<small>のお金（現場ごと）</small></h1>
        <button type="button" class="mon-arrow" data-mym="${months[i + 1] || ''}" ${i < months.length - 1 ? '' : 'disabled'} aria-label="次の月">›</button>
      </div>
      <section class="mon-sum">
        <div class="ms-total"><span>全部の現場の合計</span><b>¥${yen(d.total)}</b></div>
        <div class="ms-grid"><div><span>処分代</span><b>¥${yen(d.disp)}</b><small>${tTxt(d.t)}</small></div><div><span>経費</span><b>¥${yen(d.exp)}</b></div><div><span>リース</span><b>¥${yen(d.lease)}</b></div></div>
      </section>
      <div class="seg4 mon-seg">${KEYS.map(([k, l]) => `<button type="button" data-mkey="${k}" class="${k === monthlyKey ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="sec-label">${KEYS.find((x) => x[0] === monthlyKey)[1]}が多い順</p>
      ${rows.length ? `<ul class="rows mon-rows">${rows.map((r) => `<li><button type="button" class="mrow" data-mopen="${r.c.id}">
        <span class="mr-top"><span class="mr-name">${esc(caseName(r.c))}<small>${esc(r.c.siteAddress || '')}</small></span><b>¥${yen(r[monthlyKey])}</b><span class="chev">›</span></span>
        <span class="pbar"><i style="width:${Math.round(r[monthlyKey] / max * 100)}%"></i></span>
        <span class="mon-break"><span class="${monthlyKey === 'disp' ? 'on' : ''}">処分 ¥${yen(r.disp)}${r.t ? `（${tTxt(r.t)}）` : ''}</span><span class="${monthlyKey === 'exp' ? 'on' : ''}">経費 ¥${yen(r.exp)}</span><span class="${monthlyKey === 'lease' ? 'on' : ''}">リース ¥${yen(r.lease)}</span>${monthlyKey !== 'total' ? `<span class="mr-total">合計 ¥${yen(r.total)}</span>` : ''}</span>
      </button></li>`).join('')}</ul>`
        : '<p class="empty-row card">この月の記録はまだありません。</p>'}
      <p class="hint">処分代は捨てた日、経費は使った日、リースはリース会社の締めの月で数えています。現場を押すと、その現場のまとめが開きます。</p>`;
  }
  $('#monthlyOut').addEventListener('click', (e) => {
    let b;
    if ((b = e.target.closest('[data-mym]'))) { if (b.dataset.mym) { monthlyYm = b.dataset.mym; renderMonthly(); } return; }
    if ((b = e.target.closest('[data-mkey]'))) { monthlyKey = b.dataset.mkey; renderMonthly(); return; }
    if ((b = e.target.closest('[data-mopen]'))) { openCase(b.dataset.mopen, 'summary'); return; }
    if (e.target.closest('[data-mgo]')) go('home');
  });

  // ---------- 現場の「まとめ」 ----------
  const dayMs = 86400000;
  const isoDate = (iso) => (iso ? new Date(iso + 'T00:00:00') : null);
  function period(c) {
    const s0 = isoDate(c.startDate), e0 = isoDate(c.endDate); if (!s0 || !e0 || e0 < s0) return null;
    const total = Math.round((e0 - s0) / dayMs) + 1, day = Math.min(total, Math.max(0, Math.round((today() - s0) / dayMs) + 1));
    return { total, day, left: Math.max(0, Math.round((e0 - today()) / dayMs)), pct: Math.round(day / total * 100), started: today() >= s0 };
  }
  function todos(c) {
    const area = num(c.floorArea), st = c.startDate, out = [];
    const add = (key, need, title, due, doc, note) => { if (need) out.push({ key, title, due, doc, note, done: !!(c.todos || {})[key] }); };
    add('recycle', area >= 80, '建設リサイクル法の届出', addDays(st, -7), 'recycle', '延床80㎡以上。着工7日前まで');
    add('asbSurvey', c.asbestos === 'unknown', 'アスベストの事前調査', addDays(st, -14), null, '調査結果が「未調査」です');
    add('asbReport', area >= 80, 'アスベスト調査結果の報告', addDays(st, -1), null, '石綿事前調査結果報告システムで電子報告');
    add('asbNotice', c.asbestos === 'level12', '特定粉じん排出等作業の届出', addDays(st, -14), null, 'レベル1・2の除去。作業14日前まで');
    add('greeting', true, '近隣挨拶', addDays(st, -7), 'greeting', '着工1週間〜10日前が目安');
    add('road', !!c.narrowRoad, '道路使用許可の申請', addDays(st, -7), null, '所轄の警察署へ。早めに');
    add('certificate', true, '取毀証明書を施主へ渡す', c.endDate ? addDays(c.endDate, 0) : null, 'certificate', '施主が1か月以内に滅失登記');
    return out;
  }
  function dueInfo(due) {
    if (!due) return { cls: '', label: '日付未定', diff: 9999 };
    const diff = Math.round((due - today()) / dayMs);
    if (diff < 0) return { cls: 'late', label: `${-diff}日超過`, diff };
    if (diff === 0) return { cls: 'late', label: '今日まで', diff };
    if (diff <= 7) return { cls: 'soon', label: `あと${diff}日`, diff };
    return { cls: '', label: `${due.getMonth() + 1}/${due.getDate()}まで`, diff };
  }
  function nextTodo(c) {
    const open = todos(c).filter((x) => !x.done && x.due).map((x) => ({ ...x, ...dueInfo(x.due) })).sort((a, b) => a.diff - b.diff);
    return open[0] && open[0].diff <= 14 ? open[0] : null;
  }
  const STRUCT_S = { wood: '木造', steel: '鉄骨造', rc: 'RC造' };
  const ASB_S = { none: '含有なし', level3: 'あり（レベル3）', level12: 'あり（レベル1・2）', unknown: '未調査' };
  const INFO_PARTS = [
    ['client', '施主（お客さま）', (c) => [c.clientName && c.clientName + ' 様', c.clientTel, c.clientAddress].filter(Boolean).join('・'), (c) => !c.clientName],
    ['building', '解体する建物', (c) => [c.siteAddress, STRUCT_S[c.structure], c.floors && c.floors + '階', num(c.floorArea) ? c.floorArea + '㎡' : '', c.builtYear && c.builtYear + '年築'].filter(Boolean).join('・'), (c) => !c.siteAddress || !num(c.floorArea)],
    ['site', '現場の条件', (c) => [c.noHeavy && '重機が入れない', c.narrowRoad && '道路が狭い', num(c.debrisM3) && `残置物${c.debrisM3}㎥`, num(c.blockM) && `ブロック塀${c.blockM}m`, num(c.concreteM2) && `土間${c.concreteM2}㎡`, num(c.trees) && `庭木${c.trees}本`].filter(Boolean).join('・') || 'とくになし', () => false],
    ['asbestos', 'アスベスト', (c) => ASB_S[c.asbestos] + (num(c.asbestosM2) ? `・${c.asbestosM2}㎡` : ''), (c) => c.asbestos === 'unknown'],
    ['period', '工期', (c) => (c.startDate ? `${md(c.startDate)}〜${md(c.endDate) || '？'}` : '') + (c.workDays ? `・${c.workDays}日` : ''), (c) => !c.startDate || !c.endDate],
    ['waste', '廃棄物の量の見込み', (c) => [num(c.wConcrete) && `コンクリ${c.wConcrete}t`, num(c.wWood) && `木${c.wWood}t`, num(c.wAsphalt) && `アスファルト${c.wAsphalt}t`, num(c.wMixed) && `混合${c.wMixed}t`].filter(Boolean).join('・'), () => false],
    ['notes', 'メモ', (c) => String(c.notes || '').slice(0, 40), () => false],
  ];
  function renderSummary(c) {
    const box = $('#summaryOut'); if (!box) return;
    const [k] = caseStatus(c), pr = period(c), td = todos(c), done = td.filter((x) => x.done).length;
    const est = calcEstimate(c, state.settings).net, disp = dispSummary(c).total, ex = expenseSummary(c).total, ls = leaseSummary(c).total;
    const spent = Math.round(disp + ex + ls), remain = est - spent, pct = est ? Math.min(100, Math.round(spent / est * 100)) : 0;
    const ms = manifestsOf(c).filter((m) => num(m.qty) > 0 && !tooHeavy(m)), last = ms.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const tt = ms.filter((m) => qUnitOf(m) !== '㎥').reduce((a, m) => a + num(m.qty), 0);
    const map = c.siteAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.siteAddress)}` : '';
    box.innerHTML = `
      <div class="stat3">${[['plan', 'これから'], ['live', '工事中'], ['done', '完了']].map(([v, l]) => `<button type="button" data-st="${v}" class="${k === v ? 'on ' + v : ''}">${l}</button>`).join('')}</div>
      <section class="card pcard" data-info="period">
        ${pr ? `<div class="pc-row"><span class="lab">工期 ${md(c.startDate)}〜${md(c.endDate)}</span><b>${pr.started ? `${pr.day}日目／${pr.total}日` : `${pr.total}日間`}</b></div>
          <div class="pbar big"><i style="width:${pr.started ? pr.pct : 0}%"></i></div>
          <div class="pc-row lab"><span>${pr.started ? '着工' : `着工まで あと${Math.round((isoDate(c.startDate) - today()) / dayMs)}日`}</span><span>${k === 'done' ? '完了' : `完了まで あと${pr.left}日`}</span></div>`
          : '<div class="pc-row"><b>工期が未定です</b><span class="lnk">入れる ›</span></div>'}
      </section>
      <div class="acts4">
        <button type="button" class="go" data-act="rec"><b>＋</b>捨てた記録</button>
        <button type="button" data-act="exp"><b>¥</b>経費</button>
        <button type="button" data-act="est"><b>見</b>見積書</button>
        ${map ? `<a href="${map}" target="_blank" rel="noopener"><b>地</b>地図</a>` : '<button type="button" data-info="building"><b>地</b>地図</button>'}
      </div>
      <section class="card">
        <div class="ct">やること<small>${done}／${td.length} 済み</small></div>
        <ul class="todo">${td.map((x) => { const d = dueInfo(x.due); return `<li class="${x.done ? 'done' : ''}">
          <button type="button" class="cb ${x.done ? 'on' : ''}" data-todo="${x.key}" aria-label="${esc(x.title)}を${x.done ? '未完了に戻す' : '済みにする'}"></button>
          <span class="t">${esc(x.title)}<small>${esc(x.note)}</small></span>
          ${x.done ? '<span class="bd">済み</span>' : `<span class="bd ${d.cls}">${d.label}</span>`}
          ${x.doc && !x.done ? `<button type="button" class="lnk" data-go="${x.doc}">作る ›</button>` : ''}</li>`; }).join('')}</ul>
        ${c.startDate ? '' : '<p class="hint small">工期を入れると、それぞれの期限が出ます。</p>'}
      </section>
      <section class="card tap" data-go="profit">
        <div class="ct">お金<small>今日まで ›</small></div>
        <div class="m3"><div><span>見積（税抜）</span><b>¥${yen(est)}</b></div><div><span>かかった</span><b>¥${yen(spent)}</b></div><div><span>残り（見込み）</span><b class="${remain < 0 ? 'neg' : 'pos'}">${remain < 0 ? '−' : ''}¥${yen(Math.abs(remain))}</b></div></div>
        ${est ? `<div class="pbar"><i class="${pct >= 90 ? 'bad' : pct >= 70 ? 'mid' : ''}" style="width:${pct}%"></i></div><p class="lab">見積の${pct}%を使っています（処分代 ¥${yen(disp)}・経費 ¥${yen(ex)}・リース ¥${yen(ls)}）</p>` : '<p class="lab">延床面積を入れると見積が出ます</p>'}
      </section>
      ${leaseCardHtml(c)}
      <section class="card tap" data-go="manifest">
        <div class="ct">処分<small>${last ? `最後：${md(last.date)} ${esc((WT[last.type] || {}).name || '')} ${qtyText(last)} ›` : 'まだ記録がありません ›'}</small></div>
        <div class="pc-row"><span class="big">${Math.round(tt * 100) / 100}t</span><span class="big">¥${yen(dispSummary(c).total)}</span></div>
      </section>
      <section class="card">
        <div class="ct">現場の情報<small>押すと直せます</small></div>
        ${c.clientTel ? `<a class="quick-call" href="tel:${esc(String(c.clientTel).replace(/[^0-9+]/g, ''))}">施主に電話する（${esc(c.clientTel)}）</a>` : ''}
        <ul class="info-list">${INFO_PARTS.map(([key, title, sum, missing]) => { const v = sum(c); const miss = missing(c); return `<li><button type="button" data-info="${key}">
          <span class="il-t">${title}${miss ? '<em>未入力あり</em>' : ''}</span><span class="il-v">${esc(v) || '<span class="mut">まだ入っていません</span>'}</span><span class="chev">›</span></button></li>`; }).join('')}</ul>
      </section>
      <div class="danger-zone"><button type="button" class="btn ghost" data-act="del">この現場を削除する</button></div>`;
  }
  function leaseCardHtml(c) {
    const it = leaseShares(c), total = Math.round(it.reduce((a, x) => a + x.cost, 0));
    const badge = (x) => { const r = x.r; if (!x.here) return x.l.end ? '<span class="bd">返却済み</span>' : '<span class="bd">ほかの現場へ移動</span>';
      if (r.state === 'soon') return `<span class="bd soon">月極まで あと${r.toSwitch}日</span>`; if (r.paidUntil) return '<span class="bd ok">月極</span>'; return '<span class="bd">日割り</span>'; };
    return `<section class="card tap" data-go="lease">
      <div class="ct">リース<small>${it.length ? `${it.filter((x) => x.here).length}台 使用中・今日まで ›` : '›'}</small></div>
      ${it.length ? `<ul class="lease-mini">${it.map((x) => `<li><span class="lm-n">${esc(x.l.name || '（名前なし）')}<small>${x.days}日${x.owner.id !== c.id ? '・移ってきた機械' : x.iv.length > 1 ? '・途中で移動' : ''}</small></span>${badge(x)}<b>¥${yen(x.cost)}</b></li>`).join('')}</ul>
        <div class="pc-row lm-total"><span>この現場のリース代</span><b>¥${yen(total)}</b></div>` : '<p class="lab">この現場で借りている機械はありません。</p>'}
      <button type="button" class="btn ghost wide lm-add" data-act="lease">＋ 借りた機械を足す</button>
    </section>`;
  }
  $('#summaryOut').addEventListener('click', (e) => {
    const c = cur(); let b;
    if ((b = e.target.closest('[data-st]'))) { c.status = b.dataset.st; save(); renderAll(); toast(`「${b.textContent}」にしました`); return; }
    if ((b = e.target.closest('[data-todo]'))) {
      c.todos = c.todos || {}; const k = b.dataset.todo;
      if (c.todos[k]) delete c.todos[k]; else c.todos[k] = todayIso();
      save(); renderAll(); try { navigator.vibrate && navigator.vibrate(10); } catch (_) { /* noop */ } return;
    }
    if ((b = e.target.closest('[data-info]'))) { editInfo(b.dataset.info); return; }
    if ((b = e.target.closest('[data-act]'))) {
      const a = b.dataset.act;
      if (a === 'rec') openRec(c.id);
      if (a === 'exp') openExp();
      if (a === 'est') go('estimate');
      if (a === 'del') $('#deleteCase').click();
      if (a === 'lease') { go('lease'); setTimeout(() => { $('#leasePreset')?.scrollIntoView({ block: 'center' }); $('#leasePreset')?.focus(); }, 80); }
      return;
    }
    if ((b = e.target.closest('[data-go]'))) { go(b.dataset.go); }
  });

  // ---------- 現場の情報：区切りごとに下から出す ----------
  let infoIdx = 0;
  function editInfo(part) {
    infoIdx = Math.max(0, INFO_PARTS.findIndex((p) => p[0] === part));
    const body = $('#infoBody'); if (caseForm.parentElement !== body) body.appendChild(caseForm);
    fillForm(caseForm, cur()); syncChoices(); showInfo();
    $('#infoSheet').hidden = false; document.body.classList.add('sheet-open');
  }
  function showInfo() {
    const key = INFO_PARTS[infoIdx][0];
    $$('#caseForm fieldset').forEach((f) => { f.hidden = f.dataset.part !== key; });
    $('#infoTitle').textContent = INFO_PARTS[infoIdx][1];
    $('#infoStep').textContent = `現場の情報 ${infoIdx + 1}／${INFO_PARTS.length}`;
    $('#infoPrev').style.visibility = infoIdx ? 'visible' : 'hidden';
    $('#infoNext').textContent = infoIdx < INFO_PARTS.length - 1 ? `次へ：${INFO_PARTS[infoIdx + 1][1]} ›` : '完了';
    $('#infoBody').scrollTop = 0;
  }
  const closeInfo = () => { $('#infoSheet').hidden = true; document.body.classList.remove('sheet-open'); renderAll(); };
  $('#infoSheet').addEventListener('click', (e) => { if (e.target.id === 'infoSheet' || e.target.closest('[data-close]')) closeInfo(); });
  $('#infoPrev').addEventListener('click', () => { if (infoIdx > 0) { infoIdx--; showInfo(); } });
  $('#infoNext').addEventListener('click', () => { if (infoIdx < INFO_PARTS.length - 1) { infoIdx++; showInfo(); } else closeInfo(); });

  // ---------- 経費：下から出す ----------
  function openExp() {
    $('#expAmount').value = ''; $('#expMemo').value = ''; $('#expDate').value = todayIso(); expDaySync();
    $('#expSheet').hidden = false; document.body.classList.add('sheet-open'); syncChoices();
    setTimeout(() => $('#expAmount').focus(), 80);
  }
  const closeExp = () => { $('#expSheet').hidden = true; document.body.classList.remove('sheet-open'); };
  function expDaySync() {
    const v = $('#expDate').value, y = (() => { const x = today(); x.setDate(x.getDate() - 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; })();
    $$('#expDay [data-d]').forEach((b) => b.classList.toggle('on', (b.dataset.d === '0' && v === todayIso()) || (b.dataset.d === '-1' && v === y)));
    const lab = $('#expDay .date'); const other = v && v !== todayIso() && v !== y;
    lab.classList.toggle('on', other); lab.firstChild.textContent = other ? md(v) : '日付を選ぶ';
  }
  $('#expSheet').addEventListener('click', (e) => {
    if (e.target.id === 'expSheet' || e.target.closest('[data-close]')) { closeExp(); return; }
    const b = e.target.closest('[data-d]'); if (!b) return;
    const x = today(); x.setDate(x.getDate() + Number(b.dataset.d));
    $('#expDate').value = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; expDaySync();
  });
  $('#expDate').addEventListener('change', expDaySync);
  $('#expOpen').addEventListener('click', openExp);
  // ---------- 少ない選択肢は「押すだけ」のボタンにする ----------
  const CHOICE_SELECTS = ['#caseForm select[name=structure]', '#caseForm select[name=asbestos]', '#expCat'];
  function syncChoices() {
    CHOICE_SELECTS.forEach((q) => {
      const sel = document.querySelector(q); if (!sel || !sel.options.length) return;
      let box = sel.nextElementSibling;
      if (!box || !box.classList.contains('choice')) { box = document.createElement('div'); box.className = 'choice for-select'; sel.after(box); sel.classList.add('sr-only'); sel.tabIndex = -1;
        box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; sel.value = b.dataset.v; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); syncChoices(); }); }
      const short = [...sel.options].map((o) => o.textContent.replace(/（.*?）/, '')), uniq = new Set(short).size === short.length;
      box.innerHTML = [...sel.options].map((o, i) => `<button type="button" class="cbtn ${o.value === sel.value ? 'on' : ''}" data-v="${esc(o.value)}">${esc(uniq ? short[i] : o.textContent)}</button>`).join('');
    });
  }
  // 捨てた記録の一覧（この現場・新しい順）
  function renderWasteLog() {
    const c = cur();
    const list = manifestsOf(c).filter((m) => num(m.qty) > 0 || m.date).slice()
      .sort((x, y) => String(y.date).localeCompare(String(x.date)) || String(y.lineAt || '').localeCompare(String(x.lineAt || '')));
    $('#wasteLog').innerHTML = list.length ? list.map((m) => {
      const late = manifestChecks(m).some((x) => x.state === 'late');
      return `<li><button type="button" class="row" data-edit="${m.id}"><span class="r-main"><span class="r-title">${wchip(m.type)} ${num(m.qty) ? qtyText(m) : '数量未入力'}${unitMismatch(m) ? ' <span class="chip late">単位を確認</span>' : ''}</span>
        <span class="r-sub">${md(m.date)}・${esc(m.disposer || '処分場未入力')}${m.via === 'line' ? '・<span class="line-t">LINE</span>' : ''}${late ? '・<span class="neg">返送期限切れ</span>' : ''}</span></span>
        <span class="r-num"><b>${tooHeavy(m) ? '要確認' : '¥' + yen(dispOf(m))}</b></span></button>${tooHeavy(m) ? `<div class="fixrow">${fixKgHtml(m)}</div>` : ''}</li>`;
    }).join('') : '<li class="empty-row">まだ記録がありません。上の「＋ 捨てた記録をつける」か、公式LINEから記録できます。</li>';
  }
  // 「○tに直す」：kg で入れた重さを t に直す（処分の一覧・詳しい入力のどちらからでも）
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fixkg]'); if (!b) return;
    const c = cur(), m = manifestsOf(c).find((x) => x.id === b.dataset.fixkg); if (!m) return;
    m.qty = String(Math.round(num(m.qty)) / 1000); save(); renderAll();
    toast(`${m.qty}tに直しました`);
  });
  $('#wasteLog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]'); if (!b) return;
    $('#manifestDetail').open = true;
    const card = document.querySelector(`.mcard[data-mid="${b.dataset.edit}"]`);
    if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600); }
  });
  document.addEventListener('click', (e) => { if (e.target.closest('.print')) window.print(); });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-end]'); if (!b) return;
    cur().endDate = b.dataset.setEnd; save(); fillForm(caseForm, cur()); renderAll();
  });
  $('#dispTop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dview]'); if (!b) return;
    dispView = b.dataset.dview; renderDispTop(cur());
  });
  // マニフェストの入力（入力中のカードは描き直さず、期限表示と集計だけ更新）
  $('#manifestList').addEventListener('input', (e) => {
    const el = e.target, card = el.closest('[data-mid]'); if (!card || !el.dataset.f) return;
    const m = manifestsOf(cur()).find((x) => x.id === card.dataset.mid); if (!m) return;
    m[el.dataset.f] = el.value; save();
    if (el.dataset.f === 'kind' || el.dataset.f === 'type' || el.dataset.f === 'unit') { renderManifestList(cur()); renderWasteLog(); }
    else {
      const ch = $('#chips-' + m.id); if (ch) ch.innerHTML = chipsHtml(m);
      const mc = $('#mcost-' + m.id); if (mc) mc.innerHTML = mcostHtml(m);
      const pi = card.querySelector('[data-f=price]'); if (pi) { const d = defaultPriceOf(m); pi.placeholder = `${d.label} ${yen(d.price)}`; }
      const gs = $('#gsum-' + m.type); if (gs) gs.innerHTML = gsumHtml(cur(), m.type);
    }
    refreshManifestSummary(cur());
  });
  const mdelArmed = {};
  $('#manifestList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mdel]'); if (!b) return;
    const id = b.dataset.mdel;
    if (!mdelArmed[id]) { b.textContent = 'もう一度押すと削除'; mdelArmed[id] = setTimeout(() => { b.textContent = '削除'; delete mdelArmed[id]; }, 3000); return; }
    clearTimeout(mdelArmed[id]); delete mdelArmed[id];
    const c = cur(); c.manifests = manifestsOf(c).filter((m) => m.id !== id); save(); renderAll();
  });
  // 種類ごとの「＋ 1枚追加」：同じ種類の直前の1枚から、紙/電子・業者・日付を引き継ぐ
  $('#manifestList').addEventListener('click', (e) => {
    const add = e.target.closest('[data-addtype]'), rm = e.target.closest('[data-rmtype]');
    const c = cur(), ms = manifestsOf(c);
    if (add) {
      const type = add.dataset.addtype, same = ms.filter((m) => m.type === type), last = same[same.length - 1] || ms[ms.length - 1];
      const m = newManifest(c, { type, ...(last ? { kind: last.kind, carrier: last.carrier, disposer: last.disposer, date: last.date } : {}) });
      ms.push(m); save(); renderAll();
      const card = document.querySelector(`[data-mid="${m.id}"]`); if (card) { card.scrollIntoView({ block: 'center' }); card.querySelector('[data-f=no]')?.focus(); }
    }
    if (rm) { c.extraTypes = (c.extraTypes || []).filter((t) => t !== rm.dataset.rmtype); save(); renderAll(); }
  });
  $('#addRare').addEventListener('click', () => {
    const type = $('#rareType').value; if (!type) return;
    const c = cur(), ms = manifestsOf(c), same = ms.filter((m) => m.type === type), last = same[same.length - 1] || ms[ms.length - 1];
    const m = newManifest(c, { type, ...(last ? { kind: last.kind, carrier: last.carrier, disposer: last.disposer } : {}) });
    ms.push(m); save(); renderAll();
    const card = document.querySelector(`.mcard[data-mid="${m.id}"]`); if (card) { card.scrollIntoView({ block: 'center' }); card.querySelector('[data-f=qty]')?.focus(); }
  });
  // リースの追加・入力・削除
  $('#addLease').addEventListener('click', () => {
    const c = cur(), v = $('#leasePreset').value, p = v === 'custom' ? null : (state.settings.leasePresets || [])[+v];
    const l = { id: uid(), name: p ? p.name : '', company: '', start: c.startDate && c.startDate <= todayIso() ? c.startDate : todayIso(), end: '',
      daily: p ? p.daily : '', monthly: p ? p.monthly : '', th: p ? p.th : 20, transport: p ? p.transport : '', other: '' };
    leasesOf(c).push(l); save(); renderAll();
    document.querySelector(`[data-lid="${l.id}"]`)?.scrollIntoView({ block: 'center' });
  });
  $('#leaseList').addEventListener('input', (e) => {
    const el = e.target, card = el.closest('[data-lid]'); if (!card || !el.dataset.lf) return;
    const l = leasesOf(cur()).find((x) => x.id === card.dataset.lid); if (!l) return;
    l[el.dataset.lf] = el.value; save();
    const box = $('#lcalc-' + l.id); if (box) box.innerHTML = leaseCalcHtml(l);
    if (el.dataset.lf === 'name') card.querySelector('.mhead b').textContent = l.name || '（名前なし）';
    renderLeaseAlerts(); renderLeaseTotal(cur()); renderProfit(cur(), state.settings); renderExpenseMonthly();
  });
  const leaseDelArmed = {};
  $('#leaseList').addEventListener('click', (e) => {
    const ow = e.target.closest('[data-openowner]'); if (ow) { openCase(ow.dataset.openowner, 'money'); go('lease'); return; }
    const add = e.target.closest('[data-mvadd]');
    if (add) {
      const box = add.closest('.mv-add'), to = box.querySelector('[data-mvcase]').value, date = box.querySelector('[data-mvdate]').value;
      const all = state.cases.flatMap((x) => leasesOf(x)), l = all.find((x) => x.id === add.dataset.mvadd); if (!l || !to || !date) return;
      if (date <= l.start) { toast('借りた日より後の日を選んでください'); return; }
      if (l.end && date > l.end) { toast('返した日より前の日を選んでください'); return; }
      l.moves = (l.moves || []).filter((m) => m.date !== date).concat({ id: uid(), date, caseId: to }); save(); renderAll();
      toast(`${md(date)}から「${caseName(state.cases.find((x) => x.id === to))}」へ移しました`); return;
    }
    const del = e.target.closest('[data-mvdel]');
    if (del) { const l = state.cases.flatMap((x) => leasesOf(x)).find((x) => x.id === del.dataset.lid2); if (l) { l.moves = (l.moves || []).filter((m) => m.id !== del.dataset.mvdel); save(); renderAll(); } return; }
    const b = e.target.closest('[data-ldel]'); if (!b) return;
    const id = b.dataset.ldel;
    if (!leaseDelArmed[id]) { b.textContent = 'もう一度押すと削除'; leaseDelArmed[id] = setTimeout(() => { b.textContent = '削除'; delete leaseDelArmed[id]; }, 3000); return; }
    clearTimeout(leaseDelArmed[id]); delete leaseDelArmed[id];
    const c = cur(); c.leases = leasesOf(c).filter((x) => x.id !== id); save(); renderAll();
  });
  $('#leaseAlerts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]'); if (!b) return;
    state.currentId = b.dataset.goto; save(); fillForm(caseForm, cur()); renderAll();
  });
  // 設定：処分場ごとの単価
  function renderSites() {
    const sites = state.settings.sites || [];
    $('#sites').innerHTML = sites.map((st) => `
      <div class="site" data-sid="${st.id}">
        <div class="site-head"><label class="pname">処分場の名前<input data-sf="name" value="${esc(st.name)}" placeholder="〇〇リサイクルセンター"></label>
          <label class="pname">LINEでの呼び方（カンマ区切り）<input data-sf="alias" value="${esc(st.alias || '')}" placeholder="例：ヒラヤマ, 平山"></label>
          <label>締め日<select data-sf="close">${['末'].concat(Array.from({ length: 28 }, (_, i) => String(i + 1))).map((x) => `<option value="${x}" ${String(st.close ?? '末') === x ? 'selected' : ''}>${closeLabel(x)}締め</option>`).join('')}</select></label>
          <button type="button" class="btn ghost small" data-sdel="${st.id}">削除</button></div>
        <div class="disp-grid">${WASTE_TYPES.map((w) => `<label>${esc(w.name)}<span class="qty-unit"><input type="number" min="0" inputmode="decimal" data-sp="${w.id}" value="${esc(st.prices?.[w.id] ?? '')}" placeholder="標準 ${yen(dispPrice(w.id))}/${stdUnitOf(w.id)}"><select data-su="${w.id}" aria-label="単位">${['t', 'kg', '㎥'].map((u) => `<option value="${u}" ${siteUnitOf(st, w.id) === u ? 'selected' : ''}>円/${u}</option>`).join('')}</select></span></label>`).join('')}</div>
      </div>`).join('') || '<p class="empty">登録された処分場はありません。</p>';
    renderSiteCompare();
  }
  function renderSiteCompare() {
    const sites = (state.settings.sites || []).filter((x) => x.name);
    if (sites.length < 2) { $('#siteCompare').innerHTML = sites.length ? '<p class="hint">処分場を2つ以上登録すると、種類ごとに一番安い処分場が分かります。</p>' : ''; return; }
    const rows = WASTE_TYPES.map((w) => {
      const ps = sites.map((st) => sitePrice(st, w.id)); if (ps.every((p) => p == null)) return '';
      const min = Math.min(...ps.filter((p) => p != null));
      return `<tr><td>${esc(w.name)}</td>${ps.map((p) => `<td class="num ${p === min ? 'cheap' : ''}">${p == null ? '—' : '¥' + yen(p)}</td>`).join('')}</tr>`;
    }).join('');
    $('#siteCompare').innerHTML = `<h3 class="sc-title">処分場の単価くらべ（緑が一番安い）</h3>
      <div class="table-wrap"><table class="cost wide"><thead><tr><th>種類</th>${sites.map((st) => `<th class="num">${esc(st.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  $('#sites').addEventListener('input', (e) => {
    const box = e.target.closest('[data-sid]'); if (!box) return;
    const sites = (state.settings.sites || []).map((x) => ({ ...x, prices: { ...(x.prices || {}) } }));
    const st = sites.find((x) => x.id === box.dataset.sid); if (!st) return;
    if (e.target.dataset.sf === 'name') st.name = e.target.value;
    if (e.target.dataset.sf === 'close') st.close = e.target.value;
    if (e.target.dataset.sf === 'alias') st.alias = e.target.value;
    if (e.target.dataset.sp) st.prices[e.target.dataset.sp] = e.target.value;
    if (e.target.dataset.su) st.units = { ...(st.units || {}), [e.target.dataset.su]: e.target.value };
    state.settings.sites = sites; save(); renderSiteCompare(); renderAll();
  });
  $('#sites').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sdel]'); if (!b) return;
    state.settings.sites = (state.settings.sites || []).filter((x) => x.id !== b.dataset.sdel); save(); renderSites(); renderAll();
  });
  $('#addSite').addEventListener('click', () => {
    state.settings.sites = [...(state.settings.sites || []), { id: uid(), name: '', prices: {} }]; save(); renderSites();
    $('#sites .site:last-child [data-sf=name]')?.focus();
  });
  renderSites();

  // 設定：よく借りる機械
  function renderLeaseCompanies() {
    const cs = state.settings.leaseCompanies || [];
    const opts = (v) => ['末'].concat(Array.from({ length: 28 }, (_, i) => String(i + 1))).map((x) => `<option value="${x}" ${String(v ?? '末') === x ? 'selected' : ''}>${closeLabel(x)}締め</option>`).join('');
    $('#leaseCompanies').innerHTML = cs.map((co) => `
      <div class="company" data-cid="${co.id}">
        <label class="pname">リース会社の名前<input data-cf="name" value="${esc(co.name)}" placeholder="〇〇リース"></label>
        <label>締め日<select data-cf="close">${opts(co.close)}</select></label>
        <button type="button" class="btn ghost small" data-cdel="${co.id}">削除</button>
      </div>`).join('') || '<p class="empty">登録されたリース会社はありません（すべて末日締めで計算します）。</p>';
  }
  function updateCompanies(fn) {
    state.settings.leaseCompanies = fn((state.settings.leaseCompanies || []).map((x) => ({ ...x }))); save(); renderAll();
  }
  $('#leaseCompanies').addEventListener('input', (e) => {
    const row = e.target.closest('[data-cid]'), f = e.target.dataset.cf; if (!row || !f) return;
    updateCompanies((cs) => { const co = cs.find((x) => x.id === row.dataset.cid); if (co) co[f] = e.target.value; return cs; });
  });
  $('#leaseCompanies').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cdel]'); if (!b) return;
    updateCompanies((cs) => cs.filter((x) => x.id !== b.dataset.cdel)); renderLeaseCompanies();
  });
  $('#addCompany').addEventListener('click', () => {
    updateCompanies((cs) => [...cs, { id: uid(), name: '', close: '20' }]); renderLeaseCompanies();
    $('#leaseCompanies .company:last-child [data-cf=name]')?.focus();
  });
  renderLeaseCompanies();

  function renderLeasePresets() {
    const ps = state.settings.leasePresets || [];
    $('#leasePresets').innerHTML = ps.map((p, i) => `
      <div class="preset" data-pi="${i}">
        <label class="pname">機械の名前<input data-pf="name" value="${esc(p.name)}"></label>
        <label>日額<input data-pf="daily" type="number" min="0" value="${esc(p.daily)}"></label>
        <label>月極<input data-pf="monthly" type="number" min="0" value="${esc(p.monthly)}"></label>
        <label>月極に切り替わる日数<input data-pf="th" type="number" min="1" value="${esc(p.th)}"></label>
        <label>回送費（往復）<input data-pf="transport" type="number" min="0" value="${esc(p.transport)}"></label>
        <button type="button" class="btn ghost small" data-pdel="${i}">削除</button>
      </div>`).join('') || '<p class="empty">登録された機械はありません</p>';
  }
  $('#leasePresets').addEventListener('input', (e) => {
    const row = e.target.closest('[data-pi]'), f = e.target.dataset.pf; if (!row || !f) return;
    const ps = (state.settings.leasePresets || []).map((p) => ({ ...p }));
    ps[+row.dataset.pi][f] = f === 'name' ? e.target.value : e.target.value === '' ? '' : num(e.target.value);
    state.settings.leasePresets = ps; save(); renderLeaseList(cur());
  });
  $('#leasePresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pdel]'); if (!b) return;
    state.settings.leasePresets = (state.settings.leasePresets || []).filter((_, i) => i !== +b.dataset.pdel); save(); renderLeasePresets(); renderLeaseList(cur());
  });
  $('#addPreset').addEventListener('click', () => {
    state.settings.leasePresets = [...(state.settings.leasePresets || []), { name: '', daily: '', monthly: '', th: 20, transport: '' }];
    save(); renderLeasePresets(); renderLeaseList(cur());
    $('#leasePresets .preset:last-child [data-pf=name]')?.focus();
  });
  renderLeasePresets();

  // 経費の追加・削除
  $('#expenseForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = num($('#expAmount').value); if (!(amount > 0)) { $('#expAmount').focus(); return; }
    expensesOf(cur()).push({ id: uid(), date: $('#expDate').value || todayIso(), cat: $('#expCat').value, amount, memo: $('#expMemo').value.trim() });
    const cat = $('#expCat').value; $('#expAmount').value = ''; $('#expMemo').value = ''; save(); renderAll(); closeExp(); toast(`経費を記録しました：${cat} ¥${yen(amount)}`);
  });
  const expDelArmed = {};
  $('#expenseList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-expdel]'); if (!b) return;
    const id = b.dataset.expdel;
    if (!expDelArmed[id]) { b.textContent = 'もう一度'; expDelArmed[id] = setTimeout(() => { b.textContent = '削除'; delete expDelArmed[id]; }, 3000); return; }
    clearTimeout(expDelArmed[id]); delete expDelArmed[id];
    const c = cur(); c.expenses = expensesOf(c).filter((x) => x.id !== id); save(); renderAll();
  });
  $('#expenseMonthly').addEventListener('change', (e) => { if (e.target.id === 'expMonth') { expMonth = e.target.value; renderExpenseMonthly(); } });
  // 設定：ゴミの種類と単価（いつも出す・単価・自分で足す種類）
  const LEGALS = ['がれき類', '木くず', '廃プラスチック類', 'ガラスくず・コンクリートくず及び陶磁器くず', '金属くず', '紙くず', '繊維くず', '混合廃棄物', 'その他（種類を確認）'];
  let typeAddOpen = false, typeAddUnit = 't', renameT = 0;
  function renderTypeEditor() {
    KJCore.setCustomTypes(state.settings.customTypes);
    const dp = state.settings.dispPrices || {}, on = new Set(state.settings.alwaysTypes || []);
    const used = new Set(state.cases.flatMap((c) => manifestsOf(c).map((m) => m.type)));
    const row = (w) => {
      const asb = w.id === 'asb' || w.id === 'asbsp';
      return `<li class="trow ${w.custom ? 'custom' : ''}">
        <div class="tr-top">
          ${asb ? '<span class="tr-auto" title="アスベストは事前調査の結果で自動で出ます">自動</span>' : `<label class="tr-on"><input type="checkbox" data-always="${w.id}" ${on.has(w.id) ? 'checked' : ''} aria-label="${esc(w.name)}をいつも出す"></label>`}
          ${w.custom ? `<input class="tr-name" data-cname="${w.id}" value="${esc(w.name)}" aria-label="名前">` : `<span class="tr-name">${esc(w.name)}</span>`}
          ${w.custom ? `<button type="button" class="tr-del" data-cdel="${w.id}" aria-label="${esc(w.name)}を消す" ${used.has(w.id) ? 'data-used="1"' : ''}>×</button>` : ''}
        </div>
        <div class="tr-bot">
          <span class="legal">${esc(w.legal)}</span>
          <label class="tr-price"><span>¥</span><input type="number" min="0" inputmode="decimal" data-disp="${w.id}" value="${esc(dp[w.id] ?? '')}" placeholder="単価"><span>/</span><select data-punit="${w.id}" aria-label="${esc(w.name)}の単価の単位">${['t', 'kg', '㎥'].map((u) => `<option value="${u}" ${stdUnitOf(w.id) === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        </div>
        ${w.custom ? `<label class="tr-alias">LINEでの呼び方<input data-calias="${w.id}" value="${esc(w.alias || '')}" placeholder="例 タイヤ、古タイヤ（なくてもOK）"></label>` : ''}
      </li>`;
    };
    const html = `
      <p class="hint">チェックした種類が、どの現場でも最初から出ます。単価は「円/t」「円/kg」「円/㎥（立米）」から選べます。処分場ごとに違うときは、設定の「処分場ごとの単価」で処分場ごとに単価と単位を入れられます（そちらが優先）。</p>
      <ul class="tlist">${WASTE_TYPES.filter((w) => !w.custom).map(row).join('')}</ul>
      <div class="sec-label">自分で足した種類</div>
      <ul class="tlist">${WASTE_TYPES.filter((w) => w.custom).map(row).join('') || '<li class="empty-row">まだありません。下の「＋ ゴミの種類を足す」から追加できます。</li>'}</ul>
      ${typeAddOpen ? `<div class="tadd card">
        <label>名前<input id="taName" placeholder="例 タイヤ、畳、家電" autocomplete="off"></label>
        <div class="field"><div class="flabel">数え方</div><div class="choice"><button type="button" class="cbtn ${typeAddUnit === 't' ? 'on' : ''}" data-tunit="t">トン（t）</button><button type="button" class="cbtn ${typeAddUnit === '㎥' ? 'on' : ''}" data-tunit="㎥">立米（㎥）</button></div></div>
        <label>単価（円/${typeAddUnit}）<input id="taPrice" type="number" min="0" inputmode="numeric" placeholder="例 20000"></label>
        <label>法律上の種類（報告書の集計用・分からなければそのまま）<select id="taLegal">${LEGALS.map((l) => `<option ${l.startsWith('その他') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label>LINEでの呼び方（なくてもOK）<input id="taAlias" placeholder="例 古タイヤ、タイヤ" autocomplete="off"></label>
        <div class="tadd-btns"><button type="button" class="btn go" data-tadd>この種類を足す</button><button type="button" class="btn ghost" data-tcancel>やめる</button></div>
      </div>` : '<button type="button" class="btn ghost wide" data-topen>＋ ゴミの種類を足す</button>'}`;
    $('#typeEditor').innerHTML = html;
  }
  const renderDispPrices = renderTypeEditor, renderAlwaysTypes = () => {};
  $('#typeEditor').addEventListener('input', (e) => {
    const t = e.target, S = state.settings;
    if (t.dataset.disp) { S.dispPrices = { ...S.dispPrices, [t.dataset.disp]: t.value }; save(); renderAllKeep(); return; }
    const cu = (id) => (S.customTypes || []).find((x) => x.id === id);
    if (t.dataset.cname) { const u = cu(t.dataset.cname); if (u) { u.name = t.value; save(); renderAllKeep(); clearTimeout(renameT); renameT = setTimeout(renderSites, 600); } return; }
    if (t.dataset.calias) { const u = cu(t.dataset.calias); if (u) { u.alias = t.value; save(); } }
  });
  // 入力中の欄を作り直さないように、ほかの画面だけ描き直す
  function renderAllKeep() { const box = $('#typeEditor'); box.dataset.keep = '1'; renderAll(); delete box.dataset.keep; }
  $('#typeEditor').addEventListener('change', (e) => {
    if (e.target.dataset.punit) {
      const S = state.settings; S.priceUnits = { ...(S.priceUnits || {}), [e.target.dataset.punit]: e.target.value }; save(); renderAll(); renderSites();
      toast(`${(WT[e.target.dataset.punit] || {}).name}：単価を「円/${e.target.value}」にしました。単価の数字も確認してください`); return;
    }
    const id = e.target.dataset.always; if (!id) return;
    const set = new Set(state.settings.alwaysTypes || []);
    if (e.target.checked) set.add(id); else set.delete(id);
    state.settings.alwaysTypes = WASTE_TYPES.map((w) => w.id).filter((x) => set.has(x)); save(); renderAll();
  });
  $('#typeEditor').addEventListener('click', (e) => {
    const S = state.settings; let b;
    if (e.target.closest('[data-topen]')) { typeAddOpen = true; typeAddUnit = 't'; renderTypeEditor(); setTimeout(() => $('#taName')?.focus(), 50); return; }
    if (e.target.closest('[data-tcancel]')) { typeAddOpen = false; renderTypeEditor(); return; }
    if ((b = e.target.closest('[data-tunit]'))) { const keep = { n: $('#taName').value, p: $('#taPrice').value, l: $('#taLegal').value, a: $('#taAlias').value }; typeAddUnit = b.dataset.tunit; renderTypeEditor(); $('#taName').value = keep.n; $('#taPrice').value = keep.p; $('#taLegal').value = keep.l; $('#taAlias').value = keep.a; return; }
    if (e.target.closest('[data-tadd]')) {
      const name = $('#taName').value.trim(); if (!name) { $('#taName').focus(); toast('名前を入れてください'); return; }
      if (WASTE_TYPES.some((w) => w.name === name)) { toast('同じ名前の種類があります'); return; }
      const id = 'u_' + uid();
      S.customTypes = [...(S.customTypes || []), { id, name, unit: typeAddUnit, legal: $('#taLegal').value, alias: $('#taAlias').value.trim() }];
      if ($('#taPrice').value !== '') S.dispPrices = { ...S.dispPrices, [id]: $('#taPrice').value };
      S.alwaysTypes = [...(S.alwaysTypes || []), id];
      typeAddOpen = false; save(); renderAll(); renderSites(); toast(`「${name}」を足しました（いつも出す種類に入れました）`); return;
    }
    if ((b = e.target.closest('[data-cdel]'))) {
      if (b.dataset.used) { toast('この種類の記録があるので消せません。チェックを外すと最初の一覧から消えます'); return; }
      const u = (S.customTypes || []).find((x) => x.id === b.dataset.cdel); if (!u || !confirm(`「${u.name}」を消しますか？`)) return;
      S.customTypes = S.customTypes.filter((x) => x.id !== u.id); S.alwaysTypes = (S.alwaysTypes || []).filter((x) => x !== u.id);
      const dp = { ...S.dispPrices }; delete dp[u.id]; S.dispPrices = dp; save(); renderAll(); renderSites();
    }
  });
  // 処分の画面からも開ける（同じものを下から出す）
  $('#typeOpen').addEventListener('click', () => { $('#typeSheetBody').appendChild($('#typeEditor')); renderTypeEditor(); $('#typeSheet').hidden = false; document.body.classList.add('sheet-open'); });
  $('#typeSheet').addEventListener('click', (e) => {
    if (e.target.id !== 'typeSheet' && !e.target.closest('[data-close]')) return;
    $('#typeHome').appendChild($('#typeEditor')); $('#typeSheet').hidden = true; document.body.classList.remove('sheet-open'); renderAll();
  });
  renderTypeEditor();
  $('#manifestAlerts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]'); if (!b) return;
    state.currentId = b.dataset.goto; save(); fillForm(caseForm, cur()); renderAll();
  });
  $('#siteInvoices').addEventListener('change', (e) => { if (e.target.id === 'billMonth') { billMonth = e.target.value; renderSiteInvoices(); } });
  $('#manifestReport').addEventListener('change', (e) => {
    if (e.target.id === 'reportFy') { reportFy = parseInt(e.target.value, 10); renderManifestReport(); }
  });
  let resetArmed = null;
  $('#resetAll').addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    if (!resetArmed) { btn.textContent = 'もう一度押すと全データを消します'; resetArmed = setTimeout(() => { btn.textContent = 'すべてのデータを消して最初の状態に戻す'; resetArmed = null; }, 4000); return; }
    clearTimeout(resetArmed); resetArmed = null; btn.textContent = 'すべてのデータを消して最初の状態に戻す';
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* noop */ }
    state = load(); save(); fillForm(caseForm, cur()); fillForm(settingsForm, state.settings); renderAlwaysTypes(); renderDispPrices(); renderLeasePresets(); renderLeaseCompanies(); renderSites(); renderAll();
    $('#tabs button[data-tab=input]').click();
  });
  $('#caseSelect').addEventListener('change', (e) => { state.currentId = e.target.value; save(); fillForm(caseForm, cur()); renderAll(); });
  $('#newCase').addEventListener('click', () => {
    const c = newCase(); state.cases.unshift(c); state.currentId = c.id; save(); fillForm(caseForm, c); renderAll();
    $('#tabs button[data-tab=input]').click();
  });
  $('#deleteCase').addEventListener('click', () => {
    if (!confirm('この現場を削除しますか？\n（30日間は、設定の「消した現場・バックアップ」から戻せます）')) return;
    const gone = state.cases.find((c) => c.id === state.currentId);
    if (gone) trashAdd(gone);
    state.cases = state.cases.filter((c) => c.id !== state.currentId);
    if (!state.cases.length) state.cases.push(newCase());
    state.currentId = state.cases[0].id; save(); fillForm(caseForm, cur()); renderAll();
  });
  $('#autoWaste').addEventListener('click', () => {
    const c = cur(), f = WASTE_FACTOR[c.structure], a = num(c.floorArea);
    c.wConcrete = +(a * f.c + num(c.concreteM2) * 0.15 + num(c.blockM) * 0.2).toFixed(1);
    c.wWood = +(a * f.w + num(c.trees) * 0.1).toFixed(1);
    c.wAsphalt = +(a * f.a).toFixed(1);
    c.wMixed = +(a * f.m).toFixed(1);
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

  // ---------- 消した現場（30日間戻せる）・バックアップ ----------
  const TRASH_KEY = 'kaitai-jimu-trash', KEEP_DAYS = 30;
  const trashRead = () => { try { return (JSON.parse(localStorage.getItem(TRASH_KEY)) || []).filter((x) => x && x.data && Date.now() - new Date(x.at).getTime() < KEEP_DAYS * 864e5); } catch (_) { return []; } };
  const trashWrite = (list) => { try { localStorage.setItem(TRASH_KEY, JSON.stringify(list)); } catch (_) { /* noop */ } };
  function trashAdd(c) { trashWrite([{ at: new Date().toISOString(), data: JSON.parse(JSON.stringify(c)) }].concat(trashRead().filter((x) => x.data.id !== c.id)).slice(0, 50)); }
  let serverTrash = [], backups = null; // ログインしているときは、会社の分も（cloud.js が入れる）
  function renderTrash() {
    const map = new Map();
    serverTrash.concat(trashRead()).forEach((x) => { if (!state.cases.some((c) => c.id === x.data.id)) map.set(x.data.id, x); });
    const list = [...map.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
    const left = (at) => Math.max(0, KEEP_DAYS - Math.floor((Date.now() - new Date(at).getTime()) / 864e5));
    $('#trashBox').innerHTML = `<div class="sec-label">消した現場（${KEEP_DAYS}日間は戻せます）</div>
      ${list.length ? `<ul class="tlist">${list.map((x) => `<li class="trow"><div class="tr-top"><span class="tr-name">${esc(caseName(x.data))}<small class="mut">　${esc(x.data.siteAddress || '')}</small></span>
        <button type="button" class="btn small" data-restore="${esc(x.data.id)}">戻す</button></div>
        <div class="tr-bot"><span class="legal">${md(isoOf(new Date(x.at)))}に削除・あと${left(x.at)}日で完全に消えます</span></div></li>`).join('')}</ul>` : '<p class="hint">消した現場はありません。</p>'}`;
    $('#backupBox').innerHTML = backups === null ? '<p class="hint">ログインして使うと、毎日3時に会社のデータが自動でバックアップされます（30日分）。</p>'
      : `<div class="sec-label">自動バックアップ（毎日3時・30日分）</div>
        ${backups.length ? `<ul class="tlist">${backups.map((b) => `<li class="trow"><div class="tr-top"><span class="tr-name">${esc(b.day.replace(/^\d+-0?(\d+)-0?(\d+)$/, '$1月$2日'))}の3時<small class="mut">　現場 ${b.n}件</small></span>
          <button type="button" class="btn ghost small" data-bkdl="${b.day}">書き出す</button><button type="button" class="btn ghost small danger-t" data-bkrestore="${b.day}">この日に戻す</button></div></li>`).join('')}</ul>` : '<p class="hint">まだバックアップはありません（今夜3時に最初のバックアップを取ります）。</p>'}`;
    return list;
  }
  $('#trashFs').addEventListener('click', async (e) => {
    const r = e.target.closest('[data-restore]');
    if (r) {
      const x = [...serverTrash, ...trashRead()].find((y) => y.data.id === r.dataset.restore); if (!x) return;
      if (state.cases.some((c) => c.id === x.data.id)) return;
      state.cases.unshift(JSON.parse(JSON.stringify(x.data))); trashWrite(trashRead().filter((y) => y.data.id !== x.data.id));
      serverTrash = serverTrash.filter((y) => y.data.id !== x.data.id);
      save(); renderAll(); toast(`「${caseName(x.data)}」を戻しました`); return;
    }
    const dl = e.target.closest('[data-bkdl]'), rs = e.target.closest('[data-bkrestore]');
    if ((dl || rs) && window.KJCloud && KJCloud.backup) {
      const day = (dl || rs).dataset.bkdl || (dl || rs).dataset.bkrestore;
      const d = await KJCloud.backup(day); if (!d) { toast('バックアップを読めませんでした'); return; }
      if (dl) {
        const blob = new Blob([JSON.stringify({ settings: d.settings, cases: d.cases }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `kaitai-jimu-backup-${day}.json`; a.click(); return;
      }
      if (!confirm(`${day.replace(/^\d+-0?(\d+)-0?(\d+)$/, '$1月$2日')}の3時の状態に戻しますか？\n会社のみんなのデータが、その時の内容に戻ります（今の状態は、念のため先にファイルで書き出します）。`)) return;
      $('#exportBtn').click();
      state = { settings: normalizeSettings({ ...DEFAULT_SETTINGS, ...(d.settings || {}) }), cases: d.cases && d.cases.length ? d.cases : [newCase()], currentId: (d.cases[0] || {}).id };
      save(); fillForm(caseForm, cur()); fillForm(settingsForm, state.settings); renderAll(); toast('バックアップの状態に戻しました');
    }
  });
  window.KJTrash = { setServer: (items, bk) => { serverTrash = items || []; backups = bk === undefined ? backups : bk; renderTrash(); }, render: renderTrash };

  fillForm(caseForm, cur()); fillForm(settingsForm, state.settings); renderAll(); renderTrash();

  (function startNav() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('kaitai-jimu-nav')); } catch (_) { /* noop */ }
    if (saved && saved.lastTab) Object.assign(lastTab, saved.lastTab);
    setSection(saved && SECTIONS[saved.sec] ? saved.sec : 'home');
    foldSettings(); labelTables(document);
    // オープニング動画の設定（この端末だけ）
    if (window.KJIntro && $('#introOn')) {
      $('#introOn').checked = !KJIntro.isOff();
      $('#introOn').addEventListener('change', (e) => { KJIntro.setOff(!e.target.checked); toast(e.target.checked ? '次に開いたときから流れます（1日1回）' : 'オープニング動画を止めました'); });
      $('#introPlay').addEventListener('click', () => KJIntro.play());
    }
    window.KJNav = { go: (t) => (t === 'input' ? (openCase(cur().id, 'summary'), editInfo('client')) : go(t)), openCase, setSection, editInfo }; // テスト・他の部品から画面を開くため
  })();

  // クラウド同期（cloud.js）から使う窓口
  window.KJApp = {
    getState: () => state,
    replaceState(next) {
      next.settings = normalizeSettings(next.settings);
      if (!Array.isArray(next.cases) || !next.cases.length) next.cases = [newCase()];
      next.cases.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      if (!next.cases.some((c) => c.id === next.currentId)) next.currentId = next.cases[0].id;
      state = next;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* noop */ }
      fillForm(caseForm, cur()); fillForm(settingsForm, state.settings);
      renderAlwaysTypes(); renderDispPrices(); renderLeasePresets(); renderLeaseCompanies(); renderSites(); renderAll();
    },
  };

  // 日付が変わったら描き直す（開いたままでも、借りている途中のリースや期限が今日の日付で計算される）
  let shownDay = todayIso();
  function refreshIfNewDay() {
    if (todayIso() === shownDay) return;
    shownDay = todayIso();
    renderAll();
  }
  setInterval(refreshIfNewDay, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfNewDay(); });
  window.addEventListener('focus', refreshIfNewDay);
  $('#tabs').addEventListener('click', refreshIfNewDay);
})();
