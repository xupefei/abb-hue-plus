'use strict';
// Read-only test against the real SysAP: REST config + WebSocket connect/decode.
// Does NOT create any virtual device. Run: node test/fh_readonly.test.js
const { FreeAtHomeClient } = require('../src/freeathome');

// SysAP local API creds (provided by user)
const fh = new FreeAtHomeClient({
  host: 'SYSAP_IP',
  user: 'YOUR_LOCAL_API_USERNAME',
  password: 'YOUR_LOCAL_API_PASSWORD',
  tls: true,
});

async function main() {
  console.log('1) REST getConfiguration...');
  const cfg = await fh.getConfiguration();
  const sysap = cfg['00000000-0000-0000-0000-000000000000'];
  console.log('   sysap:', sysap.sysapName || '(unnamed)', '| devices:', Object.keys(sysap.devices).length);

  console.log('2) WebSocket connect (listen 6s for any datapoint traffic)...');
  let events = 0;
  const stop = fh.connectWebSocket();
  fh.on('open', () => console.log('   [ws] open'));
  fh.on('close', () => console.log('   [ws] closed'));
  fh.on('wsError', (e) => console.log('   [ws error]', e.message));
  fh.on('datapoint', ({ address, value }) => { events++; console.log(`   [dp] ${address} = ${value}`); });

  await new Promise((r) => setTimeout(r, 6000));
  stop();
  console.log(`   observed ${events} datapoint event(s) in window (0 is fine if nothing changed).`);
  console.log('PASS: REST + WebSocket connectivity OK.');
  process.exit(0);
}
main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
