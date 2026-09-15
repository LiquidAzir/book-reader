const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const catalog=require('../src/catalog'),{csvRows}=require('../scripts/refresh-catalog.cjs');
const q=s=>new URLSearchParams(s);
test('official snapshot provenance and bounded one-time index load',()=>{
  const before=catalog.snapshotInfo();assert.equal(before.loaded,false);assert.equal(before.source_records,79381);assert.equal(before.text_records,78130);assert.equal(before.omitted_non_text,1251);
  assert.equal(before.catalog_date,'2026-09-13');assert.equal(before.source_url,'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz');
  const packed=fs.readFileSync(path.resolve(__dirname,'../data',before.asset));assert.equal(crypto.createHash('sha256').update(packed).digest('hex'),before.asset_sha256);
  const started=performance.now(),book=catalog.detail(1342),elapsed=performance.now()-started;
  assert.equal(book.title,'Pride and Prejudice');assert.equal(book.copyright,null);assert.equal(book.download_count,null);assert.equal(book.authors[0].name,'Austen, Jane');
  assert.equal(book.authors[0].birth_year,1775);assert.equal(book.authors[0].death_year,1817);assert.match(book.formats['text/plain; charset=utf-8'],/^https:\/\/www\.gutenberg\.org\/ebooks\/1342\.txt\.utf-8$/);
  assert.ok(elapsed<5000,`first load ${elapsed}ms`);assert.ok(process.memoryUsage().rss<300*1024*1024,`RSS ${process.memoryUsage().rss}`);
  const time=catalog.snapshotInfo().first_load_ms;catalog.detail(11);assert.equal(catalog.snapshotInfo().first_load_ms,time);
  console.log(JSON.stringify({catalogFirstLoadMs:elapsed,rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed}));
});
test('full catalog is paginated at32 with stable nonoverlapping pages',()=>{
  const first=catalog.list(q('sort=ascending')),second=catalog.list(q(first.next.split('?')[1]));assert.equal(first.count,78130);assert.equal(first.results.length,32);assert.equal(first.previous,null);assert.equal(first.results[0].id,1);assert.equal(second.results.length,32);assert.equal(second.previous,'/api/books?sort=ascending&page=1');assert.equal(new Set([...first.results,...second.results].map(b=>b.id)).size,64);
  const lastPage=Math.ceil(first.count/32),last=catalog.list(q('page='+lastPage));assert.equal(last.next,null);assert.equal(last.results.length,first.count%32);const past=catalog.list(q('page=999999'));assert.equal(past.count,78130);assert.deepEqual(past.results,[]);assert.equal(past.next,null);
});
test('multiword title-author search finds Jane Austen despite comma ordering',()=>{
  const a=catalog.list(q('search=Jane+Austen'));assert.ok(a.count>6);assert.ok(a.results.some(b=>b.id===1342));assert.ok(a.results.some(b=>b.id===158));
  const b=catalog.list(q('search=%22Jane+Austen%22+Pride'));assert.ok(b.results.some(x=>x.id===1342));
});
test('Unicode and diacritic-insensitive search retain original titles',()=>{
  const accented=catalog.list(q('search=Mis%C3%A9rables&languages=fr')),plain=catalog.list(q('search=Miserables&languages=fr'));assert.ok(accented.count>0);assert.equal(accented.count,plain.count);assert.deepEqual(accented.results.map(x=>x.id),plain.results.map(x=>x.id));assert.ok(accented.results.some(x=>/misérables/i.test(x.title)));
});
test('search reaches books outside the small frontend featured list',()=>{
  const info=catalog.snapshotInfo(),walden=catalog.list(q('search=Walden+Thoreau'));assert.ok(walden.count>0);assert.ok(walden.results.some(b=>!info.featured_ids.includes(b.id)));
});
test('languages, subjects/bookshelves, IDs and order combine correctly',()=>{
  const books=catalog.list(q('ids=1342,84,11&sort=ascending')).results;assert.deepEqual(books.map(b=>b.id),[11,84,1342]);
  assert.deepEqual(catalog.list(q('ids=1342,84,11&sort=descending')).results.map(b=>b.id),[1342,84,11]);
  const french=catalog.list(q('languages=fr&topic=fiction&sort=descending'));assert.ok(french.count>0);assert.ok(french.results.every(b=>b.languages.includes('fr')&&[...b.subjects,...b.bookshelves].join(' ').toLowerCase().includes('fiction')));assert.ok(french.results[0].id>french.results.at(-1).id);
  const unknown=catalog.list(q('languages=zz'));assert.equal(unknown.count,0);assert.equal(unknown.next,null);
});
test('popular is transparent curated order, never fabricated download counts',()=>{
  const result=catalog.list(q('sort=popular'));assert.deepEqual(result.results.slice(0,3).map(b=>b.id),[84,1342,11]);assert.equal(result.catalog_sort,'featured-then-id');assert.match(result.catalog_note,/no download counts/);assert.ok(result.results.every(b=>b.download_count===null&&b.copyright===null&&b.catalog_source==='gutenberg-offline'));
});
test('unsupported or malformed filters fail explicitly before scanning',()=>{
  for(const query of ['copyright=false','copyright=true','author_year_start=1800','author_year_end=1900','mime_type=text/html','search=x&search=y','page=0','page=-1','sort=random','ids=1,x','ids=0','languages=english','unknown=x','search='+'a'.repeat(1001)])assert.throws(()=>catalog.list(q(query)),e=>e.status===400,query);
  assert.equal(catalog.list(q('copyright=null&mime_type=text/plain&ids=1342')).count,1);
});
test('detail missing is null and callers cannot mutate indexed results',()=>{
  assert.equal(catalog.detail(2147483647),null);assert.equal(catalog.detail('bad'),null);assert.equal(catalog.detail(-1),null);const a=catalog.detail(1342);a.title='Changed';a.authors[0].name='Changed';a.languages.push('xx');const b=catalog.detail('1342');assert.equal(b.title,'Pride and Prejudice');assert.equal(b.authors[0].name,'Austen, Jane');assert.ok(!b.languages.includes('xx'));
});
test('CSV parser handles real quoted multiline and escaped delimiters',()=>{
  assert.deepEqual([...csvRows('id,title\r\n1,"A ""quoted"", title\r\nnext line"\r\n2,plain')],[['id','title'],['1','A "quoted", title\r\nnext line'],['2','plain']]);assert.throws(()=>[...csvRows('id,title\n1,"unfinished')],/Unterminated/);
});
