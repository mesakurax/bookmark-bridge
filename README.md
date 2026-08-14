# Bookmark Bridge

一个简洁的 Windows 命令行工具，在不修改 Chrome Sync / Edge Sync 设置的前提下，手动桥接收藏夹、密码和浏览记录。

## 7 个主要命令

```powershell
# 收藏夹
bookmark-bridge bookmarks-to-chrome  # Edge -> Chrome
bookmark-bridge bookmarks-to-edge    # Chrome -> Edge

# 密码
bookmark-bridge passwords-to-chrome  # Edge -> Chrome
bookmark-bridge passwords-to-edge    # Chrome -> Edge

# 历史记录：无方向，双方都变成 A+B
bookmark-bridge history

# 完整同步
bookmark-bridge all-to-chrome         # 收藏夹/密码 Edge -> Chrome；历史双向
bookmark-bridge all-to-edge           # 收藏夹/密码 Chrome -> Edge；历史双向
```

浏览器重启完全自动，无需额外参数。需要关闭浏览器时，工具会自动关闭并重开原本有窗口的浏览器；浏览器原本没开则不会额外打开。关闭窗口可能丢失尚未提交的网页表单文字。

查看状态和完整中文帮助：

```powershell
bookmark-bridge status
bookmark-bridge -h
```

## 数据规则

### 收藏夹

默认使用安全的 `merge`：源端新增/修改进入目标端，同时保留目标端独有项目。收藏夹不再直接修改 `AccountBookmarks` 文件，而是通过浏览器官方 `bookmarks` API 写入 `syncing: true` 的账户根目录，让 Chrome/Edge 同时更新云同步元数据。

工具在同一父目录下按文件夹名称匹配，书签按完整 URL 匹配；已有 URL 可以移动到源端对应目录。浏览器实时模型会在命令返回前再次验证，因此反复运行不会不断制造副本，也不会再出现 Chrome 重启后回滚却显示成功的问题。

Chromium 可能不提供“移动收藏夹”根目录。此时其中内容会写入账户的“其他收藏夹”，保证仍由浏览器同步且不丢失。

```powershell
bookmark-bridge bookmarks-to-chrome --dry-run
bookmark-bridge bookmarks-to-chrome
```

精确镜像会删除目标端独有收藏夹，必须先预览并显式确认：

```powershell
bookmark-bridge bookmarks-to-edge --mode mirror --dry-run
bookmark-bridge bookmarks-to-edge --mode mirror --yes
```

### 密码

密码使用浏览器原生 CSV 导出/导入，不直接解密 Chrome/Edge 的密码数据库。命令会打开源页面、识别新导出的密码 CSV、移动到本地临时目录、打开目标页面，并在导入完成后删除明文 CSV。

导出、Windows Hello 和导入确认必须由你亲自操作，因此密码迁移不是无人值守流程。目标浏览器遇到相同 `网址 + 用户名` 时会显示冲突；本次源浏览器是主导时选择“替换”，否则选择“跳过”。

### 浏览记录

历史记录采用双向集合合并：第一次全量比较，以后利用本地增量基线只处理新访问。工具按网址、精确访问时间、跳转类型等稳定事件字段去重：

- 同一个已复制事件再次运行：不会重复；
- 同一网址在 10:00 和 10:05 分别访问：保留两条；
- 两边恰好各有一条相同事件：最终各保留一条；
- 在一边删除旧历史：删除不会传播，也不会在下一次被旧基线补回。

```powershell
bookmark-bridge history --dry-run
bookmark-bridge history
bookmark-bridge history --reset-history-baseline
```

即使是历史记录预览，也可能需要短暂关闭两款浏览器，因为 Chromium 会锁定 History 数据库。

### 完整同步

`all-to-chrome` / `all-to-edge` 依次处理收藏夹、密码和历史记录。收藏夹自动完成，密码阶段等待安全确认，历史记录最后自动关闭两款浏览器、合并并重开。

它不是跨三类数据的原子事务；收藏夹和历史记录分别留有备份。

## 安装

要求：Windows 10/11、Chrome 和/或 Edge、Node.js 22.12 或更高版本。

一键安装最新版：

```powershell
irm https://raw.githubusercontent.com/mesakurax/bookmark-bridge/main/install-remote.ps1 | iex
```

或者从 Release 解压后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装位置：

- 程序：`%LOCALAPPDATA%\Programs\BookmarkBridge`
- 命令入口：`%USERPROFILE%\.local\bin\bookmark-bridge.cmd`
- 浏览器扩展：`%LOCALAPPDATA%\Programs\BookmarkBridge\extension`

### 首次浏览器设置

Chrome/Edge 不允许普通程序静默安装本地扩展，因此首次安装后需要在两款浏览器中各确认一次：

```powershell
bookmark-bridge setup
```

该命令会打开两款浏览器的扩展页面和扩展文件夹。分别执行：

1. 打开“开发者模式”；
2. 点击“加载已解压的扩展程序”；
3. 选择打开的 `extension` 文件夹；
4. 确认名称为 Bookmark Bridge，扩展 ID 为 `faaofhehocblpehenggfdmpbpjnifpim`。

升级后如果扩展页仍显示旧版本，在 Bookmark Bridge 卡片上点一次“重新加载”。

安装程序已经注册仅限当前用户的 Native Messaging 主机。扩展只接受带一次性随机任务令牌的本机任务；收藏夹内容不会发送到网络。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\BookmarkBridge\uninstall.ps1"
```

## 配置文件和备份

默认使用两款浏览器的 `Default` 配置。其他配置可指定：

```powershell
bookmark-bridge all-to-chrome --edge-profile "Profile 1" --chrome-profile "Profile 2"
```

默认数据目录：

- 备份：`%LOCALAPPDATA%\BookmarkBridge\backups`
- 历史增量基线：`%LOCALAPPDATA%\BookmarkBridge\state`
- 密码临时中转：`%LOCALAPPDATA%\BookmarkBridge\password-transfer`

历史基线只记录配置路径、数据库版本和最大访问 ID，不保存网址。密码 CSV 不进入备份，正常流程结束后立即删除；超过 24 小时的工具自有残留中转文件会在下次密码迁移前清理。

## 开发

项目没有第三方运行时依赖。

```powershell
npm run check
npm test
node --no-warnings bookmark-bridge.js -h
```

每次实际写入前均校验数据结构并创建原始备份。历史写入任一侧失败时会尝试恢复两边数据库；收藏夹通过浏览器实时 API 写入并验证账户同步模型。

## 许可

[MIT](LICENSE)
