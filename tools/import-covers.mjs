/** One-time migration of previously vetted covers; never imports ROMs. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectRoot, safeRomFile } from './rom-config.mjs';
import { readJson, writeJson, saveCover } from './sync.mjs';
export async function importCovers(from, root=projectRoot) {
  const catalog=await readJson(path.join(from,'public/games.json'),null);
  if(!Array.isArray(catalog))throw Error('来源缺少 public/games.json');
  const seeds=await readJson(path.join(root,'metadata/cover-seeds.json'),[]);
  for(const game of catalog) {
    if(!game.cover||!game.coverSource?.matchedTitle||!game.coverSource.identityQuery)continue;
    if(!game.cover.startsWith('covers/'))throw Error('来源封面路径无效');
    const {full}=await safeRomFile(path.join(from,'public'),game.cover);
    const query=game.coverSource.identityQuery;
    const cover=await saveCover(root,game.platform,query,await readFile(full));
    const key=`${game.platform}/${query}/${game.coverSource.matchedTitle}`;
    if(!seeds.some(s=>s.key===key))seeds.push({key,platform:game.platform,query,cover,coverSource:game.coverSource});
  }
  await writeJson(path.join(root,'metadata/cover-seeds.json'),seeds);
  console.log(`迁入 ${seeds.length} 组既有封面，不包含 ROM。`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--from')throw Error('用法：pnpm run covers:import -- --from <原项目目录>');
  await importCovers(path.resolve(args[1]));
}
