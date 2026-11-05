# 调研证据

## 当前仓库初查

- 基线提交 `86f3e07a`，工作区改动仅已有的 `plan/V1.1/` 未跟踪文档。
- `src/library/service.ts` 导入 `src/library-web/index.html`，这是 `serve` 面向记忆库的当前产品前端。
- `src/library-web/App.tsx` 的顶层框架最大宽度 `max-w-3xl`，导航仅「项目」「设置」。
- 同仓库另有 `src/web`：旧版仓库内任务看板、文档、决策、里程碑等界面，不能把其全部功能视为库项目已接通。
- 当前概览三字段、任务基本创建更新、问题与回答、资料上传及列表、变更记录、客户端配置均有库 API。具体 UI 与缺口继续核对。

## 源码确认的体验缺口

- 当前只有 `/`、`/projects/:id`、`/settings` 三条 React 页面路由；首次设置和访问密钥属于条件入口屏。
- 项目页并发读取全部五类数据；概览永久编辑态、`rows={2}`，保存或其他写入后整体重载。版本冲突会重载概览覆盖本地编辑值。
- 任务 UI 只有标题、状态与「推进」，前端状态写死三种。底层 Core 有优先级、负责人和验收项，但库项目写入类型、网页类型、MCP 尚未接通。
- 资料 UI 仅上传与文件名/大小/时间列表，没有人类查看按钮；web API 无单文件读取路由，Agent 读取路由有实现。10MB 单文件限制，同名直接覆盖，尚无覆盖确认和文件版本。
- 待决定事项有正文与一次性回答，输入框为单行；大量信息用 12px 次要颜色展示。
- 变更记录总是完整展开所有前后值，长内容会淹没阅读；API 有时间范围查询但 UI 未提供。
- 设置显示完整 token；启用与连接有明确服务端区分，设置 UI 仅挂载/切换后拉取，尚无持续刷新连接态。不能把 connected 或 lastSeenAt 推断为 Agent 正在工作。
- 功能与用法、通用项目结构、P0/P1 网页策略仅在 V1.1 草案，不是现有产品功能。

## 外部调研首轮

- 六站已逐一尝试打开；Awwwards 首页超时，其余可读取公开内容。
- Curated 具体案例：https://curated.design/sites/s/2659/ （Linear），公开简介和分类可核对；分区和设计系统部分有 Pro 门槛，不能声称看过完整设计规则。
- Landing.Gallery 具体候选：https://www.landing.gallery/websites/pip-tasks-and-notes-in-one-calm-app ，索引可找到但独立工具读取不稳定，需浏览器查看。
- SaaS Landing Page 的 Productivity 分类包含 Slite、Fibery、Linear，可进一步进入详情；该站另有 SaaS Interface，但后者作为补充来源，不能替代六站调研。
- Admire The Web 的 Product 分类已进入，继续挑选轻量工作工具案例；不选展示型品牌站来决定管理应用的日常布局。

## 深入案例与可用性核对

- Landbook 已进入 Intercom 具体案例，看到按 Hero、Features、CTA 等分区的索引；适合研究单区块的单一信息目的，不能把其营销页当成后台导航依据。链接：https://land-book.com/websites/102060-intercom-a-complete-system-for-human-and-ai-customer-service 。
- SaaS Landing Page 已进入 Slite 与 Fibery 详情，有完整页面图片入口及字体/配色信息。链接：https://saaslandingpage.com/slite/ 、https://saaslandingpage.com/fibery/ 。视觉研究不能直接采用其商业字体许可。
- Landing.Gallery 的 Pip 案例已通过浏览器读取并截图，包含 Desktop/Mobile 切换；独立文本工具不可达不等于浏览器不可达。官网偏营销大标题，应用应借鉴其任务/笔记的简明内容表达，舍弃首屏大面积装饰。
- Awwwards 首页已通过浏览器成功访问，正在用站内搜索找工具案例；web 工具的首页/分类失败已用浏览器补证。
- Admire 的 Amble 案例为出行生活方式站，因与日常管理任务不相近而淘汰，继续核对 Product 分类的 Aside、Stash、Memorify。

## 当前界面运行核对

- 使用独立临时 settings home 与 library，通过当前 `LibraryService` 启动隔离样例，没有改用户真实库或客户端配置。测试创建概览、3 条任务、1 个问题、1 份资料均返回成功，实际磁盘含 overview、tasks、questions、changelog。
- 浏览器实际打开项目页并截图，56px 高的三处 textarea 实测内容高度分别 176px、116px、296px，三者均发生内滚动；这是可复现的阅读截断。
- 当前屏幕优先显示项目磁盘路径、表单和保存按钮，第一眼看不到完整最新进展，决定事项在任务后方，长历史进一步延长页面。
- Awwwards 已通过站内搜索找到并进入 Superlist 详情：https://www.awwwards.com/sites/superlist ，完成从首页到具体案例的核对，后续分析不依赖搜索引擎对该站的索引。
- Admire 的 Aside 详情包含 app、SaaS、clean、minimal 标签及真实站点 https://heyaside.com/ ，作为克制视觉语言候选；不把标签视为对应用交互的证明。

## 视觉与官方应用依据

- 浏览器已查看 Curated Linear 的公开预览，部分画面模糊且详细 Sections 为 Pro；仅引用公开构图/案例说明，不声称提取其 tokens 或完整交互。
- 浏览器已查看 SaaS Landing Page 的 Slite 页面图，能看到单侧导航与阅读文档主体的产品截图；借鉴阅读区层级与选中状态，不复刻官网奶油底/营销 CTA。
- Landbook 浏览器被站点安全验证拦住；未尝试绕过。web 文本工具可读取 Intercom 案例的分区与完整图片链接。其视觉结论限定为内容顺序与区块组织，后续高保真稿需人工复核图片。
- Awwwards Superlist 具体案例为 2021 年获奖记录，不用它推断 2026 流行趋势。公开的 notification button 和 loading transition 分项适合讨论操作反馈，时长参数为本项目设计建议，非该站测量值。
- Aside 原 live URL 已跳转 Ocelli（https://ocelli.app/?from=aside），图库收录版本与当前官网不同，需明确版本差异。
- 官方应用文档：https://linear.app/docs/projects 核对 overview 与可切换详情侧栏；https://www.notion.com/help/navigate-with-the-sidebar 核对稳定导航和折叠。只提取交互原则，不引入它们的团队、计费、会议或自定义数据库业务。
- W3C WCAG 2.2 Understanding：正文对比度 4.5:1、320 CSS px 文本重排、指针目标最少 24×24（有例外）；本项目触屏建议 44×44 为设计目标，不误称 AA 强制值。

## 提案与自查结果

- 新提案为单侧栏项目工作台，独立的待决定入口供用户审阅；不会直接把原五页规格改成已批准的六页。
- 产出 `UIUX-RESEARCH.md`（研究、事实、页面清单与方案对比）、`PAGE-BLUEPRINT.md`（逐页区块、线框、交互与空错状态）、`DESIGN-SYSTEM.md`（尺寸、字体、色彩、组件与响应式）。
- 本地链接与Markdown围栏检查通过。设计色值对比度计算：主文字16.10、次文字6.54、主按钮6.07、选中项5.43、成功5.85、等待5.83、错误5.98；输入边界3.22。以上仅验证这些色对，不代表整套未实施UI已通过可访问性。
- 尚无普通用户访谈、导航走查或新UI功能验收；这三项在报告中保留为后续门槛。
