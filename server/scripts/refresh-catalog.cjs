#!/usr/bin/env node
// Refresh only from Gutenberg's published metadata feed. Never scrape or bypass a block.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const SOURCE_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz';
const SOURCE_PAGE = 'https://www.gutenberg.org/ebooks/offline_catalogs.html';
const HEADER = ['Text#','Type','Issued','Title','Language','Authors','Subjects','LoCC','Bookshelves'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// RFC 4180 records, including quoted commas, escaped quotes and embedded CRLF.
function* csvRows(text) {
  let quoted = false, start = 0, fields = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i+1] === '"') i++; else quoted = !quoted; }
    if (!quoted && (ch === ',' || ch === '\n')) {
      let field = text.slice(start, i).replace(/\r$/, '');
      if (field.startsWith('"')) field = field.slice(1, -1).replace(/""/g, '"');
      fields.push(field); start = i + 1;
      if (ch === '\n') { yield fields; fields = []; }
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field');
  if (start < text.length || fields.length) {
    let field = text.slice(start).replace(/\r$/, '');
    if (field.startsWith('"')) field = field.slice(1, -1).replace(/""/g, '"');
    fields.push(field); yield fields;
  }
}
function convert(buffer, downloadedAt = new Date().toISOString()) {
  if (buffer.length > 16*1024*1024) throw new Error('Catalog download exceeds 16 MiB');
  const raw = zlib.gunzipSync(buffer, {maxOutputLength:64*1024*1024});
  const csv = raw.toString('utf8').replace(/^\uFEFF/, '');
  const rows = csvRows(csv), first = rows.next().value;
  if (JSON.stringify(first) !== JSON.stringify(HEADER)) throw new Error('Unexpected Gutenberg CSV schema');
  const books = [], ids = new Set(); let sourceRecords = 0;
  for (const r of rows) {
    if (r.length === 1 && !r[0]) continue;
    sourceRecords++;
    if (r.length !== HEADER.length) throw new Error('Malformed catalog record '+sourceRecords);
    const id = Number(r[0]);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error('Invalid or duplicate catalog ID');
    ids.add(id);
    if (r[1] !== 'Text') continue;
    if (!r[3].trim()) throw new Error('Missing book title '+id);
    // Tuples avoid repeating field names 79,000 times. No book content is bundled.
    books.push([id,r[3].replace(/\s+/g,' ').trim(),r[4],r[5],r[6],r[8],r[2],r[7]]);
  }
  books.sort((a,b)=>a[0]-b[0]);
  if (books.length < 70000 || books.length > 150000) throw new Error('Unexpected catalog size: '+books.length);
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(books)), {level:9});
  const stamp = buffer.readUInt32LE(4), date = stamp ? new Date(stamp*1000).toISOString() : downloadedAt;
  const featuredPath = path.resolve(__dirname,'../../glasses-app/fallback-catalog.js');
  const featured = [...fs.readFileSync(featuredPath,'utf8').matchAll(/\{\s*id:\s*(\d+)/g)].map(m=>Number(m[1]));
  const manifest = {schema:1,source:'gutenberg-offline',source_url:SOURCE_URL,source_page:SOURCE_PAGE,
    source_sha256:sha(buffer),source_gzip_bytes:buffer.length,source_uncompressed_bytes:raw.length,
    catalog_date:date.slice(0,10),catalog_timestamp:date,date_basis:stamp?'source gzip modification timestamp':'retrieved at (source date absent)',downloaded_at:downloadedAt,
    source_records:sourceRecords,text_records:books.length,omitted_non_text:sourceRecords-books.length,
    asset:'gutenberg-catalog.json.gz',asset_sha256:sha(packed),asset_bytes:packed.length,
    tuple_fields:['id','title','languages','agents','subjects','bookshelves','issued','locc'],
    featured_ids:featured,ranking:'Existing Book Reader featured classics, then ascending Gutenberg ID; no download statistics in source'};
  return {packed,manifest};
}
async function download() {
  const response = await fetch(SOURCE_URL,{signal:AbortSignal.timeout(60000),redirect:'error'});
  if (!response.ok) throw new Error('Official catalog returned HTTP '+response.status);
  if (Number(response.headers.get('content-length')) > 16*1024*1024) throw new Error('Catalog download exceeds limit');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>16*1024*1024)throw new Error('Catalog download exceeds limit');chunks.push(chunk);}
  return Buffer.concat(chunks,size);
}
async function main() {
  const args=process.argv.slice(2);
  if (args.length && (args.length!==2 || args[0]!=='--input')) throw new Error('Usage: node scripts/refresh-catalog.cjs [--input downloaded.csv.gz]');
  const source=args.length?fs.readFileSync(path.resolve(args[1])):await download();
  const {packed,manifest}=convert(source);
  const dir=path.resolve(__dirname,'../data');fs.mkdirSync(dir,{recursive:true});
  const asset=path.join(dir,manifest.asset),meta=path.join(dir,'gutenberg-catalog.meta.json');
  fs.writeFileSync(asset+'.tmp',packed);fs.writeFileSync(meta+'.tmp',JSON.stringify(manifest,null,2)+'\n');
  fs.renameSync(asset+'.tmp',asset);fs.renameSync(meta+'.tmp',meta);
  console.log(JSON.stringify(manifest,null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={csvRows,convert,SOURCE_URL};
