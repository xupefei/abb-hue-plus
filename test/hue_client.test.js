'use strict';
// Live test against the real bridge. Run: npm run test:hue
const fs = require('fs');
const path = require('path');
const { HueClient } = require('../src/hue');

const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.hue-credentials.json'), 'utf8'));

async function main() {
  const hue = new HueClient({ ip: creds.bridge_ip, appKey: creds.application_key });

  console.log('1) getConfig...');
  const cfg = await hue.getConfig();
  console.log('   bridge:', cfg.name, '| api', cfg.apiversion, '| id', cfg.bridgeid);

  console.log('2) list scenes + smart_scenes...');
  const [scenes, smarts, rooms, zones] = await Promise.all([
    hue.listScenes(), hue.listSmartScenes(), hue.listRooms(), hue.listZones(),
  ]);
  const groupName = {};
  for (const g of [...rooms, ...zones]) groupName[g.id] = g.metadata.name;
  console.log(`   ${scenes.length} scenes, ${smarts.length} smart_scenes, ${rooms.length} rooms, ${zones.length} zones`);
  console.log('   smart_scenes:');
  for (const s of smarts) {
    console.log(`     - ${s.metadata.name}  [${groupName[s.group.rid] || '?'}]  state=${s.state}  id=${s.id}`);
  }

  console.log('3) event stream: subscribe, toggle first Day Cycle, watch for update...');
  const target = smarts.find((s) => s.metadata.name.endsWith('Day Cycle'));
  if (!target) { console.log('   no Day Cycle found, skipping toggle'); return; }

  let sawUpdate = false;
  const stop = hue.subscribeEvents();
  hue.on('update', (ev) => {
    if (ev.type === 'update' && Array.isArray(ev.data)) {
      for (const d of ev.data) {
        if (d.id === target.id && d.type === 'smart_scene') {
          sawUpdate = true;
          console.log(`   [event] ${target.metadata.name} -> state=${d.state}`);
        }
      }
    }
  });
  hue.on('streamError', (e) => console.log('   [streamError]', e.message));

  await new Promise((r) => setTimeout(r, 800)); // let stream connect
  console.log(`   activating ${target.metadata.name}...`);
  await hue.setSmartScene(target.id, true);
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`   deactivating...`);
  await hue.setSmartScene(target.id, false);
  await new Promise((r) => setTimeout(r, 2500));
  stop();

  console.log(sawUpdate ? '   PASS: received state updates via event stream' : '   WARN: no event update seen (state may still have changed)');
  console.log('done.');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
