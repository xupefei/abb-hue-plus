// Minimal Philips Hue CLIP v2 client. No external deps (uses Node built-ins).
// Ported from the validated JS version. Talks to the bridge over HTTPS with the
// self-signed cert (rejectUnauthorized:false).

import * as https from 'https';
import { EventEmitter } from 'events';

export interface HueOpts { ip: string; appKey: string; }

export class HueClient extends EventEmitter {
  private ip: string;
  private appKey: string;
  private agent: https.Agent;

  constructor({ ip, appKey }: HueOpts) {
    super();
    if (!ip || !appKey) throw new Error('HueClient requires ip and appKey');
    this.ip = ip;
    this.appKey = appKey;
    this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }

  private request(method: string, path: string, body?: unknown): Promise<any> {
    const data = body != null ? JSON.stringify(body) : null;
    const options: https.RequestOptions = {
      host: this.ip, port: 443, method, path, agent: this.agent,
      headers: { 'hue-application-key': this.appKey, 'Content-Type': 'application/json' },
    };
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed: any;
          try { parsed = buf ? JSON.parse(buf) : {}; }
          catch { return reject(new Error(`Hue ${method} ${path}: bad JSON (${res.statusCode}): ${buf.slice(0, 200)}`)); }
          if ((res.statusCode ?? 0) >= 400 || (parsed.errors && parsed.errors.length)) {
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

  async getConfig(): Promise<any> { return this.request('GET', '/api/config'); }
  async listScenes(): Promise<any[]> { return (await this.request('GET', '/clip/v2/resource/scene')).data || []; }
  async listSmartScenes(): Promise<any[]> { return (await this.request('GET', '/clip/v2/resource/smart_scene')).data || []; }
  async listRooms(): Promise<any[]> { return (await this.request('GET', '/clip/v2/resource/room')).data || []; }
  async listZones(): Promise<any[]> { return (await this.request('GET', '/clip/v2/resource/zone')).data || []; }

  async getGroupedLightStates(): Promise<Record<string, boolean>> {
    const r = await this.request('GET', '/clip/v2/resource/grouped_light');
    const out: Record<string, boolean> = {};
    for (const gl of r.data || []) out[gl.id] = !!(gl.on && gl.on.on);
    return out;
  }

  async setGroupedLight(groupedLightId: string, on: boolean): Promise<any> {
    return this.request('PUT', `/clip/v2/resource/grouped_light/${groupedLightId}`, { on: { on: !!on } });
  }

  /** Set a group's brightness (0-100). Also turns it on if brightness > 0.
   *  transitionMs (optional) makes the bulb fade to the new level over that time. */
  async setGroupedLightBrightness(groupedLightId: string, brightness: number, transitionMs?: number): Promise<any> {
    const b = Math.max(0, Math.min(100, brightness));
    const body: any = { dimming: { brightness: b }, on: { on: b > 0 } };
    if (transitionMs != null) body.dynamics = { duration: Math.round(transitionMs) };
    return this.request('PUT', `/clip/v2/resource/grouped_light/${groupedLightId}`, body);
  }

  /** Start a native brightness ramp on a group ('up'|'down'), or 'stop' to halt it.
   *  The bridge ramps smoothly at its own safe rate — better than streaming setpoints. */
  async dimGroupedLightDelta(groupedLightId: string, action: 'up' | 'down' | 'stop', deltaPercent = 100, durationMs?: number): Promise<any> {
    const body: any = action === 'stop'
      ? { dimming_delta: { action: 'stop' } }
      : { on: { on: true }, dimming_delta: { action, brightness_delta: deltaPercent } };
    // duration controls ramp speed: full 0-100 sweep over durationMs. Longer = slower/finer.
    if (action !== 'stop' && durationMs != null) body.dynamics = { duration: Math.round(durationMs) };
    return this.request('PUT', `/clip/v2/resource/grouped_light/${groupedLightId}`, body);
  }

  /** Map of grouped_light id -> {on, brightness} for all groups. */
  async getGroupedLightFull(): Promise<Record<string, { on: boolean; brightness: number }>> {
    const r = await this.request('GET', '/clip/v2/resource/grouped_light');
    const out: Record<string, { on: boolean; brightness: number }> = {};
    for (const gl of r.data || []) {
      out[gl.id] = { on: !!(gl.on && gl.on.on), brightness: gl.dimming?.brightness ?? 100 };
    }
    return out;
  }

  async recallScene(sceneId: string): Promise<any> {
    return this.request('PUT', `/clip/v2/resource/scene/${sceneId}`, { recall: { action: 'active' } });
  }

  async setSmartScene(smartSceneId: string, active: boolean): Promise<any> {
    return this.request('PUT', `/clip/v2/resource/smart_scene/${smartSceneId}`, {
      recall: { action: active ? 'activate' : 'deactivate' },
    });
  }

  /** Subscribe to the v2 SSE event stream. Emits 'update' per event object. Returns stop(). */
  subscribeEvents(): () => void {
    let stopped = false;
    let req: import('http').ClientRequest | undefined;
    let backoff = 2000; // grows to a cap on repeated failures; resets once connected
    const MAX_BACKOFF = 60000;
    const reconnect = () => {
      if (stopped) return;
      const jitter = Math.floor(Math.random() * 1000);
      const delay = Math.min(backoff, MAX_BACKOFF) + jitter;
      backoff = Math.min(backoff * 2, MAX_BACKOFF); // exponential up to cap
      setTimeout(connect, delay);
    };
    const connect = () => {
      if (stopped) return;
      const options: https.RequestOptions = {
        host: this.ip, port: 443, method: 'GET', path: '/eventstream/clip/v2', agent: this.agent,
        headers: { 'hue-application-key': this.appKey, Accept: 'text/event-stream' },
      };
      req = https.request(options, (res) => {
        backoff = 2000; // connected OK -> reset backoff
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of raw.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  const events = JSON.parse(line.slice(6));
                  for (const ev of events) this.emit('update', ev);
                } catch { /* keep-alive/comment */ }
              }
            }
          }
        });
        res.on('end', reconnect);
      });
      req.on('error', (e) => { this.emit('streamError', e); reconnect(); });
      req.end();
    };
    connect();
    return () => { stopped = true; if (req) req.destroy(); };
  }
}
