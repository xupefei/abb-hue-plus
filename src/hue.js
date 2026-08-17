'use strict';
// Minimal Philips Hue CLIP v2 client. No external deps (SysAP add-on env is minimal).
// Talks to the bridge over HTTPS with the self-signed cert (rejectUnauthorized:false).

const https = require('https');
const { EventEmitter } = require('events');

class HueClient extends EventEmitter {
  /** @param {{ip:string, appKey:string}} opts */
  constructor({ ip, appKey }) {
    super();
    if (!ip || !appKey) throw new Error('HueClient requires ip and appKey');
    this.ip = ip;
    this.appKey = appKey;
    this._agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }

  _request(method, path, body) {
    const data = body != null ? JSON.stringify(body) : null;
    const options = {
      host: this.ip,
      port: 443,
      method,
      path,
      agent: this._agent,
      headers: {
        'hue-application-key': this.appKey,
        'Content-Type': 'application/json',
      },
    };
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed;
          try { parsed = buf ? JSON.parse(buf) : {}; }
          catch (e) { return reject(new Error(`Hue ${method} ${path}: bad JSON (${res.statusCode}): ${buf.slice(0, 200)}`)); }
          if (res.statusCode >= 400 || (parsed.errors && parsed.errors.length)) {
            return reject(new Error(`Hue ${method} ${path} -> ${res.statusCode}: ${JSON.stringify(parsed.errors || parsed)}`));
          }
          resolve(parsed);
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error(`Hue ${method} ${path}: timeout`)));
      if (data) req.write(data);
      req.end();
    });
  }

  /** Sanity-check connectivity; returns bridge config. */
  async getConfig() {
    // v1 endpoint returns unauthenticated bridge info
    return this._request('GET', '/api/config');
  }

  async listScenes() {
    const r = await this._request('GET', '/clip/v2/resource/scene');
    return r.data || [];
  }

  async listSmartScenes() {
    const r = await this._request('GET', '/clip/v2/resource/smart_scene');
    return r.data || [];
  }

  async listRooms() {
    const r = await this._request('GET', '/clip/v2/resource/room');
    return r.data || [];
  }

  async listZones() {
    const r = await this._request('GET', '/clip/v2/resource/zone');
    return r.data || [];
  }

  /** Map of grouped_light id -> boolean on-state for all groups. */
  async getGroupedLightStates() {
    const r = await this._request('GET', '/clip/v2/resource/grouped_light');
    const out = {};
    for (const gl of r.data || []) out[gl.id] = !!(gl.on && gl.on.on);
    return out;
  }

  /** Turn a grouped_light on or off (used to actually switch a room's lights off). */
  async setGroupedLight(groupedLightId, on) {
    return this._request('PUT', `/clip/v2/resource/grouped_light/${groupedLightId}`, {
      on: { on: !!on },
    });
  }

  /** Recall a static scene (turns the lights to that scene). */
  async recallScene(sceneId) {
    return this._request('PUT', `/clip/v2/resource/scene/${sceneId}`, {
      recall: { action: 'active' },
    });
  }

  /** Activate or deactivate a smart (dynamic) scene. */
  async setSmartScene(smartSceneId, active) {
    return this._request('PUT', `/clip/v2/resource/smart_scene/${smartSceneId}`, {
      recall: { action: active ? 'activate' : 'deactivate' },
    });
  }

  /**
   * Subscribe to the v2 event stream (Server-Sent Events).
   * Emits 'update' with each parsed event object, 'error' on stream failure.
   * Returns a stop() function.
   */
  subscribeEvents() {
    let stopped = false;
    let req;
    const connect = () => {
      if (stopped) return;
      const options = {
        host: this.ip, port: 443, method: 'GET',
        path: '/eventstream/clip/v2', agent: this._agent,
        headers: { 'hue-application-key': this.appKey, Accept: 'text/event-stream' },
      };
      req = https.request(options, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          // SSE events are separated by a blank line
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of raw.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  const events = JSON.parse(line.slice(6));
                  for (const ev of events) this.emit('update', ev);
                } catch (_) { /* ignore keep-alive/comment lines */ }
              }
            }
          }
        });
        res.on('end', () => { if (!stopped) setTimeout(connect, 2000); });
      });
      req.on('error', (e) => {
        this.emit('streamError', e);
        if (!stopped) setTimeout(connect, 3000);
      });
      req.end();
    };
    connect();
    return () => { stopped = true; if (req) req.destroy(); };
  }
}

module.exports = { HueClient };
