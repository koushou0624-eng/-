// カイタイ事務：書類を A4 の PDF にして、保存・共有する
// スマホ・タブレット：共有の画面（"ファイル"に保存、LINE・メールで送る）／パソコン：ダウンロード
(function () {
  'use strict';
  const LIBS = {
    html2canvas: 'vendor/html2canvas-1.4.1.min.js',
    jspdf: 'vendor/jspdf-2.5.1.umd.min.js',
  };
  const A4_W_PX = 794; // A4 の幅（96dpi）。スマホで開いていてもこの幅で書類を組み直してから PDF にする

  const load = (src) => new Promise((ok, ng) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return ok();
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src;
    s.onload = ok; s.onerror = () => ng(new Error('PDFの部品を読み込めませんでした（通信を確認してください）'));
    document.head.appendChild(s);
  });
  async function libs() {
    if (!window.html2canvas) await load(LIBS.html2canvas);
    if (!(window.jspdf && window.jspdf.jsPDF)) await load(LIBS.jspdf);
  }

  async function makePdf(paper) {
    await libs();
    const canvas = await window.html2canvas(paper, {
      scale: 2, backgroundColor: '#ffffff', windowWidth: 1200, logging: false,
      onclone: (doc, el) => {
        Object.assign(el.style, { width: A4_W_PX + 'px', maxWidth: 'none', minHeight: '0', margin: '0', boxShadow: 'none', padding: '60px 56px' });
        el.querySelectorAll('.no-print').forEach((n) => n.remove());
        el.querySelectorAll('.table-wrap').forEach((n) => { n.style.overflow = 'visible'; });
        if (el.scrollWidth > A4_W_PX) el.style.width = el.scrollWidth + 'px'; // 工程表など横に長いものは幅を広げて縮小
      },
    });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const pageW = 210, pageH = 297;
    const pxPerMm = canvas.width / pageW;
    const pagePx = Math.floor(pageH * pxPerMm);
    for (let y = 0, i = 0; y < canvas.height; y += pagePx, i++) {
      const h = Math.min(pagePx, canvas.height - y);
      if (i > 0 && h < 8 * pxPerMm) break; // 下の余白だけのページは作らない
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, h);
      g.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (i > 0) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageW, h / pxPerMm);
    }
    return pdf.output('blob');
  }

  function fileName(docName) {
    const st = window.KJApp ? window.KJApp.getState() : null;
    const c = st ? (st.cases.find((x) => x.id === st.currentId) || st.cases[0]) : null;
    const who = c && c.clientName ? `${c.clientName}様` : '施主未入力';
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${docName}_${who}_${ymd}.pdf`.replace(/[\\/:*?"<>|\s]+/g, '_');
  }

  const isTouch = () => navigator.maxTouchPoints > 1; // iPhone・iPad・Android（iPad は「Mac」と名乗るのでタッチで判断）
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // 作るのに時間がかかると、スマホが「ボタンを押した直後ではない」として共有を断ることがある。
  // そのときは「もう一度押して保存・送る」に変えて、2回目の押下ですぐ共有する
  const ready = new WeakMap();
  async function share(btn, file) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'canceled';
      if (err && err.name === 'NotAllowedError') { ready.set(btn, file); return 'needTap'; }
      throw err;
    }
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pdf');
    if (!btn) return;
    const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
    const msg = btn.parentElement.querySelector('.pdf-msg');
    const say = (t) => { if (msg) msg.textContent = t; };

    const pending = ready.get(btn);
    if (pending) { // 2回目の押下：作ってあるPDFをすぐ共有
      ready.delete(btn); btn.textContent = label;
      try { await share(btn, pending); say(''); } catch (err) { download(pending, pending.name); say('共有できなかったので、ダウンロードしました。'); }
      return;
    }

    const paper = btn.closest('section').querySelector('.paper');
    btn.disabled = true; btn.textContent = 'PDFを作成中…'; say('');
    try {
      const name = fileName(btn.dataset.doc || '書類');
      const blob = await makePdf(paper);
      const file = new File([blob], name, { type: 'application/pdf' });
      if (isTouch() && navigator.canShare && navigator.canShare({ files: [file] })) {
        const r = await share(btn, file);
        if (r === 'needTap') { btn.textContent = '準備できました：もう一度押して保存・送る'; btn.disabled = false; return; }
      } else {
        download(blob, name);
        say(`「${name}」を保存しました。`);
      }
    } catch (err) {
      say('PDFを作れませんでした：' + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
      if (!ready.get(btn)) btn.textContent = label;
    }
  });
})();
