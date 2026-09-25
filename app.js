'use strict';
/* BF-888 / H777 PWA — JS port of chirp/drivers/h777.py (CHIRP, GPL).
 * Protocol: 9600 8N1. Enter prog mode, 8-byte block R/W with ACK (0x06).
 * Memory: 0x03E0 bytes; channels at 0x0010, 16 x 16B; settings at 0x02B0/0x03C0.
 */

// ---------- constants (mirror h777.py, flag map verified vs Baofeng BF_V1_FH) ----------
const ACK = 0x06;
const BLOCK = 8;
const MEMSIZE = 0x03E0;
const CH_BASE = 0x0010, CH_COUNT = 16, CH_LEN = 16;
const SET_ADDR = 0x02B0, SET2_ADDR = 0x03C0;
// Write only what the UI manages. OEM skips <0x10 and writes a fixed model
// block at 0x03D0 — never overwrite header/model with 0xFF from a fresh image.
const RANGES = [[0x0010, 0x0110], [0x02B0, 0x02C0], [0x03C0, 0x03C8]];
// flag bits in channel byte 12 (MSB-first per CHIRP bitwise): skip 0x10, highpower 0x08, narrow 0x04, beatshift 0x02, bcl 0x01
const F_SKIP = 0x10, F_HIGH = 0x08, F_NARROW = 0x04, F_BEAT = 0x02, F_BCL = 0x01;
const DTCS_FLAG = 0x80, DTCS_REV = 0x40;
const TIMEOUTS = ['Off','30 seconds','60 seconds','90 seconds','120 seconds','150 seconds','180 seconds','210 seconds','240 seconds','270 seconds','300 seconds'];
const SIDEKEY = ['Off','Monitor','Transmit Power','Alarm'];

