# URL Bar Priority

Sine 本地模组：自定义 Zen 地址栏的结果权重和 provider 权重。默认将固定标签 / Essentials、其他已打开标签排在新访问 / 搜索前；Enter 切换已有标签。

## 安装

需要先安装 Sine，并启动一次浏览器。仓库安装不需要终端；尚未提交到 Sine 市场列表。

### 在 Zen 内安装（推荐）

1. 打开 **设置 → Sine Mods**，点击市场下方、仓库输入框旁的齿轮按钮。
2. 开启 **Enable installing JS from unofficial sources**（允许第三方 JS，配置键 `sine.allow-unsafe-js`）。
3. 回到仓库输入框，粘贴以下地址，点击 **Install**：

```text
https://github.com/NightWatcher314/zen-urlbar-priority
```

4. 按 Sine 提示重启 Zen，在 **Sine Mods → URL Bar Priority** 中调整权重。

此方式由 Sine 下载、注册和管理模组。更新代码后重启浏览器，让进程级模块加载新版本。

### 本地安装包

也可从 [GitHub Releases](https://github.com/NightWatcher314/zen-urlbar-priority/releases) 下载 ZIP，使用随包安装器。

1. 在 Zen 的 `about:profiles` 找到使用中 profile 的 **根目录**（Root Directory），不要选 Local Directory。
2. 在 Sine 设置启用“允许第三方 JavaScript 模组”（`sine.allow-unsafe-js`）。
3. **完全退出 Zen**，解压本包，在包目录运行：

```sh
# 将路径替换成 about:profiles 显示的根目录。先预览：
uv run --no-project python install.py "/path/to/profile"
# 执行安装；自动备份已有注册表和同 ID 模组：
uv run --no-project python install.py "/path/to/profile" --apply
```

没有 `uv` 时可用系统 `python3`；安装器只用 Python 标准库。

4. 重开 Zen，在 **设置 → Sine Mods → URL Bar Priority** 展开配置。

安装只增加 `chrome/sine-mods/d97b7d1d-13c5-4e19-81a9-0ab41db785e3/` 的四个文件，合并 `mods.json` 中对应注册项。保留其他模组，不修改 `prefs.js`、历史、书签、扩展或浏览器安装目录。安装器不会替你启用第三方 JS。浏览器运行时不要运行安装器，以免与 Sine 自身写注册表冲突。

备份路径由安装器输出；macOS/Linux 默认 `~/.local/state/zen-urlbar-priority-backups/`，Windows 默认 `%LOCALAPPDATA%/zen-urlbar-priority-backups/`。本地包关闭自动更新，更新时关闭 Zen 后重新运行安装器并重启。

## 配置

**权重越大越靠前；同权重保留原生顺序。** 无匹配标签时，继续正常访问网址或搜索。

默认开启两项：

- **保留搜索入口**：标签很多时仍留一行默认引擎搜索，结果上限为 1 时保留首结果。
- **强制搜索快捷键**：macOS **Command+Enter**、其他平台 **Ctrl+Enter** 用默认引擎搜索原始输入，并打开新标签；不受当前选中结果影响。隐私窗口使用其默认引擎。关闭此项恢复原生快捷键行为。普通 Enter 继续执行首结果 / 切换已有标签。

| 类别 | 默认权重 |
| --- | ---: |
| 固定标签 / Essentials | 120 |
| 其他已打开标签 | 100 |
| 书签 | 60 |
| 历史 | 50 |
| 搜索建议 | 20 |
| 其他结果 | 10 |
| 原生默认访问 / 搜索（heuristic） | 0 |

例如想让普通标签优先于固定标签：将“其他已打开标签”调到 `150`。改后即时生效。

高级 **Provider 权重 JSON** 可覆盖某 provider 的全部结果：

```json
{"PriorityTabs":150,"ZenUrlbarProviderSidebar":100,"Places":80,"SearchSuggestions":10}
```

`Places` 和 `UrlbarProviderPlaces` 等价；仅去掉标准前缀 `UrlbarProvider`，自定义名称保持原样。真实名称由当前浏览器版本决定。provider 覆盖优先于类别权重：例如将 `PriorityTabs` 设为 `150` 后，其固定 / 普通标签均使用 `150`。

在浏览器工具箱或浏览器控制台的浏览器窗口作用域可查询：

```js
window.ZenUrlbarPriority.providers() // 当前注册的 provider 名称
window.ZenUrlbarPriority.status()   // active / error / owners
window.ZenUrlbarPriority.results()  // 当前结果 provider / type / source；不输出 URL 或标题
```

错误 JSON 会停用自定义排序，回退原生结果；修正后自动恢复。地址栏“已打开标签”建议需保持开启。启用显式搜索引擎、限制搜索 token（例如 `%`）、书签关键字或显式 Zen 命令模式时，保留原生行为。普通输入出现 New Space 等动作建议时，仍按权重优先显示标签；动作建议保留其原生执行功能。

## 实现边界

- `PriorityTabs` 在本地扫描当前窗口、当前 Zen 工作区的现有标签；按 URL 和标题包含输入词进行匹配。普通词匹配忽略 URL query 参数，避免 `newwindow` 等参数误命中；输入 `?`、`=` 或 `&` 时按完整 URL 匹配。当前标签、关闭中的标签、隐藏标签不参与该扫描。普通与隐私窗口分开处理。
- 其他原生 provider 保留；其返回结果经过原生过滤 / 去重，再进行自定义排序。额外本地标签 provider 用于补齐被原生候选限额漏掉的较旧标签。
- 候选扫描不读取网页正文、不发送请求、不连接外部服务；主动使用搜索快捷键时，由浏览器向所选默认引擎提交搜索。没有匹配时保留原生默认访问 / 搜索。原生结果类型保持不变，沿用浏览器的 tab-switch 执行路径。
- 同 URL 在多个窗口 / 容器 / 标签中重复出现时，具体切到哪一个仍遵循原生切换行为；此版本不建立额外标签身份绑定。固定标签在导航到其他页面后，按其**当前 URL / 标题**匹配，不索引最初固定的 URL。
- 可默认选中 URL、搜索、TAB_SWITCH 类型；特殊动态结果不会强行变成默认动作。浏览器内部接口可能随更新变化。
- 已验证版本见 [验证记录](docs/validation.md)。更早版本有接口适配，但未承诺兼容；macOS 实机尚未验证。

## 停用 / 回退

优先在 Sine 中停用或卸载。模组会移除自己的 provider、排序 hook、窗口 pick hook 和快捷键监听；保留设置值方便重装。如果 Sine 自身未成功完成卸载，重启浏览器。

安装回退：关闭 Zen，按安装器输出的备份位置恢复 `mods.json` 和同 ID 模组目录。注册表备份会覆盖备份之后的其他模组注册变化；已有其他变更时只移除这个 ID 的注册项。

## 开发与验证

```sh
npm test
uv run --no-project python -m unittest discover -s tests -p 'test_*.py'
uv run --no-project --with marionette-driver python tests/browser_smoke.py /path/to/zen /path/to/Sine-source
```

没有 Sine 源码时省略最后一个参数。浏览器测试使用临时 profile、本地测试页和 Gecko Marionette；不使用个人 profile。配置和加载验证可使用真实 Sine 源码的 `getScripts` / `parsePref`，但不是完整 Sine 安装器端到端测试。

`priority.uc.js` 是 Sine 窗口入口；`priority.sys.mjs` 在进程级 system module 中保存 provider / muxer 逻辑，避免首个浏览器窗口关闭后其异步任务停止。Sine metadata 与配置分别在 `theme.json`、`preferences.json`。
