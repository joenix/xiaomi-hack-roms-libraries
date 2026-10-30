import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm,stat,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {sync,readJson,writeJson} from '../tools/sync.mjs';
import {displayName,matchGameIdentity,buildCoverQueries} from '../tools/cover-identity.mjs';
import {selectBoxart} from '../tools/libretro-covers.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGEsAAAAASUVORK5CYII=','base64');
// A minimally sized PNG fixture used to exercise signature checks and content hashes.
const bytes=Buffer.concat([png,Buffer.alloc(100)]);
const source={provider:'libretro',matchedTitle:'Langrisser II (Japan)',confidence:1,query:'Langrisser II'};
async function fixture(fn){const root=await mkdtemp(path.join(tmpdir(),'xiaomi-library-'));try{await mkdir(path.join(root,'roms/MD'),{recursive:true});await mkdir(path.join(root,'metadata'));await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const put=(r,n,data='ROM')=>writeFile(path.join(r,'roms/MD',n),data);
const run=(root,options={})=>sync({root,logger:()=>{},...options});

test('当前品牌前缀、版本号与原作识别保持独立，已知身份不被 ROM 头部替换',()=>{
 const name='【小咪优化】MD梦幻模拟战2-狮子骑士崛起·一周目PLUS增值版v4.bin';
 assert.equal(displayName(name,'MD'),'梦幻模拟战2-狮子骑士崛起·一周目PLUS增值版v4');
 assert.equal(matchGameIdentity('MD',name).queries[0],'Langrisser II');
 assert.equal(matchGameIdentity('MD','【小咪优化】MD光明力量2古代封印_意志之路2.2.bin').queries[0],'Shining Force II - Inishie no Fuuin');
 assert.equal(matchGameIdentity('MD','MD梦幻模拟战20.bin'),null);
 assert.deepEqual(buildCoverQueries({platform:'MD',sourceName:name},{},'WRONG TITLE').queries,['Langrisser II']);
 const entries=['Shining Force (Japan).png','Shining Force II (Japan).png'].map(name=>({name,href:encodeURIComponent(name)}));
 assert.equal(selectBoxart(entries,'Shining Force II').name,'Shining Force II (Japan).png');
});

test('多个改版复用封面；第二次零查图零哈希；改名保留 ID 和手工标题',()=>fixture(async root=>{
 await put(root,'【小咪优化】MD梦幻模拟战2_版本A.bin','A');await put(root,'MD梦幻模拟战2_版本B.bin','B');
 let calls=0;const lookupCover=async()=>{calls++;return {bytes,coverSource:source}};
 const first=await run(root,{lookupCover});assert.equal(calls,1);assert.equal(first.summary.downloaded,1);assert.equal(first.summary.reused,1);
 assert.equal(first.games[0].cover,first.games[1].cover);assert.match(first.games[0].cover,/^covers\/MD\/langrisser-ii-.*\/boxart-/);
 const again=await run(root,{lookupCover:()=>{throw Error('不应联网')}});assert.equal(again.summary.hashed,0);assert.equal(again.summary.downloaded,0);assert.equal(again.summary.unchanged,2);
 const changedCatalog=again.games;changedCatalog[0].title='人工标题';await writeJson(path.join(root,'games.json'),changedCatalog);
 const old=changedCatalog[0];await rename(path.join(root,old.rom),path.join(root,'roms/MD/MD梦幻模拟战2_改名.bin'));
 const renamed=await run(root,{lookupCover});const retained=renamed.games.find(g=>g.id===old.id);
 assert.equal(retained.title,'人工标题');assert.equal(retained.gameId,old.gameId);assert.equal(renamed.summary.renamed,1);assert.equal(renamed.summary.removed,0);assert.equal(calls,1);
}));

test('未匹配跨运行缓存；修改识别规则和显式重试会重新查询',()=>fixture(async root=>{
 await put(root,'Unknown.bin');let calls=0;const lookupCover=async()=>{calls++;return null};
 await run(root,{lookupCover});assert.equal(calls,1);
 const second=await run(root,{lookupCover});assert.equal(calls,1);assert.equal(second.summary.negativeCached,1);
 await run(root,{lookupCover,retryUnmatched:true});assert.equal(calls,2);
 await writeJson(path.join(root,'metadata/aliases.json'),{Unknown:'Langrisser II'});
 await run(root,{lookupCover});assert.equal(calls,3);
}));

test('网络故障只暂缓，不永久记为无图；冷却后重试',()=>fixture(async root=>{
 await put(root,'Unknown.bin');let calls=0;const lookupCover=async()=>{calls++;const e=Error('offline');e.kind='network';throw e};
 await run(root,{lookupCover,now:1000});await run(root,{lookupCover,now:2000});assert.equal(calls,1);
 await run(root,{lookupCover,now:3601001});assert.equal(calls,2);
}));

test('只处理新增/改动，删除只更新目录且不删除共享封面',()=>fixture(async root=>{
 await put(root,'MD梦幻模拟战2_A.bin','A');const lookupCover=async()=>({bytes,coverSource:source});
 const first=await run(root,{lookupCover});const cover=first.games[0].cover;
 await put(root,'MD梦幻模拟战2_B.bin','B');let second=await run(root,{lookupCover:()=>{throw Error('不应联网')}});
 assert.equal(second.summary.added,1);assert.equal(second.summary.hashed,1);assert.equal(second.summary.unchanged,1);
 const a=second.games.find(g=>g.sourceName.endsWith('_A.bin'));await put(root,a.sourceName,'changed ROM bytes');
 second=await run(root,{lookupCover});assert.equal(second.summary.changed,1);assert.equal(second.games.find(g=>g.id===a.id).gameId,a.gameId);
 await rm(path.join(root,'roms/MD',a.sourceName));second=await run(root,{lookupCover});assert.equal(second.summary.removed,1);assert.equal(second.games.length,1);assert.ok((await stat(path.join(root,cover))).isFile());
}));

test('封面被删后恢复；手工封面优先且不被覆盖',()=>fixture(async root=>{
 await put(root,'MD梦幻模拟战2.bin');let calls=0;const lookupCover=async()=>{calls++;return {bytes,coverSource:source}};
 const first=await run(root,{lookupCover});await rm(path.join(root,first.games[0].cover));await run(root,{lookupCover});assert.equal(calls,2);
 await mkdir(path.join(root,'covers/manual'),{recursive:true});await writeFile(path.join(root,'covers/manual/test.png'),bytes);
 await writeJson(path.join(root,'metadata/overrides.json'),{'MD梦幻模拟战2.bin':{cover:'covers/manual/test.png'}});
 const third=await run(root,{lookupCover});assert.equal(calls,2);assert.equal(third.games[0].cover,'covers/manual/test.png');
}));

test('dry-run 不落盘、不联网；畸形 JSON 不被静默覆盖',()=>fixture(async root=>{
 await put(root,'Unknown.bin');await writeFile(path.join(root,'games.json'),'[]\n');
 await run(root,{dryRun:true,lookupCover:()=>{throw Error('不应联网')}});
 assert.equal(await readFile(path.join(root,'games.json'),'utf8'),'[]\n');
 assert.equal(await readJson(path.join(root,'metadata/sync-state.json'),null),null);
 await writeFile(path.join(root,'games.json'),'{broken');await assert.rejects(run(root),/无法读取/);
}));

test('复制相同内容的多个文件不会被误认为同一个改名游戏；符号链接被跳过',()=>fixture(async root=>{
 await put(root,'A.bin');const first=await run(root,{noNetwork:true});await rm(path.join(root,'roms/MD/A.bin'));
 await put(root,'B.bin');await put(root,'C.bin');await symlink('/etc/hosts',path.join(root,'roms/MD/link.bin'));
 const second=await run(root,{noNetwork:true});assert.equal(second.summary.renamed,0);assert.equal(second.summary.removed,1);assert.equal(new Set(second.games.map(g=>g.id)).size,2);assert.ok(second.games.every(g=>g.id!==first.games[0].id));assert.equal(second.skipped[0].reason,'symbolic-link');
}));

test('手工封面路径越界时阻止同步',()=>fixture(async root=>{
 await put(root,'A.bin');await writeJson(path.join(root,'metadata/overrides.json'),{'A.bin':{cover:'covers/../../secret.png'}});
 await assert.rejects(run(root,{noNetwork:true}),/路径不合法/);
}));


test('显式重试时，同一原作多个无图版本每轮仍只查询一次',()=>fixture(async root=>{
 await put(root,'MD梦幻模拟战2_A.bin','A');await put(root,'MD梦幻模拟战2_B.bin','B');
 let calls=0;const lookupCover=async()=>{calls++;return null};
 await run(root,{lookupCover});assert.equal(calls,1);
 await run(root,{lookupCover,retryUnmatched:true});assert.equal(calls,2);
}));

test('缺失 ROM 根目录时停止，不清空旧目录',()=>fixture(async root=>{
 await put(root,'A.bin');await run(root,{noNetwork:true});
 const before=await readFile(path.join(root,'games.json'),'utf8');
 await rename(path.join(root,'roms'),path.join(root,'roms-backup'));
 await assert.rejects(run(root,{noNetwork:true}),/ENOENT/);
 assert.equal(await readFile(path.join(root,'games.json'),'utf8'),before);
}));