// ---------- tiny UI helpers ----------
const $ = (id) => document.getElementById(id);
const logEl = $('log'), barEl = $('bar'), statusEl = $('status');
function log(...a) { const m = a.join(' '); logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; if (/fail/i.test(m)) { const d = document.getElementById('logdetails'); if (d) d.open = true; } }
function setProg(cur, max, msg) { barEl.style.width = (100 * cur / max).toFixed(1) + '%'; statusEl.textContent = msg || ''; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- BCD codec (mirror chirp/bitwise.py lbcd) ----------
const bcdByteToDec = (b) => ((b >> 4) & 0xF) * 10 + (b & 0xF);
const decToBcdByte = (v) => (((Math.floor(v / 10) % 10) << 4) | (v % 10)) & 0xFF;
function lbcdToInt(bytes) { let v = 0, m = 1; for (const b of bytes) { v += bcdByteToDec(b) * m; m *= 100; } return v; }
function intToLbcd(val, n) { const o = []; for (let i = 0; i < n; i++) { o.push(decToBcdByte(val % 100)); val = Math.floor(val / 100); } return o; }
const isValidBcd = (b) => (b & 0xF) <= 9 && ((b >> 4) & 0xF) <= 9;

// tone decode mirrors H777Radio._decode_tone (mask flag bits on byte 2)
function decodeTone(b0, b1) {
  if (b0 === 0xFF && b1 === 0xFF) return { mode: '', value: null, pol: null };
  const isDtcs = (b1 & DTCS_FLAG) !== 0, isRev = (b1 & DTCS_REV) !== 0;
  const masked = [b0, b1 & 0x3F];
  // treat non-BCD as empty (erased/FF-ish images)
  if (!isValidBcd(masked[0]) || !isValidBcd(masked[1])) return { mode: '', value: null, pol: null };
  const v = lbcdToInt(masked);
  if (isDtcs) return { mode: 'DTCS', value: v, pol: isRev ? 'R' : 'N' };
  return { mode: 'Tone', value: v / 10, pol: null };
}
function encodeTone(mode, value, pol) {
  if (!mode) return [0xFF, 0xFF];
  if (mode === 'Tone') return intToLbcd(Math.round(value * 10), 2);
  const b = intToLbcd(value, 2);
  b[1] = (b[1] | DTCS_FLAG | (pol === 'R' ? DTCS_REV : 0)) & 0xFF;
  return b;
}
// combine tx/rx tones -> CHIRP tmode (mirror split_tone_decode, N polarity only for the simple UI)
function tonesToTmode(tx, rx) {
  if (!tx.mode && !rx.mode) return { tmode: 'None' };
  if (tx.mode === 'Tone' && !rx.mode) return { tmode: 'Tone', rtone: tx.value };
  if (tx.mode === 'Tone' && rx.mode === 'Tone' && tx.value === rx.value) return { tmode: 'TSQL', ctone: tx.value };
  if (tx.mode === 'DTCS' && rx.mode === 'DTCS' && tx.value === rx.value) return { tmode: 'DTCS', dtcs: tx.value };
  return { tmode: 'Cross', tx, rx }; // edited via JSON
}
function tmodeToTones(ch) {
  if (ch.tmode === 'Tone') return [{ mode: 'Tone', value: ch.rtone }, { mode: '', value: null }];
  if (ch.tmode === 'TSQL') return [{ mode: 'Tone', value: ch.ctone }, { mode: 'Tone', value: ch.ctone }];
  if (ch.tmode === 'DTCS') return [{ mode: 'DTCS', value: ch.dtcs, pol: 'N' }, { mode: 'DTCS', value: ch.dtcs, pol: 'N' }];
  if (ch.tmode === 'Cross') return [ch.tx || { mode: '' }, ch.rx || { mode: '' }];
  return [{ mode: '' }, { mode: '' }];
}

// ---------- image model ----------
let image = null; // Uint8Array(MEMSIZE)

function parseChannels() {
  const out = [];
  for (let n = 0; n < CH_COUNT; n++) {
    const o = CH_BASE + n * CH_LEN;
    const rxB = [...image.slice(o, o + 4)], txB = [...image.slice(o + 4, o + 8)];
    const rxRawEmpty = rxB.every(b => b === 0xFF);
    const rxHz = lbcdToInt(rxB) * 10;
    if (rxRawEmpty || rxHz === 0) { out.push({ number: n + 1, empty: true }); continue; }
    const txRawOff = txB.every(b => b === 0xFF);
    const txHz = txRawOff ? null : lbcdToInt(txB) * 10;
    const tx = decodeTone(image[o + 10], image[o + 11]);
    const rx = decodeTone(image[o + 8], image[o + 9]);
    const fl = image[o + 12];
    const tm = tonesToTmode(tx, rx);
    out.push({
      number: n + 1, empty: false, rxHz,
      txHz: txRawOff ? null : (txHz === rxHz ? rxHz : txHz),
      duplexOff: txRawOff,
      ...tm,
      power: (fl & F_HIGH) ? 'High' : 'Low',
      bw: (fl & F_NARROW) ? 'NFM' : 'FM',
      skip: !!(fl & F_SKIP),
      bcl: !(fl & F_BCL),          // inverted like CHIRP driver
      beatshift: !(fl & F_BEAT),   // inverted "scramble"
      flagHigh: fl & 0xE0,         // OEM bit7=Jmpfreq + unknown bits 6,5: preserve, never force
    });
  }
  return out;
}

function writeChannel(ch) {
  const o = CH_BASE + (ch.number - 1) * CH_LEN;
  if (ch.empty || !ch.rxHz) { image.fill(0xFF, o, o + CH_LEN); return; }
  const set = (off, bytes) => bytes.forEach((b, i) => { image[off + i] = b; });
  set(o, intToLbcd(Math.round(ch.rxHz / 10), 4));
  if (ch.duplexOff || ch.txHz == null) set(o + 4, [0xFF, 0xFF, 0xFF, 0xFF]);
  else set(o + 4, intToLbcd(Math.round(ch.txHz / 10), 4));
  const [tx, rx] = tmodeToTones(ch);
  const txB = encodeTone(tx.mode, tx.value, tx.pol);
  const rxB = encodeTone(rx.mode, rx.value, rx.pol);
  set(o + 10, txB); set(o + 8, rxB);
  let fl = image[o + 12];
  const bit = (m, on) => { fl = on ? (fl | m) : (fl & ~m); };
  bit(F_SKIP, !!ch.skip);
  bit(F_HIGH, ch.power === 'High');
  bit(F_NARROW, ch.bw === 'NFM');
  bit(F_BEAT, !ch.beatshift);
  bit(F_BCL, !ch.bcl);
  // Preserve OEM high bits (bit7=Jmpfreq, bits 6,5 unknown). New channels built
  // on a 0xFF image default them to 0; channels from a real read keep theirs.
  // Previously `fl &= ~0xE0` wiped Jmpfreq silently.
  fl = (fl & 0x1F) | ((ch.flagHigh | 0) & 0xE0);
  image[o + 12] = fl;
  image[o + 13] = 0xFF; image[o + 14] = 0xFF; image[o + 15] = 0xFF;
}

function parseSettings() {
  const s = SET_ADDR, s2 = SET2_ADDR;
  const g = (a) => image[a];
  return {
    voiceprompt: !!g(s), voicelanguage: g(s + 1), scan: !!g(s + 2),
    vox: !!g(s + 3), voxlevel: g(s + 4) + 1, voxinhibitonrx: !!g(s + 5),
    lowvolinhibittx: !!g(s + 6), highvolinhibittx: !!g(s + 7),
    alarm: !!g(s + 8), fmradio: !!g(s + 9),
    beep: !!(g(s2) & 0x01), batterysaver: !!(g(s2) & 0x02),
    squelchlevel: g(s2 + 1), sidekeyfunction: g(s2 + 2), timeouttimer: g(s2 + 3),
    scanmode: g(s2 + 7) & 0x01,
  };
}
function writeSettings(st) {
  const s = SET_ADDR, s2 = SET2_ADDR;
  const b = (v) => v ? 1 : 0;
  image[s] = b(st.voiceprompt); image[s + 1] = st.voicelanguage & 1; image[s + 2] = b(st.scan);
  image[s + 3] = b(st.vox); image[s + 4] = Math.min(4, Math.max(0, (st.voxlevel | 0) - 1));
  image[s + 5] = b(st.voxinhibitonrx); image[s + 6] = b(st.lowvolinhibittx);
  image[s + 7] = b(st.highvolinhibittx); image[s + 8] = b(st.alarm); image[s + 9] = b(st.fmradio);
  image[s2] = (image[s2] & 0xFC) | (b(st.beep) ? 0x01 : 0) | (b(st.batterysaver) ? 0x02 : 0);
  image[s2 + 1] = st.squelchlevel | 0; image[s2 + 2] = st.sidekeyfunction | 0;
  image[s2 + 3] = st.timeouttimer | 0; image[s2 + 7] = (image[s2 + 7] & 0xFE) | (st.scanmode & 1);
}

// ---------- Transports: Web Serial (desktop) + WebUSB PL2303 (Android) ----------
// Desktop OS claims USB-serial cables with its own driver (COM port), so WebUSB
// gets "Access denied" there — must use Web Serial. Android has no such driver,
// and its Web Serial list is Bluetooth-only — must use WebUSB.
let port = null, reader = null, writer = null; // Web Serial (desktop)
let usbPort = null; // Pl2303WebUsb instance (Android)
const hasSerial = 'serial' in navigator;
const hasUsb = 'usb' in navigator;
const isAndroid = /Android/i.test(navigator.userAgent || '');
$('compat').textContent = (hasSerial || hasUsb) ? 'ready' : 'no USB API';
$('compat').className = 'badge ' + ((hasSerial || hasUsb) ? 'ok' : 'err');
if (!hasSerial && !hasUsb) log('WARNING: no USB API. Use Chrome/Edge over HTTPS or localhost.');
if (hasSerial && !isAndroid) {
  navigator.serial.addEventListener('disconnect', (e) => {
    log('serial disconnect');
    if (port && e.target === port) closePort();
  });
}
if (hasUsb) {
  navigator.usb.getDevices().then((devs) => {
    if (devs && devs.length) log(`WebUSB already-paired devices: ${devs.length}`);
  }).catch(() => {});
  navigator.usb.addEventListener('connect', (e) => log('USB device plugged: ' + (e.device.productName || 'unknown')));
  navigator.usb.addEventListener('disconnect', (e) => {
    log('USB device unplugged');
    if (usbPort && e.device === usbPort.device) closePort();
  });
}
async function openSerialPort() {
  if (!hasSerial) throw new Error('Web Serial not available.');
  await closePort();
  try {
    port = await navigator.serial.requestPort({});
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'AbortError'))
      throw new Error('no port picked. If the list is empty, the OS has not exposed a COM port (driver/cable). Check Device Manager / dmesg.');
    throw e;
  }
  await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  reader = port.readable.getReader();
  writer = port.writable.getWriter();
  log('port open @9600 8N1 (Web Serial)');
}
async function openPort() {
  // Route by platform: Android -> raw WebUSB (serial list is BT-only there),
  // desktop -> OS COM port via Web Serial (WebUSB is blocked by the OS driver).
  if (isAndroid) return openUsbPort();
  if (hasSerial) return openSerialPort();
  return openUsbPort();
}
async function openUsbPort() {
  if (!hasUsb) throw new Error('WebUSB not available. Use Chrome/Edge over HTTPS or localhost.');
  if (typeof Pl2303WebUsb === 'undefined') throw new Error('PL2303 driver missing (pl2303.js not loaded).');
  await closePort();
  const filters = [{ vendorId: 0x067B }, { vendorId: 0x0403 }, { vendorId: 0x10C4 }, { vendorId: 0x1A86 }];
  let device;
  try {
    device = await navigator.usb.requestDevice({ filters });
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'AbortError'))
      throw new Error('no USB device picked. Plug cable into radio while OFF, plug USB into phone, press Cancel on the system popup, turn radio ON, then retry. Check chrome://device-log.');
    throw e;
  }
  log(`USB opening ${device.productName || '?'} ${fmtVidPid(device.vendorId, device.productId)}...`);
  usbPort = await Pl2303WebUsb.connect(device, 9600, log);
  log('USB port open @9600 8N1 (WebUSB PL2303)');
}
async function closePort() {
  try { reader && reader.releaseLock(); } catch {}
  try { writer && writer.releaseLock(); } catch {}
  try { port && await port.close(); } catch {}
  reader = writer = port = null;
  if (usbPort) { try { await usbPort.close(); } catch {} usbPort = null; }
}
async function writeBytes(u8) {
  if (usbPort) { await usbPort.writeBytes(u8); return; }
  if (!writer) throw new Error('no port open. Tap Connect first.');
  await writer.write(u8);
}
async function readExactly(n, timeoutMs = 1500) {
  if (usbPort) return usbPort.readExactly(n, timeoutMs);
  if (!reader) throw new Error('no port open. Tap Connect first.');
  const out = new Uint8Array(n); let got = 0;
  const t0 = Date.now();
  while (got < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`serial timeout (${got}/${n} bytes)`);
    const { value, done } = await reader.read();
    if (done) throw new Error('serial stream closed');
    if (!value || !value.length) continue;
    out.set(value.subarray(0, n - got), got);
    got += Math.min(value.length, n - got);
  }
  return out;
}
const hex = (u8) => [...u8].map(b => b.toString(16).padStart(2, '0')).join(' ');

