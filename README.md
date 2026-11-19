# TongjiTools · 同济校园助手（本地版）

面向 Codex 的同济校园查询工具。用户在自己的电脑上登录同济官网，插件通过插件专用浏览器会话读取本人可见的课表、高等讲堂信息，查询图书馆馆藏，准备不提交的委托表单，按馆舍、日期和楼层查询座位。普通座位需用户选定并确认后预约。

当前版本：`0.5.1`。[更新记录](CHANGELOG.md)。当前适配与验证环境为 **macOS、Google Chrome、研究生教务页面**；本科生专属页面和 Windows 尚未单独验收。

## 已验证功能

- 研究生课表：课程名称、课程编号、教师、教学安排、备注与校区。
- 高等讲堂：完成进度卡片及最终成绩状态；区分进度统计与具体讲座记录。
- 图书馆：按关键词检索，读取当前结果页的书名、版次、索书号、纸本数与可借数。
- 委托表单准备：连续检索、定位版本、检查登录并打开申请表，到取书地和手机号即停止。
- 座位查询：已在真实页面验证普通座位日期/馆舍/楼层/区域筛选、具体座位号和考研专座权限提示；真实预约提交尚未验收。
- 登录会话在本机保存和复用；学校端会话失效时重新登录。

查询依据来自实际网页。未加载、页面变化、空结果及无法结构化读取会返回不同状态；无法访问不代表没有课程或没有馆藏。馆藏数量不能直接解释成某一分馆或某一册的状态，隐藏分页及未打开的详情不自动补全。

## 安装和接入 Codex

需要 Node.js 20+，以及可正常访问学校业务网页的网络环境。插件依次检测 Chrome、Edge 和 Chromium。

```sh
git clone https://github.com/lyzweiwu/tongjitools.git
cd tongjitools
sh bin/setup.sh
sh bin/launch.sh cli doctor
codex mcp add tongji-campus-local -- /bin/sh "$PWD/bin/launch.sh"
```

安装依赖时优先使用 pnpm，也支持 npm。已有兼容浏览器时直接使用。若都没有，在源码目录运行 `sh bin/setup.sh --with-browser`，从 Playwright 下载匹配版本的 Chromium 到用户缓存。依赖已经安装时，也可以运行 `sh bin/launch.sh install-browser`。在有 Node.js 的终端中，可用 `node node_modules/playwright-core/cli.js install --no-shell --no-remove chromium` 执行同一下载。

用 `sh bin/launch.sh cli doctor` 查看 `browserName`。可设置 `TONGJI_BROWSER=edge` 或 `TONGJI_BROWSER=chromium` 指定浏览器。首次切换浏览器需重新登录，因为各浏览器使用独立的会话目录。Safari 和 Firefox 暂未适配。

运行 `codex mcp list` 检查连接，然后新开 Codex 聊天，用户在插件专用浏览器中完成学校登录。没有 `sh` 的环境可在安装 Node 依赖后用 `codex mcp add tongji-campus-local -- node <src/server.mjs 的绝对路径>` 直接接入。Windows 路径识别已测，实际 Windows 客户端未验收。

上述命令直接配置本地 MCP 连接。仓库同时包含 `plugin.json`、`mcp.json`、Codex 兼容清单与 `skills/tongji-campus/SKILL.md`，可用于插件封装。移动源码目录后，需要更新 MCP 连接中的绝对路径。

## 工具

| 工具 | 用途 |
| --- | --- |
| `campus_status` | 检查本地运行环境与浏览器状态。 |
| `campus_open_login` | 打开教务或图书馆页面，供用户自行登录。 |
| `campus_query_timetable` | 查询个人课表。 |
| `campus_export_timetable` | 复用个人课表会话，将可确认的课次导出为本机 `.ics` 文件。 |
| `campus_query_lectures` | 查询高等讲堂进度或页面中的讲座记录。 |
| `campus_search_books` | 查询书目与页面明确显示的馆藏数量。 |
| `campus_get_preferences` / `campus_set_preferences` | 查看、保存或重置本机校区、取书点、跨校区和登录偏好。 |
| `campus_recommend_books` | 按作者、书名片段或主题查馆藏，优先显示匹配官方热门借阅榜的版本。 |
| `campus_open_book_request` | 用户选定版本后复查可委托复本并打开正式表单，由用户在官网提交。 |
| `campus_prepare_book_request` | 准备委托表单，到取书地和手机号即停止，不填写、不提交。 |
| `campus_query_seats` | 查询普通/考研/研修座位、区域余位和具体座位号，默认四平路馆。 |
| `campus_reserve_seat` | 用户选定并确认后，重新检查普通座位再点击一次预约；真实提交尚未验收。 |
| `campus_read_current_page` | 读取用户手动定位的同济业务页面。 |
| `campus_close_browser` | 关闭插件专用浏览器并保留本机会话。 |

