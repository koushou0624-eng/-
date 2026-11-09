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
    dispPrices: { wood: 12000, concrete: 3000, concreteR: 4500, mixed: 25000, plastic: 35000, glass: 10000, gypsum: 20000, asphalt: 3000, metal: 5000, asb: 30000, asbsp: 80000 },
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
    alwaysTypes: ['wood', 'concrete', 'concreteR', 'mixed', 'plastic', 'glass', 'gypsum'], wasteVer: 2,
  };
  // マニフェストの廃棄物の種類（sp: 特別管理産業廃棄物 → B2・D票の期限が60日）
  // name: 現場での呼び方、legal: 法律上の産業廃棄物の種類（報告書の集計に使う）
  const WASTE_TYPES = [
    { id: 'wood', name: '木（シバ）', legal: '木くず', unit: 't' },
    { id: 'concrete', name: 'コンクリートガラ（無筋）', legal: 'がれき類', unit: 't' },
    { id: 'concreteR', name: 'コンクリートガラ（有筋）', legal: 'がれき類', unit: 't' },
    { id: 'mixed', name: 'ミンチ', legal: '混合廃棄物', unit: 't' },
    { id: 'plastic', name: '廃プラ', legal: '廃プラスチック類', unit: 't' },
    { id: 'glass', name: '瓦', legal: 'ガラスくず・コンクリートくず及び陶磁器くず', unit: 't' },
    { id: 'gypsum', name: '石膏ボード', legal: 'ガラスくず・コンクリートくず及び陶磁器くず（廃石膏ボード）', unit: 't' },
    { id: 'asphalt', name: 'アスファルトガラ', legal: 'がれき類', unit: 't' },
    { id: 'metal', name: '金属くず（売れない鉄くずなど）', legal: '金属くず', unit: 't' },
    { id: 'asb', name: 'アスベスト（レベル3の成形板など）', legal: '石綿含有産業廃棄物', unit: '㎥' },
    { id: 'asbsp', name: 'アスベスト（レベル1・2の吹付けなど）', legal: '廃石綿等（特別管理産業廃棄物）', unit: '㎥', sp: true },
  ];
  const WT = Object.fromEntries(WASTE_TYPES.map((w) => [w.id, w]));
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
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if ((d.settings?.wasteVer || 1) < 2) { d.settings = { ...d.settings, alwaysTypes: DEFAULT_SETTINGS.alwaysTypes, wasteVer: 2 }; }
        const old = d.settings || {};
        d.settings = { ...DEFAULT_SETTINGS, ...old };
        // 処分単価：古いデータの「コンクリート塊・木くず・混合廃棄物」の単価を引き継ぐ
        const legacy = {};
        if (old.cDispConcrete != null) legacy.concrete = old.cDispConcrete;
        if (old.cDispWood != null) legacy.wood = old.cDispWood;
        if (old.cDispMixed != null) legacy.mixed = old.cDispMixed;
        d.settings.dispPrices = { ...DEFAULT_SETTINGS.dispPrices, ...(old.dispPrices ? {} : legacy), ...(old.dispPrices || {}) };
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
    const by = parseInt(String(c.builtYear).replace(/[^0-9]/g, ''), 10);
    if (by) {
      if (by <= 2006) items.unshift(`<div class="deadline need"><div class="when">アスベスト判定｜${by}年築：含有の可能性あり</div><div class="sub">2006年9月以前に着工した建物は、石綿含有建材が使われている可能性があります。有資格者による書面調査・目視調査、必要に応じて分析調査を行ってください。${by === 2006 ? '（2006年築は着工日が9月1日より前か後かを確認）' : ''}</div></div>`);
      else items.unshift(`<div class="deadline ok"><div class="when">アスベスト判定｜${by}年築：含有の可能性は低い</div><div class="sub">着工日が2006年9月1日以降であることを設計図書等で確認できれば、書面調査で「含有なし」と判断できます。事前調査と結果報告（80㎡以上）自体は必要です。</div></div>`);
    }
    item(true, '近隣挨拶', addDays(c.startDate, -7), '着工1週間〜10日前が目安。→「⑤ 近隣挨拶文」タブ');
    item(!!c.narrowRoad, '道路使用許可（所轄警察署）', addDays(c.startDate, -7), '道路上に車両を止めて作業する場合に必要。処理に数日かかるため早めに申請。');
    item(true, '建物取毀証明書の発行 → 施主の滅失登記', addMonths(c.endDate, 1), '解体完了後、施主が1か月以内に法務局へ建物滅失登記。→「⑥ 取毀証明書」タブ');
    const ms = manifestsOf(c), open = ms.filter((m) => m.kind === 'paper' && !(m.b2 && m.d && m.e)).length;
    item(true, 'マニフェスト（産業廃棄物管理票）の交付・回収', null, `搬出ごとに交付。紙の場合はB2・D票90日、E票180日以内の返送を確認。登録 ${ms.length}枚${open ? `（返送待ち ${open}枚）` : ''} →「🚛 マニフェスト」タブ`);
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
    $('#profitOut').innerHTML = num(c.floorArea) <= 0 ? '<p class="hint">「① 案件入力」で延床面積を入れると、この現場の利益を計算します。</p>' : `
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
      <p class="hint">原価の単価は「⚙ 会社・単価設定」の「原価」で自社の値に変えられます。数字は目安です。</p>
      ${actualHtml(c, r)}`;
  }

  // 実績（マニフェストの処分代・経費）で見た利益
  function actualHtml(c, r) {
    const disp = dispSummary(c), exp = expenseSummary(c), ls = leaseSummary(c);
    if (!disp.total && !exp.total && !ls.total) {
      return '<h2>実際の利益（実績）</h2><p class="hint">「🚛 マニフェスト」に数量、「⛽ 経費」に消耗品・高速代・燃料費、「🚜 リース」に借りた機械を入れると、見込みと実際の利益を比べられます。</p>';
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

  // 電子マニフェストの登録期限：引渡しから3日以内（土日を除いた目安）
  function plus3BizDays(iso) {
    const d = new Date(iso + 'T00:00:00'); let n = 0;
    while (n < 3) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) n++; }
    return d;
  }

  // 返送・報告の期限と状態
  function manifestChecks(m) {
    if (!m.date) return [];
    const sp = WT[m.type]?.sp, out = [];
    const st = (label, doneIso, due) => {
      if (doneIso) return { label, state: 'done', text: `${label} 済` };
      const diff = Math.round((due - today()) / 86400000);
      if (diff < 0) return { label, state: 'late', due, text: `${label} ${-diff}日超過`, report: addDays(isoOf(due), 30) };
      return { label, state: diff <= 14 ? 'soon' : 'wait', due, text: `${label} あと${diff}日` };
    };
    if (m.kind === 'electronic') {
      out.push(st('JWNET登録', m.reg, plus3BizDays(m.date)));
      out.push(st('運搬終了報告', m.b2, addDays(m.date, sp ? 60 : 90)));
      out.push(st('処分終了報告', m.d, addDays(m.date, sp ? 60 : 90)));
      out.push(st('最終処分報告', m.e, addDays(m.date, 180)));
    } else {
      out.push(st('B2票', m.b2, addDays(m.date, sp ? 60 : 90)));
      out.push(st('D票', m.d, addDays(m.date, sp ? 60 : 90)));
      out.push(st('E票', m.e, addDays(m.date, 180)));
    }
    return out;
  }

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
  function defaultPriceOf(m) {
    const site = siteByName(m.disposer), sp = sitePrice(site, m.type);
    return sp != null ? { price: sp, label: `${site.name}の単価` } : { price: dispPrice(m.type), label: '標準' };
  }
  const unitPriceOf = (m) => (m.price !== '' && m.price != null ? num(m.price) : defaultPriceOf(m).price);
  // その種類で一番安い処分場
  function cheapestSite(type) {
    let best = null;
    (state.settings.sites || []).forEach((st) => { const p = sitePrice(st, type); if (p != null && st.name && (!best || p < best.price)) best = { name: st.name, price: p }; });
    return best;
  }
  const dispOf = (m) => num(m.qty) * unitPriceOf(m);
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
  const mcostHtml = (m) => {
    if (!(num(m.qty) > 0)) return '';
    const b = billOf(m);
    return `処分代 <b>¥${yen(dispOf(m))}</b>${b.ym ? `<span class="billtag">${b.label}の請求（${closeLabel(b.close)}締め）</span>` : ''}`;
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
      const u = WT[x.m.type]?.unit || 't'; g.qty[u] = (g.qty[u] || 0) + num(x.m.qty);
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
      <p class="hint">処分場から届いた請求書と、枚数・金額を照らし合わせてください。締め日は「⚙ 会社・単価設定」の「処分場ごとの単価」で処分場ごとに変えられます。</p>`;
  }
  function gsumHtml(c, type) {
    const w = WT[type], list = manifestsOf(c).filter((m) => m.type === type);
    const total = list.reduce((a, m) => a + num(m.qty), 0), cost = list.reduce((a, m) => a + dispOf(m), 0), est = estimateFor(c, type);
    const open = list.filter((m) => manifestChecks(m).some((x) => x.state === 'late')).length;
    const best = cheapestSite(type);
    return `${list.length}枚・合計 <b>${total ? total.toFixed(2) : '0'}${w.unit}</b>・処分代 <b>¥${yen(cost)}</b>${est ? `（${estLabel(type)} ${est.toFixed(1)}t）` : ''}${best ? `<br><span class="best">一番安い処分場：${esc(best.name)} ¥${yen(best.price)}/${w.unit}</span>` : ''}${open ? `　<span class="chip late">期限超過 ${open}枚</span>` : ''}`;
  }
  function dispSummary(c) {
    const ms = manifestsOf(c).filter((m) => num(m.qty) > 0), by = {};
    ms.forEach((m) => { const g = by[m.type] || (by[m.type] = { n: 0, qty: 0, cost: 0 }); g.n++; g.qty += num(m.qty); g.cost += dispOf(m); });
    return { by, total: Math.round(ms.reduce((a, m) => a + dispOf(m), 0)), count: ms.length };
  }
  function renderManifestCost(c) {
    const d = dispSummary(c);
    const rows = WASTE_TYPES.filter((w) => d.by[w.id]).map((w) => {
      const g = d.by[w.id];
      return `<tr><td>${esc(w.name)}</td><td class="num">${g.n}</td><td class="num">${g.qty.toFixed(2)} ${w.unit}</td><td class="num">¥${yen(g.qty ? g.cost / g.qty : 0)}</td><td class="num">¥${yen(g.cost)}</td></tr>`;
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
          <label>数量（${WT[m.type]?.unit || 't'}）<input data-f="qty" type="number" min="0" step="0.01" value="${esc(m.qty)}" placeholder="${esc(m.hint || '')}"></label>
          <label>処分単価（円/${WT[m.type]?.unit || 't'}）<input data-f="price" type="number" min="0" value="${esc(m.price ?? '')}" placeholder="${esc(defaultPriceOf(m).label)} ${yen(defaultPriceOf(m).price)}"></label>
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
    const ms = manifestsOf(c), shown = typesShown(c), always = new Set(state.settings.alwaysTypes || []);
    $('#manifestList').innerHTML = shown.map((type) => {
      const w = WT[type], list = ms.filter((m) => m.type === type);
      const total = list.reduce((a, m) => a + num(m.qty), 0), est = estimateFor(c, type);
      const open = list.filter((m) => manifestChecks(m).some((x) => x.state === 'late')).length;
      const tag = always.has(type) ? '' : type === 'asb' || type === 'asbsp' ? '<span class="tag2">アスベスト調査結果より</span>' : '<span class="tag2">追加したゴミ</span>';
      return `
      <section class="mgroup" data-type="${type}">
        <div class="ghead">
          <div class="gname">${esc(w.name)} <span class="legal">${esc(w.legal)}</span>${w.sp ? ' <span class="chip late">特別管理・期限60日</span>' : ''} ${tag}</div>
          <div class="gsum" id="gsum-${type}">${gsumHtml(c, type)}</div>
          <button class="btn small" data-addtype="${type}">＋ 1枚追加</button>
        </div>
        ${list.length ? list.map(manifestCard).join('') : '<p class="empty small-pad">まだ0枚です。搬出したら「＋ 1枚追加」で登録します。</p>'}
        ${!always.has(type) && !list.length && type !== 'asb' && type !== 'asbsp' ? `<button class="link" data-rmtype="${type}">この種類を消す</button>` : ''}
      </section>`;
    }).join('');
    const rare = WASTE_TYPES.filter((w) => !shown.includes(w.id));
    $('#rareType').innerHTML = rare.length ? rare.map((w) => `<option value="${w.id}">${esc(w.name)}（${esc(w.legal)}）</option>`).join('') : '<option value="">（すべて表示済み）</option>';
    $('#addRare').disabled = !rare.length;
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
    const act = (ids) => ms.filter((m) => ids.includes(m.type) && (WT[m.type]?.unit === 't')).reduce((a, m) => a + num(m.qty), 0);
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
      const g = groups[key] || (groups[key] = { n: 0, qty: 0, unit: WT[m.type]?.unit || 't' });
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

  function renderManifest(c) { renderManifestAlerts(); renderManifestList(c); renderManifestCost(c); renderSiteInvoices(); renderManifestCompare(c); renderManifestReport(); }
  function refreshManifestSummary(c) { renderManifestAlerts(); renderManifestCost(c); renderSiteInvoices(); renderManifestCompare(c); renderManifestReport(); renderSchedule(c); renderProfit(c, state.settings); renderExpense(c); }

  // ---------- リース ----------
  const leasesOf = (c) => (Array.isArray(c.leases) ? c.leases : (c.leases = []));
  const LEASE_MODES = {
    calendar: 'リース会社の締め日ごと（登録のない会社は末日締め）',
    anniv: '借りた日から1か月ごと',
    days30: '借りた日から30日ごと',
  };
  const lastOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
  // 借りた日から nか月後（月末を超える日は月末にそろえる）
  function addMonthsClamp(d, n) {
    const y = d.getFullYear(), m = d.getMonth() + n;
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(d.getDate(), last));
  }
  // リース会社の締め日（登録がなければ末日）
  const companyOf = (name) => (state.settings.leaseCompanies || []).find((x) => x.name && x.name.trim() === String(name || '').trim());
  const closeOf = (l) => { const co = companyOf(l.company); return co && co.close !== '' && co.close != null ? co.close : '末'; };
  const closeLabel = (c) => (c === '末' || c === 'end' ? '末日' : `${c}日`);
  // その月の締め日（31日締め → 30日の月は30日、末日締め → 月末）
  const closeDate = (y, m, c) => { const last = new Date(y, m + 1, 0).getDate(); return new Date(y, m, c === '末' ? last : Math.min(num(c) || last, last)); };
  // 月極の区切り（1区切り＝1回の請求）の終わりの日
  function segEnd(segStart, l0, k, mode, close = '末') {
    if (mode === 'calendar') {
      const thisClose = closeDate(segStart.getFullYear(), segStart.getMonth(), close);
      return segStart <= thisClose ? thisClose : closeDate(segStart.getFullYear(), segStart.getMonth() + 1, close);
    }
    if (mode === 'anniv') { const e = addMonthsClamp(l0, k + 1); e.setDate(e.getDate() - 1); return e; }
    const e = new Date(l0); e.setDate(e.getDate() + (k + 1) * 30 - 1); return e;
  }
  const DAY = 86400000;
  const dayCount = (a, b) => Math.round((b - a) / DAY) + 1;
  const mLabel = (end, k, mode) => (mode === 'calendar' ? `${end.getMonth() + 1}月` : `${k + 1}か月目`);

  // 区切りごとに「使った日数が決めた日数を超えたら月極、超えなければ日割り」で計算
  function leaseCalc(l, endOverride) {
    const daily = num(l.daily), monthly = num(l.monthly), th = Math.max(1, num(l.th) || 1);
    const mode = LEASE_MODES[state.settings.leaseMode] ? state.settings.leaseMode : 'calendar';
    const close = closeOf(l);
    const extra = num(l.transport) + num(l.other);
    if (!l.start) return { days: 0, cost: extra, rent: 0, parts: [], state: 'none' };
    const s0 = new Date(l.start + 'T00:00:00'), e0 = new Date((endOverride || l.end || todayIso()) + 'T00:00:00');
    const days = dayCount(s0, e0);
    if (days <= 0) return { days: 0, cost: extra, rent: 0, parts: [], state: 'bad' };
    const segs = [];
    let cur = new Date(s0), k = 0;
    while (cur <= e0 && k < 240) {
      const natEnd = segEnd(cur, s0, k, mode, close);
      const to = natEnd < e0 ? natEnd : e0;
      const d = dayCount(cur, to);
      const len = dayCount(cur, natEnd); // その区切りで借りられる最大の日数
      segs.push({ from: new Date(cur), to, natEnd, d, len, monthly: d > th, label: mLabel(natEnd, k, mode), amount: d > th ? monthly : d * daily, ym: isoOf(natEnd).slice(0, 7) });
      cur = new Date(natEnd); cur.setDate(cur.getDate() + 1); k++;
    }
    const rent = segs.reduce((a, g) => a + (g.monthly ? monthly : g.d * daily), 0);
    const parts = segs.map((g) => (g.monthly ? `${g.label} ${g.d}日（${th}日超え → 月極）¥${yen(monthly)}` : `${g.label} 日割り ${g.d}日 × ¥${yen(daily)}`));
    const last = segs[segs.length - 1];
    const nMonthly = segs.filter((g) => g.monthly).length;
    const res = { days, rent, cost: rent + extra, parts, segs, full: nMonthly, rem: last.d, th, ongoing: !l.end && !endOverride, state: 'ok', mode, close,
      summary: nMonthly === segs.length ? '月極' : nMonthly ? `月極${nMonthly}・日割り${segs.length - nMonthly}` : '日割り' };
    if (!last.monthly) {
      if (last.len > th) {
        // この区切りの中で月極に切り替わる
        res.toSwitch = th - last.d + 1;
        res.lastDaily = new Date(last.from); res.lastDaily.setDate(res.lastDaily.getDate() + th - 1); // 日割りで済む最後の日
        if (res.ongoing && res.toSwitch <= 3) res.state = 'soon';
        if (monthly > 0 && last.d * daily > monthly) {
          res.tip = `今回の締め（${last.label}分）までの日割り（¥${yen(last.d * daily)}）は月極（¥${yen(monthly)}）より高くなっています。あと${res.toSwitch}日借りると月極に切り替わり、¥${yen(last.d * daily - monthly)}安くなります。`;
        }
      } else {
        res.shortSeg = last; // 締め日までの日数が足りず、この請求は月極にならない
      }
    } else {
      res.paidUntil = last.natEnd; // 月極で追加料金なしの最終日
      if (res.ongoing) res.state = 'monthly';
    }
    if (res.ongoing && segs.length > 1 && last.d <= 3) res.newMonth = { prev: segs[segs.length - 2], cur: last };
    return res;
  }
  // 月ごとの請求額（回送費・その他は借りた月に計上）
  function leaseByMonth(l) {
    const r = leaseCalc(l); const out = {};
    (r.segs || []).forEach((g, i) => { out[g.ym] = (out[g.ym] || 0) + g.amount + (i === 0 ? num(l.transport) + num(l.other) : 0); });
    return out;
  }
  function leaseSummary(c) {
    const ls = leasesOf(c);
    return { total: Math.round(ls.reduce((a, l) => a + leaseCalc(l).cost, 0)), count: ls.length };
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
      <tfoot><tr><th colspan="3">この現場の合計（${r.ongoing ? '今日まで' : '返却まで'}）</th><td class="num"><b>¥${yen(r.cost)}</b></td><td></td></tr></tfoot></table></div>`;
  }
  // 現場の完了予定日まで借り続けた場合の見込み
  function leaseForecastHtml(l, r, c) {
    if (!r.ongoing || !c.endDate || c.endDate <= todayIso()) return '';
    const f = leaseCalc(l, c.endDate);
    const future = f.segs.filter((g) => g.to > today());
    const lastSeg = f.segs[f.segs.length - 1];
    let advice = '';
    if (!lastSeg.monthly && lastSeg.len > num(l.th)) advice = `最後の${lastSeg.label}は${lastSeg.d}日なので日割り（${num(l.th)}日以内に返せば日割りのまま）。`;
    else if (lastSeg.monthly) advice = `最後の${lastSeg.label}は${lastSeg.d}日使うので月極になります。`;
    return `<div class="forecast">🔮 <b>完了予定日（${fmtIso(c.endDate)}）まで借りた場合：合計 ¥${yen(f.cost)}</b>（今日から あと¥${yen(f.cost - r.cost)}）
      <div class="sub">${future.map((g) => `${g.label}：${g.d}日 ${g.monthly ? '月極' : '日割り'} ¥${yen(g.amount)}`).join('　')}</div>
      ${advice ? `<div class="sub">${advice}</div>` : ''}</div>`;
  }
  function renderLeaseList(c) {
    const ls = leasesOf(c);
    $('#leaseList').innerHTML = ls.length ? ls.map((l) => `
      <div class="mcard" data-lid="${l.id}">
        <div class="mhead"><b>${esc(l.name || '（名前なし）')}</b><span class="flex1"></span><button class="btn ghost small" data-ldel="${l.id}">削除</button></div>
        <div class="lcalc" id="lcalc-${l.id}">${leaseCalcHtml(l, c)}</div>
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
      </div>`).join('') : '<p class="empty">この案件で借りた機械はまだありません。上の「借りた機械を追加」から選んでください。</p>';
    $('#companyList').innerHTML = (state.settings.leaseCompanies || []).filter((x) => x.name).map((x) => `<option value="${esc(x.name)}">${closeLabel(x.close)}締め</option>`).join('');
    const ps = state.settings.leasePresets || [];
    $('#leasePreset').innerHTML = ps.map((p, i) => `<option value="${i}">${esc(p.name)}（日額¥${yen(p.daily)}／月極¥${yen(p.monthly)}／${num(p.th) + 1}日目から月極）</option>`).join('') + '<option value="custom">その他（自分で入力）</option>';
  }
  function renderLeaseTotal(c) {
    const ls = leasesOf(c);
    const rows = ls.map((l) => { const r = leaseCalc(l); return `<tr><td>${esc(l.name)}</td><td class="num">${r.days}日</td><td>${r.days ? r.summary : '—'}</td><td class="num">¥${yen(r.cost)}</td></tr>`; }).join('');
    const total = leaseSummary(c).total;
    $('#leaseTotal').innerHTML = ls.length ? `
      <h2>リース代の合計</h2>
      <div class="table-wrap"><table class="cost wide"><thead><tr><th>機械</th><th class="num">使用日数</th><th>計算</th><th class="num">リース代（回送費込み）</th></tr></thead><tbody>${rows}</tbody>
        <tfoot><tr><th colspan="3">合計</th><td class="num"><b>¥${yen(total)}</b></td></tr></tfoot></table></div>
      <p class="hint">月極の区切り：${LEASE_MODES[state.settings.leaseMode] || LEASE_MODES.calendar}（「⚙ 会社・単価設定」で変更できます）。締めごとに、使った日数が決めた日数を超えたら月極、超えなければ日割りで計算します。</p>` : '';
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
      <div class="kpis compact">${EXPENSE_CATS.map((k) => `<div class="kpi"><div class="k">${k}</div><div class="v">¥${yen(sum.byCat[k] || 0)}</div></div>`).join('')}
        <div class="kpi"><div class="k">経費 合計</div><div class="v">¥${yen(sum.total)}</div></div></div>
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
        lease: leasesOf(c).reduce((a, l) => a + (leaseByMonth(l)[mon] || 0), 0) };
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

  function renderAll() {
    const c = cur(), s = state.settings;
    renderCaseSelect(); renderSchedule(c); renderEstimate(c, s); renderProfit(c, s); renderProcess(c, s); renderManifest(c); renderExpense(c); renderLease(c); renderRecycle(c, s); renderGreeting(c, s); renderCertificate(c, s);
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

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-end]'); if (!b) return;
    cur().endDate = b.dataset.setEnd; save(); fillForm(caseForm, cur()); renderAll();
  });
  // マニフェストの入力（入力中のカードは描き直さず、期限表示と集計だけ更新）
  $('#manifestList').addEventListener('input', (e) => {
    const el = e.target, card = el.closest('[data-mid]'); if (!card || !el.dataset.f) return;
    const m = manifestsOf(cur()).find((x) => x.id === card.dataset.mid); if (!m) return;
    m[el.dataset.f] = el.value; save();
    if (el.dataset.f === 'kind' || el.dataset.f === 'type') { renderManifestList(cur()); }
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
    const c = cur(); c.extraTypes = [...new Set([...(c.extraTypes || []), type])]; save(); renderAll();
    document.querySelector(`.mgroup[data-type="${type}"]`)?.scrollIntoView({ block: 'center' });
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
          <label>締め日<select data-sf="close">${['末'].concat(Array.from({ length: 28 }, (_, i) => String(i + 1))).map((x) => `<option value="${x}" ${String(st.close ?? '末') === x ? 'selected' : ''}>${closeLabel(x)}締め</option>`).join('')}</select></label>
          <button type="button" class="btn ghost small" data-sdel="${st.id}">削除</button></div>
        <div class="disp-grid">${WASTE_TYPES.map((w) => `<label>${esc(w.name)}（円/${w.unit}）<input type="number" min="0" data-sp="${w.id}" value="${esc(st.prices?.[w.id] ?? '')}" placeholder="受け入れなし／標準 ${yen(dispPrice(w.id))}"></label>`).join('')}</div>
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
    if (e.target.dataset.sp) st.prices[e.target.dataset.sp] = e.target.value;
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
    $('#expAmount').value = ''; $('#expMemo').value = ''; save(); renderAll(); $('#expAmount').focus();
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
  // 設定：処分単価
  function renderDispPrices() {
    const dp = state.settings.dispPrices || {};
    $('#dispPrices').innerHTML = WASTE_TYPES.map((w) => `<label>${esc(w.name)}（円/${w.unit}）<input type="number" min="0" data-disp="${w.id}" value="${esc(dp[w.id] ?? '')}"></label>`).join('');
  }
  $('#dispPrices').addEventListener('input', (e) => {
    const id = e.target.dataset.disp; if (!id) return;
    state.settings.dispPrices = { ...state.settings.dispPrices, [id]: e.target.value }; save(); renderAll();
  });
  renderDispPrices();
  // 設定：いつも出るゴミ
  function renderAlwaysTypes() {
    const on = new Set(state.settings.alwaysTypes || []);
    $('#alwaysTypes').innerHTML = WASTE_TYPES.filter((w) => w.id !== 'asb' && w.id !== 'asbsp')
      .map((w) => `<label class="check"><input type="checkbox" data-always="${w.id}" ${on.has(w.id) ? 'checked' : ''}> ${esc(w.name)} <span class="legal">${esc(w.legal)}</span></label>`).join('');
  }
  $('#alwaysTypes').addEventListener('change', (e) => {
    const id = e.target.dataset.always; if (!id) return;
    const set = new Set(state.settings.alwaysTypes || []);
    if (e.target.checked) set.add(id); else set.delete(id);
    state.settings.alwaysTypes = WASTE_TYPES.map((w) => w.id).filter((x) => set.has(x)); save(); renderAll();
  });
  renderAlwaysTypes();
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

  fillForm(caseForm, cur()); fillForm(settingsForm, state.settings); renderAll();

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
