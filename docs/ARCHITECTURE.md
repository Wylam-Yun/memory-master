# 项目架构页的内容呈现

本说明覆盖五页项目空间中的架构阅读与编辑预览，不是整个旧 CLI 的架构清单。

## 数据流

项目架构仍是一份有版本的 Markdown，由现有架构 API 和 MCP 工具读写。`ArchitecturePage` 负责读取、草稿、保存、版本冲突、图节点定位和放大；`ArchitectureDocument` 负责阅读及编辑预览的共同布局。

`splitCompositionDocument` 从 Markdown 找到第一张含「名称」「说明」列且有正文的组成表，返回前文、组成项和后文。页面在表格原位置展示「各部分做什么」，名称与职责始终可读，来源和 P0 关联任务按需展开。不再先渲染全篇再追加同一份组成列表。

其它表格、任意正文和代码围栏保持原位；相邻且已知的组成标题由展示标题替换，没有组成表时完整渲染原文。存储源不因阅读而改写。图仍经现有受控 Markdown/Mermaid 渲染器处理。

图节点 ID 与组成表 ID 对应时，点击将滚动到该说明，短暂突出约 1.8 秒。重复点击始终定位同一部分，不切换职责的可见性。编辑预览使用正在编辑的内容匹配节点。来源和关联任务不阻碍职责阅读，任务读取失败会提供重试。

项目空间的 HTML 声明浅色模式，共用正文组件也独立声明浅色；Markdown 外层与实际预览层使用透明背景、继承文字色。这样第三方 Markdown 的系统深色偏好规则不会在固定浅色页面中生成黑底块。Mermaid 继续使用现有默认浅色主题；旧看板的主题切换不变。

## 内容来源与边界

安装源在 `src/library/agent-content/`；V1.1 的 Skill 和格式文档同步相同要求。整体说明、关系图、职责、主要流程属于架构；测试过程、接手状态、发布待办属于当前进展和任务。没有添加新的数据字段、工具或权限。

## 验证

`src/test/library-web-architecture.test.tsx` 直接挂载实际页面，验证职责只出现一次、默认可读、预览一致、旧正文兼容、节点重复定位与 P0 任务过滤。jsdom 检查 DOM 和事件，不等于真实浏览器像素、Mermaid 图形尺寸或响应式视觉验收。

`src/test/library-markdown-theme.test.tsx` 加载实际安装的 Markdown 依赖样式，分别激活系统浅色及深色规则，逐层检查正文的浅色变量、颜色模式和透明背景。这是 CSS 与 DOM 的回归检查，不能替代浏览器视觉验收。


# 动态概览的数据流

`overview.md`继续是概览权威源。四个原有正文节不变，新增TRACKING标记节，以JSON围栏保存schema=1、currentUpdatedAt、goals和progress。每条目标、阶段记录有固定ID、稳定创建key及创建/更新时间。目标维护active/completed/adjusted状态，completedAt或adjustedAt可明确未知；成果保留summary、completedAt和可选goalId。旧GOAL正文保留且读取不迁移。

`src/library/tracking.ts`负责纯解析、数据校验、去重、状态转换与列表分页。`LibraryService.mutateOverview`负责项目写队列→实体锁→版本复核→停服与撤权检查→保存→自动历史；失败回滚。目标完成可附阶段成果与最新简报，保存到同一个文件，并对应一条包含完整变化的历史。新建缺文件时检查空版本并在失败后移除自身占位文件。

GET overview返回原文、当前目标、归档数量、简报更新时间和整份文件的version。goals/progress列表与单条读取也从同一份字节计算版本。列表默认20条，最多100；未知完成日期用记录时间排序，但界面明确未知。网页用GoalProgress组件独立管理目标与阶段表单，展开才读取归档，查看更多分页。

双通道API使用同一套服务方法：`/api/projects/:id/goals`与`/progress`支持GET/POST，单条支持GET/PUT；Agent前缀`/api/agent`逐请求验证授权。MCP提供goal_list/create/update、progress_list/record/update，base_version映射到HTTP的baseVersion。创建使用稳定key及归一化标题去重，更新有版本冲突。主观目标requiresConfirmation=true时，Agent完成必须传confirmed=true；网页人类本人点击完成即确认。

方向调整保留原目标，可原子创建替代目标。归档目标不直接变成另一目标，日期可修正。新结构化目标建立后，旧overview_write.goal拒绝覆盖，新旧客户端不会静默维护两份冲突目标。坏格式拒绝读写，不清空重建。记录的创建时间由系统生成，历史实际完成日期只能由明确输入提供。

