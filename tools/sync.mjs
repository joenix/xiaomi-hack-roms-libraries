import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, rename, stat, open, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectRoot, safeRomFile } from './rom-config.mjs';
import { GAME_IDENTITIES, displayName, buildCoverQueries } from './cover-identity.mjs';
import { fetchBoxartIndex, selectBoxart, downloadBoxart } from './libretro-covers.mjs';
import { mediaType, classifyCoverError } from './cover-network.mjs';

export const SYSTEMS = {
  MD: {core:'segaMD',extensions:['bin','md','gen','smd','zip','7z']},
  FC: {core:'nes',extensions:['nes','zip','7z']},
  SFC: {core:'snes',extensions:['sfc','smc','zip','7z']},
  GBA: {core:'gba',extensions:['gba','zip','7z']},
  PSP: {core:'psp',extensions:['iso','cso','chd']},
};
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw Error(`无法读取 ${file}：${error.message}`); }
}
export async function writeJson(file, value) {
  const content = JSON.stringify(value, null, 2) + '\n';
  try { if (await readFile(file, 'utf8') === content) return; } catch(e) { if(e.code!=='ENOENT')throw e; }
  await mkdir(path.dirname(file), {recursive:true});
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}
export function groupPath(platform, query) {
  const slug = query.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g,'').slice(0,64) || 'game';
  return `covers/${platform}/${slug}-${hash(query).slice(0,8)}`;
}
export async function saveCover(root, platform, query, bytes) {
  const ext = mediaType(bytes);
  if (!ext || bytes.length < 100) throw Error('封面不是有效的 PNG/JPEG/WebP');
  const relative = `${groupPath(platform,query)}/boxart-${hash(bytes).slice(0,16)}${ext}`;
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), {recursive:true});
  try { await writeFile(file, bytes, {flag:'wx'}); } catch(e) { if(e.code!=='EEXIST')throw e; }
  return relative;
}
async function coverExists(root, relative) {
  if (typeof relative !== 'string' || !relative.startsWith('covers/')) return false;
  // Reject traversal and symlinks escaping the resource root; also check image bytes.
  const {full,stat:s} = await safeRomFile(root,relative);
  if (!s.isFile() || s.size > 12*1024*1024) return false;
  const file = await open(full,'r');
  try { const bytes=Buffer.alloc(12); await file.read(bytes,0,12,0); return !!mediaType(bytes); }
  finally { await file.close(); }
}
async function hasCover(root, relative) {
  try { return await coverExists(root, relative); }
  catch(e) { if(e.code==='ENOENT')return false; throw e; }
}
async function walk(root, dir, list, skipped) {
  const entries = await readdir(dir, {withFileTypes:true});
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir,entry.name);
    if (entry.isSymbolicLink()) { skipped.push({path:path.relative(root,full),reason:'symbolic-link'}); continue; }
    if (entry.isDirectory()) await walk(root,full,list,skipped);
    else if (entry.isFile()) list.push(full);
  }
}
async function shaFile(file) { const digest=createHash('sha256'); for await(const c of createReadStream(file))digest.update(c); return digest.digest('hex'); }
async function headerTitle(full, platform, format) {
  if(platform!=='MD'||!['bin','md','gen'].includes(format))return null;
  const file=await open(full,'r');
  try {
    const bytes=Buffer.alloc(512); await file.read(bytes,0,512,0);
    if(bytes.toString('ascii',256,260)!=='SEGA')return null;
    return bytes.toString('latin1',0x150,0x180).replace(/[\x00-\x1f\x7f-\xff]/g,' ').replace(/\s+/g,' ').trim()||null;
  } finally { await file.close(); }
}
function cleanQuery(name) {
  return name.replace(/小咪优化(?:版)?|汉化版?|中文版|秘籍(?:增值)?版|专家增值版|v\s?\d+(?:\.\d+)*|\[(?:!|T[^\]]+)\]/gi,' ').replace(/\s+/g,' ').trim();
}
function validateObject(value,label) { if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${label} 必须为 JSON 对象`); }

export async function sync({root=projectRoot,dryRun=false,retryUnmatched=false,noNetwork=false,lookupCover,logger=console.log,now=Date.now()}={}) {
  root=path.resolve(root);
  const config=await readJson(path.join(root,'library.config.json'),{});
  validateObject(config,'library.config.json');
  const settings={region:'jp',minMatchScore:0.9,timeoutMs:15000,retries:1,networkRetryAfterMs:3600000,...config.covers};
  if(!['jp','us','any'].includes(settings.region)||!Number.isFinite(settings.minMatchScore)||settings.minMatchScore<0.9||settings.minMatchScore>1||!Number.isFinite(settings.timeoutMs)||settings.timeoutMs<1||!Number.isInteger(settings.retries)||settings.retries<0||settings.retries>3||!Number.isFinite(settings.networkRetryAfterMs)||settings.networkRetryAfterMs<0)throw Error('封面配置不合法');
  const aliases=await readJson(path.join(root,'metadata/aliases.json'),{});
  const overrides=await readJson(path.join(root,'metadata/overrides.json'),{});
  validateObject(aliases,'aliases'); validateObject(overrides,'overrides');
  const previous=await readJson(path.join(root,'games.json'),[]);
  const old=await readJson(path.join(root,'metadata/sync-state.json'),{version:1,files:{},identities:{}});
  const seeds=await readJson(path.join(root,'metadata/cover-seeds.json'),[]);
  if(!Array.isArray(previous)||!Array.isArray(seeds)||old.version!==1)throw Error('目录或同步状态格式不正确');
  validateObject(old.files,'state.files'); validateObject(old.identities,'state.identities');
  const summary={total:0,added:0,changed:0,renamed:0,unchanged:0,removed:0,hashed:0,downloaded:0,reused:0,negativeCached:0,networkDeferred:0,manual:0,unmatched:0};
  const romDirectory=await stat(path.join(root,'roms'));
  if(!romDirectory.isDirectory())throw Error('roms 根目录不存在或不是目录，停止同步');
  const skipped=[],files=[];
  for(const platform of Object.keys(SYSTEMS)) {
    const dir=path.join(root,'roms',platform);
    try { await walk(root,dir,files,skipped); }
    catch(e) { if(e.code!=='ENOENT')throw e; }
  }
  const scanned=[];
  for(const full of files) {
    const rel=path.relative(root,full).split(path.sep).join('/');
    const [,platform]=rel.split('/');
    const format=path.extname(full).slice(1).toLowerCase();
    if(!SYSTEMS[platform].extensions.includes(format)) {skipped.push({path:rel,reason:'unsupported-extension'});continue;}
    const {stat:s}=await safeRomFile(root,rel);
    if(!s.size){skipped.push({path:rel,reason:'empty-file'});continue;}
    const before=old.files[rel];
    const cached=before&&before.size===s.size&&before.mtimeMs===s.mtimeMs;
    const sha256=cached?before.sha256:await shaFile(full);
    if(!cached)summary.hashed++;
    scanned.push({full,rel,platform,format,s,sha256,before});
  }
  const paths=new Set(scanned.map(f=>f.rel));
  const previousByPath=new Map(previous.map(g=>[g.rom,g]));
  const missingByHash=new Map();
  for(const [rel,f] of Object.entries(old.files))if(!paths.has(rel)) {
    const key=`${rel.split('/')[1]}/${f.sha256}`;
    const rows=missingByHash.get(key)||[]; rows.push({rel,...f}); missingByHash.set(key,rows);
  }
  const addedByHash=new Map();
  for(const f of scanned)if(!f.before){const k=`${f.platform}/${f.sha256}`;addedByHash.set(k,(addedByHash.get(k)||0)+1);}
  const state={version:1,files:{},identities:{...old.identities}};
  const ids=new Set(previous.map(g=>g.id)); const numericIds=new Set(previous.map(g=>g.gameId));
  const used=new Set(),renamedOld=new Set(),indexMap=new Map(),failedPlatforms=new Map(),attemptedIdentities=new Set();
  const reports=[],games=[];
  const fetchCover=lookupCover|| (async({platform,queries,region})=>{
    if(failedPlatforms.has(platform))throw failedPlatforms.get(platform);
    if(!indexMap.has(platform)) {
      try {indexMap.set(platform,await fetchBoxartIndex(platform,{...settings,cacheDir:path.join(root,'.cache/covers-index')}));}
      catch(e){failedPlatforms.set(platform,e);throw e;}
    }
    for(const query of queries){
      const item=selectBoxart(indexMap.get(platform),query,{...settings,region});
      if(item){
        try {return {bytes:await downloadBoxart(platform,item,settings),coverSource:{provider:'libretro',matchedTitle:item.title,confidence:item.score,query}};}
        catch(e){ if(['network','timeout','server-error','rate-limit'].includes(classifyCoverError(e)))failedPlatforms.set(platform,e); throw e; }
      }
    }
    return null;
  });
  for(const file of scanned) {
    const {rel,platform,format,s,sha256}=file;
    let before=file.before,prev=previousByPath.get(rel);
    const key=`${platform}/${sha256}`;
    if(!before && missingByHash.get(key)?.length===1 && addedByHash.get(key)===1) {
      before=missingByHash.get(key)[0];prev=previousByPath.get(before.rel);renamedOld.add(before.rel);summary.renamed++;
    } else if(!before)summary.added++;
    else if(before.sha256!==sha256)summary.changed++;
    else summary.unchanged++;
    let id=before?.id||prev?.id||`${platform.toLowerCase()}-${hash(rel).slice(0,16)}`;
    let suffix=0;
    while(used.has(id)||(!before&&!prev&&ids.has(id)))id=`${platform.toLowerCase()}-${hash(rel+':'+ ++suffix).slice(0,16)}`;
    ids.add(id);used.add(id);
    let gameId=before?.gameId||prev?.gameId;
    if(!gameId){let salt=0;do{gameId=(parseInt(hash(id+':'+salt++).slice(0,8),16)%2000000000)+1;}while(numericIds.has(gameId));}
    numericIds.add(gameId);
    const sourceName=path.basename(file.full),generatedTitle=displayName(sourceName,platform);
    const override=overrides[id]||overrides[rel]||overrides[sourceName]||{};
    validateObject(override,`override ${rel}`);
    const title=override.title||(prev?.title&&prev.title!==before?.generatedTitle?prev.title:generatedTitle);
    const game={id,gameId,title,platform,core:prev?.core||SYSTEMS[platform].core,sourceName,rom:rel,format,folder:path.posix.dirname(rel).split('/').slice(2).join('/'),sizeBytes:s.size,modifiedAt:s.mtime.toISOString(),sha256,cover:''};
    const identified=buildCoverQueries(game,{aliases,overrides},await headerTitle(file.full,platform,format),()=>cleanQuery(generatedTitle));
    const queries=identified.queries;
    game.originalTitle=identified.baseName;
    const region=override.region||settings.region;
    if(!['jp','us','any'].includes(region))throw Error('封面区域不合法');
    const signature=hash(JSON.stringify({rules:2,dictionary:GAME_IDENTITIES,queries,platform,region,minMatchScore:settings.minMatchScore}));
    let cached=state.identities[signature];
    const custom=override.cover||(prev?.cover && (!prev.coverSource||prev.coverSource.provider==='manual') ? prev.cover : null);
    if(custom){
      if(!await hasCover(root,custom))throw Error(`手工封面不存在或格式无效：${custom}`);
      game.cover=custom;game.coverSource={provider:'manual'};summary.manual++;
    } else if(override.skip===true) {
      reports.push({rom:rel,title,queries:[],reason:'skipped-by-override'});
    } else if(cached?.status==='matched'&&await hasCover(root,cached.cover)) {
      game.cover=cached.cover;game.coverSource=cached.coverSource;summary.reused++;
    } else {
      // A missing image must be recovered, regardless of any prior positive cache.
      const regionMatch = seed => region==='any'||(region==='jp'?/\(Japan(?:,|\))/i:/\(USA(?:,|\))/i).test(seed.coverSource?.matchedTitle||'');
      // Region is a preference, as in the original matcher; a vetted European cover remains useful.
      const seed=seeds.filter(seed=>seed.platform===platform&&queries.includes(seed.query))
        .sort((a,b)=>Number(regionMatch(b))-Number(regionMatch(a)))[0];
      if(seed&&await hasCover(root,seed.cover)) {
        cached={status:'matched',cover:seed.cover,coverSource:{...seed.coverSource,identity:identified.reason,identityQuery:queries[0]}};
        state.identities[signature]=cached;game.cover=cached.cover;game.coverSource=cached.coverSource;summary.reused++;
      } else {
        const isNegative=cached?.status==='not-found';
        const cooldown=cached?.status==='error'&&now-cached.checkedAt<settings.networkRetryAfterMs;
        if((isNegative||cooldown)&&(!retryUnmatched||attemptedIdentities.has(signature))){
          if(isNegative)summary.negativeCached++;else summary.networkDeferred++;
        } else if(dryRun||noNetwork) {
          cached={status:'pending',reason:dryRun?'dry-run':'network-disabled'};
        } else {
          try {
            attemptedIdentities.add(signature);
            const result=queries.length?await fetchCover({platform,queries,region,game}):null;
            if(result){
              const cover=await saveCover(root,platform,queries[0],result.bytes);
              const coverSource={...result.coverSource,identity:identified.reason,identityQuery:queries[0]};
              cached={status:'matched',cover,coverSource};game.cover=cover;game.coverSource=coverSource;summary.downloaded++;
            }else cached={status:'not-found',reason:'no-confident-match',checkedAt:now};
          } catch(error){cached={status:'error',reason:classifyCoverError(error),details:error.message,checkedAt:now};}
          state.identities[signature]=cached;
        }
        if(!game.cover)reports.push({rom:rel,title,queries,reason:cached?.reason||'not-found',status:cached?.status||'pending'});
      }
    }
    if(!game.cover)summary.unmatched++;
    state.files[rel]={size:s.size,mtimeMs:s.mtimeMs,sha256,id,gameId,generatedTitle,identitySignature:signature};
    games.push(game);
  }
  summary.total=games.length;
  summary.removed=Object.keys(old.files).filter(rel=>!paths.has(rel)&&!renamedOld.has(rel)).length;
  if(!dryRun){
    // State is recoverable; publish the complete catalog only after images are available.
    await writeJson(path.join(root,'metadata/sync-state.json'),state);
    await writeJson(path.join(root,'reports/unmatched-covers.json'),reports);
    await writeJson(path.join(root,'reports/skipped-files.json'),skipped);
    await writeJson(path.join(root,'games.json'),games);
    await writeJson(path.join(root,'reports/last-sync.json'),summary);
  }
  logger(JSON.stringify(summary,null,2));
  return {summary,games,reports,skipped};
}

async function main(){
  const args=new Set(process.argv.slice(2));
  const allowed=new Set(['--dry-run','--retry-unmatched','--no-network']);
  for(const arg of args)if(!allowed.has(arg))throw Error(`未知参数：${arg}`);
  const lock=path.join(projectRoot,'.cache/sync.lock');
  const dryRun=args.has('--dry-run');
  if(!dryRun){
    await mkdir(path.dirname(lock),{recursive:true});
    try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('已有同步任务运行，或上次异常退出遗留 .cache/sync.lock；确认后再清理该锁目录。');throw e;}
  }
  try{await sync({dryRun,retryUnmatched:args.has('--retry-unmatched'),noNetwork:args.has('--no-network')});}
  finally{if(!dryRun)await rm(lock,{recursive:true});}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