async function enterProgModeOnce() {
  if (usbPort) usbPort.flush(); // drop stale PL2303 pump bytes from init
  await writeBytes(new Uint8Array([0x02]));
  await sleep(150); // BF-888 needs ~100ms (h777.py); 150ms is the value Read worked with — keep
  await writeBytes(new TextEncoder().encode('PROGRAM'));
  const a1 = await readExactly(1, 2500);
  if (a1[0] !== ACK) throw new Error('radio refused programming mode (no ACK, got 0x' + a1[0].toString(16) + ' — plug cable with radio OFF, then turn radio ON, volume up, cable fully seated, then retry)');
  await writeBytes(new Uint8Array([0x02]));
  const ident = await readExactly(8, 2500); // some BF-888 stagger ident bytes ~0.33s
  log('ident: ' + hex(ident));
  if (!new TextDecoder().encode && false) throw 0;
  const s = String.fromCharCode(...ident);
  if (!s.includes('P3107')) throw new Error('unexpected ident (not BF-888/H777?): ' + JSON.stringify(s));
  await writeBytes(new Uint8Array([ACK]));
  const a2 = await readExactly(1, 2500);
  if (a2[0] !== ACK) throw new Error('bad ACK after ident (got 0x' + a2[0].toString(16) + ')');
}
async function enterProgMode() {
  // Cheap PL2303 clones + phone OTG often drop the first PROGRAM attempt; retry with flush.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        log(`prog mode retry ${attempt}/3...`);
        if (usbPort) usbPort.flush();
        await sleep(300);
      }
      await enterProgModeOnce();
      return;
    } catch (e) {
      lastErr = e;
      log(`prog attempt ${attempt} failed: ${e.message}`);
    }
  }
  throw lastErr;
}
async function exitProgMode() { try { await writeBytes(new TextEncoder().encode('E')); } catch {} }
async function readBlock(addr) {
  await writeBytes(new Uint8Array([0x52, (addr >> 8) & 0xFF, addr & 0xFF, BLOCK])); // 'R'
  const r = await readExactly(4 + BLOCK);
  if (r[0] !== 0x57 || r[1] !== ((addr >> 8) & 0xFF) || r[2] !== (addr & 0xFF) || r[3] !== BLOCK)
    throw new Error(`bad read echo @${addr.toString(16)}: ${hex(r.slice(0, 4))}`);
  const data = r.slice(4);
  await writeBytes(new Uint8Array([ACK]));
  const a = await readExactly(1);
  if (a[0] !== ACK) throw new Error(`no ACK after read @${addr.toString(16)}`);
  return data;
}
async function writeBlock(addr, bytes8) {
  const pkt = new Uint8Array(4 + BLOCK);
  pkt[0] = 0x57; pkt[1] = (addr >> 8) & 0xFF; pkt[2] = addr & 0xFF; pkt[3] = BLOCK; // 'W'
  pkt.set(bytes8, 4);
  await writeBytes(pkt);
  let a;
  try {
    a = await readExactly(1, 2500); // writes can take ~0.3s on some units
  } catch (e) {
    throw new Error(`no ACK after write @${addr.toString(16)} (${e.message})`);
  }
  if (a[0] !== ACK) throw new Error(`no ACK after write @${addr.toString(16)} (got 0x${a[0].toString(16)})`);
  await sleep(40); // let clone EEPROM + PL2303 settle
}

