import {spawnSync} from 'node:child_process';
import {projectRoot} from './rom-config.mjs';
function run(command,args,options={}){
 const result=spawnSync(command,args,{cwd:projectRoot,stdio:'inherit',...options});
 if(result.error)throw result.error;if(result.status!==0)throw Error(`${command} 执行失败，停止发布`);
 return result.stdout?.trim();
}
const dryRun=process.argv.slice(2).includes('--dry-run');
for(const arg of process.argv.slice(2))if(arg!=='--dry-run')throw Error(`未知参数：${arg}`);
if(dryRun){run(process.execPath,['tools/sync.mjs','--dry-run']);console.log('预览完成，未提交或上传。');}
else{
 const remote=run('git',['remote','get-url','origin'],{stdio:['ignore','pipe','inherit'],encoding:'utf8'});
 if(!/^(https:\/\/github.com\/joenix\/xiaomi-hack-roms-libraries(?:\.git)?|git@github.com:joenix\/xiaomi-hack-roms-libraries(?:\.git)?)$/.test(remote))throw Error('远端不是指定的 libraries 仓库，停止发布');
 const branch=run('git',['branch','--show-current'],{stdio:['ignore','pipe','inherit'],encoding:'utf8'});
 if(branch!=='main')throw Error('请在 main 分支发布');
 run(process.execPath,['tools/sync.mjs']);
 run('npm',['test']);
 run(process.execPath,['tools/build-pages.mjs']);
 run('git',['add','--all','--','roms','covers','metadata','reports','games.json','library.json','player-config.json','library.config.json','package.json','pnpm-lock.yaml','tools','tests','README.md','.github','.gitignore']);
 run('git',['diff','--cached','--check']);
 const status=run('git',['diff','--cached','--name-only'],{stdio:['ignore','pipe','inherit'],encoding:'utf8'});
 if(status)run('git',['commit','-m','Update game library and generated catalog']);
 run('git',['-c','http.version=HTTP/1.1','-c','credential.helper=!gh auth git-credential','push','-u','origin','main']);
 console.log('已推送。GitHub Actions 正在发布，成功后刷新游戏大厅即可读取更新。');
}
