import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {hash,writeJson} from '../tools/sync.mjs';
import {buildPages} from '../tools/build-pages.mjs';
test('发布配置指向版本目录，ROM 使用内容哈希地址且保留游戏 ID，变更未同步会阻止发布',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'xiaomi-library-build-'));
 try{
  await mkdir(path.join(root,'roms/MD'),{recursive:true});const bytes=Buffer.from('test ROM');
  await writeFile(path.join(root,'roms/MD/中文.md'),bytes);
  await writeJson(path.join(root,'games.json'),[{id:'game',gameId:123,platform:'MD',format:'md',rom:'roms/MD/中文.md',sha256:hash(bytes),cover:''}]);
  await writeJson(path.join(root,'library.json'),{schemaVersion:1,playEnabled:true,notice:'欢迎'});
  await writeJson(path.join(root,'player-config.json'),{controls:{}});
  const built=await buildPages(root);
  const config=JSON.parse(await readFile(path.join(built.out,'library.json')));
  assert.match(config.catalog,/^catalogs\/[a-f0-9]{64}\.json$/);assert.equal(config.notice,'欢迎');
  assert.equal(built.games[0].gameId,123);assert.equal(built.games[0].rom,`roms/MD/${hash(bytes)}.bin`);
  assert.deepEqual(await readFile(path.join(built.out,built.games[0].rom)),bytes);
  await writeFile(path.join(root,'roms/MD/中文.md'),'changed');await assert.rejects(buildPages(root),/ROM 已变化/);
 }finally{await rm(root,{recursive:true,force:true});}
});