async function doRead() {
  if (!port && !usbPort) await openPort();
  try {
    await enterProgMode();
    const buf = new Uint8Array(MEMSIZE);
    const total = MEMSIZE / BLOCK;
    for (let addr = 0, i = 0; addr < MEMSIZE; addr += BLOCK, i++) {
      buf.set(await readBlock(addr), addr);
      setProg(i + 1, total, `reading ${addr + BLOCK}/${MEMSIZE}`);
    }
    image = buf;
    renderAll();
    log('read OK: ' + MEMSIZE + ' bytes');
    $('btnWrite').disabled = false;
  } finally { await exitProgMode(); }
}

async function doWrite() {
  if (!image) { log('nothing to write'); return; }
  if (!port && !usbPort) await openPort();
  await sleep(300); // settle before first prog attempt on Write (radio exiting idle)
  try {
    await enterProgMode();
    let n = 0; const total = RANGES.reduce((a, [s, e]) => a + (e - s) / BLOCK, 0);
    for (const [s, e] of RANGES) {
      for (let addr = s; addr < e; addr += BLOCK) {
        await writeBlock(addr, image.slice(addr, addr + BLOCK));
        setProg(++n, total, `writing ${addr.toString(16)}`);
      }
    }
    log('write OK');
  } finally { await exitProgMode(); }
}

