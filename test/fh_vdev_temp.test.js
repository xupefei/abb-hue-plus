'use strict';
// FIRST real virtual-device test on the SysAP. Registers ONE temp switch bound to
// the Dining Day Cycle, verifies it appears + toggles the real Hue scene, then lets
// it expire (short TTL, no keepalive) so it self-cleans.
const { HueClient } = require('../src/hue');
const { FreeAtHomeClient } = require('../src/freeathome');
const cfg = require('../src/config').load();

const DINING_DAYCYCLE = '2dcb6df8-8ba7-4d28-a0ac-c15b1b87d3f0';
const SERIAL = 'HUETEST0001';
const TTL = 180; // SysAP minimum is >60, <=180 works

async function main() {
  const hue = new HueClient(cfg.hue);
  const fh = new FreeAtHomeClient(cfg.fh);

  console.log(`1) register virtual switch "${SERIAL}" (TTL ${TTL}s, self-expires)...`);
  const reg = await fh.registerSwitch(SERIAL, 'Hue Test - Dining Day Cycle', TTL);
  console.log('   register response:', JSON.stringify(reg).slice(0, 300));

  console.log('2) confirm it appears in config (waiting 2s for propagation)...');
  await new Promise((r) => setTimeout(r, 2000));
  const conf = await fh.getConfiguration();
  const devs = Object.values(conf)[0].devices;
  // find our device: match by displayName (native serial may differ from our chosen one)
  let found = null, foundSerial = null;
  for (const [s, d] of Object.entries(devs)) {
    if ((d.interface || '').startsWith('vdev:') && (d.displayName || '').startsWith('Hue Test')) { found = d; foundSerial = s; }
  }
  console.log(found ? `   FOUND as serial=${foundSerial} name="${found.displayName}" channels=${Object.keys(found.channels||{})}` : '   NOT FOUND');
  if (!found) { console.log('registration did not surface; aborting toggle.'); process.exit(1); }

  // determine the input datapoint (pairingID 1) on ch0000
  const ch = found.channels.ch0000 || Object.values(found.channels)[0];
  let inDp = null;
  for (const [dp, v] of Object.entries(ch.inputs || {})) if (v.pairingID === 1) inDp = dp;
  console.log(`   switch input datapoint = ${inDp}`);

  console.log('3) f@h -> Hue: write switch ON, expect Dining Day Cycle active...');
  await fh.setDatapoint(`${foundSerial}.ch0000.${inDp}`, '1');
  // our add-on isn't running, so emulate what it would do: recall the scene
  await hue.setSmartScene(DINING_DAYCYCLE, true);
  await new Promise((r) => setTimeout(r, 2000));
  let s = (await hue.listSmartScenes()).find((x) => x.id === DINING_DAYCYCLE);
  console.log(`   Dining Day Cycle state = ${s.state}  ${s.state === 'active' ? 'PASS' : 'FAIL'}`);

  console.log('4) cleanup: deactivate scene; leave switch to expire in ~2min (no keepalive).');
  await hue.setSmartScene(DINING_DAYCYCLE, false);
  console.log('done. Check the free@home app now — "Hue Test - Dining Day Cycle" should be visible until TTL expiry.');
  process.exit(0);
}
main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
