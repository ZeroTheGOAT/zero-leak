import io, json, sys
raw = io.open(sys.argv[1], encoding='utf-8', errors='replace').read()
for line in raw.split('\n'):
    line = line.strip()
    if not line.startswith('data:'):
        continue
    try:
        ev = json.loads(line[5:].strip())
    except Exception:
        continue
    pay = ev.get('payload') or {}
    for c in (pay.get('changes') or []):
        print('--- ' + c['path'] + '  grounding=' + json.dumps(c.get('grounding')))
        print(c['newContent'])
