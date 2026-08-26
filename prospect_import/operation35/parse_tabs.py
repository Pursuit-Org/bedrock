import json, csv, os, re, sys

def unmd(s):
    s = s.replace('\\[','[').replace('\\]',']').replace('\\_','_')
    s = s.replace('\\>','>').replace('\\<','<').replace('\\-','-')
    s = s.replace('\\`','`').replace('\\*','*').replace('\\|','|')
    return s.strip()

def split_row(line):
    if not line.startswith('|'): return None
    # strip leading/trailing pipe then split
    inner = line.strip()
    if inner.endswith('|'): inner = inner[:-1]
    inner = inner[1:]
    return [unmd(c) for c in inner.split('|')]

def parse(path, outdir):
    c = json.load(open(path))['fileContent']
    lines = c.split('\n')
    os.makedirs(outdir, exist_ok=True)
    # tabs are separated by blank lines
    tabs, cur = [], []
    for l in lines:
        if l.strip()=='':
            if cur: tabs.append(cur); cur=[]
        else:
            cur.append(l)
    if cur: tabs.append(cur)
    manifest=[]
    for i,tab in enumerate(tabs):
        rows=[split_row(l) for l in tab]
        rows=[r for r in rows if r is not None]
        # drop alignment rows (all cells are :-: )
        rows=[r for r in rows if not all(x in (':-:','---',':--','--:','') for x in r) or any(x for x in r)]
        rows=[r for r in rows if not all(x in (':-:','---',':--','--:') for x in r if x)]
        fn=os.path.join(outdir, f'tab{i:02d}.csv')
        with open(fn,'w',newline='') as f:
            w=csv.writer(f)
            for r in rows: w.writerow(r)
        # guess title/header
        nonempty=[r for r in rows if any(x.strip() for x in r)]
        title = nonempty[0][0] if nonempty else ''
        manifest.append((i,len(rows),title[:80]))
    return manifest

m=parse('priority_raw.json','ptabs')
for i,n,t in m: print(f'tab{i:02d}  rows={n:5d}  {t}')
