// 消した現場を戻す・自動バックアップの一覧と「この日に戻す」・ほかの会社からは見えない、を本番のデータベースで試す
// 使い方：node tests/trash-backup.js（試しのアカウントは tests/.last-test-users.json。あとで tests/cleanup-test-users.sh）
// バックアップを作るために Supabase の管理用の API（api.supabase.com）を使う
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), { execSync } = require('child_process'); const ROOT = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const BASE = 'http://localhost:8769/';
const stamp = Date.now();
const users = ['owner', 'other'].map((n) => ({ email: `kj-co-${n}-${stamp}@example.com`, pass: 'Pw' + Math.random().toString(36).slice(2, 12) + '9' }));
fs.writeFileSync(path.join(__dirname, '.last-test-users.json'), JSON.stringify(users.map((u) => u.email)));
const ok = (label, cond) => console.log((cond ? '✓ ' : '✗ ') + label);
const sql = (q) => execSync(`curl -sS -X POST "https://api.supabase.com/v1/projects/bheudvidpcbfrerugnkg/database/query" -H "Content-Type: application/json" --data @-`, { input: JSON.stringify({ query: q }) }).toString();
(async () => {
  await new Promise((r) => server.listen(8769, r));
  const b = await chromium.launch(); const e = [];
  const open = async (name) => { const ctx = await b.newContext({ viewport: { width: 1000, height: 1300 }, acceptDownloads: true }); const p = await ctx.newPage(); p.on('pageerror', (x) => e.push(name + ': ' + x.message)); p.on('dialog', (d) => d.accept()); await p.goto(BASE); await p.waitForSelector('#loginOverlay:not([hidden])'); return p; };
  const signup = async (p, u, co) => { await p.click('#loginToggle'); await p.fill('#loginEmail', u.email); await p.fill('#loginPassword', u.pass); await p.fill('#loginPassword2', u.pass); await p.click('#loginSubmit');
    await p.waitForSelector('#companyOverlay:not([hidden])', { timeout: 15000 }); await p.fill('#companyName', co); await p.click('#companyCreate button'); await p.waitForSelector('#companyOverlay[hidden]', { state: 'attached', timeout: 15000 }); };
  const edit = (p, fn) => p.evaluate((f) => { const st = KJApp.getState(); (new Function('st', f))(st); KJApp.replaceState(st); }, fn);
  const O = await open('O'); await signup(O, users[0], 'ゴミ箱テスト');
  await edit(O, "st.cases[0].clientName = '残す現場'; st.cases.push({ ...JSON.parse(JSON.stringify(st.cases[0])), id: 'DEL1', clientName: '消す現場', siteAddress: '堺市', manifests: [{ id: 'mm', kind: 'paper', date: '2026-11-20', type: 'wood', qty: '1', disposer: '' }] });");
  await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  // バックアップを作る（毎日3時の分を、今作る）
  sql('select public.kj_daily_backup();');
  // 消す
  await O.evaluate(() => { KJNav.openCase('DEL1', 'summary'); }); await O.waitForTimeout(200);
  await O.click('#summaryOut [data-act=del]'); await O.waitForTimeout(400);
  await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  ok('消した現場は一覧から消える', await O.evaluate(() => !KJApp.getState().cases.some((c) => c.id === 'DEL1')));
  ok('サーバーには「消した」印つきで中身が残る', /消す現場/.test(sql("select data->>'clientName' as n, deleted from kj_docs where id = 'DEL1';")) && /true/.test(sql("select deleted from kj_docs where id = 'DEL1';")));
  // 別の端末（同じ人）で開いても、ゴミ箱に出る：この端末のゴミ箱を消してから確かめる
  await O.evaluate(() => localStorage.removeItem('kaitai-jimu-trash'));
  await O.click('#mainNav [data-sec=settings]'); await O.waitForTimeout(1500); await O.evaluate(() => { document.querySelectorAll('#tab-settings fieldset').forEach((f) => f.classList.remove('closed')); KJCloud.loadTrash(); }); await O.waitForTimeout(1500);
  const trashTxt = (await O.textContent('#trashBox')).replace(/\s+/g, ' ');
  ok('ゴミ箱（会社の分）に「消す現場」が出る', /消す現場/.test(trashTxt)); console.log('  ', trashTxt.slice(0, 90));
  const bkTxt = (await O.textContent('#backupBox')).replace(/\s+/g, ' ');
  ok('バックアップの一覧が出る', /現場 2件/.test(bkTxt)); console.log('  ', bkTxt.slice(0, 90));
  await O.locator('#trashFs').scrollIntoViewIfNeeded(); await O.screenshot({ path: '/tmp/claude-0/-home-user--/d1d53c4c-f72d-5750-a742-ddcc0de8fe05/scratchpad/trash.png' });
  // 戻す
  await O.click('#trashBox [data-restore="DEL1"]'); await O.waitForTimeout(300); await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  ok('戻すと一覧に戻り、記録も残っている', await O.evaluate(() => { const c = KJApp.getState().cases.find((x) => x.id === 'DEL1'); return !!c && c.manifests.length === 1; }));
  ok('サーバーでも戻っている', /false/.test(sql("select deleted from kj_docs where id = 'DEL1';")));
  // バックアップの日に戻す：いったん名前を変えて、戻す
  await edit(O, "st.cases.find((c) => c.clientName === '残す現場').clientName = '変えた名前';"); await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  await O.evaluate(() => KJCloud.loadTrash()); await O.waitForTimeout(1200);
  await O.click('#backupBox [data-bkrestore]'); await O.waitForTimeout(500); await O.evaluate(() => KJCloud.push()); await O.waitForTimeout(1500);
  ok('「この日に戻す」でその時の名前に戻る', await O.evaluate(() => KJApp.getState().cases.some((c) => c.clientName === '残す現場')));
  // ほかの会社からは見えない
  const X = await open('X'); await signup(X, users[1], '別の会社');
  const leak = await X.evaluate(async () => { const sb = window.supabase.createClient(window.KJ_CONFIG.supabaseUrl, window.KJ_CONFIG.supabaseKey, { auth: { storageKey: 'kaitai-jimu-auth' } }); const r = await sb.from('kj_backups').select('company_id'); return (r.data || []).length; });
  const myCo = JSON.parse(sql("select count(*)::int as n from kj_backups b join kj_members m on m.company_id = b.company_id join auth.users u on u.id = m.user_id where u.email = '" + users[1].email + "';"))[0].n;
  ok('別の会社の人は、ほかの会社のバックアップを読めない', leak === myCo);
  console.log('errors', e); await b.close(); server.close();
})().catch((err) => { console.log('FAILED', err.message); process.exit(1); });
