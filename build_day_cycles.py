#!/usr/bin/env python3
"""Create a Hallway-style 4-phase 'Day Cycle' dynamic scene in every eligible room.
Missing building-block scenes (Concentrate/Bright/Relax/Rest) are created first,
using canonical values from hallway-scene-definitions.md.
Run with --apply to write; default is dry-run.
"""
import sys, json, urllib.request, ssl

KEY = open('.hue-credentials.json'); import json as _j
KEY = _j.load(open('.hue-credentials.json'))['application_key']
BASE = "https://BRIDGE_IP/clip/v2/resource"
CTX = ssl.create_default_context(); CTX.check_hostname=False; CTX.verify_mode=ssl.CERT_NONE
APPLY = '--apply' in sys.argv

# canonical scene specs (mirek, brightness) from the saved table
SPEC = {
    'Concentrate': (233, 100.0),
    'Bright':      (370, 100.0),
    'Relax':       (447, 56.25),
    'Rest':        (500, 35.0),
}
IMAGE = "eb014820-a902-4652-8ca7-6e29c03b87a1"  # smart-scene tile art
# per-scene public_image ids (from saved table) for the standalone scenes
SCENE_IMG = {
    'Concentrate': 'b90c8900-a6b7-422c-a5d3-e170187dbf8c',
    'Bright':      '732ff1d9-76a7-4630-aad0-c8acc499bb0b',
    'Relax':       'a1f7da49-d181-4328-abea-68c9dc4b5416',
    'Rest':        '11a09ad5-8d65-4e90-959b-f05981a9ab1b',
}
CYCLE = [('time', 7, 'Concentrate'), ('time', 13, 'Bright'),
         ('sunset', None, 'Relax'), ('time', 22, 'Rest')]

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{BASE}/{path}", data=data,
        headers={"hue-application-key": KEY, "Content-Type":"application/json"}, method=method)
    return json.load(urllib.request.urlopen(r, context=CTX))

def get(rtype):
    return req("GET", rtype)['data']

rooms = get('room')
lights = {l['id']: l for l in get('light')}
scenes = get('scene')
smarts = get('smart_scene')

from collections import defaultdict
room_scenes = defaultdict(dict)   # rid -> {name: sceneid}
for s in scenes: room_scenes[s['group']['rid']][s['metadata']['name']] = s['id']
room_smart = defaultdict(list)
for s in smarts: room_smart[s['group']['rid']].append(s['metadata']['name'])

SKIP = {'Storage'}  # 0 lights
def room_lights(r):
    devids = {c['rid'] for c in r['children']}
    return [l for l in lights.values() if l.get('owner',{}).get('rid') in devids]

def make_action(light, mirek, bri):
    act = {"on": {"on": True}}
    if 'dimming' in light: act['dimming'] = {"brightness": bri}
    if 'color_temperature' in light: act['color_temperature'] = {"mirek": mirek}
    return {"target": {"rid": light['id'], "rtype":"light"}, "action": act}

plan = []
for r in sorted(rooms, key=lambda x: x['metadata']['name']):
    name = r['metadata']['name']; rid = r['id']
    if name in SKIP: continue
    if room_smart.get(rid):
        plan.append((name, 'SKIP (already has smart scene: %s)' % room_smart[rid], [], None)); continue
    rl = room_lights(r)
    if len(rl) == 0:
        plan.append((name, 'SKIP (no lights)', [], None)); continue
    have = room_scenes.get(rid, {})
    to_create = [n for n in SPEC if n not in have]
    plan.append((name, 'BUILD', to_create, rid))

print(f"{'=== APPLY ===' if APPLY else '=== DRY RUN (no writes) ==='}")
for name, action, to_create, rid in plan:
    if action.startswith('SKIP'):
        print(f"  {name:<14} {action}")
    else:
        print(f"  {name:<14} create scenes: {to_create or 'none (all exist)'} + 'Day Cycle' smart_scene")

if not APPLY:
    print("\nRun again with --apply to execute.")
    sys.exit(0)

# ---- APPLY ----
print("\n--- executing ---")
for name, action, to_create, rid in plan:
    if not action.startswith('BUILD'): continue
    r = [x for x in rooms if x['id']==rid][0]
    rl = room_lights(r)
    have = dict(room_scenes.get(rid, {}))
    # create missing scenes
    for sname in to_create:
        mirek, bri = SPEC[sname]
        actions = [make_action(l, mirek, bri) for l in rl]
        body = {"type":"scene","metadata":{"name":sname,"image":{"rid":SCENE_IMG[sname],"rtype":"public_image"}},
                "group":{"rid":rid,"rtype":"room"},"actions":actions}
        res = req("POST","scene",body)
        if res.get('errors'):
            print(f"  {name}: FAILED scene {sname}: {res['errors']}"); continue
        have[sname] = res['data'][0]['rid']
        print(f"  {name}: created scene {sname}")
    # build smart_scene
    slots=[]
    for kind, hour, sname in CYCLE:
        st = {"kind":"sunset"} if kind=='sunset' else {"kind":"time","time":{"hour":hour,"minute":0,"second":0}}
        slots.append({"start_time":st,"target":{"rid":have[sname],"rtype":"scene"}})
    body={"type":"smart_scene","metadata":{"name":f"{name} Day Cycle","image":{"rid":IMAGE,"rtype":"public_image"}},
          "group":{"rid":rid,"rtype":"room"},
          "week_timeslots":[{"timeslots":slots,"recurrence":["sunday","monday","tuesday","wednesday","thursday","friday","saturday"]}],
          "transition_duration":60000}
    res=req("POST","smart_scene",body)
    print(f"  {name}: {'created Day Cycle -> '+res['data'][0]['rid'] if not res.get('errors') else 'FAILED smart: '+str(res['errors'])}")
print("done.")
