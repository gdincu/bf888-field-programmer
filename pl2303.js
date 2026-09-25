'use strict';
/* PL2303 (067B:2303 etc) user-space driver over WebUSB for Chrome Android.
 * Ported from tidepool-org/pl2303 (MIT, fork of andreasgal/usbserial) + Linux pl2303 startup.
 * Browser-correct: controlTransferIn returns {data: DataView, status}, endpoints discovered dynamically.
 * BF-888 use: 9600 8N1, small request/response packets -> buffered readExactly().
 */
(function (global) {
  const SUPPORTED_BAUD = [75, 150, 300, 600, 1200, 1800, 2400, 3600, 4800, 7200, 9600,
    14400, 19200, 28800, 38400, 57600, 115200, 230400, 460800];

  async function vendorRead(device, value, index) {
    const r = await device.controlTransferIn({
      requestType: 'vendor', recipient: 'device', request: 0x01, value, index,
    }, 1);
    if (!r || !r.data || r.data.byteLength < 1) throw new Error('PL2303 vendorRead empty');
    return r.data.getUint8(0);
  }
  async function vendorWrite(device, value, index) {
    await device.controlTransferOut({
      requestType: 'vendor', recipient: 'device', request: 0x01, value, index,
    });
  }
  async function setBaudrate(device, ifNum, baud) {
    const list = SUPPORTED_BAUD.slice().sort((a, b) => Math.abs(a - baud) - Math.abs(b - baud));
    const nb = list[0];
    // GET_LINE_CODING (throwaway, matches Linux + tidepool)
    await device.controlTransferIn({
      requestType: 'class', recipient: 'interface', request: 0x21, value: 0, index: ifNum,
    }, 7);
    const buf = new ArrayBuffer(7);
    const dv = new DataView(buf);
    dv.setInt32(0, nb, true);
    dv.setUint8(4, 0); // 1 stop bit
    dv.setUint8(5, 0); // no parity
    dv.setUint8(6, 8); // 8 bits
    await device.controlTransferOut({
      requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: ifNum,
    }, buf);
    await vendorWrite(device, 0x0, 0x0); // no flow control
    await vendorWrite(device, 8, 0); // reset upstream pipes
    await vendorWrite(device, 9, 0);
    return nb;
  }

  function findBulkEndpoints(device, ifNum) {
    const cfg = device.configuration;
    if (!cfg) return { inEp: 3, outEp: 2 };
    const iface = cfg.interfaces.find((i) => i.interfaceNumber === ifNum) || cfg.interfaces[0];
    const alt = (iface.alternates && iface.alternates[0]) || iface.alternate;
    let inEp = null, outEp = null;
    const eps = (alt && alt.endpoints) || [];
    for (const ep of eps) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in' && inEp == null) inEp = ep.endpointNumber;
      if (ep.direction === 'out' && outEp == null) outEp = ep.endpointNumber;
    }
    return { inEp: inEp != null ? inEp : 3, outEp: outEp != null ? outEp : 2 };
  }

  class Pl2303WebUsb {
    constructor(device, ifNum, epIn, epOut) {
      this.device = device;
      this.ifNum = ifNum;
      this.epIn = epIn;
      this.epOut = epOut;
      this.rx = []; // byte queue
      this.waiters = [];
      this.closed = false;
    }
    static async connect(device, baudRate, logFn) {
      const log = logFn || (() => {});
      await device.open();
      if (device.configuration == null) await device.selectConfiguration(1);
      const ifNum = (device.configuration.interfaces[0] || {}).interfaceNumber || 0;
      await device.claimInterface(ifNum);
      // Linux pl2303_startup sequence (also in tidepool driver)
      await vendorRead(device, 0x8484, 0);
      await vendorWrite(device, 0x0404, 0);
      await vendorRead(device, 0x8484, 0);
      await vendorRead(device, 0x8383, 0);
      await vendorRead(device, 0x8484, 0);
      await vendorWrite(device, 0x0404, 1);
      await vendorRead(device, 0x8484, 0);
      await vendorRead(device, 0x8383, 0);
      await vendorWrite(device, 0, 1);
      await vendorWrite(device, 1, 0);
      await vendorWrite(device, 2, 0x44);
      const nb = await setBaudrate(device, ifNum, baudRate || 9600);
      log(`PL2303 init OK @${nb} if#${ifNum}`);
      const { inEp, outEp } = findBulkEndpoints(device, ifNum);
      log(`PL2303 endpoints: bulk-in=${inEp} bulk-out=${outEp}`);
      const inst = new Pl2303WebUsb(device, ifNum, inEp, outEp);
      inst._pump();
      return inst;
    }
    _pushBytes(u8) {
      for (let i = 0; i < u8.length; i++) this.rx.push(u8[i]);
      while (this.waiters.length) this.waiters.shift()();
    }
    async _pump() {
      while (!this.closed) {
        let res;
        try {
          res = await this.device.transferIn(this.epIn, 64);
        } catch (e) {
          if (this.closed) break;
          // Stall / timeout: small backoff, then continue. Disconnect throws here too.
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        if (res && res.data && res.data.byteLength) {
          const u8 = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
          this._pushBytes(u8);
        }
      }
    }
    async writeBytes(u8) {
      const data = (u8 instanceof Uint8Array) ? u8 : new Uint8Array(u8);
      // PL2303 bulk-out max packet 64: chunk just in case
      for (let off = 0; off < data.length; off += 64) {
        const chunk = data.slice(off, off + 64);
        await this.device.transferOut(this.epOut, chunk);
      }
    }
    readBuffered(n) {
      if (this.rx.length < n) return null;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = this.rx.shift();
      return out;
    }
    async readExactly(n, timeoutMs = 1500) {
      const t0 = Date.now();
      while (true) {
        const got = this.readBuffered(n);
        if (got) return got;
        if (Date.now() - t0 > timeoutMs) throw new Error(`usb timeout (${this.rx.length}/${n} bytes)`);
        await new Promise((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 50); });
      }
    }
    async close() {
      this.closed = true;
      this.waiters.forEach((w) => { try { w(); } catch {} });
      this.waiters = [];
      try { await this.device.releaseInterface(this.ifNum); } catch {}
      try { await this.device.close(); } catch {}
      this.rx = [];
    }
  }

  global.Pl2303WebUsb = Pl2303WebUsb;
})(typeof window !== 'undefined' ? window : globalThis);
