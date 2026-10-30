# 小咪游戏资源库

本地路径：`/Users/joenix/Game/@小咪优化/xiaomi-hack-roms-libraries`

这个项目独立维护 ROM、封面和游戏目录，不需要安装第三方依赖。要求 Node.js 22+。资源发布到 GitHub Pages，由独立游戏大厅自动读取。

## 日常更新

将 ROM **复制**到 `roms/MD/`、`roms/FC/`、`roms/SFC/`、`roms/GBA/` 或 `roms/PSP/`，然后在本项目目录运行：

```bash
pnpm run sync
```

也可以用 `npm run sync`，或者直接 `node tools/sync.mjs`。

扫描结果写入 `games.json`，图片保存到 `covers/<平台>/<原作标识>/boxart-<内容哈希>.png`。多个 Hack 版本共用原作封面。原始文件名和 ROM 内容不会被修改；展示名去掉品牌、平台前缀和下划线，保留改版名与版本号。`originalTitle` 是用于归类的原作名。

- 已有封面不重复查询、下载；新增改版优先复用已有原作封面。
- 文件大小和修改时间不变时复用上次 SHA-256，不重复读取整个 ROM。
- 内容相同、旧路径消失且新旧映射唯一时，改名保留原游戏 ID；存在多个相同文件时不擅自合并。
- 同一路径替换 ROM 会更新内容哈希，并保留游戏 ID。真正的不同游戏应使用新文件名。
- 删除 ROM 后，从目录中移除该项，但不自动删除共享封面。
- 未找到封面的结果持久缓存；修改对应查询规则后自动重试，或者使用下方显式重试命令。
- 网络故障暂缓一小时后再试，不永久认定无图。超时和重试次数可在 `library.config.json` 调整。
- 首次查询仍可能需要下载所在平台的封面索引，默认缓存七天。

```bash
pnpm run sync --dry-run           # 只预览，绝不联网或写入
pnpm run sync --no-network        # 离线整理，允许写入目录和复用本地封面
pnpm run sync --retry-unmatched   # 重试未匹配和网络暂缓的项目
pnpm test                        # 在临时目录验证同步行为，不操作真实 ROM
```

使用 npm 时，参数前加 `--`，例如 `npm run sync -- --dry-run`。

## 目录结构

```text
roms/<平台>/                     原始游戏，可含子目录
covers/<平台>/<原作标识>/         自动封面，共享且按内容哈希命名
metadata/aliases.json            名称别名
metadata/overrides.json          单个游戏的修正，优先级最高
metadata/cover-seeds.json        从旧项目迁入的已确认封面
metadata/sync-state.json         文件指纹、稳定 ID、匹配缓存（请保留）
reports/unmatched-covers.json    无图游戏和原因
reports/skipped-files.json       不支持的文件、空文件及符号链接
reports/last-sync.json           最近一次同步统计
games.json                      网站将来读取的完整目录
```

## 修正识别或指定封面

例如在 `metadata/aliases.json` 写入中文标题到原作查询名的映射（最长前缀优先）：

```json
{
  "某个中文标题": "Original English Title"
}
```

在 `metadata/overrides.json` 以游戏 ID、相对 ROM 路径或完整文件名作为键，支持 `title`、`searchTitle`、`region`、`cover`、`skip`：

```json
{
  "【小咪优化】MD某游戏.bin": {
    "title": "我希望展示的名字 v1.0",
    "searchTitle": "Original English Title",
    "cover": "covers/MD/manual/my-cover.png"
  }
}
```

手工封面请先自行放入指定路径，PNG/JPEG/WebP 均可；同步不会覆盖手工图片。`skip: true` 表示不自动查图。图像路径必须在本项目 `covers/` 内。`region` 支持 `jp`、`us`、`any`，为地区偏好，不保证每个游戏都有对应地区封面。

未知中文名不一定能自动转换成准确英文原作名；低置信度保留无图，查看报告后补别名或手工封面。不会根据改版副标题强行匹配其他作品。

## 旧项目封面迁移

本次已迁入原项目中九组已匹配封面；需要再次导入时：

```bash
pnpm run covers:import --from /Users/joenix/Game/@小咪优化/xiaomi-hack-roms
pnpm run sync
```

迁移只读取来源目录中的游戏 JSON 和封面，不复制或更改原项目 ROM。同一封面按内容哈希复用。

## 发布和更新线上游戏

游戏大厅：https://joenix.github.io/xiaomi-hack-roms/

资源配置：https://joenix.github.io/xiaomi-hack-roms-libraries/library.json

日常只需要在本目录运行：

```bash
pnpm run publish
```

它会依次同步游戏和封面、运行测试、校验并生成发布包、提交变更并推送到 `main`。GitHub Actions 自动构建和发布；在仓库 Actions 页面看到成功后，刷新游戏大厅即可。无需更新前端仓库。要求本机 GitHub 登录有推送权限。

新增：将文件复制到 `roms/<平台>/`，再运行发布命令。

替换：更新同一路径的 ROM，再发布；游戏 ID 保留，下载地址随内容哈希更新。新版本能否使用旧存档取决于 ROM 自身兼容性。

删除：从资源目录移走文件，再发布；新目录不再显示该游戏，Git 历史中的旧文件仍然存在。

改标题或指定图片：编辑 `metadata/overrides.json`，再发布。

全站公告/开关：编辑根目录 `library.json` 的 `notice` 或 `playEnabled`，再发布。平台更新这些设置不需要修改前端代码。

播放器按键/音量等：修改 `player-config.json`，再发布。

```bash
pnpm run publish --dry-run   # 只预览本地变化，不写入、不推送
```

ROM、封面和目录均为公开可下载的仓库内容。发布包仅包含被目录引用的资源和公开配置，不包含同步缓存、工具或私密文件。目录与播放器配置使用内容哈希版本，`library.json` 是固定入口。单个文件必须小于 100 MiB，发布包小于 1 GiB。

网页已打开的玩家需要刷新后才能读到更新。资源文件采用版本地址；更新时建议等待 Actions 完整部署成功再通知玩家刷新。

同步锁位于 `.cache/sync.lock`。如果进程异常退出，确认没有其他同步正在运行后，再清理该锁目录。不要删除 `metadata/sync-state.json`，否则会丢失增量缓存和改名跟踪。

基础名称词典、Libretro 匹配器和网络重试模块复用自原 `xiaomi-hack-roms` 项目。同步不会将 ROM 字节发送给封面服务。
