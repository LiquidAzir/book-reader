// Server-only fallback generated from Project Gutenberg's published CSV catalog.
// No runtime scraping, third-party proxy, tracking, or invented popularity statistics.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const metadata=require('../data/gutenberg-catalog.meta.json');
const PAGE_SIZE=32;
let index=null;
class CatalogQueryError extends Error { constructor(message){super(message);this.name='CatalogQueryError';this.code='CATALOG_FILTER_UNSUPPORTED';this.status=400;} }
const fold = s => String(s).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const split = s => s.split(';').map(v=>v.trim()).filter(Boolean);
function load() {
  if(index)return index;
  const started=performance.now();
  const compressed=fs.readFileSync(path.resolve(__dirname,'../data',metadata.asset));
  if(compressed.length>16*1024*1024||crypto.createHash('sha256').update(compressed).digest('hex')!==metadata.asset_sha256)throw new Error('Gutenberg catalog integrity check failed');
  const rows=JSON.parse(zlib.gunzipSync(compressed,{maxOutputLength:64*1024*1024}).toString('utf8'));
  if(!Array.isArray(rows)||rows.length!==metadata.text_records)throw new Error('Gutenberg catalog record count mismatch');
  const byId=new Map(), search=[], topics=[];
  for(let i=0;i<rows.length;i++){byId.set(rows[i][0],i);search.push(fold(rows[i][1]+' '+rows[i][3]));topics.push(fold(rows[i][4]+' '+rows[i][5]));}
  const ranks=new Map(metadata.featured_ids.map((id,i)=>[id,i]));
  const popular=Array.from({length:rows.length},(_,i)=>i).sort((a,b)=>(ranks.get(rows[a][0])??1e9)-(ranks.get(rows[b][0])??1e9)||rows[a][0]-rows[b][0]);
  index={rows,byId,search,topics,popular,first_load_ms:performance.now()-started};return index;
}
function snapshotInfo(){return {...metadata,featured_ids:metadata.featured_ids.slice(),tuple_fields:metadata.tuple_fields.slice(),loaded:!!index,first_load_ms:index?.first_load_ms??null};}
function person(raw){
  const role=raw.match(/\s*\[([^\]]+)\]\s*$/)?.[1]||'Author';
  let name=raw.replace(/\s*\[[^\]]+\]\s*$/,'').trim(),birth=null,death=null;
  // Only exact known years are promoted. Approximate/BC/incomplete dates remain in the name.
  const years=name.match(/,\s*(\d{3,4})-(\d{3,4})$/);
  if(years){birth=Number(years[1]);death=Number(years[2]);name=name.slice(0,years.index).trim();}
  return {name,birth_year:birth,death_year:death,role};
}
function shape(r){
  const people=split(r[3]).map(person);
  const plain=p=>({name:p.name,birth_year:p.birth_year,death_year:p.death_year});
  return {id:r[0],title:r[1],authors:people.filter(p=>/^author$/i.test(p.role)).map(plain),translators:people.filter(p=>/^translator$/i.test(p.role)).map(plain),
    subjects:split(r[4]),bookshelves:split(r[5]),languages:split(r[2]),copyright:null,media_type:'Text',
    formats:{'text/plain; charset=utf-8':`https://www.gutenberg.org/ebooks/${r[0]}.txt.utf-8`},download_count:null,
    issued:r[6],locc:split(r[7]),contributors:people.filter(p=>!/^author$|^translator$/i.test(p.role)),
    catalog_source:'gutenberg-offline',catalog_date:metadata.catalog_date};
}
function detail(id){
  if(typeof id==='string'&&/^[1-9]\d{0,9}$/.test(id))id=Number(id);
  if(!Number.isSafeInteger(id)||id<=0)return null;
  const state=load(),i=state.byId.get(id);return i===undefined?null:shape(state.rows[i]);
}
function list(params=new URLSearchParams()){
  if(!(params instanceof URLSearchParams))throw new CatalogQueryError('Catalog filters must be URLSearchParams');
  const allowed=new Set(['search','languages','topic','ids','sort','page','mime_type','copyright','author_year_start','author_year_end']);
  for(const [key,value]of params){if(!allowed.has(key)||value.length>1000||params.getAll(key).length!==1)throw new CatalogQueryError('Invalid catalog query');}
  for(const key of ['author_year_start','author_year_end'])if(params.has(key))throw new CatalogQueryError('Author-year filters are unavailable in the offline catalog');
  if(params.has('copyright')&&params.get('copyright')!=='null')throw new CatalogQueryError('Copyright status is unknown in the offline catalog; this filter is unavailable');
  const mime=params.get('mime_type');if(mime!==null&&(!mime||!'text/plain; charset=utf-8'.startsWith(mime)))throw new CatalogQueryError('Only plain-text editions are indexed by the offline catalog');
  const order=params.get('sort')||'popular';if(!['popular','ascending','descending'].includes(order))throw new CatalogQueryError('Invalid catalog sort');
  const pageRaw=params.get('page')||'1';if(!/^[1-9]\d{0,5}$/.test(pageRaw))throw new CatalogQueryError('Invalid catalog page');const page=Number(pageRaw);
  let ids=null;if(params.has('ids')){const value=params.get('ids');if(!/^[1-9]\d{0,9}(,[1-9]\d{0,9})*$/.test(value))throw new CatalogQueryError('Invalid catalog IDs');ids=new Set(value.split(',').map(Number));}
  let languages=null;if(params.has('languages')){const value=params.get('languages').toLowerCase();if(!/^[a-z]{2,3}(,[a-z]{2,3})*$/.test(value))throw new CatalogQueryError('Invalid catalog languages');languages=new Set(value.split(','));}
  const words=[...new Set(fold(params.get('search')||'').match(/[\p{L}\p{N}]+/gu)||[])],topic=fold((params.get('topic')||'').trim());
  const state=load(),matches=[];
  for(let i=0;i<state.rows.length;i++){const r=state.rows[i];if(ids&&!ids.has(r[0]))continue;if(languages&&!split(r[2]).some(l=>languages.has(l)))continue;if(words.some(w=>!state.search[i].includes(w)))continue;if(topic&&!state.topics[i].includes(topic))continue;matches.push(i);}
  let ordered=matches;
  if(order==='descending')ordered=matches.reverse();
  else if(order==='popular'){const selected=new Set(matches);ordered=state.popular.filter(i=>selected.has(i));}
  const count=ordered.length,last=Math.max(1,Math.ceil(count/PAGE_SIZE));
  const link=n=>{const q=new URLSearchParams(params);q.set('page',String(n));return '/api/books?'+q;};
  return {count,next:page<last?link(page+1):null,previous:page>1&&count?link(Math.min(last,page-1)):null,
    results:ordered.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).map(i=>shape(state.rows[i])),
    catalog_source:'gutenberg-offline',catalog_date:metadata.catalog_date,catalog_sort:order==='popular'?'featured-then-id':order,
    catalog_note:order==='popular'?'Featured classics first; this snapshot contains no download counts.':undefined};
}
module.exports={detail,list,snapshotInfo,CatalogQueryError};
