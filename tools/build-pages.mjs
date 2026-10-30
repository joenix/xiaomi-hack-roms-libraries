import path from 'node:path';
import {mkdir,readFile,copyFile,writeFile,rm,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {projectRoot,safeRomFile} from './rom-config.mjs';
import {readJson,hash,writeJson} from './sync.mjs';
export async function buildPages(root=projectRoot){
 const games=await readJson(path.join(root,'games.json'),null);
 const config=await readJson(path.join(root,'library.json'),null);
 const player=await readJson(path.join(root,'player-config.json'),null);
 if(!Array.isArray(games)||config?.schemaVersion!==1||typeof config.playEnabled!=='boolean'||typeof config.notice!=='string'||!player?.controls)throw Error('资源目录或配置格式错误');
 const out=path.join(root,'dist');
 const assets=new Map(),published=[],ids=new Set();let total=0;
 async function include(relative,destination,expectedHash){
  const {full,stat:s}=await safeRomFile(root,relative);
  if(!s.isFile()||s.size===0||s.size>=100*1024*1024)throw Error(`文件为空或超过 GitHub 单文件限制：${relative}`);
  if(expectedHash){const digest=createHash('sha256');for await(const chunk of createReadStream(full))digest.update(chunk);if(digest.digest('hex')!==expectedHash)throw Error(`ROM 已变化，请重新 sync：${relative}`);}
  if(!assets.has(destination)){assets.set(destination,full);total+=s.size;}
 }
 for(const game of games){
  if(!game.id||ids.has(game.id)||!/^[a-f0-9]{64}$/.test(game.sha256)||!game.rom?.startsWith(`roms/${game.platform}/`))throw Error('游戏 ID、哈希或平台路径不合法');
  ids.add(game.id);
  const ext=game.platform==='MD'&&game.format==='md'?'bin':game.format;
  if(!/^[a-z0-9]+$/.test(ext))throw Error('游戏格式不合法');
  const rom=`roms/${game.platform}/${game.sha256}.${ext}`;
  await include(game.rom,rom,game.sha256);
  if(game.cover){if(!game.cover.startsWith(`covers/${game.platform}/`))throw Error('封面平台路径错误');await include(game.cover,game.cover);}
  published.push({...game,rom});
 }
 if(total>=1024**3)throw Error('发布包超过 GitHub Pages 1 GB 容量限制');
 // Only rebuild this generated directory after validation. Source files are never modified.
 await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
 for(const [destination,source] of assets){const target=path.join(out,destination);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);}
 const catalog=`catalogs/${hash(JSON.stringify(published))}.json`;
 const playerConfig=`config/player-${hash(JSON.stringify(player))}.json`;
 await writeJson(path.join(out,catalog),published);
 await writeJson(path.join(out,playerConfig),player);
 await writeJson(path.join(out,'games.json'),published);
 await writeJson(path.join(out,'library.json'),{...config,catalog,playerConfig});
 await writeFile(path.join(out,'.nojekyll'),'');
 await writeFile(path.join(out,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>小咪游戏资源库</title><h1>小咪游戏资源库</h1><p>本项目提供游戏目录、封面与 ROM。</p><a href="../xiaomi-hack-roms/">进入游戏大厅</a></html>');
 console.log(`资源发布包：${published.length} 款游戏，${assets.size} 个去重资源，${(total/1024**2).toFixed(1)} MB。`);
 return {out,games:published,catalog};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildPages();
