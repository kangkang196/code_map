# 设计依据与核实记录

环境与插件规范初次核实于 2026-11-02。查询、初建和 Cluster 需求更新至 2026-11-08。

## 1. 用户材料

已通过 read_thread 读取[《代码地图设计建议》](chatgpt-conversation://6ac4ba09-f9c8-83e9-98ee-83822d66403b) 的两轮完整对话。返回 hasMore=false、nextCursor=null。设计使用第二轮修正后的边界，而不是第一轮中由插件生成 Reading Plan 的建议。

已完整读取工作区 [feedback.md](../feedback.md)。原文件保持不变。

| 需求或反馈 | 落实位置 |
|---|---|
| 从项目结构定位到源码 | design 第 2、4、9 节：Cluster、文件、节点逐级导航，支持直接定位 |
| 批量与并发 | design 9.6、implementation-plan 9.1：集合查询、单批快照、共享刷新和延迟门槛 |
| Reading Plan 由 Agent 决定 | design 第 1、4、9 节：工具只返回证据 |
| Node 与 Region 对齐实际代码 | design 第 5 节：声明、调用位置和语句块分别建模 |
| Cluster 覆盖和文件语义 | design 7.3–7.4、9.2–9.3：成员全覆盖，文件用途与内容，重点节点语义 |
| 直接关系和静态路径 | design 8、9.4–9.5：一跳证据与有界多跳路径 |
| 目录和文件输入区分 | design 9.2–9.3：`scope_path` 相对目录，`paths` 相对文件路径 |
| 各层可以链式导航 | design 第 4、6、9 节：统一 ID、位置和版本 |
| 不要量化 uncertainty | design 7.2：只保留事实、证据与未解析诊断 |
| 语义覆盖与维护范围 | design 3.3、7.3、11–12：首建完整阅读，增量只复核相关 Cluster、文件和重点节点 |
| 修改后确定性维护，不等 Git commit | design 第 11、12 节：磁盘差异、查询复核、同步 Stop |
| 明确维护输入输出，防止越写越多 | design 12.2–12.4：严格补丁、替换、幂等和清理 |
| 语言与平台 | 用户此前确认 TS／JS + Python，优先 Windows |
| 首次构建与无需构建 | design 3.1–3.2：默认 inactive、显式首建、恢复与暂停 |
| 初建入口和 JSON | design 3.2–3.3、16：`code-map-init`、分批源码、语义草稿和覆盖校验 |
| 扩展语言 | design 10：适配器注册、能力声明和统一事实输出 |

## 2. 官方 Codex／插件规范

以下页面已实际读取正文。结论以本日期的内容为准，实施和发布时需重新核对发生变化的部分。

| 来源 | 读取所得事实 | 设计影响 |
|---|---|---|
| [Package your plugin](https://developers.openai.com/plugins/build/plugins) | 推荐根 plugin.json、mcp.json；兼容 .codex-plugin；支持本地 marketplace；带 Hook 不可公共提交 | 单一清单、本地发行、独立兼容产物 |
| [Submit desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only) | 本地 stdio 入口；PLUGIN_ROOT；本地 MCP 公共提交限获准合作伙伴 | 本地源码接入；不承诺公共上架 |
| [Hooks](https://learn.chatgpt.com/docs/hooks) | command／mcp_tool 可用；prompt／agent 被跳过；同步 Stop 可续跑；需信任；有 commandWindows；transcript 格式不稳定 | command Hook + 原 Agent 续跑；不读取内部对话格式 |
| [Build skills](https://developers.openai.com/plugins/build/skills) | Skill 以 SKILL.md 分发，包含 name、description 与指令 | 两个职责明确的 Skill |
| [Define tools](https://developers.openai.com/plugins/plan/tools) | 工具围绕清晰的用户目标设计，接口和副作用须明确 | 查询与维护分离 |
| [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server) | MCP 可提供结构化数据，不要求自定义 UI | 首版无需图形面板 |

2026-11-08 核对了桌面斜杠菜单和技能调用策略。启用的 Skill 可从 `/` 菜单选择，也支持 `$` 显式调用。初建 Skill 关闭隐式调用，在目标客户端验收入口发现。[桌面斜杠命令](https://learn.chatgpt.com/docs/app/slash-commands) · [技能调用策略](https://learn.chatgpt.com/docs/build-skills#optional-metadata)

本地命令已读取 `codex --help`、`codex plugin --help`、`codex plugin add --help`、`codex plugin marketplace --help`、`codex mcp --help`。存在 add、list、remove、marketplace。没有据此假定实际插件或 Hook 已安装。

## 3. 技术来源与借鉴边界

| 来源 | 已查看内容 | 采用的机制 |
|---|---|---|
| [Aider RepoMap 实现](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) | get_tags、get_tags_raw、定义／引用图构造代码 | 解析事实缓存与紧凑输出。文件浏览使用完整清单和 Agent 维护的导航 |
| [SCIP 数据定义](https://github.com/sourcegraph/scip/blob/main/scip.proto) | SymbolInformation、Occurrence、Relationship | 定义身份与出现位置分开；本方案不宣称兼容完整 SCIP 协议 |
| [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) | Context7 返回的 Program／TypeChecker／声明文档接口 | 编译器负责 TS 静态绑定；固定 JS API 版本 |
| [MCP TypeScript SDK v1](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md) | Context7 返回 registerTool、inputSchema、outputSchema、structuredContent、stdio | 使用官方 SDK 校验查询协议 |
| [Web Tree-sitter](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md) | WASM 初始化、语言加载、解析、获取 grammar WASM 的说明 | Python 解析随包提供 WASM，不增加 Python 运行时 |
| [Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) | DatabaseSync、版本历史、Release Candidate 状态 | 选 Node 24.15+；隔离存储 API 并验证跨进程写入 |

这里只借鉴机制，不复制项目源码。引入的 npm 依赖和 WASM 必须随发行包保存原始许可；以实际打包的固定版本为准。

## 4. 原环境与依赖检查

| 项目 | 2026-11-02 核实结果 |
|---|---|
| 工作区 | D:\ai_projects\code_map |
| 起始文件 | 仅 feedback.md；不是 Git 仓库 |
| 本地规则 | 用户提供与本机全局 AGENTS.md 一致：中文、简明、结构图 |
| Codex CLI | 0.166.0-alpha.5.1 |
| Node / npm | v24.3.0 / 11.4.2；Node 低于拟定验收基线 |
| 包版本 | typescript 5.9.3、MCP SDK 1.32.2、web-tree-sitter 0.25.10、tree-sitter-python 0.25.0、zod 4.6.7、ignore 7.0.14 可从 npm registry 读取 |
| WASM | 已读取两份 npm tarball 文件列表，包含 runtime 和 Python grammar WASM |
| MCP peer | SDK 1.32.2 支持 zod ^3.25 或 ^4.0 |

环境和包元数据检查没有安装插件、更新 Node、修改 Codex 全局配置或执行发布。

## 5. 解析器和存储可用性实测

2026-11-08 在 Windows x64 临时目录执行。运行时为 Node 24.15.0，下载后按发行方 SHA-256 清单核对。解析器从固定 npm 版本提取 JS 和 WASM，测试结束清理临时目录。

| 组件 | 实测结果 | 实施门槛 |
|---|---|---|
| TypeScript 5.9.3 | TS 导入别名与 JS 调用均绑定跨文件声明。接口方法返回声明目标。修改导出后受影响集合包含 TS 和 JS 调用者，旧目标消失。中文、emoji 与 CRLF 的 UTF-8 字节定位正确 | W3 将编译器结果转换为统一事实，保留声明和实现的区别 |
| Web Tree-sitter 0.25.10 ＋ Python grammar 0.25.0 | ABI 15 成功加载。识别导入别名、声明、直接调用、属性调用与条件块。重解析能取得新声明。中文、emoji 与 CRLF 的坐标转换正确 | W4 实现词法与导入绑定。对真实夹具校验遮蔽、重赋值、跨文件变更和未解析诊断 |
| Node 24.15.0 SQLite | 外键拒绝无效归属。写事务原子移动文件归属。WAL 读事务保留旧快照，下一事务看到新值 | W5、W7、W8 验证真实 schema、版本一致性、竞争写入和批量性能 |
| Git 忽略清单 | 临时仓库中，`git check-ignore --no-index -z --stdin` 识别被强制跟踪且命中规则的源码，保留可见源码 | W2 将同一清单用于解析、Agent 阅读与覆盖校验 |

探针验证固定依赖具备方案所需的基础能力。跨语言绑定、动态调用和完整插件性能按实施门槛验证。

## 6. 当前尚未验证的能力

实施验收覆盖完整事实索引与适配器、初建断点恢复和 Cluster 覆盖、Windows 安装、批量与并发性能、Hook 信任与续跑，以及真实 Agent 的任务质量和 Token 收益。

公共目录提交资格未验证，完整 Hook 版本也不符合当前公共目录条件。该限制已通过本地安装的交付边界处理，不依赖申请公共资格才能开始实施。