若工具提示需要定位页面，在插件打开的浏览器中手动进入目标页面后继续查询。返回 `page_pending` 时，等待页面更新后读取当前页，不将旧结果用于回答新查询。

## 导出课表到日历

在插件专用浏览器登录后，可以说「把这学期的课表导出到苹果日历」。助理调用 `campus_export_timetable` 并返回本机文件路径、课程数、事件数及警告。默认参数为 `{}`，使用教务页面可确认的当前学期和已核验校历。以下是页面所选学期已核对为 2026–2027 学年第 1 学期时的 MCP 参数示例。

```json
{
  "semesterStartDate": "2026-09-14",
  "calendarName": "同济大学课表"
}
```

| 参数 | 用途 |
| --- | --- |
| `semesterStartDate` | 当学期无法自动确认时，填所选学期第一教学周的星期一，格式 `YYYY-MM-DD`。和已核验校历冲突时请重新核对学期。 |
| `outputDir` | 已存在、可写的本机绝对目录。默认使用本机会话目录下的 `exports/`，macOS 上通常为 `~/Library/Application Support/TongjiCampusLocal/exports/`。 |
| `calendarName` | ICS 内的日历名称，默认「同济大学课表」。导入时仍需选择目标日历。 |
| `periodTimes` | 经核实适用于该课表的节次与时刻映射，值为 `["HH:mm", "HH:mm"]`。只有课表未直接给出时刻时才用于换算节次。 |
| `scheduleChanges` | 仅传入已通过教务或学院确认、且尚未反映在当前课表的停课、调课或补课。 |

`scheduleChanges` 的每一项用 `courseCode`、原上海日期 `date` 和原开始时刻 `startTime` 唯一匹配一节课。`action` 可填 `cancel`（停课）、`move`（调课）或 `add`（保留原课并另加补课）。后两种需提供 `newDate`，可用 `newTime` 和 `newLocation` 指定已确认的新时段和地点，省略时沿用原值。匹配不到原课次，或新日期时段与同一课程已有安排重叠，工具会要求复核本次变更。

