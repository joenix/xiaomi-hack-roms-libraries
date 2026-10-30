/** Zero-API-key Libretro thumbnail lookup; ONLY trusted per-platform directories. */
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from './rom-config.mjs';
import {fetchWithRetry} from './cover-network.mjs';

export const LIBRETRO_DIRS = Object.freeze({
  FC:'Nintendo - Nintendo Entertainment System',
  MD:'Sega - Mega Drive - Genesis',
  SFC:'Nintendo - Super Nintendo Entertainment System',
  GBA:'Nintendo - Game Boy Advance',
  PSP:'Sony - PlayStation Portable',
});
export const LIBRETRO_BASE = 'https://thumbnails.libretro.com/';
const CACHE_ROOT = path.join(projectRoot,'.cache','covers-index');
const MAX_INDEX_AGE=7*24*3600*1000;
const MAX_INDEX_BYTES=12*1024*1024;
const MAX_IMAGE_BYTES=12*1024*1024;
const PNG_SIG=Buffer.from([137,80,78,71,13,10,26,10]);
const unhtml = value=>value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(Number(x)));

export function parseBoxartIndex(html) {
  const found=[];
  const seen=new Set();
  // Standard nginx/Apache auto-index has one <a href="...png"> per image.
  for (const m of String(html).matchAll(/<a\s+[^>]*href\s*=\s*["']([^"']+\.png)["']/gi)) {
    const href=unhtml(m[1]);
    if (/^(?:https?:|\/|\.)/i.test(href) || /[?#]/.test(href)) continue;
    let name;
    try {name=decodeURIComponent(href).normalize('NFC');} catch {continue;}
    if (!name.toLowerCase().endsWith('.png') || name.includes('/') || name.includes('\\') || name.includes('\0') || name.length>260)continue;
    if(!seen.has(name)){seen.add(name);found.push({name,href});}
  }
  return found;
}
function canonicalName(value){
  return String(value||'').normalize('NFKC').toLowerCase()
    .replace(/\s*\([^)]*\)/g,' ').replace(/\s*\[[^\]]*\]/g,' ')
    .replace(/\biii\b/g,'3').replace(/\bii\b/g,'2').replace(/\biv\b/g,'4')
    .replace(/[‐‑‒–—_]/g,' ').replace(/\bthe\b/g,' ')
    .replace(/[^\p{L}\p{N}]/gu,'');
}
function bigramScore(a,b){
  if(a===b)return 1;
  if(!a || !b || a.length<4 || b.length<4)return 0;
  const bigrams = s=>new Set([...s].slice(0,-1).map((_,i)=>[...s][i]+[...s][i+1]));
  const x=bigrams(a),y=bigrams(b);
  let n=0;for(const v of x)if(y.has(v))n++;
  const similarity=(2*n)/(x.size+y.size);
  const lengthPenalty=Math.min(a.length,b.length)/Math.max(a.length,b.length);
  return similarity*lengthPenalty;
}
function seriesNumbers(title){
  const main=String(title).replace(/\.png$/i,'').replace(/\([^)]*\)/g,'');
  const roman={I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10};
  return [...main.matchAll(/(?:^|[\s:,_-])([0-9]+|VIII|VII|VI|IV|III|II|IX|V|I|X)(?=$|[\s:,_-])/gi)]
    .map(m=>String(roman[m[1].toUpperCase()]||Number(m[1])));
}
export function compatibleSeries(query,title){
  const q=seriesNumbers(query),t=seriesNumbers(title);
  return q.join(',')===t.join(',');
}
export function selectBoxart(entries,query,{minMatchScore=0.9,region='jp'}={}) {
  const term=canonicalName(query);
  if(!term) return null;
  const candidates=[];
  for(const entry of entries){
    const title=entry.name.replace(/\.png$/i,'');
    if(!compatibleSeries(query,title))continue;
    const base=canonicalName(title);
    const score=bigramScore(term,base);
    if(score<minMatchScore)continue;
    const japan=/\((?:japan|jp)(?:,|\))/i.test(title);
    const us=/\((?:usa|us)(?:,|\))/i.test(title);
    const alt=/(?:beta|proto|sample|demo|unl|hack|alt\s?\d|virtual console|sega channel|rev\s?[a-z]|v\d)/i.test(title);
    const regionBonus=region==='jp'?Number(japan):region==='us'?Number(us):0;
    candidates.push({...entry,title,score,rank:score+regionBonus*0.012-(alt?0.025:0)});
  }
  candidates.sort((a,b)=>b.rank-a.rank || a.name.localeCompare(b.name,'en'));
  return candidates[0] || null;
}
export async function limitedFetch(url,{fetchImpl=fetch,maxBytes=MAX_INDEX_BYTES,timeoutMs=30000,retries=2,wait}={}){
  return fetchWithRetry(url,{fetchImpl,maxBytes,timeoutMs,retries,...(wait?{wait}:{})});
}
export function boxartUrl(platform,entry){
  const directory=LIBRETRO_DIRS[platform];
  if(!directory)throw new Error(`平台不支持：${platform}`);
  if(!entry || !parseBoxartIndex(`<a href="${entry.href}">`).some(x=>x.name===entry.name))throw new Error('封面文件名异常');
  return `${LIBRETRO_BASE}${encodeURIComponent(directory)}/Named_Boxarts/${entry.href}`;
}
export async function fetchBoxartIndex(platform,{fetchImpl=fetch,refresh=false,cacheDir=CACHE_ROOT,timeoutMs=30000,retries=2}={}){
  const directory=LIBRETRO_DIRS[platform];
  if(!directory)throw new Error(`Libretro 不支持：${platform}`);
  const file=path.join(cacheDir,platform+'.json');
  let cached;
  try {cached=JSON.parse(await readFile(file,'utf8'));}catch{}
  if(!refresh && cached && Date.now()-cached.updatedAt<MAX_INDEX_AGE && Array.isArray(cached.entries)) return cached.entries;
  try {
    const url=`${LIBRETRO_BASE}${encodeURIComponent(directory)}/Named_Boxarts/`;
    const body=await limitedFetch(url,{fetchImpl,maxBytes:MAX_INDEX_BYTES,timeoutMs,retries});
    const entries=parseBoxartIndex(body.toString('utf8'));
    if(entries.length<10)throw new Error(`索引数量异常（${entries.length}）`);
    await mkdir(cacheDir,{recursive:true});
    const tmp=file+'.tmp';
    await writeFile(tmp,JSON.stringify({updatedAt:Date.now(),entries}));await rename(tmp,file);
    return entries;
  } catch (error){
    if(cached?.entries?.length) {console.warn(`  ⚠ ${platform} 索引更新失败，使用历史缓存：${error.message}`);return cached.entries;}
    throw new Error(`${platform} 获取封面索引失败：${error.message}`);
  }
}
export async function downloadBoxart(platform,entry,{fetchImpl=fetch,timeoutMs=35000,retries=2}={}){
  const bytes=await limitedFetch(boxartUrl(platform,entry),{fetchImpl,maxBytes:MAX_IMAGE_BYTES,timeoutMs,retries});
  if(bytes.length<100 || !bytes.subarray(0,8).equals(PNG_SIG))throw new Error('远程资源不是合法 PNG 文件');
  return bytes;
}
