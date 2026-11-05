# 参考站调研与当前问题取证

核对日期：2026-11-05。方法：公开网页、具体案例、现有代码与真实项目内容。独立调查，未使用computer use。网页正文与公开标签支持信息架构观察；未完成浏览器视觉、动效或精确像素测量，不将建议参数宣称为这些网站的实际CSS。

## 当前项目的可复现问题

- OverviewPage先渲染四个导航项的item.label，又把同一个page.label传给PageHeader，大号可见标题重复选中导航，且带来第二行操作区与额外空白。
- 原因是分页后仍沿用“每个页面都需要页名大标题”的通用外壳。正文并未重复存一份：memmaster的features实际从“按页面阅读项目说明”开始，页面顶部重复来自外壳。
- 网页用“项目简介”，Skill表用“概览·简介”；“进展与目标”是页面组合，实际字段为current与独立目标，不能当成另一个交接对象。“简报”是当前进展的写法，不能另造一份首页摘要。
- 当前四页有真实URL与独立正文，但展示基本都是Markdown文章。已实现分页不等于已经完成各类内容的阅读设计。

对应实现：src/library-web/pages/OverviewPage.tsx、src/library-web/overview-pages.ts、src/library/overview.ts、src/library/agent-content/SKILL.md、src/mcp/library-bridge.ts。根因回归用例先失败于重复可见标题，再修正；保留读屏可访问标题。

## 九个参考入口与深入阅读

| 入口 | 实际深入页面 | 核对到的结构及可借鉴方向 |
| --- | --- | --- |
| [Apple Store SG](https://www.apple.com/sg/store) | [Shop Mac](https://www.apple.com/sg/shop/buy-mac) | 全局导航、商品分类、机型、选择指南、支持分别承担不同任务。借鉴稳定导航与按阅读任务分组；不引入商城或购买流程。 |
| [DJI](https://www.dji.com/) | [Mavic 4 Pro](https://www.dji.com/ch/mavic-4-pro) | 产品局部导航区分比较、规格、视频、下载、FAQ和购买，产品叙述与操作各有位置。借鉴固定上下文与有明确名称的入口。地域自动跳转；Mini 5 Pro子页404，未据其推断布局。 |
| [Insta360 Consumer](https://store.insta360.com/consumer) | [GO Ultra商品页](https://store.insta360.com/product/go-ultra) | 列表展示可选择对象，详情再按规格/选项/套装描述组织。借鉴“先选具体对象，再深入读说明”的层级；不把项目做成商品卡或加入价格模块。 |
| [Curated](https://curated.design/) | [Oqoqo案例](https://curated.design/sites/s/4424/)及[原站](https://oqoqo.ai/) | 案例标为Minimal；原站将用途、平台能力与操作流程分开，并用具体章节标题组织。借鉴内容职责明确；不引入其评测业务。案例的设计系统仍标为未公开，未声称取得完整设计规范。 |
| [Landbook](https://land-book.com/) | [Symmetry AI案例](https://land-book.com/websites/102075-symmetry-ai-the-work-finds-itself-and-gets-done) | 公开标签为Software、Single Page、Sans Serif、Pastel Colors等。可作克制配色与软件展示方向的候选；截图CDN拒绝访问，未据标签断言具体间距或产品内布局。 |
| [Landing.Gallery](https://www.landing.gallery/) | [Pip案例](https://www.landing.gallery/websites/pip-tasks-and-notes-in-one-calm-app)及[原站](https://pipdot.app/) | 原站明确比较繁杂菜单与简洁任务列表，内容演示围绕普通任务和自然语言。借鉴降低无关控件密度、以具体对象为内容标题；不引入该产品的其他功能。 |
| [SaaS Landing Page](https://saaslandingpage.com/) | [Productivity分类](https://saaslandingpage.com/tag/productivity/)及[Slite案例](https://saaslandingpage.com/slite/) | 分类中找到文档协作案例；案例公开字体与配色元数据，并保留设计截图入口。可作资料阅读和克制强调色的参考；截图请求未完整下载，未作为已完成视觉观察的证据。 |
| [Admire The Web](https://admiretheweb.com/) | [Cursor Compile案例](https://admiretheweb.com/inspiration/cursor-compile/)及[原站](https://cursor.com/compile) | 案例标签包括light、minimal、large type、whitespace；原站把场次、录像和讲者按具体内容分组。借鉴明确区块与正常字号，不采用活动营销功能或巨大宣传标题。 |
| [Awwwards](https://www.awwwards.com/) | [Clean分类](https://www.awwwards.com/websites/clean/) | 分类说明强调内容元素的准确位置和秩序，清爽不等于删掉必要内容。可作本次保留完整简介的依据之一。首页和The Content Architecture案例超时，使用可访问分类说明，未宣称完整检查其案例或微交互。 |

以上是结构证据与适配推论。商城、产品官网和画廊本身具有不同任务，不能据其是否重复导航词，机械规定所有应用都不许有同名标题。本项目的导航已明确当前内容，第二个同名大标题没有提供新增背景，因此可以合并。

## 提炼到本项目的规则

1. 稳定的项目上下文、页面导航、具体内容标题、操作按钮分别有明确用途。导航说明位置；正文标题说明具体在读哪项功能或哪条成果。
2. 同一套字体、间距、强调色和控件规则可以支持不同的内容布局。完整介绍适合连续文章，进展适合清楚的事实分段，功能用法适合章节目录，约定适合明确条目。
3. 首页保留完整项目简介，不因研究营销站而替换成口号。关键进展与下一步在进展页常显，历史结果按条打开。
4. 每个展示对象有统一名称；同一正文供人和Agent读取。内容组织变化不生成另一份交接数据。
5. 白底、深色正文、少量强调色、克制分隔与一致对齐是本项目建议，具体数值应在真实页面核对，不伪称来自参考站的精确测量。
