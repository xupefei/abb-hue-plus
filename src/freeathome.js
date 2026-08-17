'use strict';
// Minimal free@home local API client. No external deps.
// - REST: register virtual devices (SwitchingActuator), write datapoints.
// - WebSocket: listen for datapoint changes (switch commands from the f@h UI).
//
// The SysAP local API uses HTTP Basic auth. Virtual devices expire after `ttl`
// seconds unless re-registered, so callers must refresh periodically.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SYSAP_ALL = '00000000-0000-0000-0000-000000000000';

class FreeAtHomeClient extends EventEmitter {
  /**
   * @param {{host:string, user:string, password:string, tls?:boolean, sysap?:string}} opts
   */
  constructor({ host, user, password, tls = true, sysap = SYSAP_ALL }) {
    super();
    this.host = host;
    this.user = user;
    this.password = password;
    this.tls = tls;
    this.sysap = sysap;
    this._auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this._mod = tls ? https : http;
    this._agent = new this._mod.Agent({ rejectUnauthorized: false, keepAlive: true });
  }

  _request(method, path, body, contentType = 'application/json') {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const options = {
      host: this.host, port: this.tls ? 443 : 80, method, path, agent: this._agent,
      headers: { Authorization: this._auth, 'Content-Type': contentType },
    };
    return new Promise((resolve, reject) => {
      const req = this._mod.request(options, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`f@h ${method} ${path} -> ${res.statusCode}: ${buf.slice(0, 200)}`));
          try { resolve(buf ? JSON.parse(buf) : {}); }
          catch (_) { resolve(buf); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error(`f@h ${method} ${path}: timeout`)));
      if (data) req.write(data);
      req.end();
    });
  }

  getConfiguration() { return this._request('GET', '/fhapi/v1/api/rest/configuration'); }

  /**
   * Register (or refresh) a virtual SwitchingActuator.
   * @param {string} serial  caller-chosen serial (stable per scene)
   * @param {string} displayname
   * @param {number} ttlSeconds  device expires after this unless refreshed
   * @returns {Promise<object>} response (contains the assigned native device id)
   */
  registerSwitch(serial, displayname, ttlSeconds = 300) {
    const body = {
      type: 'SwitchingActuator',
      properties: { ttl: String(ttlSeconds), displayname },
    };
    return this._request('PUT', `/fhapi/v1/api/rest/virtualdevice/${this.sysap}/${serial}`, body);
  }

  /** Write an input/output datapoint. address = "serial.channel.datapoint" */
  setDatapoint(address, value) {
    return this._request(
      'PUT',
      `/fhapi/v1/api/rest/datapoint/${this.sysap}/${address}`,
      String(value),
      'text/plain',
    );
  }

  getDatapoint(address) {
    return this._request('GET', `/fhapi/v1/api/rest/datapoint/${this.sysap}/${address}`);
  }

  /**
   * Open the datapoint WebSocket. Emits:
   *  - 'datapoint' {address, value}   for each changed datapoint
   *  - 'raw' with the full message
   *  - 'open' / 'close' / 'wsError'
   * Returns stop().
   */
  connectWebSocket() {
    let stopped = false;
    let socket;
    const connect = () => {
      if (stopped) return;
      const key = crypto.randomBytes(16).toString('base64');
      const options = {
        host: this.host, port: this.tls ? 443 : 80, path: '/fhapi/v1/api/ws',
        agent: this._agent,
        headers: {
          Authorization: this._auth,
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      };
      const req = this._mod.request(options);
      req.on('upgrade', (res, sock) => {
        socket = sock;
        this.emit('open');
        let buf = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          let frame;
          while ((frame = decodeFrame(buf))) {
            buf = frame.rest;
            if (frame.opcode === 0x8) { sock.end(); return; } // close
            if (frame.opcode === 0x9) { sock.write(encodeFrame(frame.payload, 0xA)); continue; } // ping->pong
            if (frame.opcode === 0x1 || frame.opcode === 0x2) {
              try {
                const msg = JSON.parse(frame.payload.toString('utf8'));
                this.emit('raw', msg);
                const sysapMsg = msg[this.sysap] || Object.values(msg)[0] || {};
                const dps = sysapMsg.datapoints || {};
                for (const [address, value] of Object.entries(dps)) {
                  this.emit('datapoint', { address, value });
                }
              } catch (_) { /* ignore */ }
            }
          }
        });
        sock.on('close', () => { this.emit('close'); if (!stopped) setTimeout(connect, 2000); });
        sock.on('error', (e) => { this.emit('wsError', e); });
      });
      req.on('error', (e) => { this.emit('wsError', e); if (!stopped) setTimeout(connect, 3000); });
      req.end();
    };
    connect();
    return () => { stopped = true; if (socket) socket.destroy(); };
  }
}

// --- minimal RFC6455 frame codec (client sends masked; server sends unmasked) ---
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let maskKey;
  if (masked) { if (buf.length < offset + 4) return null; maskKey = buf.slice(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]; }
  return { opcode, payload, rest: buf.slice(offset + len) };
}

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, 0x80 | len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

module.exports = { FreeAtHomeClient, SYSAP_ALL };
