# Bookmark Bridge

一个简洁的 Windows 命令行工具，在不关闭 Chrome Sync / Edge Sync、也不修改两款浏览器同步设置的前提下，手动桥接收藏夹、密码和浏览记录。

## 五个同步命令

```powershell
# 三个单项命令
bookmark-bridge bookmarks edge chrome
bookmark-bridge passwords edge chrome
bookmark-bridge history

# 两个完整同步命令
bookmark-bridge all edge chrome
bookmark-bridge all chrome edge
```

浏览器顺序始终是 `<源> <目标>`。收藏夹和密码按这个方向同步；历史记录没有方向，始终让两边都得到 A+B。因此：

- `all edge chrome`：收藏夹、密码 Edge → Chrome；历史记录 Edge ↔ Chrome。
- `all chrome edge`：收藏夹、密码 Chrome → Edge；历史记录 Edge ↔ Chrome。

## 数据规则

### 收藏夹

默认使用安全的 `merge`：源端新增/修改会进入目标端，同时保留目标端独有项目。工具先匹配 Chromium GUID，再匹配唯一文件夹名和完全相同的 URL，反复运行不会不断制造副本。

```powershell
bookmark-bridge bookmarks edge chrome --dry-run
bookmark-bridge bookmarks edge chrome --restart-target
```

精确镜像会删除目标端独有收藏夹，必须先预览并显式确认：

```powershell
bookmark-bridge bookmarks chrome edge --mode mirror --dry-run
bookmark-bridge bookmarks chrome edge --mode mirror --yes --restart-target
```

### 密码

密码使用浏览器原生 CSV 导出/导入，不直接解密 Chrome/Edge 的密码数据库。命令会：

1. 打开源浏览器的密码管理页；
2. 等你亲自确认导出和 Windows Hello；
3. 自动识别下载/桌面中的新密码 CSV，并移动到用户本地临时目录；
4. 打开目标浏览器的密码管理页；
5. 等你亲自完成导入后删除明文 CSV。

```powershell
bookmark-bridge passwords chrome edge
```

密码迁移不是无人值守操作。稳定版 Chromium 没有面向普通用户的完整密码导出命令行接口，安全确认也不应被绕过。目标浏览器遇到相同 `网址 + 用户名` 时会显示冲突；如果本次源浏览器是主导，选择“替换”，否则选择“跳过”。

### 浏览记录

历史记录采用双向集合合并：第一次全量比较，之后保存本地增量基线，只比较新访问。去重键由网址、精确访问时间、跳转类型等稳定事件字段组成：

- 同一个已复制事件再次运行：不会重复；
- 同一网址在 10:00 和 10:05 分别访问：保留两条；
- 两边恰好各有一条相同事件：最终各保留一条；
- 你在一边删除旧历史：删除不会传播，下一次也不会因基线而把本地删除的旧记录补回来。

历史数据库同时写两边，执行前必须退出两款浏览器：

```powershell
bookmark-bridge history --dry-run --restart-browsers
bookmark-bridge history --restart-browsers
```

如果浏览器历史库被重建或配置目录更换，可重新做一次全量基线：

```powershell
bookmark-bridge history --reset-history-baseline --restart-browsers
```

## 完整同步

```powershell
bookmark-bridge all edge chrome --dry-run --restart-browsers
bookmark-bridge all edge chrome --restart-browsers

bookmark-bridge all chrome edge --dry-run --restart-browsers
bookmark-bridge all chrome edge --restart-browsers
```

`all` 依次处理收藏夹、密码和历史记录。收藏夹自动完成，密码阶段会等待你的安全确认，历史记录最后在两款浏览器关闭时合并并重开。实际执行 `all` 必须带 `--restart-browsers`。它不是跨三类数据的原子事务；收藏夹和历史记录分别留有备份。

## 安装

要求：Windows 10/11、Chrome 和/或 Edge、Node.js 22.12 或更高版本。

从 Release 解压后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

仓库版一键安装：

```powershell
irm https://raw.githubusercontent.com/mesakurax/bookmark-bridge/main/install-remote.ps1 | iex
```

安装程序把应用放在 `%LOCALAPPDATA%\Programs\BookmarkBridge`，把命令入口放在 `%USERPROFILE%\.local\bin`，并在需要时加入当前用户 PATH。打开新的 PowerShell 后运行：

```powershell
bookmark-bridge -h
bookmark-bridge status
```

旧名称 `bookmark-sync edge-to-chrome` 和 `bookmark-sync chrome-to-edge` 继续兼容。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\BookmarkBridge\uninstall.ps1"
```

## 配置文件和备份

默认使用两款浏览器的 `Default` 配置。其他配置可指定：

```powershell
bookmark-bridge all edge chrome --edge-profile "Profile 1" --chrome-profile "Profile 2" --restart-browsers
```

默认数据目录：

- 备份：`%LOCALAPPDATA%\BookmarkBridge\backups`
- 历史增量基线：`%LOCALAPPDATA%\BookmarkBridge\state`
- 密码临时中转：`%LOCALAPPDATA%\BookmarkBridge\password-transfer`

历史基线只记录配置路径、数据库版本和最大访问 ID，不保存网址。密码 CSV 不进入备份，正常流程结束后立即删除；超过 24 小时的工具自有残留中转文件会在下次密码迁移前清理。

## 开发

项目没有第三方运行时依赖。

```powershell
node --no-warnings --test *.test.js
node --no-warnings bookmark-sync.js -h
```

每次实际写入前均校验数据结构并创建原始备份。历史写入任一侧失败时会尝试恢复两边数据库；收藏夹使用校验和验证和原子替换。

## 许可

[MIT](LICENSE)
