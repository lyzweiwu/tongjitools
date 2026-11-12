# TongjiTools · 同济校园助手（本地版）

面向 Codex 的同济校园查询工具。用户在自己的电脑上登录同济官网，插件通过独立 Chrome 会话读取本人可见的课表、高等讲堂信息，并查询图书馆馆藏。

当前版本：`0.1.0`。当前适配与验证环境为 **macOS、Google Chrome、研究生教务页面**；本科生专属页面和 Windows 尚未单独验收。

## 已验证功能

- 研究生课表：课程名称、课程编号、教师、教学安排、备注与校区。
- 高等讲堂：完成进度卡片及最终成绩状态；区分进度统计与具体讲座记录。
- 图书馆：按关键词检索，读取当前结果页的书名、版次、索书号、纸本数与可借数。
- 登录会话在本机保存和复用；学校端会话失效时重新登录。

查询依据来自实际网页。未加载、页面变化、空结果及无法结构化读取会返回不同状态；无法访问不代表没有课程或没有馆藏。馆藏数量不能直接解释成某一分馆或某一册的状态，隐藏分页及未打开的详情不自动补全。

## 安装和接入 Codex

需要 Node.js 20+、Google Chrome，以及可正常访问学校业务网页的网络环境。

```sh
git clone https://github.com/lyzweiwu/tongjitools.git
cd tongjitools
sh bin/setup.sh
sh bin/launch.sh cli doctor
codex mcp add tongji-campus-local -- /bin/sh "$PWD/bin/launch.sh"
```

安装依赖时优先使用 pnpm，也支持 npm；`playwright-core` 使用本机 Chrome，无需额外下载浏览器。运行 `codex mcp list` 检查连接，然后新建 Codex 聊天，输入“帮我查询同济课表”。首次使用由用户在打开的独立 Chrome 窗口中自行完成学校登录。

上述命令直接配置本地 MCP 连接。仓库同时包含 `plugin.json`、`mcp.json`、Codex 兼容清单与 `skills/tongji-campus/SKILL.md`，可用于插件封装。移动源码目录后，需要更新 MCP 连接中的绝对路径。

## 工具

| 工具 | 用途 |
| --- | --- |
| `campus_status` | 检查本地运行环境与浏览器状态。 |
| `campus_open_login` | 打开教务或图书馆页面，供用户自行登录。 |
| `campus_query_timetable` | 查询个人课表。 |
| `campus_query_lectures` | 查询高等讲堂进度或页面中的讲座记录。 |
| `campus_search_books` | 查询书目与页面明确显示的馆藏数量。 |
| `campus_read_current_page` | 读取用户手动定位的同济业务页面。 |
| `campus_close_browser` | 关闭插件专用浏览器并保留本机会话。 |

若工具提示需要定位页面，在插件打开的浏览器中手动进入目标页面后继续查询。返回 `page_pending` 时，等待页面更新后读取当前页，不将旧结果用于回答新查询。

## 本地命令行

```sh
sh bin/launch.sh cli login academic
```

登录后，在同一终端会话中输入 `query timetable`、`query lectures`、`books 线性代数`、`read academic`、`read library`、`status` 或 `close`。每次单独启动的 CLI 是独立进程，不会控制另一条 CLI 或 MCP 进程中打开的浏览器。

## 本地数据与配置

macOS 默认会话目录为 `~/Library/Application Support/TongjiCampusLocal`。该目录中的浏览器配置和会话文件包含敏感登录状态，不应上传或共享。测试与开发的临时数据可通过 `TONGJI_CAMPUS_DATA_DIR` 指定到本机私有目录。

| 环境变量 | 用途 |
| --- | --- |
| `TONGJI_CAMPUS_DATA_DIR` | 指定本机会话目录。 |
| `TONGJI_CHROME_PATH` | 指定 Chrome 可执行文件。 |
| `TONGJI_NODE_PATH` | 指定 Node 可执行文件。 |
| `TONGJI_ACADEMIC_URL` | 覆盖教务入口，只接受 HTTPS 同济域名。 |
| `TONGJI_LIBRARY_URL` | 覆盖馆藏入口，只接受 HTTPS 同济域名。 |
| `TONGJI_HEADLESS=1` | 无界面测试模式；人工登录使用默认有界面模式。 |

密码和验证码由用户在学校网页中处理；插件不提供密码输入或凭证导出工具。Cookie 与业务页面的 sessionStorage 只在本机私有目录保存，状态文件仅本人可读写。查询结果会返回 Codex 并由模型处理，“凭证保存在本机”不代表查询结果不会离开电脑。

插件提供只读查询，不自动选课、退课、报名、预约、续借、提交评价、提交心得或修改资料。本项目为个人工具原型，非同济官方产品；正式推广前需核实学校对相应自动化访问方式的要求。

## 验证与开发

```sh
npm test
node test/browser-smoke.mjs
```

当前默认测试共 29 项，覆盖 MCP 握手、输入验证、解析、空结果与凭证输出边界。Chrome 模拟集成检查共 9 项，覆盖工作台导航、拆分表格、讲堂卡片、异步结果、新标签和本机会话恢复。测试使用虚构数据，仓库不包含个人课表、讲堂记录、登录会话或页面截图。

- `src/`：MCP 服务、浏览器连接与解析器。
- `bin/`：启动和依赖安装脚本。
- `skills/`：Codex 查询流程与证据处理规则。
- `test/`：自动化验证与模拟浏览器集成检查。
