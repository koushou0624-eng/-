// 会社の作成・招待・共有・他社との分離・メンバーを外す、をまとめて試す
// 使い方：node tests/company-flow.js                 … このフォルダを手元で配信して試す
//         KJ_BASE=https://koushou0624-eng.github.io/-/ node tests/company-flow.js … 公開中のサイトで試す
// 試しに作ったアカウントのメールアドレスは tests/.last-test-users.json に書き出す（あとで消すため）
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'); const ROOT = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const LOCAL = !process.env.KJ_BASE;
const BASE = process.env.KJ_BASE || 'http://localhost:8767/';
const stamp = Date.now();
const users = ['owner', 'staff', 'other'].map((n) => ({ email: `kj-co-${n}-${stamp}@example.com`, pass: 'Pw' + Math.random().toString(36).slice(2, 12) + '9' }));
fs.writeFileSync(path.join(__dirname, '.last-test-users.json'), JSON.stringify(users.map((u) => u.email)));

(async () => {
  if (LOCAL) await new Promise((r) => server.listen(8767, r));
  const b = await chromium.launch(); const e = [];
  const open = async (name, url = BASE) => {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 1300 } });
    const p = await ctx.newPage(); p.on('pageerror', (x) => e.push(name + ': ' + x.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/400|401|403|422/.test(m.text())) e.push(name + ' console: ' + m.text()); });
    p.on('dialog', (d) => d.accept());
    await p.goto(url); await p.waitForSelector('#loginOverlay:not([hidden])'); return p;
  };
  const signup = async (p, u) => {
    if ((await p.textContent('#loginSubmit')) !== '登録する') await p.click('#loginToggle');
    await p.fill('#loginEmail', u.email); await p.fill('#loginPassword', u.pass); await p.fill('#loginPassword2', u.pass);
    await p.click('#loginSubmit');
  };
  const st = (p) => p.evaluate(() => KJApp.getState());
  // 新しい画面：下の5つのボタンから開く
  const toInput = (p) => p.evaluate(() => KJNav.go('input'));
  const toSettings = (p) => p.click('#mainNav [data-sec=settings]');

  // 1) 代表が登録 → 会社を作る
  const O = await open('O');
  await O.click('#loginToggle'); await O.fill('#loginEmail', users[0].email); await O.fill('#loginPassword', 'short'); await O.fill('#loginPassword2', 'short'); await O.click('#loginSubmit');
  console.log('短いパスワード →', await O.textContent('#loginError'));
  await signup(O, users[0]);
  await O.waitForSelector('#companyOverlay:not([hidden])', { timeout: 15000 });
  console.log('O: 会社の設定画面が出た');
  await O.fill('#companyName', 'テスト解体株式会社'); await O.click('#companyCreate button');
  await O.waitForSelector('#companyOverlay[hidden]', { state: 'attached', timeout: 15000 });
  await toInput(O); await O.fill('#caseForm [name=clientName]', '共有テスト 太郎'); await O.waitForTimeout(2500);
  await toSettings(O);
  await O.waitForFunction(() => document.querySelectorAll('#memberList li').length === 1);
  console.log('O: 会社名', await O.inputValue('#companyNameEdit'), '/ メンバー', (await O.textContent('#memberList')).replace(/\s+/g, ' '));
  await O.click('#inviteMake'); await O.waitForSelector('#inviteUrlRow:not([hidden])');
  const invite = (await O.inputValue('#inviteUrl')).replace(/^https?:\/\/[^/]+\/[^?]*/, BASE);
  console.log('O: 招待リンクを作った', /\?invite=[0-9a-f]{32}$/.test(invite));

  // 2) 社員が招待リンクから登録 → 自動で参加し、同じデータが見える
  const S = await open('S', invite);
  console.log('S: 招待の案内', !(await S.$eval('#inviteNote', (x) => x.hidden)), '/ 最初から新規登録', await S.textContent('#loginSubmit'));
  await signup(S, users[1]);
  await S.waitForFunction(() => KJApp.getState().cases.some((c) => c.clientName === '共有テスト 太郎'), null, { timeout: 15000 });
  console.log('S: 代表の案件が見えた');
  await toInput(S); await S.fill('#caseForm [name=clientName]', '共有テスト 次郎'); await S.waitForTimeout(2500);
  await O.evaluate(() => KJCloud.pull());
  await O.waitForFunction(() => KJApp.getState().cases.some((c) => c.clientName === '共有テスト 次郎'), null, { timeout: 15000 });
  console.log('O: 社員の変更が届いた');
    await O.reload(); await O.waitForFunction(() => document.querySelectorAll('#memberList li').length === 2, null, { timeout: 15000 });
  console.log('O: メンバー一覧', (await O.textContent('#memberList')).replace(/\s+/g, ' '));

  // 3) 別の人は招待なしで登録 → 自分の会社を作る → 代表の会社のデータは見えない
  const X = await open('X');
  await signup(X, users[2]);
  await X.waitForSelector('#companyOverlay:not([hidden])', { timeout: 15000 });
  await X.fill('#companyName', '別の解体'); await X.click('#companyCreate button');
  await X.waitForSelector('#companyOverlay[hidden]', { state: 'attached', timeout: 15000 }); await X.waitForTimeout(2000);
  const xs = await st(X);
  console.log('X: 自分の会社の案件', xs.cases.map((c) => c.clientName || '(空)').join(','), '/ 代表の案件が見える?', xs.cases.some((c) => /共有テスト/.test(c.clientName)));
  const xRaw = await X.evaluate(async () => {
    const auth = JSON.parse(localStorage.getItem('kaitai-jimu-auth'));
    const h = { apikey: KJ_CONFIG.supabaseKey, Authorization: 'Bearer ' + auth.access_token };
    const docs = await (await fetch(KJ_CONFIG.supabaseUrl + '/rest/v1/kj_docs?select=data', { headers: h })).json();
    const mem = await (await fetch(KJ_CONFIG.supabaseUrl + '/rest/v1/kj_members?select=email', { headers: h })).json();
    const co = await (await fetch(KJ_CONFIG.supabaseUrl + '/rest/v1/kj_companies?select=name', { headers: h })).json();
    return { docs: docs.map((d) => d.data.clientName || ''), mem: mem.map((m) => m.email), co: co.map((c) => c.name) };
  });
  console.log('X: 直接読める範囲', JSON.stringify(xRaw));
  // 招待を作れるのは代表だけ（社員は招待欄が出ない）
  await toSettings(S);
  console.log('S: 招待ボタンが見える?', await S.isVisible('#inviteMake'), '/ 会社名を変えられる?', !(await S.isDisabled('#companyNameEdit')));

  // 4) 代表が社員を外す → 社員は会社のデータを読めなくなる
  await toSettings(O);
  const btn = O.locator('#memberList [data-remove]'); await btn.click(); await btn.click();
  await O.waitForFunction(() => document.querySelectorAll('#memberList li').length === 1, null, { timeout: 15000 });
  console.log('O: 外した →', await O.textContent('#companyMsg'));
  const sRaw = await S.evaluate(async () => {
    const auth = JSON.parse(localStorage.getItem('kaitai-jimu-auth'));
    const r = await fetch(KJ_CONFIG.supabaseUrl + '/rest/v1/kj_docs?select=id', { headers: { apikey: KJ_CONFIG.supabaseKey, Authorization: 'Bearer ' + auth.access_token } });
    return (await r.json()).length;
  });
  console.log('S: 外されたあとに読める行数', sRaw);
  await S.reload(); await S.waitForSelector('#companyOverlay:not([hidden])', { timeout: 15000 });
  console.log('S: 開き直すと会社の設定画面に戻る');

  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await m.goto(invite);
  await m.waitForSelector('#loginOverlay:not([hidden])'); await m.screenshot({ path: path.join(__dirname, '.last-signup.png') });
  console.log('mobile width', await m.evaluate(() => document.documentElement.scrollWidth));
  console.log('errors', e);
  await b.close(); if (LOCAL) server.close();
})().catch(async (x) => { console.error('FAILED', x.message.split('\n')[0]); if (LOCAL) server.close(); process.exit(1); });
