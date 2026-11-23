/* PNS Quét chuyển tuyến — giao diện app cho bưu tá.
 * Lưu trên máy (localStorage): cfg, name, batch (lô đang quét), outbox (lô chưa gửi được), routes.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- lưu trữ ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pns.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pns.' + k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } },
    del(k) { try { localStorage.removeItem('pns.' + k); } catch (e) { /* bỏ qua */ } },
  };
  let cfg = store.get('cfg', null);           // {u, t, s, title}
  let name = store.get('name', '');
  let routes = store.get('routes', []);
  let postmen = store.get('postmen', []);
  let batch = store.get('batch', { route: '', codes: [] });
  let outbox = store.get('outbox', []);       // [{route, codes, name, at}]
  const saveBatch = () => store.set('batch', batch);

  /* ---------------- mã bưu gửi S10 (2 chữ + 8 số + số kiểm + 2 chữ) ---------------- */
  function isS10(code) {
    const m = /^[A-Z]{2}(\d{8})(\d)[A-Z]{2}$/.exec(code);
    if (!m) return false;
    const w = [8, 6, 4, 2, 3, 5, 9, 7];
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += Number(m[1][i]) * w[i];
    let chk = 11 - (sum % 11);
    if (chk === 10) chk = 0;
    if (chk === 11) chk = 5;
    return chk === Number(m[2]);
  }
  const clean = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  /* ---------------- màn hình ---------------- */
  let screen = '';
  function show(id) {
    document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === id));
    screen = id;
    if (id !== 'sScan' && id !== 'sQr') Scanner.stop();
    window.scrollTo(0, 0);
  }
  function home() {
    if (!cfg) return show('sSetup');
    if (!name) return showWho();
    if (batch.route && batch.codes.length) return openScan(batch.route);
    showRoutes();
  }

  let toastTimer;
  function toast(msg, ms = 2200) {
    const t = $('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms);
  }

  // Hộp thoại to, dễ bấm. ask({msg, input?, yes?, no?}) -> Promise<false|true|string>
  function ask({ msg, input = false, yes = 'Đồng ý', no = 'Hủy', value = '' }) {
    return new Promise(resolve => {
      $('dlgMsg').textContent = msg;
      $('dlgYes').textContent = yes;
      $('dlgNo').textContent = no;
      $('dlgNo').style.display = no ? '' : 'none';
      const inp = $('dlgInput');
      inp.style.display = input ? '' : 'none';
      inp.value = value;
      $('dlg').classList.add('on');
      if (input) setTimeout(() => inp.focus(), 50);
      const done = v => {
        $('dlg').classList.remove('on');
        $('dlgYes').onclick = $('dlgNo').onclick = inp.onkeydown = null;
        resolve(v);
      };
      $('dlgYes').onclick = () => done(input ? inp.value : true);
      $('dlgNo').onclick = () => done(false);
      inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value); };
    });
  }

  /* ---------------- âm thanh / rung ---------------- */
  let actx;
  function beep(ok = true) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok ? 1500 : 320;
      o.type = ok ? 'sine' : 'square';
      g.gain.value = 0.25;
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (ok ? 0.09 : 0.25));
    } catch (e) { /* bỏ qua */ }
    try { navigator.vibrate && navigator.vibrate(ok ? 70 : [60, 60, 60]); } catch (e) { /* bỏ qua */ }
  }
  function flash(dup) {
    const f = $('flash');
    f.classList.toggle('dup', !!dup);
    f.classList.add('show');
    setTimeout(() => f.classList.remove('show'), 60);
  }

  /* ---------------- gọi web app ---------------- */
  async function api(action, extra = {}, post = false) {
    if (!cfg) throw new Error('Chưa cài đặt');
    let res;
    if (post) {
      res = await fetch(cfg.u, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ token: cfg.t, sheet: cfg.s, action }, extra)),
        redirect: 'follow',
      });
    } else {
      const q = new URLSearchParams(Object.assign({ token: cfg.t, sheet: cfg.s, action }, extra));
      res = await fetch(cfg.u + '?' + q.toString(), { redirect: 'follow' });
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('Máy chủ trả lời không đúng (kiểm tra mạng).'); }
    if (!data.ok) throw new Error(data.error || 'Lỗi máy chủ');
    return data;
  }

  async function loadConfig(quiet) {
    try {
      const d = await api('config');
      routes = d.routes || [];
      postmen = d.postmen || [];
      cfg.title = d.title || cfg.title || '';
      store.set('cfg', cfg); store.set('routes', routes); store.set('postmen', postmen);
      updateHeader();
      return true;
    } catch (e) {
      if (!quiet) await ask({ msg: 'Không tải được danh sách tuyến:\n' + e.message, no: '' });
      return false;
    }
  }

  /* ---------------- cài đặt bằng QR ---------------- */
  // Mã cài đặt dạng gọn: PNS1|<URL web app>|<token>|<ID hoặc link file kết quả>|<tên bưu cục>
  // (vẫn nhận dạng JSON {"u","t","s","n"})
  function parseSetup(text) {
    let o;
    const s = String(text || '').trim();
    if (s.startsWith('PNS1|')) {
      const p = s.split('|');
      const sheet = /^[a-zA-Z0-9_-]{20,}$/.test(p[3] || '') ? 'https://docs.google.com/spreadsheets/d/' + p[3] + '/edit' : p[3];
      o = { u: p[1], t: p[2], s: sheet, n: p.slice(4).join('|') };
    } else {
      try { o = JSON.parse(s); } catch (e) { return null; }
    }
    if (!o || !/^https:\/\/script\.google(usercontent)?\.com\//.test(o.u || '') || !o.t || !/\/spreadsheets\/d\//.test(o.s || '')) return null;
    return { u: o.u, t: o.t, s: o.s, title: o.n || '' };
  }
  async function applySetup(c) {
    cfg = c;
    store.set('cfg', cfg);
    toast('Đang tải danh sách tuyến…');
    const ok = await loadConfig();
    if (!ok) { cfg = null; store.del('cfg'); return show('sSetup'); }
    beep(true);
    toast('Đã cài đặt xong ✓', 1500);
    showWho();
  }
  function scanSetupQr() {
    show('sQr');
    $('qrHolder').appendChild($('camBox'));
    $('guide').classList.add('qr');
    $('camMsg').textContent = 'Đưa mã QR vào khung';
    Scanner.start('qr', text => {
      const c = parseSetup(text);
      if (!c) { $('camMsg').textContent = 'Không phải mã cài đặt, thử lại'; return false; }
      Scanner.stop();
      backCam();
      applySetup(c);
      return true;
    });
  }
  function backCam() {
    $('guide').classList.remove('qr');
    $('camMsg').textContent = 'Đưa mã vạch vào khung cam';
    const scan = $('sScan');
    scan.insertBefore($('camBox'), scan.querySelector('.counter'));
  }

  /* ---------------- chọn tên ---------------- */
  function showWho() {
    $('whoOffice').textContent = cfg && cfg.title ? 'Bưu cục: ' + cfg.title : '';
    $('whoList').innerHTML = postmen.map(p => `<button data-n="${esc(p)}">${esc(p)}</button>`).join('');
    $('whoInput').value = name || '';
    show('sWho');
  }
  function setName(n) {
    n = String(n || '').trim();
    if (!n) return toast('Hãy chọn hoặc gõ tên');
    name = n; store.set('name', name);
    updateHeader();
    home();
  }

  function updateHeader() {
    $('hTitle').textContent = name ? name : 'Quét chuyển tuyến';
  }

  /* ---------------- chọn tuyến ---------------- */
  function showRoutes() {
    renderOutbox();
    $('routeSearch').value = '';
    renderRoutes('');
    show('sHome');
    if (!routes.length) loadConfig(true).then(() => renderRoutes($('routeSearch').value));
  }
  const plain = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  function renderRoutes(q) {
    const k = plain(q.trim());
    const list = routes.filter(r => !k || plain(r).includes(k));
    const last = store.get('lastRoute', '');
    if (last && !k && list.includes(last)) { list.splice(list.indexOf(last), 1); list.unshift(last); }
    $('routeList').innerHTML = list.length
      ? list.map(r => {
          const i = r.indexOf(' - ');
          const label = i > 0 ? `${esc(r.slice(i + 3))} <span class="muted">${esc(r.slice(0, i))}</span>` : esc(r);
          return `<button data-r="${esc(r)}" class="${r === last ? 'sel' : ''}">${r === last ? '⭐ ' : ''}<b>${label}</b></button>`;
        }).join('')
      : `<div class="card muted">${routes.length ? 'Không thấy tuyến phù hợp' : 'Chưa có danh sách tuyến. Kiểm tra sheet "DS tuyen" trong file kết quả.'}</div>`;
  }
  function openScan(route) {
    // Đổi tuyến khi đang có mã: giữ nguyên các mã đã quét, chỉ đổi tuyến đích
    if (batch.route !== route) { batch.route = route; saveBatch(); }
    store.set('lastRoute', route);
    $('scanRoute').textContent = route;
    backCam();
    renderCodes();
    show('sScan');
    startBarcode();
  }

  /* ---------------- quét bưu gửi ---------------- */
  const recent = {}; // chống kêu liên tục cùng 1 mã
  function startBarcode() {
    Scanner.start('bar', raw => {
      const code = clean(raw);
      if (!isS10(code)) return false;            // mã khác (SĐT, mã bưu chính…) hoặc đọc sai -> bỏ qua
      const now = Date.now();
      if (recent[code] && now - recent[code] < 2500) return false;
      recent[code] = now;
      addCode(code, false);
      return false; // tiếp tục quét
    });
  }
  function addCode(code, manual) {
    if (batch.codes.includes(code)) {
      beep(false); flash(true);
      toast('Đã quét rồi: ' + code, 1500);
      return false;
    }
    batch.codes.unshift(code);
    saveBatch();
    beep(true); if (!manual) flash(false);
    renderCodes(code);
    return true;
  }
  function renderCodes(last) {
    const n = batch.codes.length;
    $('count').textContent = n;
    $('lastCode').textContent = last || batch.codes[0] || '';
    $('btnSend').disabled = !n;
    $('btnSend').textContent = n ? `Gửi (${n})` : 'Gửi';
    $('btnClear').style.display = n ? '' : 'none';
    $('codeList').innerHTML = batch.codes.map(c => `<li><span>${esc(c)}</span><button data-c="${esc(c)}">✕</button></li>`).join('');
  }
  async function manualEntry() {
    const v = await ask({ msg: 'Gõ mã bưu gửi (VD: CK378214727VN)', input: true, yes: 'Thêm' });
    if (v === false) return;
    const code = clean(v);
    if (!code) return;
    if (!isS10(code)) {
      const ok = await ask({ msg: `Mã "${code}" có vẻ không đúng (sai định dạng hoặc số kiểm).\nVẫn thêm?`, yes: 'Vẫn thêm' });
      if (!ok) return;
    }
    addCode(code, true);
  }

  /* ---------------- gửi ---------------- */
  async function send() {
    const n = batch.codes.length;
    if (!n) return;
    const ok = await ask({ msg: `Gửi yêu cầu chuyển ${n} bưu gửi\nsang tuyến:\n${batch.route}?`, yes: 'Gửi' });
    if (!ok) return;
    Scanner.stop();
    const job = { route: batch.route, codes: batch.codes.slice().reverse(), name, at: Date.now() };
    $('btnSend').disabled = true; $('btnSend').textContent = 'Đang gửi…';
    try {
      const r = await api('submit', { name: job.name, route: job.route, codes: job.codes }, true);
      batch = { route: batch.route, codes: [] }; saveBatch();
      showDone(job, r);
    } catch (e) {
      outbox.push(job); store.set('outbox', outbox);
      batch = { route: batch.route, codes: [] }; saveBatch();
      $('doneBox').className = 'card warn';
      $('doneBox').innerHTML = `<b>Chưa gửi được</b> (${esc(e.message)})<br>${job.codes.length} bưu gửi đã được <b>lưu trong máy</b>. App sẽ tự gửi lại khi có mạng.`;
      show('sDone');
    }
  }
  function showDone(job, r) {
    const dup = r.dup || [];
    $('doneBox').className = 'card okbox';
    $('doneBox').innerHTML =
      (r.added ? `<b>✅ Đã gửi ${r.added} bưu gửi</b><br>sang tuyến <b>${esc(job.route)}</b>.<br><span class="muted">Nhân viên nghiệp vụ sẽ chuyển trên PNS.</span>` : '<b>Không có mã mới để gửi.</b>') +
      (dup.length ? `<div class="card warn" style="margin-top:10px">${dup.length} mã đã có người xin chuyển trước đó, không gửi lại:<br>` +
        dup.map(d => `<span style="font-family:monospace">${esc(d.code)}</span> → ${esc(d.route)}`).join('<br>') + '</div>' : '');
    beep(true);
    show('sDone');
  }
  async function flushOutbox() {
    if (!outbox.length || !navigator.onLine) return;
    const left = [];
    let sent = 0;
    for (const job of outbox) {
      try { const r = await api('submit', { name: job.name, route: job.route, codes: job.codes }, true); sent += r.added || 0; }
      catch (e) { left.push(job); }
    }
    outbox = left; store.set('outbox', outbox);
    if (sent) toast(`Đã gửi lại ${sent} bưu gửi lưu trong máy`);
    renderOutbox();
  }
  function renderOutbox() {
    const n = outbox.reduce((a, j) => a + j.codes.length, 0);
    const box = $('outboxCard');
    box.style.display = n ? '' : 'none';
    box.className = 'card warn';
    box.innerHTML = n ? `⏳ Còn <b>${n}</b> bưu gửi chưa gửi được (mất mạng). <button class="big sec" id="btnFlush">Gửi lại ngay</button>` : '';
    if (n) $('btnFlush').onclick = flushOutbox;
  }

  /* ---------------- yêu cầu của tôi ---------------- */
  async function showMine() {
    if (!cfg || !name) return home();
    $('mineWho').textContent = '· ' + name;
    $('mineList').innerHTML = '<div class="card muted">Đang tải…</div>';
    show('sMine');
    try {
      const d = await api('mine', { name });
      $('mineList').innerHTML = d.items.length ? d.items.map(it => {
        const done = it.status === 'Đã chuyển';
        return `<div class="card"><div class="status ${done ? 'done' : 'wait'}">${done ? '✅' : '⏳'} ${esc(it.status)}${done && it.doneAt ? ' · ' + esc(it.doneAt) : ''}</div>
          <div>${it.count} bưu gửi → <b>${esc(it.route)}</b></div>
          <div class="muted">Gửi lúc ${esc(it.time)}${it.note && it.note !== 'Gửi từ app' ? ' · ' + esc(it.note) : ''}</div></div>`;
      }).join('') : '<div class="card muted">Chưa có yêu cầu nào.</div>';
    } catch (e) {
      $('mineList').innerHTML = `<div class="card warn">Không tải được: ${esc(e.message)}</div>`;
    }
  }

  /* ---------------- cài đặt ---------------- */
  function showGear() {
    $('gearInfo').innerHTML = cfg
      ? `<div><b>Bưu cục:</b> ${esc(cfg.title || '—')}</div><div><b>Bưu tá:</b> ${esc(name || '—')}</div><div class="muted">${routes.length} tuyến</div>`
      : 'Chưa cài đặt';
    show('sGear');
  }

  /* ---------------- máy quét (camera) ---------------- */
  const Scanner = (() => {
    let stream = null, timer = null, mode = '', cb = null, busy = false, detector = null, reader = null;
    const video = $('video');
    const canvas = document.createElement('canvas');
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

    async function makeDetector(m) {
      if ('BarcodeDetector' in window) {
        try {
          const fm = await window.BarcodeDetector.getSupportedFormats();
          const want = m === 'qr' ? ['qr_code'] : ['code_128', 'code_39'];
          const use = want.filter(f => fm.includes(f));
          if (use.length) return { native: new window.BarcodeDetector({ formats: use }) };
        } catch (e) { /* dùng ZXing */ }
      }
      const Z = window.ZXing;
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, m === 'qr' ? [Z.BarcodeFormat.QR_CODE] : [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      const r = new Z.MultiFormatReader();
      r.setHints(hints);
      return { zxing: r };
    }

    function grabFrame() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      // vùng khung cam: mã vạch = dải ngang giữa; QR = hình vuông giữa
      let sx, sy, sw, sh;
      if (mode === 'qr') { sw = sh = Math.min(vw, vh) * 0.8; sx = (vw - sw) / 2; sy = (vh - sh) / 2; }
      else { sw = vw * 0.92; sh = vh * 0.5; sx = (vw - sw) / 2; sy = (vh - sh) / 2; }
      const scale = Math.min(1, 1000 / sw);
      canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
      ctx2d.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    const small = document.createElement('canvas');
    const ctxSmall = small.getContext('2d', { willReadFrequently: true });
    function zxDecode(src, scale) {
      const Z = window.ZXing;
      let cv = src, cx = ctx2d;
      if (scale !== 1) {
        small.width = Math.round(src.width * scale); small.height = Math.round(src.height * scale);
        ctxSmall.drawImage(src, 0, 0, small.width, small.height);
        cv = small; cx = ctxSmall;
      }
      const img = cx.getImageData(0, 0, cv.width, cv.height).data;
      const lum = new Uint8ClampedArray(cv.width * cv.height);
      for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (img[i] * 77 + img[i + 1] * 150 + img[i + 2] * 29) >> 8;
      try {
        const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, cv.width, cv.height)));
        return detector.zxing.decodeWithState(bmp).getText();
      } catch (e) {
        return null; // không thấy mã
      } finally {
        detector.zxing.reset();
      }
    }

    async function tick() {
      if (!stream || busy) return;
      busy = true;
      try {
        const c = grabFrame();
        if (c) {
          let texts = [];
          if (detector.native) {
            const res = await detector.native.detect(c);
            texts = res.map(r => r.rawValue);
          } else {
            // QR: thử vài cỡ ảnh vì ZXing đọc QR nhạy với tỉ lệ phóng
            const scales = mode === 'qr' ? [1, 0.7, 0.5, 0.85] : [1];
            for (const s of scales) {
              const t = zxDecode(c, s);
              if (t) { texts = [t]; break; }
            }
          }
          for (const t of texts) { if (cb && cb(t)) break; }
        }
      } catch (e) { /* bỏ qua khung hình lỗi */ }
      busy = false;
    }

    async function start(m, onText) {
      stop();
      mode = m; cb = onText;
      try {
        detector = await makeDetector(m);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        video.srcObject = stream;
        await video.play();
        // bật tự lấy nét liên tục nếu máy hỗ trợ
        try {
          const tr = stream.getVideoTracks()[0];
          const cap = tr.getCapabilities ? tr.getCapabilities() : {};
          if (cap.focusMode && cap.focusMode.includes('continuous')) await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (e) { /* bỏ qua */ }
        timer = setInterval(tick, 130);
      } catch (e) {
        stop();
        $('camMsg').textContent = 'Không mở được camera';
        ask({ msg: 'Không mở được camera.\nHãy cho phép app dùng camera (Cài đặt điện thoại > Ứng dụng > PNS Quét > Quyền).', no: '' });
      }
    }
    function stop() {
      clearInterval(timer); timer = null;
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null; cb = null;
      try { video.srcObject = null; } catch (e) { /* bỏ qua */ }
    }
    return { start, stop };
  })();

  /* ---------------- gắn sự kiện ---------------- */
  $('btnScanSetup').onclick = scanSetupQr;
  $('btnQrCancel').onclick = () => { Scanner.stop(); backCam(); home(); };
  $('btnSetupText').onclick = () => {
    const c = parseSetup($('setupText').value);
    if (!c) return ask({ msg: 'Mã cài đặt không đúng.', no: '' });
    applySetup(c);
  };
  $('whoList').onclick = e => { const b = e.target.closest('button'); if (b) setName(b.dataset.n); };
  $('btnWhoSave').onclick = () => setName($('whoInput').value);
  $('routeSearch').oninput = e => renderRoutes(e.target.value);
  $('routeList').onclick = e => { const b = e.target.closest('button'); if (b) openScan(b.dataset.r); };
  $('btnChangeRoute').onclick = () => { Scanner.stop(); showRoutes(); };
  $('btnManual').onclick = manualEntry;
  $('btnSend').onclick = send;
  $('btnClear').onclick = async () => {
    if (await ask({ msg: `Xóa hết ${batch.codes.length} mã đã quét?`, yes: 'Xóa hết' })) {
      batch.codes = []; saveBatch(); renderCodes();
    }
  };
  $('codeList').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (await ask({ msg: 'Bỏ mã ' + b.dataset.c + '?', yes: 'Bỏ' })) {
      batch.codes = batch.codes.filter(c => c !== b.dataset.c); saveBatch(); renderCodes();
    }
  };
  $('btnAgain').onclick = () => {
    const r = batch.route || store.get('lastRoute', '');
    if (r && routes.includes(r)) openScan(r); else showRoutes();
  };
  $('btnDoneMine').onclick = showMine;
  $('btnMine').onclick = showMine;
  $('btnMineBack').onclick = home;
  $('btnGear').onclick = showGear;
  $('btnGearBack').onclick = home;
  $('btnGearName').onclick = () => { if (cfg) showWho(); };
  $('btnGearReload').onclick = async () => { if (await loadConfig()) { toast(`Đã tải ${routes.length} tuyến`); showGear(); } };
  $('btnGearReset').onclick = async () => {
    if (!(await ask({ msg: 'Xóa cài đặt và quét mã QR mới?', yes: 'Cài lại' }))) return;
    cfg = null; store.del('cfg'); store.del('routes'); store.del('postmen');
    routes = []; postmen = [];
    show('sSetup');
  };
  // nút Back của Android (MainActivity gọi window.onAndroidBack)
  window.onAndroidBack = () => {
    if ($('dlg').classList.contains('on')) { $('dlgNo').click(); return true; }
    if (screen === 'sHome' || screen === 'sSetup') return false;   // thoát app
    if (screen === 'sScan') { Scanner.stop(); showRoutes(); return true; }
    if (screen === 'sQr') { Scanner.stop(); backCam(); home(); return true; }
    home(); return true;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) Scanner.stop();
    else if (screen === 'sScan') startBarcode();
  });
  window.addEventListener('online', flushOutbox);
  setInterval(flushOutbox, 60000);

  // Cho phép test logic
  window.__pns = { isS10, parseSetup };

  updateHeader();
  home();
  flushOutbox();
})();
