/**
 * 识别 ROM 所基于的游戏（不把 Hack 副标题误当成游戏名）。
 * 查封面用的原作名与页面上展示的 Hack ROM 名称保持独立。
 */
import {open} from 'node:fs/promises';
import {loadRomConfig,safeRomFile} from './rom-config.mjs';

// 手工校对过的中文 / 英文常用标题。数组按长度处理，系列编号不能被吞掉。
// 这是游戏身份词典，不是“从 ROM 硬解析出来的事实”。
export const GAME_IDENTITIES=Object.freeze({
  MD: [
    {names:['阿斯特堡的恶魔','阿斯特伯格的恶魔','Demons of Asteborg'],queries:['Demons of Asteborg']},
    {names:['阿斯特博格兄弟','阿斯特堡兄弟','阿斯特堡三兄弟','Astebros'],queries:['Astebros']},
    {names:['大航海时代2','大航海时代II','大航海時代II','Daikoukai Jidai II','Uncharted Waters 2','Uncharted Waters II','New Horizons'],queries:['Daikoukai Jidai II','New Horizons']},
    {names:['斗技王','鬥技王','King Colossus','Tougiou King Colossus'],queries:['Tougiou King Colossus']},
    {names:['光明力量1','光明力量Ⅰ','光明力量-众神遗产','光明力量-眾神遺產','光明力量 众神遗产','Shining Force 1','Shining Force - Kamigami no Isan'],queries:['Shining Force - Kamigami no Isan','Shining Force']},
    {names:['光明力量2','光明力量II','光明力量Ⅱ','Shining Force II','Shining Force 2'],queries:['Shining Force II - Inishie no Fuuin','Shining Force II']},
    {names:['光之继承者','光之繼承者','Beyond Oasis','The Story of Thor','Story of Thor'],queries:['Story of Thor, The - Hikari o Tsugumono','Beyond Oasis']},
    {names:['梦幻模拟战2','夢幻模擬戰2','梦幻模拟战Ⅱ','夢幻模擬戰Ⅱ','Langrisser II','Langrisser 2'],queries:['Langrisser II']},
    {names:['梦幻之星4','夢幻之星4','梦幻之星IV','Phantasy Star 4','Phantasy Star IV'],queries:['Phantasy Star IV','Phantasy Star - Sennenki no Owari ni']},
    {names:['怒之铁拳2','怒之鐵拳2','怒之铁拳II','Streets of Rage 2','Streets of Rage II'],queries:['Bare Knuckle II - Shitou e no Requiem ~ Streets of Rage II','Streets of Rage 2']},
    {names:['太阁立志传','太閤立志傳','Taikou Risshiden'],queries:['Taikou Risshiden']},
  ],
});

function norm(value){return String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[\s_.·・—–\-()\[\]【】:：+]/gu,'');}
function prefixIsGameTitle(input,alias){
  const full=norm(input),part=norm(alias);
  if(!full.startsWith(part)||!part)return false;
  const remain=full.slice(part.length);
  // 防止如《梦幻模拟战2》命中《梦幻模拟战20》，或《光明力量1》命中 11。
  if(/\d$/.test(part)&&/^\d/.test(remain))return false;
  return true;
}
function dedupe(list){return [...new Set(list.map(x=>String(x||'').trim()).filter(Boolean))];}
function bestPrefix(name,entries){
  return entries.filter(item=>prefixIsGameTitle(name,item.key)).sort((a,b)=>norm(b.key).length-norm(a.key).length)[0];
}

export function stripBrandPrefix(value) {
  return String(value || '').replace(/^(?:【小咪优化(?:版)?】|\[小咪优化(?:版)?\])\s*/i, '');
}

export function displayName(filename, platform) {
  return stripBrandPrefix(filename).replace(/\.[^.]+$/, '')
    .replace(new RegExp(`^\\[?${platform}\\]?(?:[_\\s-]+|(?=[\\u3400-\\u9fff]))`, 'i'), '')
    .replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function matchGameIdentity(platform,filename,aliases={}){
  const raw=stripBrandPrefix(filename).replace(/\.(?:bin|md|gen|smd|zip|7z|nes|sfc|smc|gba|iso|cso|chd)$/i,'').replace(/^\[?(?:MD|FC|SFC|GBA|PSP)\]?(?:[_\s\-]+|(?=[\u3400-\u9fff]))/i,'');
  const userEntries=Object.entries(aliases).filter(([,value])=>typeof value==='string'&&value.trim()).map(([key,value])=>({key,queries:[value]}));
  const chosen=bestPrefix(raw,userEntries);
  if(chosen)return {queries:dedupe(chosen.queries),reason:'user-alias',baseName:chosen.key};
  const system=(GAME_IDENTITIES[platform]||[]).flatMap(game=>game.names.map(key=>({...game,key})));
  const matched=bestPrefix(raw,system);
  return matched?{queries:dedupe(matched.queries),reason:'builtin-identity',baseName:matched.names[0]}:null;
}

/** 只读取 MD ROM 最初 512 字节：普通 BIN/MD/GEN 的 Mega Drive 头部包含海外标题。 */
export async function readMdHeaderTitle(game){
  if(game.platform!=='MD'||!['bin','md','gen'].includes(game.format))return null;
  try{
    const {romRoot}=await loadRomConfig();
    const source=String(game.rom||'').replace(/^roms\//,'');
    if(!source.startsWith('MD/'))return null;
    const {full}=await safeRomFile(romRoot,source);
    const file=await open(full,'r');
    try{
      const buffer=Buffer.alloc(0x200);
      const {bytesRead}=await file.read(buffer,0,buffer.length,0);
      if(bytesRead<0x180||buffer.subarray(0x100,0x104).toString('ascii')!=='SEGA')return null;
      const title=buffer.subarray(0x150,0x180).toString('latin1').replace(/[\x00-\x1f\x7f-\xff]/g,' ').replace(/\s+/g,' ').trim();
      return title.length>=4 && /[A-Z]{3}/i.test(title) ? title : null;
    }finally{await file.close();}
  }catch{return null;}
}

export function buildCoverQueries(game,covers={},headerTitle=null,cleanTitleFn=x=>x){
  const {platform,sourceName,title}=game;
  const override=covers.overrides?.[game.id]||covers.overrides?.[game.rom]||covers.overrides?.[sourceName]||{};
  if(override.skip===true)return {queries:[],reason:'skipped',baseName:''};
  if(typeof override.searchTitle==='string'&&override.searchTitle.trim()){
    return {queries:[override.searchTitle.trim()],reason:'manual-override',baseName:override.searchTitle.trim()};
  }
  const guessed=matchGameIdentity(platform,sourceName||title,covers.aliases||{})||matchGameIdentity(platform,title,covers.aliases||{});
  const fallback=cleanTitleFn(sourceName)||cleanTitleFn(title);
  const queries=dedupe(guessed ? guessed.queries : [headerTitle,fallback]);
  return {queries,reason:guessed?.reason||(headerTitle?'rom-header':'filename'),baseName:guessed?.baseName||headerTitle||fallback};
}
