// 2人が同じ現場を同時に直したとき、両方の変更が残るか／電波がないときに入れたものが、つながったら送られるか
// 使い方：node tests/sync-conflict.js（試しに作ったアカウントは tests/.last-test-users.json に書き出す。あとで tests/cleanup-test-users.sh で消す）
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'); const ROOT = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const BASE = 'http://localhost:8768/';
const stamp = Date.now();
const users = ['owner', 'staff'].map((n) => ({ email: `kj-co-${n}-${stamp}@example.com`, pass: 'Pw' + Math.random().toString(36).slice(2, 12) + '9' }));
fs.writeFileSync(path.join(__dirname, '.last-test-users.json'), JSON.stringify(users.map((u) => u.email)));
const ok = (label, cond) => console.log((cond ? '✓ ' : '✗ ') + label);
(async () => {
  await new Promise((r) => server.listen(8768, r));
  const b = await chromium.launch(); const e = [];
  const open = async (name, url = BASE) => {
    const ctx = await b.newContext({ viewport: { width: 1000, height: 1200 } });
    const p = await ctx.newPage(); p.on('pageerror', (x) => e.push(name + ': ' + x.message)); p.on('dialog', (d) => d.accept());
    await p.goto(url); await p.waitForSelector('#loginOverlay:not([hidden])'); return { p, ctx };
  };
  const signup = async (p, u) => { if ((await p.textContent('#loginSubmit')) !== '登録する') await p.click('#loginToggle'); await p.fill('#loginEmail', u.email); await p.fill('#loginPassword', u.pass); await p.fill('#loginPassword2', u.pass); await p.click('#loginSubmit'); };
  const edit = (p, fn, arg) => p.evaluate(([f, a]) => { const st = KJApp.getState(); (new Function('st', 'a', f))(st, a); KJApp.replaceState(st); }, [fn, arg]);
  const server_ = async (p) => p.evaluate(async () => { await KJCloud.pull(); return KJApp.getState().cases.find((c) => c.id === 'X'); });

  // 準備：代表 O と社員 S、同じ現場 X
  const { p: O, ctx: OC } = await open('O');
  await signup(O, users[0]); await O.waitForSelector('#companyOverlay:not([hidden])', { timeout: 15000 });
  await O.fill('#companyName', '同時編集テスト'); await O.click('#companyCreate button'); await O.waitForSelector('#companyOverlay[hidden]', { state: 'attached', timeout: 15000 });
  await edit(O, "const c = st.cases[0]; c.id = 'X'; st.currentId = 'X'; c.clientName = 'テスト'; c.manifests = []; c.expenses = []; c.notes = '';");
  await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  await O.evaluate(() => KJNav.setSection('settings')); await O.evaluate(() => document.querySelectorAll('#tab-settings fieldset').forEach((f) => f.classList.remove('closed')));
  await O.click('#inviteMake'); await O.waitForSelector('#inviteUrlRow:not([hidden])');
  const invite = (await O.inputValue('#inviteUrl')).replace(/^https?:\/\/[^/]+\/[^?]*/, BASE);
  const { p: S } = await open('S', invite); await signup(S, users[1]);
  await S.waitForFunction(() => KJApp.getState().cases.some((c) => c.id === 'X'), null, { timeout: 15000 });
  ok('S にも現場 X が見える', true);

  // 1) O が電波なしで経費を入れている間に、S が処分の記録を入れて送る → O がつながると両方残る
  await OC.setOffline(true);
  await edit(O, "st.cases.find((c) => c.id === 'X').expenses.push({ id: 'e1', date: '2026-11-20', cat: '燃料費', amount: 5000, memo: '' });");
  await O.waitForTimeout(1500);
  await edit(S, "st.cases.find((c) => c.id === 'X').manifests.push({ id: 'm1', kind: 'paper', date: '2026-11-20', type: 'wood', qty: '2', disposer: '' });");
  await S.evaluate(() => KJCloud.push()); await S.waitForTimeout(1000);
  await OC.setOffline(false); await O.evaluate(() => window.dispatchEvent(new Event('online')));
  await O.waitForTimeout(4000); await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  let x = await server_(S);
  ok('1) Sの画面に O の経費と S の記録の両方', x.expenses.some((y) => y.id === 'e1') && x.manifests.some((y) => y.id === 'm1'));
  x = await O.evaluate(() => KJApp.getState().cases.find((c) => c.id === 'X'));
  ok('1) Oの画面にも両方', x.expenses.some((y) => y.id === 'e1') && x.manifests.some((y) => y.id === 'm1'));
  console.log('   O の表示：', await O.evaluate(() => document.getElementById('syncStatus').textContent));

  // 2) 同じ現場の別の欄：O は施主名、S はメモ → 両方残る
  await OC.setOffline(true);
  await edit(O, "st.cases.find((c) => c.id === 'X').clientName = 'O が直した名前';"); await O.waitForTimeout(1200);
  await edit(S, "st.cases.find((c) => c.id === 'X').notes = 'S のメモ';"); await S.evaluate(() => KJCloud.push()); await S.waitForTimeout(1000);
  await OC.setOffline(false); await O.evaluate(() => window.dispatchEvent(new Event('online'))); await O.waitForTimeout(4000); await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  x = await server_(S);
  ok('2) 施主名（O）とメモ（S）の両方が残る', x.clientName === 'O が直した名前' && x.notes === 'S のメモ');

  // 3) S が記録を消し、O は同じ時に別の記録を足す → 消したものは消えたまま、足したものは残る
  await OC.setOffline(true);
  await edit(O, "st.cases.find((c) => c.id === 'X').manifests.push({ id: 'm2', kind: 'paper', date: '2026-11-21', type: 'mixed', qty: '1', disposer: '' });"); await O.waitForTimeout(1200);
  await edit(S, "const c = st.cases.find((c) => c.id === 'X'); c.manifests = c.manifests.filter((m) => m.id !== 'm1');"); await S.evaluate(() => KJCloud.push()); await S.waitForTimeout(1000);
  await OC.setOffline(false); await O.evaluate(() => window.dispatchEvent(new Event('online'))); await O.waitForTimeout(4000); await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  x = await server_(S);
  ok('3) S が消した m1 は消えたまま・O が足した m2 は残る', !x.manifests.some((m) => m.id === 'm1') && x.manifests.some((m) => m.id === 'm2'));

  // 4) 電波がない状態で開き直しても使える（Supabase につながらない）→ 入れたものは、つながったら送られる
  await OC.route(/supabase\.co/, (r) => r.abort());
  await O.reload(); await O.waitForTimeout(2500);
  ok('4) つながらなくてもログイン画面にならない', await O.evaluate(() => document.getElementById('loginOverlay').hidden));
  ok('4) 現場 X が見える', await O.evaluate(() => KJApp.getState().cases.some((c) => c.id === 'X')));
  console.log('   O の表示：', await O.evaluate(() => document.getElementById('syncStatus').textContent));
  await edit(O, "st.cases.find((c) => c.id === 'X').expenses.push({ id: 'e2', date: '2026-11-21', cat: '高速代', amount: 1200, memo: '' });"); await O.waitForTimeout(1500);
  await OC.unroute(/supabase\.co/);
  await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(2500);
  x = await server_(S);
  ok('4) つながったあと、電波なしで入れた経費が S に届く', x.expenses.some((y) => y.id === 'e2'));
  console.log('errors', e);
  await b.close(); server.close();
})().catch((err) => { console.log('FAILED', err.message); process.exit(1); });