`library-dynamic.test.ts`断言HTTP/MCP返回、磁盘和历史，覆盖去重、日期、迁移保留、并发、撤权、重启、回滚和隔离。`library-web-overview.test.tsx`挂载真实概览页并调用临时真实服务，验证人类新增、完成、归档、分页、成果修正、冲突保留输入和原始文件终态。不使用浏览器或computer use。


# 项目约定的保存与接手

overview.md新增按需创建的AGREEMENTS标记节，对应agreements正文。旧文件读取返回空字符串，不触发迁移；无关保存和空值不会追加空节。首次明确写入非空约定才新增，后续清空作为真实变更记录。解析与输入标记校验按相同的去首尾空白整行规则处理，避免带缩进的保留标记改变段落边界。

agreements通过既有overview_read/write和Web概览API维护，共享overview的内容哈希版本、写锁、撤权复核、失败回滚和自动历史。新增字段已同步后端类型、解析、写入允许列表、MCP schema、Web API及历史标签。current更新不触碰agreements；旧客户端省略新字段时保持原文。

概览内使用四个独立路由：项目根地址完整阅读description，progress阅读current与目标/历史，features阅读功能与用法，agreements完整阅读项目约定。overview-pages.ts提供统一字段、路径和名称，App注册路由，AppShell让这些子页保持概览选中。单页编辑只提交当前字段，冲突比较和覆盖也只影响本页。旧overview多字段草稿拆到overview:字段名，保留各自旧baseVersion；缺失字段不猜内容，取消或保存一页不清其他页草稿。

CONTENT-STANDARD的“接手与交接”描述停点、下一步、长期决定与已回答问题的保护、相关文件和可用Skill、过期状态核对及脱敏；SKILL.md通过明确指针要求接手时读取。接手信息分别来自概览、约定与任务，不产生平行的长期进度文件。上游规则固定到提交版本，UPSTREAM记录适配边界，UPSTREAM-LICENSE保留两位作者完整MIT许可。

library-agreements.test.ts覆盖实际HTTP/MCP与磁盘，分别断言旧文无迁移、两种客户端写读、重启、类型与标记拒绝、项目隔离、冲突/撤权/历史失败终态。真实页面测试核对独立分页、保存及旧草稿兼容；浏览器视觉和真实LLM自主行为需要另外验证。

## 概览阅读隔离

四页共用原有概览API与内容版本，读取仍是一份权威记录，当前页面只挂载本页正文。简介全文保留，不添加摘要字段或改变MCP。进展与目标页沿用Goals/StageProgress，阶段记录外层按需分页，内层单条details打开后才挂载summary正文与修正按钮，避免一次展开所有成果长文。导航随窄屏换行，正文保持正常字号与单列宽度。

实际App连接临时HTTP服务的测试覆盖默认完整简介、四个URL与一级导航、直达刷新、单字段磁盘终态、跨页草稿和冲突保护；原有目标、日期、分页与历史测试继续执行。

## 内容命名与概览页头

project-content.ts提供人类可读的共享名称，overview持久化节标题、网页字段名与历史标签、MCP概览工具描述共用；旧英文工具参数与存储标记保持兼容。Skill和内容标准使用相同名称，并明确进展与目标是页面分组、简报是当前进展的写法。

OverviewPage的导航与操作合并为header，选中导航承担可见页面名称，唯一h1使用sr-only保留可访问标题。正文不再由通用PageHeader重复显示同名大标题；其他一级页面继续使用各自原有页头。真实App回归覆盖当前页导航、可访问标题和操作区的实际DOM。

## 概览内容的四种阅读组织

overview-content.ts使用现有mdast-util-from-markdown解析真实顶层标题。功能目录取主要章节，单个文档总标题保留在正文；目录ID按标题与出现次序确定，重复标题不会碰撞，代码块标题不成为入口。Markdown的可选headingAnchors通过rehype按源行号设置真实标题ID，原文整体渲染，因此引用定义、列表、HTML文本化和strict Mermaid保持原链路。

当前进展只识别project-content.ts的CURRENT_PROGRESS_HEADINGS四个标题，按源顺序显示实际内容，保留前言、未知补充和引用定义。有内容才展示，无标题旧文完整阅读，不提取推测摘要。OverviewContent区分简介文章、进展分段、带目录用法和约定列表；目标与当前进展先呈现，阶段历史后置。数据仍来自相同overview字段，不迁移、不新增副本。

实际App与HTTP服务测试核对目录链接对应真实DOM标题、点击后的URL、少量内容无目录、正文及引用完整、HTML安全、四段与旧文兼容、保存与磁盘终态。