已核验的起始日期和节次作息绑定到 `2025-2026-1`、`2025-2026-2`、`2026-2027-1` 三个学期。校历资料见[同济学期日历数据说明](https://api.tongji.edu.cn/docs/interface/teaching_management_data/educational_administration_data/term_calendar_info/v1_rt_teaching_info_semester)、[同济 2026–2027 学年第一学期校历](https://xxgk.tongji.edu.cn/index.php?classid=3077&newsid=21359&t=show)和[同济建筑与城市规划学院 2026 秋季课表](https://caup.tongji.edu.cn/caupen/d0/84/c33820a381060/page.htm)。未确认的节假日和临时调整保留页面原排课日期，并提示核对通知。

`exported` 表示文件已写入，`partial_export` 还会返回 `omitted`（未导出的课程安排或表格行）及原因。仅可见分页被读取时会提示数据缺口。`needs_calendar_info` 表示缺少可核实的学期锚点或节次时刻，`no_exportable_events` 表示本次没有可写入的课次。登录失效、页面未加载、页面需要手动定位和结构无法识别使用原查询状态。输出文件含个人课程数据，重名时自动加数字后缀。重复导出相同课次保留相同 UID，重复导入时的处理取决于日历客户端。

### 在 macOS 人工验收

1. 重新载入指向此源码目录的 MCP 服务或新开聊天。在插件专用浏览器登录同济教务，选择当前学期的个人课表列表，保留账号和密码在学校页面内。
2. 请求导出。核对工具返回的学期、`courseCount`、`eventCount`、`warnings` 和 `omitted`。对照教务课表和学院通知，抽查连续周、单双周、换教室或调课。需要补充的起始日期、作息或改课信息核实后再导出。
3. 在苹果日历使用「文件 → 导入」打开 `.ics`，选择专用测试日历。如果希望导入后继续只存本机，选用「在我的 Mac 上」的日历。核对导入的课次总数，至少检查课程标题、上海时间和校区教室，再核对一条跨周或跨年安排。见 [Apple 日历导入说明](https://support.apple.com/guide/calendar/import-or-export-calendars-icl1023/mac)。

已在 macOS 苹果日历本机测试日历导入三条虚构课次，核对了中文标题与标点、上海时刻、地点及跨年日期。待用真实研究生页面核验当前版「教学安排」的实际格式和校内临时调课。Google Calendar、Outlook 可使用同一 ICS 文件尝试导入，尚未做各客户端实测。

## 固定委托准备流程（不提交）

先运行 `sh bin/launch.sh cli login library`，在打开的学校窗口完成登录。随后可在同一终端输入 `prepare-book 线性代数 O151.2/ZT437.3A`，或复用已保存会话执行单次调用：

```sh
sh bin/launch.sh cli prepare-book "线性代数" "O151.2/ZT437.3A"
```

一次完成检索、唯一版本定位、登录检查、在架馆藏选择和打开申请表。多个版本未确定时返回 `needs_book_selection`，登录失效时返回 `login_required`。使用 ISBN 检索可减少版本歧义。

准备成功返回 `ready_for_user_input`、`submitted: false`、取书地选项及联系方式是否已填写。不会返回联系方式原值，不选择地点、不填写字段。预览禁用提交按钮，并拦截提交点击和回车；没有提交接口或提交参数。准备成功不等于预约成功。CLI 返回后关闭专用浏览器；MCP 调用保留准备好的表单。

检索结果最长等待 25 秒，后续等待共用 45 秒总预算，其余步骤默认上限保持 12 秒。结果出现后立即继续，超时不自动重复发送检索。`timingsMs` 记录程序各阶段及总耗时，不包含外层审批、工具调用、模型处理和人工登录。

`diagnostics` 记录具体阶段、步骤、等待配置，以及检索请求发出时间、响应状态、持续时间和是否仍在进行。不输出请求头、请求正文或原始错误栈。

| 失败状态 | 含义 |
| --- | --- |
| `search_timeout` | 等待检索结果超时。 |
| `search_request_failed` | 检索请求失败或返回错误。 |
| `page_structure_changed` | 页面结构或执行异常。 |
| `step_timeout` | 其他步骤等待超时。 |
| `flow_timeout` | 总等待预算耗尽。 |
| `browser_error` | 专用浏览器未能正常打开。 |

真实页面已验证准备流程；单次成功不能保证每次同样耗时。更新源码后需要重新载入 MCP 服务或新建聊天，才能发现新增工具。

## 按热门借阅推荐图书

可以说“想要一本东野圭吾的书，按借阅热度推荐”。工具读取同济热门借阅近一年榜单和首屏馆藏结果，用索书号和书目信息核对版本。优先展示可核实的榜单名次、借阅次数和可借册数。榜单仅读取部分条目，未匹配的馆藏备选没有可核实的热度。作者检索按首位责任者核对，避免把作者传记或译作混入原著。可以指定“文学”等榜单学科，也可浏览全部学科。

```sh
sh bin/launch.sh cli recommend-books '{"query":"东野圭吾","match":"author","discipline":"文学"}'
```

回复候选号或书名选定版本后，助手重新检查该版本的可借馆藏并打开官方委托表单。你可以在浏览器选择取书地、核对联系方式并提交。

## 借书与登录偏好

第一次可以说“记住我在四平路校区”，也可以指定官网表单中的取书点全名并设置是否接受跨校调书。之后优先找常用校区有可借复本且有委托入口的馆藏。找不到时默认允许准备跨校区委托，表单会显示实际馆藏地；若关闭跨校调书，则先返回其他馆舍的库存供选择。常用取书点在本次官方表单中唯一、完全匹配时会预选，提交前请确认。

偏好只存于本机会话目录的 `preferences.json`。你可以说“查看借书偏好”“改到嘉定校区”“以后不要跨校调书”或“清除借书偏好”。

登录默认手动，已有会话可以继续使用。使用 Chrome 时可选择快速登录模式，并在插件专用 Chrome 的密码管理器中自行保存同济登录凭证。下次启动专用 Chrome 后，工具可在同济统一认证页识别浏览器自动填充并尝试一次登录；若 Chrome 需要你先选账号，或学校要求验证码、扫码或二次验证，则在浏览器中继续。插件的设置与对话均不接收账号密码，不保存手机号或邮箱。关闭快速登录不会删除 Chrome 中已经存过的条目；如需删除，在 Chrome 密码管理器中操作。

## 座位查询与预约

官方入口为 https://space.tongji.edu.cn/。使用 `campus_open_login(service="seats")` 由用户自行登录，与馆藏页面分别管理标签。

用户可说“查明天四平路馆六楼的座位”。工具返回各区域余位及部分具体座位号，供用户选择；不会自动替用户换楼层或座位类型。CLI 查询示例：

```sh
sh bin/launch.sh cli seats '{"date":"明天","campus":"四平路校区图书馆","floor":"六楼","limit":10}'
```

指定时间时，同时传入 `startTime: "14:00"`、`endTime: "16:00"`。当前普通座位按日、考研/研修座位按期预约，不能锁定小时区间；工具保留这个要求并返回不支持。普通座位次日预约须在次日8:30前签到，不适合只计划下午到馆的用户。四平路综合阅览楼二楼是考研专座，按期预约且需要资格。实际日期、可选楼层和权限以每次页面为准。

用户接受普通座位按日规则、选定候选并明确确认预约后，MCP 使用候选 `selectionId` 调用 `campus_reserve_seat(confirm=true)`。候选只在当前服务进程内保留5分钟、限用一次；工具重新查询、检查座位、仅点击一次官方“立即预约”。`reserved` 代表页面明确显示成功；`outcome_unknown` 需用户到官方“我的预约”核查，不能重复提交。CLI 单次查询结束即关闭进程，候选ID随之失效。

座位查询不会选择座位或提交。考研/研修仅查询，不提供自动预约。普通座位提交仅通过虚构页面测试，尚未对真实预约提交作验收；测试没有预约真实座位。

## 本地命令行

```sh
sh bin/launch.sh cli login academic
```

登录后，在同一终端会话中输入 `query timetable`、`query lectures`、`books 线性代数`、`prepare-book 线性代数 O151.2/ZT437.3A`、`read academic`、`read library`、`status` 或 `close`。每次单独启动的 CLI 是独立进程，不会控制另一条 CLI 或 MCP 进程中打开的浏览器。

已保存有效会话时，可单独导出。目录参数需替换为你电脑上已存在的绝对目录。

```sh
sh bin/launch.sh cli export-timetable
sh bin/launch.sh cli export-timetable '{"semesterStartDate":"2026-09-14","outputDir":"/absolute/path/to/exports"}'
```

若在 `cli login academic` 中完成登录，可直接在同一终端输入 `export-timetable` 或 `export-timetable {"semesterStartDate":"2026-09-14"}`，继续使用当前打开的课表。

## 本地数据与配置

macOS 默认会话目录为 `~/Library/Application Support/TongjiCampusLocal`。该目录中的浏览器配置和会话文件包含敏感登录状态，不应上传或共享。测试与开发的临时数据可通过 `TONGJI_CAMPUS_DATA_DIR` 指定到本机私有目录。

| 环境变量 | 用途 |
| --- | --- |
| `TONGJI_CAMPUS_DATA_DIR` | 指定本机会话目录。 |
| `TONGJI_BROWSER` | 选择 `auto`（默认）、`chrome`、`edge` 或 `chromium`。 |
| `TONGJI_BROWSER_PATH` | 指定 Chromium 系列浏览器可执行文件绝对路径，兼容原 `TONGJI_CHROME_PATH`。 |
| `TONGJI_NODE_PATH` | 指定 Node 可执行文件。 |
| `TONGJI_ACADEMIC_URL` | 覆盖教务入口，只接受 HTTPS 同济域名。 |
| `TONGJI_SEATS_URL` | 覆盖空间入口，只接受 HTTPS 同济域名；筛选流程目前只适配 space.tongji.edu.cn。 |
| `TONGJI_LIBRARY_URL` | 覆盖馆藏入口，只接受 HTTPS 同济域名。 |
| `TONGJI_HEADLESS=1` | 无界面测试模式；人工登录使用默认有界面模式。 |
| `TONGJI_DIRECT_CONNECTION=1` | 专用浏览器绕过代理直连，不修改系统代理；适用于校园网或 VPN 已接通且代理影响学校认证的情况。 |

密码和验证码由用户在学校网页中处理；插件不提供密码输入或凭证导出工具。Cookie 与业务页面的 sessionStorage 只在本机私有目录保存，状态文件仅本人可读写。查询结果会返回 Codex 并由模型处理，“凭证保存在本机”不代表查询结果不会离开电脑。

插件提供查询、不提交的图书委托准备，以及用户选定并确认后的普通座位预约；不自动提交其他业务。本项目为个人工具原型，非同济官方产品；正式推广前需核实学校对相应自动化访问方式的要求。

## 验证与开发

```sh
npm test
node test/seat-flow-smoke.mjs
node test/library-flow-smoke.mjs
node test/browser-smoke.mjs
```

当前默认测试覆盖 MCP 握手、输入验证、解析、空结果、诊断分类、凭证输出边界和 ICS 导出。导出测试包含单双周、换教室、跨年、课程变更、UTF-8 行折叠、稳定 UID、文件冲突和失败状态。座位 Chrome 模拟检查覆盖 12 类场景。委托准备及交接 Chrome 模拟检查共 16 项，包含实际延迟 13 秒的慢检索。通用 Chrome 模拟检查覆盖工作台导航、拆分表格、课表导出、讲堂卡片、异步结果、新标签和本机会话恢复。测试使用虚构数据，仓库不包含个人课表、讲堂记录、登录会话或页面截图。

- `src/`：MCP 服务、浏览器连接、固定准备流程与解析器。
- `bin/`：启动和依赖安装脚本。
- `skills/`：Codex 查询流程与证据处理规则。
- `test/`：自动化验证与模拟浏览器集成检查。
