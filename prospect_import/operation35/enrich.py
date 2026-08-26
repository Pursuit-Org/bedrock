import json, csv, re, collections, glob

# ---------- normalization ----------
STOP = r'\b(inc|inc\.|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|group|holdings|holding|plc|lp|llp|the|and|&|nyc|usa|us)\b'
def norm(s):
    if not s: return ''
    s = s.lower().strip()
    s = s.replace('&',' and ')
    s = re.sub(r'\(.*?\)', ' ', s)          # drop parentheticals
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    s = re.sub(STOP, ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def clean(s):
    if s is None: return ''
    s = str(s).replace('\\~','~').replace('\\-','-').replace('\\_','_')
    s = s.replace('\\','').strip()
    return s

# ---------- canonical band ----------
def to_band(exact):
    """map an exact integer headcount to the 4-band vocabulary"""
    if exact is None: return ''
    if exact < 50: return 'Under 50'
    if exact < 300: return '50-300'
    if exact < 1000: return '300-1,000'
    return '1,000+'

CANON = {'under 50':'Under 50','50-300':'50-300','300-1,000':'300-1,000','300-1000':'300-1,000','1,000+':'1,000+','1000+':'1,000+'}
# LinkedIn / PDL raw bands -> canonical (midpoint logic)
LI_BAND = {
 '1-10':'Under 50','2-10':'Under 50','~1-10':'Under 50','11-50':'Under 50',
 '51-200':'50-300','201-500':'300-1,000','201-1000':'300-1,000',
 '501-1000':'300-1,000','500-1000':'300-1,000','1001-5000':'1,000+','5000+':'1,000+','5001-10000':'1,000+','10001+':'1,000+',
}
def parse_headcount(raw):
    """returns (exact:int|None, band:str|None) from a messy cell"""
    s = clean(raw)
    if not s: return (None,None)
    low = s.lower().strip()
    if low in ('yes','no','needs research','unconfirmed','investor','core','0',''): return (None,None)
    if low in CANON: return (None, CANON[low])
    if low in LI_BAND: return (None, LI_BAND[low])
    # "50-300 (sweet spot)"
    for k,v in CANON.items():
        if low.startswith(k): return (None,v)
    # a plain / approx number, possibly with commas
    m = re.match(r'^~?\s*([\d,]+)\s*\+?$', low)
    if m:
        n = int(m.group(1).replace(',',''))
        return (n, to_band(n))
    # leading approx number in a longer phrase e.g. "~500 (acquiring company ...)"
    m = re.match(r'^~?\s*([\d,]+)\b', low)
    if m:
        n = int(m.group(1).replace(',',''))
        if n > 0: return (n, to_band(n))
    return (None,None)

TRI_OK = {'yes':'Yes','no':'No','remote':'Remote','unknown':'Unknown'}
def parse_tri(raw):
    s = clean(raw).lower().strip()
    if not s: return ''
    if s in TRI_OK: return TRI_OK[s]
    if s.startswith('yes'): return 'Yes'
    if s.startswith('no'): return 'No'
    if 'remote' in s: return 'Remote'
    return ''

# ---------- load tabs ----------
def load(fn, hrow=0):
    rows=list(csv.reader(open(fn)))
    hdr=[clean(c) for c in rows[hrow]]
    out=[]
    for r in rows[hrow+1:]:
        if not any(c.strip() for c in r): continue
        d={hdr[i]:clean(r[i]) for i in range(min(len(hdr),len(r))) if hdr[i]}
        out.append(d)
    return out

T = {}
for i,hrow in [(0,0),(1,0),(2,0),(3,0),(4,0),(8,0),(9,0),(10,1),(11,0),(12,0),(13,0),(15,0)]:
    T[i]=load(f'ptabs/tab{i:02d}.csv', hrow)

# ---------- hires ----------
hires={}
with open('t1.csv') as f:
    rr=list(csv.reader(f))
# find header row
hi=[i for i,r in enumerate(rr) if r and r[0].strip()=='Company'][0]
hh=rr[hi]
for r in rr[hi+1:]:
    if not r or not r[0].strip(): continue
    d=dict(zip(hh,r))
    co=d['Company'].strip()
    try: n=int(d['Builders Hired'].strip() or 0)
    except: n=0
    k=norm(co)
    if not k: continue
    if k not in hires or n>hires[k]['n']:
        hires[k]={'company':co,'n':n,'first':d.get('First Hire','').strip(),
                  'last':d.get('Most Recent Hire','').strip(),
                  'still':d.get('Still There Today','').strip(),
                  'fac':d.get('Pursuit-Facilitated Hires','').strip()}
json.dump(hires,open('hires_index.json','w'),indent=1)
print('hire companies indexed:',len(hires))

# ---------- company attribute index ----------
# priority: lower number = more authoritative
ci=collections.defaultdict(dict)   # normkey -> field -> (priority, value, source)
def put(key, field, val, prio, src):
    if not val: return
    cur=ci[key].get(field)
    if cur is None or prio < cur[0]:
        ci[key][field]=(prio,val,src)

def feed(rows, cocol, prio, src, hc=None, tri=None, hq=None, exact=None):
    for d in rows:
        co=d.get(cocol,'')
        k=norm(co)
        if not k: continue
        put(k,'company_display',co,prio,src)
        if exact:
            e,_b=parse_headcount(d.get(exact,''))
            if e: put(k,'headcount_exact',e,prio,src)
        if hc:
            e,b=parse_headcount(d.get(hc,''))
            if e: put(k,'headcount_exact',e,prio,src)
            if b: put(k,'band',b,prio,src)
        if tri:
            t=parse_tri(d.get(tri,''))
            if t: put(k,'tristate',t,prio,src)
        if hq:
            h=clean(d.get(hq,''))
            if h and h.lower() not in ('0','no','yes'): put(k,'hq',h,prio,src)

# tab12: richest, ranked accounts (has exact headcount + hq_location + tristate_office)
feed(T[12],'company',1,'ranked_accounts(tab12)',hc='headcount_band',tri='tristate_office',hq='hq_location',exact='headcount_exact')
for d in T[12]:
    k=norm(d.get('company',''))
    if not k: continue
    e,b=parse_headcount(d.get('headcount_range',''))
    if b: put(k,'band',b,4,'ranked_accounts.headcount_range')
# tab04: deep company research w/ HQ
feed(T[4],'Company',2,'company_research(tab04)',hc='Headcount (approx.)',tri='Tristate Presence',hq='HQ')
# tab09: PE/VC portfolio cos w/ HQ + exact headcount
feed(T[9],'Company',3,'portfolio(tab09)',hc='Headcount',tri='Tristate',hq='HQ')
# tab11: scored accounts
feed(T[11],'Company',3,'scored_accounts(tab11)',hc='Headcount',tri='Tristate?')
# tab15: LinkedIn-band list w/ HQ
feed(T[15],'Company',4,'li_list(tab15)',hc='Headcount',hq='HQ`')
# tab00/01/03/10: account_key lists
for ti in (0,1,3,10):
    feed(T[ti],'Company',5,f'priority_list(tab{ti:02d})',hc='Headcount',tri='Tristate Presence')
# tab08: Nick's master contact list
feed(T[8],'Company',5,'nick_list(tab08)',hc='Headcount',tri='Tri-state presence')
# tab02
feed(T[2],'Company',6,'investor_list(tab02)',hc='Company Size')

json.dump({k:{f:[v[0],v[1],v[2]] for f,v in d.items()} for k,d in ci.items()},
          open('company_index.json','w'),indent=1)
print('company attr index:',len(ci))

# ---------- contact_id index ----------
cid={}
for ti in (0,1,3,10):
    for d in T[ti]:
        c=d.get('contact_id','').strip()
        if c.isdigit():
            cid.setdefault(int(c),{}).update({
              'company':d.get('Company',''),'headcount':d.get('Headcount',''),
              'tristate':d.get('Tristate Presence',''),'priority':d.get('Priority',''),
              'src':f'tab{ti:02d}'})
for d in T[13]:
    c=d.get('contact_id','').strip()
    if c.isdigit():
        cid.setdefault(int(c),{}).setdefault('company',d.get('company',''))
json.dump(cid,open('cid_index.json','w'),indent=1)
print('contact_id index:',len(cid))
