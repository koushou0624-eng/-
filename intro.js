/* 起動時の動画（オープニング）
   ・設定でオンにした端末だけ、1日1回、最初に開いたときに流す（最初はオフ）
   ・音は最初は消してある（スマホは音つきの自動再生ができないため）。右下のボタンで音を出せる
   ・「スキップ」でいつでも飛ばせる */
(function () {
  const KEY = 'kaitai-jimu-intro'; // { off: true/false, last: 'YYYY-MM-DD' }
  const box = document.getElementById('intro');
  if (!box) return;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } };
  const write = (o) => { try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...o })); } catch (_) { /* noop */ } };
  const d = new Date(), today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const vids = [...box.querySelectorAll('video')];
  const sound = box.querySelector('.intro-sound'), skip = box.querySelector('.intro-skip'), tap = box.querySelector('.intro-tap');
  let idx = -1, done = false, safety = 0, muted = true;

  function finish() {
    if (done) return; done = true; clearTimeout(safety);
    vids.forEach((v) => { try { v.pause(); } catch (_) { /* noop */ } });
    box.classList.add('out');
    setTimeout(() => { box.hidden = true; vids.forEach((v) => { v.removeAttribute('src'); v.load(); }); document.documentElement.classList.remove('intro-on'); }, 450);
  }
  function play(i) {
    if (i >= vids.length) { finish(); return; }
    idx = i;
    vids.forEach((v, k) => v.classList.toggle('on', k === i));
    box.classList.toggle('bg', vids[i].classList.contains('wide'));
    const v = vids[i]; v.muted = muted; v.currentTime = 0;
    const p = v.play();
    if (p && p.catch) p.catch(() => { tap.hidden = false; }); // 省電力モードなどで自動再生できないとき
    if (vids[i + 1]) vids[i + 1].preload = 'auto';
  }
  function start(force) {
    const s = read();
    if (!force && (s.off !== false || s.last === today)) { box.hidden = true; return; } // 最初は止めてある（設定でオンにしたときだけ流す）
    write({ last: today });
    done = false; box.hidden = false; box.classList.remove('out');
    document.documentElement.classList.add('intro-on');
    vids.forEach((v, k) => {
      if (!v.getAttribute('src')) v.src = v.dataset.src;
      v.onended = () => play(k + 1);
      v.onerror = () => play(k + 1); // 動画が読めないときは次へ
    });
    clearTimeout(safety); safety = setTimeout(finish, 30000);
    play(0);
  }
  skip.addEventListener('click', finish);
  tap.addEventListener('click', () => { tap.hidden = true; vids[idx] && vids[idx].play().catch(finish); });
  sound.addEventListener('click', () => {
    muted = !muted; sound.classList.toggle('on', !muted); sound.setAttribute('aria-label', muted ? '音を出す' : '音を消す');
    if (vids[idx]) vids[idx].muted = muted;
  });
  window.KJIntro = {
    play: () => start(true),
    isOff: () => read().off !== false,
    setOff: (off) => write({ off: !!off }),
  };
  start(false);
})();
