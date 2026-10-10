# 验证记录

2026-10-10，在 Linux x86_64 上完成。浏览器使用单独下载的 Zen，不替换现有安装；所有浏览器用临时 profile、本地 HTTP 测试页，关闭后移除 profile。

## 基线

- Zen **1.23.2b**，Gecko **157.0.1**，BuildID `20261009073723`。
- 官方 Linux x86_64 发布包 `https://github.com/zen-browser/desktop/releases/download/1.23.2b/zen.linux-x86_64.tar.xz`；SourceStamp `185e856f68a451dc71988e988bc080c56452ea66`。
- Sine 核心源码 commit `fb0bd4ca6af888f10648e126947f7d1f82228433`。验证真实 `getScripts` 和 `parsePref`，不代表完整 Sine 安装器或市场端到端验收。

## 已通过

- [地址栏与 Sine 集成：21 项](evidence/zen-1.23.2b.json)：原生新标签命令、超出原生候选上限的旧固定标签、默认选中、Enter 不重复建标签、secondaryActions 行为、动态权重、provider 覆盖、限制搜索及其 Enter 行为、无效 JSON 回退、重载卸载、查询窗口归属、首窗口关闭后的连续使用、隐私固定标签及隐私隔离、Sine JS gate 和配置解析、普通 `new` 查询中与 Zen 动作建议并存的固定标签排序，以及 learned action 降级后的执行数据保留。
- [排序单测：12 项](evidence/ranking.txt)：类别权重、provider 名称兼容、稳定排序、0 / 负权重、错误配置、特殊搜索、结果跨度、普通 Zen 动作建议不屏蔽排序。
- [安装器：3 项](evidence/installer.txt)：只读预览、备份、保留其他注册项、写入失败回滚和重试、拒绝未安装 Sine 的 profile。
- JS 语法检查；只读独立代码审查发现的问题已修复。

浏览器测试使用 Gecko 原生 Marionette。`BrowserCommands.openTab()` 验证的是 `Ctrl/Command+T` 对应的浏览器命令和 Zen 浮动地址栏路径；没有在 macOS 上发送真实 Command 键。

## 未验证

- 用户日常 profile 的安装及与其已装模组的组合。
- macOS / Windows 实机、早期 Zen / Sine 版本。
- 大量标签的性能压力测试、全部 provider 的特殊动态结果、网络搜索引擎建议。
- 完整 Sine 设置页视觉验收、Sine 安装器及市场下载。

## 结构与回退

排序 hook 和补充标签 provider 在 `priority.sys.mjs` 系统模块中；窗口入口负责 Sine unload 注册。避免 window script 的异步 realm 在首窗口关闭后停止。Provider 从原生查询 controller 获取所属窗口，不能以最近聚焦窗口代替。

最后一个窗口 owner 卸载时注销补充 provider 和 pref observer，撤销自身 hook。若其他模组后来包裹了本模组的 hook，保留其包装，但使本模组的旧链回到原生逻辑。

语法错误、无效 provider JSON 或排序内部异常回退原生结果。未写入用户日常 profile；GitHub 发布及仓库文件回读属于发布验收。

## GitHub 发布回读

2026-10-10 发布公开仓库 [NightWatcher314/zen-urlbar-priority](https://github.com/NightWatcher314/zen-urlbar-priority)，默认分支 `main`，首发 tag / Release 为 [v0.1.0](https://github.com/NightWatcher314/zen-urlbar-priority/releases/tag/v0.1.0)。

匿名下载 `theme.json`、`preferences.json`、`priority.uc.js`、`priority.sys.mjs`，逐字节与本地一致；GitHub codeload 的 `main` ZIP 内四个文件同样一致。Release 附 ZIP 安装包及 SHA-256 文件。GitHub 仓库安装仍需启用 Sine 第三方 JS，尚未提交到 Sine 市场列表。

## v0.1.1 回归修复

普通输入 `new` 可触发 New Space 等 `zenAction` 建议。v0.1.0 把任何这类结果当作显式命令模式，跳过整组排序；即使模组已加载且固定标签权重为 120，标签仍会位于动作 / 搜索结果之后。

回归测试在 v0.1.0 逻辑上实际失败，修复后通过：查询中确实存在 `zenAction`，匹配的固定应用仍排第一且默认选中，Enter 切换原标签、标签数量不变。显式 `searchMode`、限制 token、书签关键字及命令前缀保留原生行为。降级 learned action 时保留其 `commandId` 和原生执行 payload。

更新后需完全退出并重开浏览器，清除进程级系统模块缓存。日常用户 profile 的更新仍由 Sine 管理。


## v0.1.2 搜索入口与强制搜索

普通词不再匹配 URL query 参数中的导航标志（例如 `newwindow`），显式 URL 输入仍匹配完整地址。高权重标签填满列表时，默认保留一个普通搜索入口；结果上限为 1 时保留最高权重结果。搜索去重保留隐私窗口动作语义。

默认启用 macOS Command+Enter / 其他平台 Ctrl+Enter：用默认引擎搜索当前原始输入，在新标签打开，独立于首结果。隐私窗口取隐私默认引擎。设置可关闭。已完成查询或切换标签后，不用旧查询替换当前 URL。

原生回归覆盖 20 个只有 query key 命中的无关标签、满列表搜索入口、本地默认引擎提交与新标签数量、已完成查询后切换页面的原始文本。单测覆盖 macOS modifier、IME / Alt / Shift 排除、完整 URL / 内部 URL、搜索动作语义。macOS 实机 Command+Enter 与隐私默认引擎提交尚未端到端验证。
