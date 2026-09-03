import io, json, sys
PERM_ONLY = '--perm-ids' in sys.argv
text = []
for line in io.open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.rstrip('\r\n')
    if not line.startswith('data:'): continue
    try: d = json.loads(line[5:].strip())
    except Exception: continue
    ev, p = d.get('event'), d.get('payload') or {}
    if PERM_ONLY and ev != 'agent://permission':
        continue
    if ev == 'agent://step' and p.get('status') != 'running':
        print('  %-8s %-14s %-40s %s' % (p.get('status'), p.get('kind'), (p.get('title') or '')[:40],
              (p.get('error') or p.get('detail') or '').replace('\n',' ')[:88]))
    elif ev == 'agent://text':
        text.append(p.get('delta') or '')
    elif ev == 'agent://permission':
        if PERM_ONLY:
            print(p.get('id'))
        else:
            print('  PERMISSION %s' % json.dumps(p)[:200])
    elif ev == 'agent://done':
        print('  DONE elapsed=%sms %s tok/s model=%s changes=%s' % (p.get('elapsedMs'),
              round(p.get('tokensPerSec') or 0, 1), p.get('modelId'), len(p.get('changes') or [])))
if text and not PERM_ONLY: print('  ANSWER: %s' % ''.join(text).strip()[:700])
