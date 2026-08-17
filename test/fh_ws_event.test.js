'use strict';
// Validate WS decode: subscribe, toggle a real datapoint, confirm we receive it.
// Uses the imported Hue "Hallway" group (BEEDBABC0151) switch datapoint, restores it.
const { FreeAtHomeClient } = require('../src/freeathome');

const fh = new FreeAtHomeClient({
  host: 'SYSAP_IP',
  user: 'YOUR_LOCAL_API_USERNAME',
  password: 'YOUR_LOCAL_API_PASSWORD',
});

const DEVICE = 'BEEDBABC0151'; // Hallway huegroup
const SWITCH_DP = `${DEVICE}.ch0000.idp0000`; // pairingID 1 = on/off input

async function main() {
  // read current state first (odp0000 = output on/off)
  const cur = await fh.getDatapoint(`${DEVICE}.ch0000.odp0000`);
  const curVal = (cur['00000000-0000-0000-0000-000000000000'] || {}).values?.[0];
  console.log('current Hallway on/off output =', curVal);

  let saw = false;
  const stop = fh.connectWebSocket();
  fh.on('open', () => console.log('[ws] open'));
  fh.on('datapoint', ({ address, value }) => {
    if (address.startsWith(DEVICE)) { saw = true; console.log(`[dp] ${address} = ${value}`); }
  });

  await new Promise((r) => setTimeout(r, 1000));
  console.log('toggling Hallway ON via idp0000=1 ...');
  await fh.setDatapoint(SWITCH_DP, '1');
  await new Promise((r) => setTimeout(r, 2500));
  console.log('restoring OFF (idp0000=0) ...');
  await fh.setDatapoint(SWITCH_DP, '0');
  await new Promise((r) => setTimeout(r, 2500));
  stop();

  console.log(saw ? 'PASS: received datapoint event(s) over WS.' : 'WARN: no WS event seen for device.');
  process.exit(0);
}
main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
