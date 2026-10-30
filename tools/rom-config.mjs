import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function loadRomConfig() { return {romRoot: path.join(projectRoot, 'roms')}; }
export async function safeRomFile(root, relative) {
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(x => !x || x === '.' || x === '..')) throw Error('资源路径不合法');
  const base = await realpath(root);
  const full = await realpath(path.resolve(root, relative));
  if (!full.startsWith(base + path.sep)) throw Error('资源超出目录');
  return { full, stat: await stat(full) };
}
