// カイタイ事務：画面と毎朝の通知（LINE）で共通に使う計算
// ブラウザでは window.KJCore、Node/Deno では module.exports / globalThis.KJCore として使う
(function (root) {
  'use strict';
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const yen = (n) => Math.round(n).toLocaleString('ja-JP');
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (iso, n) => { if (!iso) return null; const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d; };
  const fmtDate = (d) => (d ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : '');
  const md = (d) => (d ? `${d.getMonth() + 1}/${d.getDate()}` : '');
  // 「今日」（0時0分）。日本時間で動かすため、Node/Deno 側では TZ=Asia/Tokyo で実行する
  const todayOf = (date) => { const d = date ? new Date(date) : new Date(); d.setHours(0, 0, 0, 0); return d; };

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

  // 電子マニフェストの登録期限：引渡しから3日以内（土日を除いた目安）
  function plus3BizDays(iso) {
    const d = new Date(iso + 'T00:00:00'); let n = 0;
    while (n < 3) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) n++; }
    return d;
  }

  // 返送・報告の期限と状態
  function manifestChecks(m, now) {
    if (!m.date) return [];
    const sp = WT[m.type]?.sp, out = [];
    const st = (label, doneIso, due) => {
      if (doneIso) return { label, state: 'done', text: `${label} 済` };
      const diff = Math.round((due - now) / 86400000);
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
  const companyOf = (settings, name) => ((settings && settings.leaseCompanies) || []).find((x) => x.name && x.name.trim() === String(name || '').trim());
  const closeOf = (settings, l) => { const co = companyOf(settings, l.company); return co && co.close !== '' && co.close != null ? co.close : '末'; };
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
  function leaseCalc(l, settings, endOverride, now) {
    const daily = num(l.daily), monthly = num(l.monthly), th = Math.max(1, num(l.th) || 1);
    const mode = LEASE_MODES[settings && settings.leaseMode] ? settings.leaseMode : 'calendar';
    const close = closeOf(settings, l);
    const extra = num(l.transport) + num(l.other);
    if (!l.start) return { days: 0, cost: extra, rent: 0, parts: [], state: 'none' };
    const s0 = new Date(l.start + 'T00:00:00'), e0 = new Date((endOverride || l.end || isoOf(now)) + 'T00:00:00');
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
  const caseName = (c) => `${c.clientName || '（施主未入力）'}様邸`;

  // ---------- LINE で送られた「捨てた記録」を読み取る ----------
  // 例：「ヒラヤマ 住吉区 シバ 3t」「住吉 ミンチ 2.4トン 平山」「11/8 山田邸 有筋 4t」
  // ひらがな→カタカナ、全角→半角にそろえてから照合する
  const kana = (str) => String(str || '').normalize('NFKC').replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)).toLowerCase();
  // 住所などの照合用：空白・記号と「都道府県市区町村」を除く
  const squash = (str) => kana(str).replace(/[\s、,，・\-ー－−()（）「」『』様邸]/g, '').replace(/[都道府県市区町村]/g, '');

  // ゴミの種類の言い方（長いものから照合する）
  const WASTE_WORDS = [
    ['有筋ガラ', 'concreteR'], ['鉄筋ガラ', 'concreteR'], ['有筋', 'concreteR'],
    ['無筋ガラ', 'concrete'], ['コンクリートガラ', 'concrete'], ['コンクリガラ', 'concrete'], ['コンガラ', 'concrete'], ['無筋', 'concrete'], ['コンクリ', 'concrete'],
    ['アスファルト', 'asphalt'], ['アスガラ', 'asphalt'], ['アスコン', 'asphalt'],
    ['ガラス', 'glass'], ['ガラ', 'concrete'],
    ['木クズ', 'wood'], ['木屑', 'wood'], ['廃木材', 'wood'], ['木材', 'wood'], ['シバ', 'wood'], ['柴', 'wood'], ['木', 'wood'],
    ['混合廃棄物', 'mixed'], ['ミンチ', 'mixed'], ['混廃', 'mixed'], ['混合', 'mixed'],
    ['廃プラ', 'plastic'], ['プラ', 'plastic'],
    ['カワラ', 'glass'], ['瓦', 'glass'], ['陶器', 'glass'],
    ['石膏ボード', 'gypsum'], ['セッコウ', 'gypsum'], ['石膏', 'gypsum'], ['ボード', 'gypsum'],
    ['鉄クズ', 'metal'], ['金属', 'metal'], ['鉄', 'metal'],
    ['アスベスト', 'asb'], ['石綿', 'asb'],
  ].map(([w, t]) => [kana(w), t]).sort((a, b) => b[0].length - a[0].length);

  // いちばん長く一致する部分の長さ（照合の点数）
  function overlap(a, b) {
    if (!a || !b) return 0;
    if (b.includes(a)) return a.length + 2; // 送った言葉がまるごと含まれていれば高得点
    let best = 0;
    for (let i = 0; i < a.length; i++) for (let j = i + best + 1; j <= a.length; j++) { if (b.includes(a.slice(i, j))) best = j - i; else break; }
    return best >= 2 ? best : 0;
  }

  // 処分場の候補：登録した処分場（名前と呼び方）、これまでのマニフェストの処分業者、いつもの処分業者
  function siteCandidates(state) {
    const s = state.settings || {}, out = [];
    (s.sites || []).forEach((st) => { if (st.name) out.push({ name: st.name, words: [st.name].concat(String(st.alias || '').split(/[,、，\s]+/)).filter(Boolean) }); });
    const seen = new Set(out.map((x) => x.name));
    const add = (n) => { if (n && !seen.has(n)) { seen.add(n); out.push({ name: n, words: [n] }); } };
    add(s.defDisposer);
    (state.cases || []).forEach((c) => (c.manifests || []).forEach((m) => add(m.disposer)));
    return out;
  }

  const activeCase = (c, now) => {
    const end = c.endDate ? new Date(c.endDate + 'T00:00:00') : null;
    const start = c.startDate ? new Date(c.startDate + 'T00:00:00') : null;
    return (!end || end >= addDays(isoOf(now), -21)) && (!start || start <= addDays(isoOf(now), 14));
  };
  const caseLabel = (c) => `${caseName(c)}${c.siteAddress ? '（' + c.siteAddress + '）' : ''}`;

  // 単価：処分場ごとの単価 → 標準の単価
  function priceFor(state, disposer, type) {
    const s = state.settings || {};
    const st = (s.sites || []).find((x) => x.name && x.name.trim() === String(disposer || '').trim());
    const v = st && st.prices ? st.prices[type] : '';
    if (v !== '' && v != null) return num(v);
    return num((s.dispPrices || {})[type]);
  }

  function parseRecord(text, state, date) {
    const now = todayOf(date);
    let t = kana(text).replace(/[、,，・\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    const raw = String(text || '').normalize('NFKC');
    // 日付（なければ今日）：「11/8」「11月8日」「昨日」
    let day = new Date(now);
    const md = raw.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
    if (md) {
      day = new Date(now.getFullYear(), num(md[1]) - 1, num(md[2]));
      if (day > addDays(isoOf(now), 7)) day.setFullYear(day.getFullYear() - 1);
      t = t.replace(kana(md[0]).replace(/\//g, ' '), ' ');
    } else if (/昨日|きのう/.test(raw)) { day = addDays(isoOf(now), -1); t = t.replace(/昨日|キノウ/g, ' '); }
    else if (/一昨日|おととい/.test(raw)) { day = addDays(isoOf(now), -2); t = t.replace(/一昨日|オトトイ/g, ' '); }
    // 重さ・量：「3t」「3トン」「2.4ton」「3000kg」「3000キロ」「2m3」「2立米」
    let qty = null, unit = 't';
    const w = t.match(/(\d+(?:\.\d+)?)\s*(トン|ton|t|kg|キロ|m3|立米|リューベ)(?![a-z])/i);
    if (w) {
      qty = num(w[1]);
      if (/kg|キロ/i.test(w[2])) qty = qty / 1000;
      if (/m3|立米|リューベ/i.test(w[2])) unit = 'm3';
      t = t.replace(w[0], ' ');
    }
    // ゴミの種類
    let type = null;
    for (const [word, id] of WASTE_WORDS) { const i = t.indexOf(word); if (i >= 0) { type = id; t = t.slice(0, i) + ' ' + t.slice(i + word.length); break; } }
    if (qty == null) { const bare = t.match(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/); if (bare) { qty = num(bare[1]); t = t.replace(bare[0], ' '); } } // 単位なしの数字はトンとみなす
    // 空白なしで続けて書かれても分けられるよう、カタカナ・英字と漢字・ひらがなの境目でも区切る（「ヒラヤマ住吉区」→「ヒラヤマ」「住吉区」）
    const split = (x) => x.match(/[\u30a0-\u30ffa-z0-9ー]+|[^\u30a0-\u30ffa-z0-9ー]+/g) || [];
    const tokens = t.split(' ').flatMap((x) => { const parts = split(x.trim()); return parts.length > 1 ? [x.trim()].concat(parts) : parts; })
      .filter((x) => x.length >= 2 || /[\u4e00-\u9fff]/.test(x)); // 「堺」など漢字1文字の地名も使う

    // 処分場
    const sites = siteCandidates(state);
    let disposer = null; const used = new Set();
    let best = { score: 0 };
    tokens.forEach((tok) => sites.forEach((st) => st.words.forEach((wd) => {
      const sc = overlap(squash(tok), squash(wd));
      if (sc > best.score) best = { score: sc, name: st.name, tok };
    })));
    if (best.score >= 3 || (best.score >= 2 && best.tok && squash(best.tok).length <= 3)) { disposer = best.name; used.add(best.tok); }

    // 現場
    const cases = (state.cases || []);
    const scored = cases.map((c) => {
      let sc = 0;
      tokens.filter((tok) => !used.has(tok)).forEach((tok) => {
        const k = squash(tok);
        sc = Math.max(sc, overlap(k, squash(c.siteAddress)), overlap(k, squash(c.clientName)), overlap(k, squash(c.estimateNo)));
      });
      return { c, sc };
    }).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);
    let target = null, candidates = [];
    if (scored.length && (scored.length === 1 || scored[0].sc > scored[1].sc)) target = scored[0].c;
    else if (scored.length) candidates = scored.filter((x) => x.sc === scored[0].sc).map((x) => x.c);
    else {
      const act = cases.filter((c) => activeCase(c, now));
      if (act.length === 1) target = act[0]; else candidates = act.length ? act : cases;
    }
    // 現場の照合に使わなかった言葉は、未登録の処分場の名前として使う
    if (!disposer) {
      // 空白で区切られた言葉のうち、現場の地名・施主名と重なる部分を取り除いた残りを処分場名にする（「タナカ産業伏見」→「タナカ産業」）
      const strip = (tok) => {
        if (!target) return tok;
        let out = tok;
        [target.siteAddress, target.clientName].forEach((f) => {
          const k = kana(f || '').replace(/\s/g, '');
          for (let len = Math.min(out.length, k.length); len >= 2; len--) {
            let hit = '';
            for (let i = 0; i + len <= out.length; i++) { const sub = out.slice(i, i + len); if (k.includes(sub)) { hit = sub; break; } }
            if (hit) { out = out.replace(hit, ''); break; }
          }
        });
        return out.trim();
      };
      const rest = t.split(' ').map((x) => x.trim()).filter(Boolean).map(strip).filter((x) => x.length >= 2);
      disposer = rest.length ? rest[0] : ((state.settings || {}).defDisposer || '');
    }

    const res = { type, qty, unit, date: isoOf(day), disposer, target, candidates };
    res.missing = [!type && 'type', qty == null && 'qty', !target && 'case'].filter(Boolean);
    return res;
  }

  // マニフェスト1枚分（画面と同じ形）
  function manifestFromRecord(r, state, by) {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: 'paper', no: '', date: r.date, type: r.type,
      qty: String(Math.round(r.qty * 1000) / 1000), carrier: (state.settings || {}).defCarrier || '', disposer: r.disposer || '',
      reg: '', b2: '', d: '', e: '', via: 'line', lineBy: by || '', lineAt: new Date().toISOString(),
    };
  }

  const LINE_HELP = '【カイタイ事務】捨てた記録の送り方\n処分場・現場・ゴミの種類・重さを、空白で区切って送ってください。順番は自由です。\n\n例）ヒラヤマ 住吉区 シバ 3t\n例）住吉 ミンチ 2.4トン 平山\n例）11/8 山田 有筋 4t（日付を付けると、その日の記録になります）\n\n間違えたときは「取消」と送ると、直前の記録を消します。';

  function recordReply(r, state) {
    const w = WT[r.type] || { name: r.type, unit: 't' };
    const price = priceFor(state, r.disposer, r.type);
    const site = (state.settings && (state.settings.sites || []).find((x) => x.name === r.disposer)) ? '' : '（単価が未登録の処分場です）';
    return `✅ 登録しました\n現場：${caseLabel(r.target)}\n日付：${r.date.replace(/^\d+-0?(\d+)-0?(\d+)$/, '$1/$2')}\nゴミ：${w.name} ${r.qty}${r.unit === 'm3' ? '㎥' : 't'}\n処分場：${r.disposer || '（未入力）'}${site}\n処分代：${price ? '¥' + yen(r.qty * price) + '（単価 ¥' + yen(price) + '）' : '単価未登録'}\n\n間違えたら「取消」と送ってください。`;
  }
  function askReply(r) {
    const parts = [];
    if (r.missing.includes('type')) parts.push('ゴミの種類（シバ・ガラ・有筋・ミンチ・廃プラ・瓦・石膏 など）');
    if (r.missing.includes('qty')) parts.push('重さ（例：3t、2.5トン、3000kg）');
    if (parts.length) return `読み取れなかったものがあります：\n・${parts.join('\n・')}\n\nもう一度、全部まとめて送ってください。\n例）ヒラヤマ 住吉区 シバ 3t`;
    if (r.missing.includes('case')) {
      const list = (r.candidates || []).slice(0, 9);
      if (!list.length) return '現場が見つかりませんでした。カイタイ事務に現場（案件）を登録してから送ってください。';
      return 'どの現場ですか？ 番号だけ送ってください。\n' + list.map((c, i) => `${i + 1}. ${caseLabel(c)}`).join('\n');
    }
    return '';
  }

  // 毎朝の通知に載せる注意をまとめる（画面の「全案件の注意」と同じ基準）
  function collectAlerts(state, date) {
    const now = todayOf(date);
    const settings = state.settings || {};
    const out = { lease: [], manifest: [], schedule: [] };
    (state.cases || []).forEach((c) => {
      const name = caseName(c);
      // リース
      (c.leases || []).forEach((l) => {
        const r = leaseCalc(l, settings, null, now);
        if (!r.ongoing || r.state === 'bad' || r.state === 'none') return;
        const who = `${name} ${l.name || 'リース'}`;
        if (r.state === 'soon' && r.tip) out.lease.push(`${who}：あと${r.toSwitch}日で月極。${r.tip}`);
        else if (r.state === 'soon') out.lease.push(`${who}：あと${r.toSwitch}日で月極。返すなら${fmtDate(r.lastDaily)}までに返せば日割り（今の時点で¥${yen(r.rent)}）`);
        else if (r.paidUntil && r.rem === r.th + 1) out.lease.push(`${who}：今日から月極に切り替わりました。${fmtDate(r.paidUntil)}までは追加料金なし`);
        if (r.newMonth && r.newMonth.cur.d === 1) out.lease.push(`${who}：締め日を過ぎ、${r.newMonth.cur.label}分は日割りに戻りました（${r.newMonth.prev.label}分は¥${yen(r.newMonth.prev.amount)}で締め）`);
      });
      // マニフェスト
      (c.manifests || []).forEach((m) => {
        manifestChecks(m, now).forEach((x) => {
          const what = `${name} ${(WT[m.type] && WT[m.type].name) || ''}（${m.date ? md(new Date(m.date + 'T00:00:00')) + '搬出' : ''}${m.no ? '・' + m.no : ''}）`;
          if (x.state === 'late') out.manifest.push(`${what}：${x.label}の期限（${fmtDate(x.due)}）を過ぎています。${fmtDate(x.report)}までに措置内容等報告書`);
          else if (x.state === 'soon' && Math.round((x.due - now) / 86400000) <= 7) out.manifest.push(`${what}：${x.text}（期限 ${fmtDate(x.due)}）`);
        });
      });
      // 着工前の届出・挨拶（期限の3日前から当日まで）
      if (c.startDate) {
        const area = num(c.floorArea);
        const items = [];
        if (area >= 80) items.push(['建設リサイクル法の事前届出', addDays(c.startDate, -7)]);
        if (area >= 80) items.push(['アスベスト事前調査結果の報告', addDays(c.startDate, -1)]);
        items.push(['近隣挨拶', addDays(c.startDate, -7)]);
        if (c.narrowRoad) items.push(['道路使用許可', addDays(c.startDate, -7)]);
        items.forEach(([label, due]) => {
          const diff = Math.round((due - now) / 86400000);
          if (diff >= 0 && diff <= 3) out.schedule.push(`${name}：${label}の期限 ${fmtDate(due)}（${diff === 0 ? '今日' : 'あと' + diff + '日'}）※済んでいれば不要`);
        });
      }
    });
    return out;
  }

  // LINE に送る文章（注意がなければ空文字）
  function alertMessage(state, date) {
    const a = collectAlerts(state, date);
    const n = a.lease.length + a.manifest.length + a.schedule.length;
    if (!n) return '';
    const now = todayOf(date);
    const sec = (title, list) => (list.length ? `\n■${title}\n` + list.map((x) => '・' + x).join('\n') + '\n' : '');
    return `【カイタイ事務】${now.getMonth() + 1}月${now.getDate()}日の注意 ${n}件\n` + sec('リース', a.lease) + sec('マニフェスト', a.manifest) + sec('届出・挨拶', a.schedule);
  }

  const api = {
    num, yen, isoOf, addDays, fmtDate, todayOf,
    WASTE_TYPES, WT, plus3BizDays, manifestChecks,
    LEASE_MODES, lastOfMonth, addMonthsClamp, companyOf, closeOf, closeLabel, closeDate, segEnd, dayCount, mLabel, leaseCalc,
    caseName, collectAlerts, alertMessage,
    kana, parseRecord, manifestFromRecord, recordReply, askReply, priceFor, caseLabel, LINE_HELP,
  };
  root.KJCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