// ---------- UI: channels + settings ----------
const TONES_CTCSS = ['', '67.0','69.3','71.9','74.4','77.0','79.7','82.5','85.4','88.5','91.5','94.8','97.4','100.0','103.5','107.2','110.9','114.8','118.8','123.0','127.3','131.8','136.5','141.3','146.2','151.4','156.7','159.8','162.2','165.5','167.9','171.3','173.8','177.3','179.9','183.5','186.2','189.9','192.8','196.6','199.5','203.5','206.5','210.7','218.1','225.7','229.1','233.6','241.8','250.3','254.1'];
const TONES_DTCS = ['', '23','25','26','31','32','36','43','47','51','53','54','65','71','72','73','74','114','115','116','122','125','131','132','134','143','145','152','155','156','162','165','172','174','205','212','223','225','226','243','244','245','246','251','252','255','261','263','265','266','271','274','306','311','315','322','325','331','332','343','346','351','356','364','365','371','411','412','413','423','431','432','445','446','452','454','455','462','464','465','466','503','506','516','523','526','532','546','565','606','612','624','627','631','632','654','662','664','703','712','723','731','732','734','743','754'];

function toneSelects(ch) {
  // stacked phone UI: tone family + value side by side; Cross -> keep but flag
  const tmode = ch.tmode || 'None';
  if (tmode === 'Cross') return `<span class="badge warn">Cross (JSON)</span>`;
  const isD = tmode === 'DTCS';
  const list = isD ? TONES_DTCS : TONES_CTCSS;
  const cur = tmode === 'None' ? '' : String(tmode === 'Tone' ? ch.rtone.toFixed(1) : tmode === 'TSQL' ? ch.ctone.toFixed(1) : ch.dtcs);
  const opts = ['None', 'Tone', 'TSQL', 'DTCS'].map(m => `<option ${m === tmode ? 'selected' : ''}>${m}</option>`).join('');
  const vals = list.map(v => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v || '(none)'}</option>`).join('');
  return `<label>Tone<select data-n="${ch.number}" data-f="tmode">${opts}</select></label><label>Value<select data-n="${ch.number}" data-f="tval">${vals}</select></label>`;
}

function renderChannels() {
  const body = $('chbody'); body.innerHTML = '';
  const chs = image ? parseChannels() : Array.from({ length: 16 }, (_, i) => ({ number: i + 1, empty: true }));
  for (const ch of chs) {
    const card = document.createElement('div');
    card.className = 'ch-card';
    const rx = ch.empty ? '' : (ch.rxHz / 1e6).toFixed(4);
    const tx = ch.empty || ch.duplexOff || ch.txHz == null ? '' : (ch.txHz / 1e6).toFixed(4);
    const flags = ch.empty ? '' :
      `<div class="ch-flags">
        <label class="inline"><input type="checkbox" data-n="${ch.number}" data-f="bcl" ${ch.bcl ? 'checked' : ''}> BCL</label>
        <label class="inline"><input type="checkbox" data-n="${ch.number}" data-f="beatshift" ${ch.beatshift ? 'checked' : ''}> Scramble</label>
      </div>`;
    card.innerHTML = `<div class="ch-head"><span class="chnum">CH ${ch.number}</span>
      <label class="inline"><input type="checkbox" data-n="${ch.number}" data-f="skip" ${ch.skip ? 'checked' : ''}> Skip</label></div>
      <div class="ch-grid">
        <label>RX MHz<input class="freq mono" data-n="${ch.number}" data-f="rx" inputmode="decimal" placeholder="—" value="${rx}"></label>
        <label>TX MHz<input class="freq mono" data-n="${ch.number}" data-f="tx" inputmode="decimal" placeholder="RX-only" value="${tx}"></label>
      </div>
      <div class="ch-grid">${toneSelects(ch)}</div>
      <div class="ch-grid">
        <label>Power<select data-n="${ch.number}" data-f="power"><option ${ch.power !== 'High' ? 'selected' : ''}>Low</option><option ${ch.power === 'High' ? 'selected' : ''}>High</option></select></label>
        <label>Width<select data-n="${ch.number}" data-f="bw"><option ${ch.bw !== 'NFM' ? 'selected' : ''}>FM</option><option ${ch.bw === 'NFM' ? 'selected' : ''}>NFM</option></select></label>
      </div>
      ${flags}`;
    body.appendChild(card);
  }
}

function currentSettings() { return image ? parseSettings() : null; }

function renderSettings() {
  const el = $('settings'); el.innerHTML = '';
  const st = currentSettings() || { voiceprompt: true, voicelanguage: 0, scan: true, vox: false, voxlevel: 1, voxinhibitonrx: false, lowvolinhibittx: false, highvolinhibittx: false, alarm: true, fmradio: false, beep: true, batterysaver: true, squelchlevel: 5, sidekeyfunction: 1, timeouttimer: 0, scanmode: 0 };
  const chk = (k, t) => `<label class="inline"><input type="checkbox" data-s="${k}" ${st[k] ? 'checked' : ''}> ${t}</label>`;
  const num = (k, t, min, max) => `<label>${t}<input type="number" data-s="${k}" min="${min}" max="${max}" value="${st[k]}"></label>`;
  const sel = (k, t, opts) => `<label>${t}<select data-s="${k}">${opts.map((o, i) => `<option value="${i}" ${i === st[k] ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  el.innerHTML =
    chk('voiceprompt', 'Voice prompt') + chk('scan', 'Scan (ch16)') + chk('vox', 'VOX') +
    num('voxlevel', 'VOX level 1–5', 1, 5) + num('squelchlevel', 'Squelch 0–9', 0, 9) +
    chk('beep', 'Beep') + chk('batterysaver', 'Battery saver') + chk('fmradio', 'FM radio') + chk('alarm', 'Alarm') +
    chk('voxinhibitonrx', 'Inhibit VOX on RX') + chk('lowvolinhibittx', 'LowV inhibit TX') + chk('highvolinhibittx', 'HighV inhibit TX') +
    sel('voicelanguage', 'Voice lang', ['English', 'Chinese']) +
    sel('sidekeyfunction', 'Side key', SIDEKEY) +
    sel('timeouttimer', 'Timeout', TIMEOUTS) +
    sel('scanmode', 'Scan mode', ['Carrier', 'Time']);
}

function collectFormToImage() {
  if (!image) { image = new Uint8Array(MEMSIZE).fill(0xFF); }
  const chs = parseChannels();
  const byNum = Object.fromEntries(chs.map(c => [c.number, c]));
  document.querySelectorAll('#chbody [data-n]').forEach(inp => {
    const n = +inp.dataset.n, f = inp.dataset.f;
    const c = byNum[n] || (byNum[n] = { number: n, empty: true, tmode: 'None' });
    if (f === 'rx') {
      const v = parseFloat(inp.value);
      if (!inp.value || isNaN(v)) { if (f === 'rx') c.empty = true; }
      else { c.empty = false; c.rxHz = Math.round(v * 1e6); if (c.txHz == null && !c.duplexOff) c.txHz = c.rxHz; if (!c.tmode) c.tmode = 'None'; }
    } else if (f === 'tx') {
      const v = parseFloat(inp.value);
      if (!inp.value || isNaN(v)) { c.duplexOff = true; c.txHz = null; }
      else { c.duplexOff = false; c.txHz = Math.round(v * 1e6); }
    } else if (f === 'tmode') {
      c.tmode = inp.value;
      if (c.tmode === 'None') { delete c.rtone; delete c.ctone; delete c.dtcs; }
      if (c.tmode === 'Tone' && c.rtone == null) c.rtone = 88.5;
      if (c.tmode === 'TSQL' && c.ctone == null) c.ctone = 88.5;
      if (c.tmode === 'DTCS' && c.dtcs == null) c.dtcs = 23;
    } else if (f === 'tval') {
      const v = inp.value;
      if (c.tmode === 'Tone') c.rtone = parseFloat(v) || 88.5;
      else if (c.tmode === 'TSQL') c.ctone = parseFloat(v) || 88.5;
      else if (c.tmode === 'DTCS') c.dtcs = parseInt(v, 10) || 23;
    } else if (f === 'skip' || f === 'bcl' || f === 'beatshift') c[f] = inp.checked ?? inp.checked;
    else if (f === 'power' || f === 'bw') c[f] = inp.value;
    if ((f === 'skip' || f === 'power' || f === 'bw' || f === 'bcl' || f === 'beatshift') && c.empty && c.rxHz) c.empty = false;
  });
  for (const c of Object.values(byNum)) {
    if (c.empty) { writeChannel({ number: c.number, empty: true }); continue; }
    if (c.rxHz && (c.txHz == null && !c.duplexOff)) c.txHz = c.rxHz; // default simplex
    writeChannel({ number: c.number, empty: false, rxHz: c.rxHz, txHz: c.txHz, duplexOff: !!c.duplexOff, tmode: c.tmode || 'None', rtone: c.rtone, ctone: c.ctone, dtcs: c.dtcs, power: c.power || 'Low', bw: c.bw || 'FM', skip: !!c.skip, bcl: c.bcl !== false, beatshift: c.beatshift !== false, flagHigh: (c.flagHigh | 0) & 0xE0 });
  }
  // settings
  const st = parseSettingsSafe();
  document.querySelectorAll('#settings [data-s]').forEach(inp => {
    const k = inp.dataset.s;
    st[k] = inp.type === 'checkbox' ? inp.checked : (+inp.value);
  });
  writeSettings(st);
  renderAll(true); // re-render (keeps model canonical), preserving image
}
function parseSettingsSafe() { try { return parseSettings(); } catch { return { voiceprompt: true, voicelanguage: 0, scan: true, vox: false, voxlevel: 1, voxinhibitonrx: false, lowvolinhibittx: false, highvolinhibittx: false, alarm: true, fmradio: false, beep: true, batterysaver: true, squelchlevel: 5, sidekeyfunction: 1, timeouttimer: 0, scanmode: 0 }; } }

function renderAll(keepImage) { renderChannels(); renderSettings(); if (!keepImage) {} }

// ---------- export/import ----------
function toJSON() {
  collectFormToImage();
  return JSON.stringify({ radio: 'Baofeng BF-888', channels: parseChannels(), settings: parseSettings(), rawHex: [...image].map(b => b.toString(16).padStart(2, '0')).join('') }, null, 1);
}

// ---------- USB helpers ----------
const VID_NAME = { '0403': 'FTDI?', '067b': 'Prolific PL2303?', '10c4': 'SiLabs CP210x?', '1a86': 'WCH CH340?', '0483': 'ST CDC?', '2341': 'Arduino?' };
function fmtVidPid(vid, pid) {
  const v = (vid || 0).toString(16).padStart(4, '0'), p = (pid || 0).toString(16).padStart(4, '0');
  return `${v}:${p} (${VID_NAME[v.toLowerCase()] || 'unknown chip'})`;
}

// ---------- wiring ----------
$('btnConnect').onclick = async () => { try { await openPort(); log('connected. Now Read or Write.'); } catch (e) { log('connect failed: ' + e.message); } };
$('btnRead').onclick = async () => {
  $('btnRead').disabled = true;
  try { collectFormToImageLight(); await doRead(); } catch (e) { log('READ FAILED: ' + e.message); await closePort(); }
  $('btnRead').disabled = false;
};
// don't wipe a hand-filled form when pressing Read with no image yet: only push settings UI defaults, not channels
function collectFormToImageLight() { if (!image) return; collectFormToImage(); }
$('btnWrite').onclick = async () => {
  $('btnWrite').disabled = true;
  try { collectFormToImage(); await doWrite(); } catch (e) { log('WRITE FAILED: ' + e.message); await closePort(); }
  $('btnWrite').disabled = false;
};
$('btnExport').onclick = () => {
  const blob = new Blob([toJSON()], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bf888.json'; a.click();
};
$('btnImport').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const j = JSON.parse(await f.text());
  if (j.rawHex) { image = Uint8Array.from(j.rawHex.match(/../g).map(h => parseInt(h, 16))); }
  else {
    image = new Uint8Array(MEMSIZE).fill(0xFF);
    for (const c of j.channels || []) writeChannel(c);
    if (j.settings) writeSettings(j.settings);
  }
  renderAll(); $('btnWrite').disabled = false; log('imported ' + f.name);
};
document.addEventListener('change', (e) => {
  if (e.target.matches('#chbody select[data-f="tmode"]')) { collectFormToImage(); } // rebuild tone value list
});

renderAll();
