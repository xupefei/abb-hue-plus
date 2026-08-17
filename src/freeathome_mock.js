'use strict';
// In-memory mock of FreeAtHomeClient with the same interface, for local testing
// without touching the real SysAP. Simulates virtual-device registration,
// datapoint writes, and a helper to inject "user toggled the switch" events.

const { EventEmitter } = require('events');

class FreeAtHomeMock extends EventEmitter {
  constructor() {
    super();
    this.devices = {};       // serial -> {displayname, nativeId, channels:{}}
    this.datapoints = {};    // "serial.ch.dp" -> value
    this._idCounter = 0;
    this.registrations = 0;  // count PUTs (to observe keepalive)
  }

  async getConfiguration() {
    return { '00000000-0000-0000-0000-000000000000': { sysapName: 'MOCK', devices: {} } };
  }

  async registerSwitch(serial, displayname, ttlSeconds = 300) {
    this.registrations++;
    if (!this.devices[serial]) {
      this._idCounter++;
      this.devices[serial] = { displayname, nativeId: `MOCK${String(this._idCounter).padStart(6, '0')}`, ttlSeconds };
    } else {
      this.devices[serial].displayname = displayname;
      this.devices[serial].ttlSeconds = ttlSeconds;
    }
    // mimic real SysAP response: native serial -> {serial: ourHandle}
    const nativeSerial = this.devices[serial].nativeId;
    return { '00000000-0000-0000-0000-000000000000': { devices: { [nativeSerial]: { serial } } } };
  }

  async setDatapoint(address, value) {
    this.datapoints[address] = String(value);
    return { result: 'OK' };
  }

  async getDatapoint(address) {
    return { '00000000-0000-0000-0000-000000000000': { values: [this.datapoints[address] ?? '0'] } };
  }

  connectWebSocket() {
    this._wsOpen = true;
    setImmediate(() => this.emit('open'));
    return () => { this._wsOpen = false; this.emit('close'); };
  }

  // --- test helper: simulate the f@h UI writing an input datapoint on a switch ---
  simulateSwitch(serial, on) {
    const address = `${serial}.ch0000.idp0000`;
    this.datapoints[address] = on ? '1' : '0';
    this.emit('datapoint', { address, value: on ? '1' : '0' });
  }
}

module.exports = { FreeAtHomeMock };
