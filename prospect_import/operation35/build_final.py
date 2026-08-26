import json,csv,re,collections
exec(open('enrich.py').read().split('# ---------- load tabs')[0])

contacts = json.load(open('contacts_full.json'))
ci       = json.load(open('company_index.json'))
hires    = json.load(open('hires_index.json'))
web      = json.load(open('web_overrides.json'))
cfix     = json.load(open('company_fix.json'))
bfb      = json.load(open('bedrock_fallback.json'))     # keyed on raw-ish name

ALIAS={'citigroup':'citi','robin hood':'robin hood foundation',
       'madison square garden sports corp':'madison square garden','hearst newspapers':'hearst'}
SB={'1-10':'Under 50','11-50':'Under 50','51-200':'50-300','1001-5000':'1,000+','5000+':'1,000+'}
TRI=('new york','ny','new jersey','nj','connecticut','ct','brooklyn','manhattan','queens','bronx',
     'staten island','newark','jersey city','stamford','hartford','long island','white plains',
     'yonkers','greenwich','hoboken','nyc')
def tri_from_hq(hq):
    if not hq: return ''
    h=hq.lower()
    for s in TRI:
        if re.search(r'\b'+re.escape(s)+r'\b',h): return 'Yes'
    return 'No'

rows=[]
for c in contacts:
    cidk=str(c['contact_id'])
    co = c['current_company'] or c.get('co_name') or ''
    fix = cfix.get(cidk)
    fixnote=''
    if fix:
        co = fix['company']; fixnote = fix['why']
    k = norm(co)
    a = ci.get(k,{})
    g  = lambda f: (a[f][1] if f in a else '')
    gs = lambda f: (a[f][2] if f in a else '')

    exact=''; ex_src=''; band=''; b_src=''; conf=''
    # 1) web override (authoritative where we researched)
    w = web.get(co) or web.get(fix['company'] if fix else '')
    if w:
        exact=w['exact']; ex_src=w['src']; band=to_band(exact); b_src=w['src']; conf=w['conf']
    # 2) sheet exact
    elif g('headcount_exact'):
        exact=int(g('headcount_exact')); ex_src=f"sheet ({gs('headcount_exact')})"
        band=to_band(exact); b_src=ex_src; conf='High'
    # 3) sheet band
    elif g('band'):
        band=g('band'); b_src=f"sheet band ({gs('band')})"; conf='High'
    # 4) bedrock size_bucket (contact's own company row, then name fallback)
    else:
        sb=(c.get('size_bucket') or '').strip()
        if not sb:
            for nk,v in bfb.items():
                if norm(nk)==k or nk.lower()==co.lower(): sb=v['sb']; break
        if sb in SB:
            band=SB[sb]; b_src=f'bedrock size_bucket {sb}'; conf='Medium'
        elif sb=='201-1000':
            band=''; b_src='bedrock size_bucket 201-1000 (straddles the 300 line)'; conf='UNRESOLVED'
        else:
            b_src='no source found'; conf='UNRESOLVED'

    seg = 'SME' if band in ('Under 50','50-300') else ('Enterprise' if band in ('300-1,000','1,000+') else '')

    hkey=ALIAS.get(k,k); h=hires.get(hkey)
    hired='Yes' if h and h['n']>0 else 'No'
    nh=h['n'] if h else 0

    hq=(c.get('hq_location') or '').strip() or g('hq')
    if not hq:
        for nk,v in bfb.items():
            if norm(nk)==k or nk.lower()==co.lower(): hq=v.get('hq',''); break
    hq_src='bedrock companies.hq_location' if (c.get('hq_location') or '').strip() else (gs('hq') if g('hq') else ('bedrock (name match)' if hq else ''))

    tri=g('tristate'); tri_src=gs('tristate') if tri else ''
    if tri=='Unknown': tri=''; tri_src=''
    if not tri and hq:
        tri=tri_from_hq(hq); tri_src='derived from HQ'

    rows.append({
      'contact_id':c['contact_id'],'name':c['full_name'],'title':c['current_title'] or '',
      'company':co,'op35_tag':c['tags'],'owner':c.get('owner_email') or '',
      'headcount':exact,'headcount_source':ex_src,
      'headcount_range':band,'range_source':b_src,'confidence':conf,
      'segment':seg,
      'hired_from_pursuit':hired,'n_hired_from_pursuit':nh,
      'hq_location':hq,'hq_source':hq_src,
      'tri_state':tri or 'Unknown','tri_state_source':tri_src,
      'notes':fixnote})
    if norm(co)=='pursuit':
        rows[-1]['notes']=('Pursuit internal contact - the 38 "hires" are builders hired onto '
                           'Pursuit staff, NOT a hiring-partner signal. Exclude from partner analysis.')

cols=['contact_id','name','title','company','op35_tag','owner','headcount','headcount_source',
      'headcount_range','range_source','confidence','segment','hired_from_pursuit',
      'n_hired_from_pursuit','hq_location','hq_source','tri_state','tri_state_source','notes']
with open('operation35_enriched.csv','w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=cols); w.writeheader()
    for r in sorted(rows,key=lambda x:(x['company'].lower(),x['name'].lower())): w.writerow(r)
json.dump(rows,open('final_rows.json','w'),indent=1)

print('rows:',len(rows))
print('range resolved:',sum(1 for r in rows if r['headcount_range']),'/',len(rows))
print('exact headcount:',sum(1 for r in rows if r['headcount']))
print('confidence:',dict(collections.Counter(r['confidence'] for r in rows)))
print('segment  :',dict(collections.Counter(r['segment'] or 'UNRESOLVED' for r in rows)))
print('range    :',dict(collections.Counter(r['headcount_range'] or 'UNRESOLVED' for r in rows)))
print('hired    :',dict(collections.Counter(r['hired_from_pursuit'] for r in rows)))
print('tri_state:',dict(collections.Counter(r['tri_state'] for r in rows)))
print('hq known :',sum(1 for r in rows if r['hq_location']))
print()
un=[r for r in rows if not r['headcount_range']]
print('STILL UNRESOLVED:',len(un))
for r in un: print('   ',r['contact_id'],r['company'],'|',r['range_source'])
