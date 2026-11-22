# Code Map 实施方案

修订于 2026-11-21。M1／M2 工作包保留历史背景；当前维护实现与验收按 [维护方案](index-maintenance-plan.md) 和 [验收记录](index-maintenance-acceptance.md)。[设计方案](design.md) · [原始反馈](../feedback.md) · [核实记录](evidence.md)

## 1. 交付目标与实施顺序

两个里程碑可独立交付。估计需要 22–32 个工作日，涵盖实现、集成与验收，约 40–55 个源码、配置和测试文件。

```text
已完成：读取会话与反馈 / 核对规范 / 明确语言与平台
                          |
M1 v0.1：显式初建 Skill + Cluster/文件/重点节点 + 四个工具 + 手动维护
                          |
              可安装、可定点定位、可独立使用
                          |
M2 v0.2：Stop 自动维护 + 真实宿主与效果验收
                          |
                  完整反馈范围的本地插件
```

M1 通过显式 Skill 完成事实与语义首建，后续可手动更新。M2 在同一索引和维护协议上启用 Stop Hook。范围以设计方案第 1 节为准。

## 2. 固定技术选择与前置条件

| 项目 | 选择 | 实施要求 |
|---|---|---|
| 运行时 | Node.js 24 LTS，最低 24.15.0 | 使用固定 CI 版本；当前机器 24.3.0 需升级后验收 |
| 实现语言 | TypeScript | 一个运行时；不增加 Python 服务 |
| TS／JS 解析 | typescript 5.9.3 | Compiler API 负责语法、静态绑定和受影响文件检测 |
| Python 解析 | web-tree-sitter 0.25.10 + tree-sitter-python 0.25.0 WASM | 随包提供 ABI 15 语法。Python 适配器负责词法绑定和依赖传播 |
| 独立 MCP 接口与测试 | @modelcontextprotocol/sdk 1.32.2 | 固定 v1 API；stdio，无端口 |
| schema | zod 4.6.7 | 共享输入、输出、补丁校验；固定版本 |
| 排除规则 | ignore 7.0.14 + 内置文件遍历 | 有 Git 时使用 NUL 分隔的文件枚举 |
| 存储 | node:sqlite | 通过存储适配器统一管理事务、外键和读快照 |
| 测试 | Node 内置 test runner + MCP Client | 避免为了测试引入另一套服务框架 |
| 构建 | tsc + 发布文件复制脚本 | 输出 ESM 入口与固定运行依赖；无需运行时编译 |

TS／JS 跨文件绑定、变更传播、Python WASM 加载和语法提取、SQLite 外键和读快照已在 Windows x64、临时 Node 24.15.0 通过探针。W1 将依赖锁入 `package-lock.json`，将这些用例转成随构建执行的验收夹具。[实测记录](evidence.md#5-解析器和存储可用性实测)

构建端通过忽略安装脚本的方式提取 Python grammar WASM。v0.2 包含 TypeScript、web-tree-sitter、Zod、ignore 和两份 WASM，无需联网安装依赖。

必需账号：用户当前 Codex 账号与可用会话。插件不要求额外 API Key、OAuth、OpenAI Platform 组织或第三方云账号。开发端获取 npm 包需要网络；正常索引和查询不主动联网。真实 Agent 效果验收使用当前 Codex 模型额度。

目标宿主基线是当前实测 CLI `0.166.0-alpha.5.1` 所属的桌面环境；具体桌面构建号在首次安装验收时记录。不可据此宣称所有较旧版本兼容。Hook 支持必须实测，不能由 CLI 版本号推断。

## 3. 建议文件职责

以下为实施目标，不是本次已创建的代码脚手架。

```text
plugin.json                         唯一插件清单
mcp.json                            stdio 服务配置
.agents/plugins/marketplace.json     仓库本地安装来源
package.json / package-lock.json     命令、固定依赖与运行时约束
tsconfig.json                       插件自身构建配置
src/
  cli.ts / server.ts                CLI 与 MCP 入口
  workspace/
    lifecycle.ts                   inactive/building/incomplete/ready/suspended
    discovery.ts / paths.ts         文件清单、排除和根边界
    freshness.ts                   内容哈希与查询复核
  index/
    build.ts / reconcile.ts         首次构建、恢复、Node 对齐
    bootstrap.ts                    源码分批读取、JSON 草稿与发布
    sync.ts / impact.ts             增量事务与影响集合
    coordinates.ts                 行号、UTF-16 与 UTF-8 转换
  adapters/
    registry.ts                     语言注册、统一事实接口与能力
    typescript.ts / python.ts       两个语言适配器
    python-bindings.ts              有限、明确的 Python 绑定规则
  storage/
    database.ts / lease.ts          SQLite、schema 与 fencing
  query/
    overview.ts / browse-files.ts / inspect-node.ts / trace-node-paths.ts
    protocol.ts / pagination.ts     公共协议、预算与游标
  semantic/
    worklist.ts / apply.ts          有界工作单和语义写入校验
  hooks/
    post-tool-use.ts / stop.ts      提前同步与完整工作单登记
skills/
  code-map-init/SKILL.md            显式启用、预览、首建与恢复
  code-map-init/agents/openai.yaml  英文菜单名与显式调用策略
  use-code-map/SKILL.md                 四个查询工具与增量维护
  use-code-map/references/              协议说明与短样例
hooks/hooks.json                    Hook 配置及 Windows 覆盖
scripts/                            打包、清单校验、fixture 和 benchmark
tests/                              单元、集成、MCP、Hook 与回归夹具
assets/                             图标及第三方许可
dist/                               构建产物；不作为源码真相
```

核心维护归属：workspace 管理生命周期；adapters 只产事实；index 决定影响范围；storage 执行事务；semantic 验证模型输出；hooks 只编排现有服务。避免同一套更新逻辑分别在 CLI、MCP 和 Hook 内复制。

## 4. 需要实现的接口

### 4.1 MCP

M1 使用 MCP。M2 默认包通过 `use-code-map` Skill 调用 `codemap query NAME --root PATH [--input FILE]`。源码保留独立 stdio 接口及原有查询测试。

注册 `map_overview`、`map_browse_files`、`map_inspect_node` 和 `map_trace_node_paths`。协议从版本 1 开始。两个发布版本使用同一查询契约。文件和节点支持批量与单项错误，所有工具共享新鲜度复核。数据库 schema 1 包含 Cluster、语义和维护表。

### 4.2 CLI

发布入口为 `dist/cli.mjs`。下面用 `codemap` 作为该入口的命令简称；Skill 必须解析自身安装目录，转换为实际 Node 入口绝对路径，不能假设全局 PATH 已注册 codemap。

| 命令 | 输入与结果 | 写入边界 |
|---|---|---|
| `init --root PATH --dry-run` | 预览目录清单、语言、文件数、字节数和排除数 | 只读 |
| `init --root PATH` | 初建 Skill 预览后建立暂存快照，也用于恢复已暂停工作区 | 启用状态、暂存事实及最小忽略项 |
| `init --root PATH --next` | 按阶段输出原始源码批次或待分类文件摘要 | 暂存批次与片段标识 |
| `init --root PATH --submit --input FILE` | 接收版本化初建 JSON，保存阅读回执、语义与归属草稿 | 暂存数据 |
| `init --root PATH --publish` | 完整性、哈希、成员和重点节点校验后发布首个版本 | 事实、语义、归属同版本发布 |
| `suspend --root PATH` | 暂停维护，保留索引 | state.json 的 enabled=false |
| `sync --root PATH` | 已 ready 工作区的确定性增量更新 | 事实图、失效状态及 generation |
| `sync --root PATH --resume` | 恢复用户明确要求的未完成初建 | 检查点及事实索引 |
| `sync --root PATH --rebuild` | 重新构建事实图，重验可复用语义 | 构建库完成后事务切换版本 |
| `annotate --root PATH --prepare [--scope ID]` | 默认准备增量工作单，可重复指定 Cluster、文件或重点节点 ID | 有界的派生工作单 |
| `annotate --root PATH --apply --input FILE` | 校验 JSON 版本、证据、语义和文件归属 | 语义、导航、归属和批次状态 |
| `doctor --root PATH` | 生命周期、运行时、库完整性、覆盖率和维护状态 | 只读诊断 |

M1 交付表中命令，M2 的 Hook 复用 `sync` 和 `annotate`。CLI 的业务 JSON 输出到 stdout，日志和进度到 stderr。退出码 0 表示成功，2 表示参数或协议错误，3 表示状态不允许或发布条件未满足，4 表示基础设施错误，5 表示锁或版本冲突。文件解析问题由 coverage 表达。

CLI 未启用时不能由 sync 自动 init。空源码目录的 init 返回 NO_SOURCE_FILES，不留下已激活的空索引。init 重复执行不得覆盖配置或重复追加忽略项。所有参数用结构化解析，互斥模式在执行前拒绝；--input 的 JSON 仅作为数据读取，不转成 shell 片段。

### 4.3 本地状态

`.codemap/state.json` 只记录本机启用选择和身份；SQLite 是构建状态和派生数据真相。可选 `.codemap.json` 只包含 languages、include、exclude、max_file_bytes。状态文件不能指定任意脚本或数据库路径。

Git 项目初始化时，在根 `.gitignore` 中最小、去重地加入 `.codemap/`；不覆盖现有内容。无 Git 项目无需生成 .gitignore。暂停或卸载保留这些状态；用户显式清理时才删除本插件派生目录。

## 5. M1 完整初建、查询与手动维护，v0.1

预计 16–22 个工作日，按依赖顺序交付。

| 工作包 | 文件职责 | 实施内容 | 完成条件 |
|---|---|---|---|
| W1 生命周期与基础包 | cli、workspace/lifecycle、清单、storage | 锁定依赖、运行时、schema 1、探针夹具、启用与暂停 | 解析与存储探针复现，未启用目录零写入 |
| W2 发现与位置 | discovery、paths、coordinates | 统一 ignore 清单、相对目录和文件路径、编码与偏移转换 | 事实、初建阅读和归类使用同一纳入清单 |
| W3 TS 适配器 | adapters/typescript | 声明、重载、导入别名、调用绑定、分支与回调位置 | 事实夹具区分实现、声明绑定和未知目标 |
| W4 Python 适配器 | adapters/python、python-bindings、WASM | 从语法树构建作用域、声明、Region、静态导入和有限直接调用 | 跨文件别名绑定到声明，遮蔽、重赋值和动态目标保留诊断 |
| W5 构建与增量 | build、reconcile、sync、impact、lease | 首建检查点、恢复、Node 对齐、位置迁移、反向影响和 fencing | 中断恢复结果等于新建；并发旧租约不能提交 |
| W6 完整初建 | bootstrap、code-map-init Skill、semantics | 目录分批读源码、两阶段 JSON、注释补缺、归属覆盖校验 | 所有纳入文件已读且唯一归属，事实和语义一起发布 |
| W7 手动维护 | semantic、cluster 归属、file_highlights | 文件和重点节点依赖指纹、Cluster 复核、归属事务 | 变更向上定位，新增文件可归类，重复补丁幂等 |
| W8 查询与本地交付 | query、server、skills、打包脚本 | 四工具、批量和分页、共享刷新、本地 marketplace | 初建入口与查询真实可用，批量和并发达到性能门槛 |

W3、W4 通过注册表接入。先固定适配器的输入、统一事实输出、能力和影响范围接口，再实现 TS／JS 与 Python。用测试适配器验证注册新语言时查询协议和数据库表可直接复用。

首建固定文件清单后，事实解析和 Agent 完整阅读分别推进。阅读阶段提交文件语义与重点声明定位，分类阶段按语义草稿提交 Cluster 和归属。覆盖率校验通过后发布 `generation=1`。恢复时重验文件哈希、配置和适配器版本，复用有效草稿与回执。

全量重建先写 `.codemap/build/<租约 ID>/index.sqlite`。每个租约使用独立目录，避免过期进程覆盖后续重建。保持旧 active 库可读取；查询返回 INDEX_REFRESHING，旧位置不得作为当前版本证据。新库完成并验证后，用持有 fencing token 的 active 库事务导入事实与身份映射，保留可验证复用的语义；不能用操作系统文件替换绕过 Windows 打开句柄限制。

M1 验收从 `/` 菜单选择 `code-map-init` 或用 `$code-map-init` 显式触发。验证忽略文件不会进入阅读批次，初建结果覆盖全部纳入源码。已知路径直接批量查文件，已知 ID 直接查节点。手动同步一个改动并提交语义复核，验证仅相关文件、节点和 Cluster 入单。

M1 发布包不包含生命周期 Hook。它是能独立使用的最小版本，不宣称自动语义维护。

## 6. v0.3 维护协议 v2

| 阶段 | 实现 | 验收重点 |
|---|---|---|
| 事实与查询 | 共享完整校验、一次自动 sync、apply_patch PostToolUse | 外部编辑、新增、删除、配置、锁与分页 |
| 语义与接口 | 独立重要性、已接受基线、操作数组、原 base、stdin | 普通文件发布、位置移动、撤销、部分提交、删除与并发 |
| Stop 与宿主 | 完整工作单、默认不阻塞、统一执行器、隔离适配器 | 完成事件后 fork、只读工具、目标延迟、恢复与结果隔离 |

正常插件只注册 PostToolUse 和 Stop。宿主必须把 MaintenanceAdapter 接到拥有源 thread 的 App Server 连接。没有连接或缺少父目标延迟能力时保留待办，不自动改用主 Agent。显式 main 模式最多一次 block。事件重放、隔离宿主和真实 Agent 结果分别记录；工程测试不替代桌面闭环验收。

## 7. 验证命令与脚本职责

以下命令在实施中建立。M1 运行基础与首次构建检查；M2 增加语义、Hook 和 Agent 验收。它们当前不是已通过的命令。

| 命令 | 必须检查的内容 |
|---|---|
| `npm ci --ignore-scripts` | 从 lock 安装；不运行原生 grammar 安装脚本 |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm test` | 解析、坐标、身份、增量、存储、语义单元与集成 |
| `npm run test:mcp` | 真实 stdio initialize、tools/list、tools/call、schema 与错误 |
| `npm run test:lifecycle` | 状态机、完整阅读回执、JSON 校验、覆盖、恢复和暂停 |
| `npm run test:hooks` | Node 驱动 stdin／stdout 事件重放及状态机 |
| `npm run build` | 生成 server、CLI、Hook 入口及运行依赖 |
| `npm run validate:plugin` | 官方清单 schema、路径边界、引用文件、许可和包内容 |
| `npm run pack:plugin` | 生成 dist/code-map-版本号.zip 和 SHA-256 清单 |
| `npm run bench:index` | 首建、恢复、单文件增量、完整哈希、查询、体积和内存 |
| `npm run bench:agent` | 读取真实 Codex 对照任务记录并计算总 Token 与正确率 |

真实宿主集成单独记录。安装流程按官方本地 marketplace 文档执行。将插件放入 `plugins/code-map/`，marketplace 的 source.path 使用相对 marketplace 根的 `./plugins/code-map`，安装后开启新会话验证 Skill 发现、CLI 查询和 Hook。[官方安装路径](https://developers.openai.com/plugins/build/plugins)

当前已核对 CLI 存在 `codex plugin add` 和 `codex plugin marketplace`；不得凭记忆使用不存在的 `codex plugin install`。若使用 CLI 测试，按实际 help 配置名为 code-map-dev 的本地来源，再执行 `codex plugin add code-map@code-map-dev`。不可在验收脚本中自动修改用户全局配置。

## 8. 功能与故障测试矩阵

| 类别 | 必测路径 | 通过标准 |
|---|---|---|
| 不需要建图 | 纯文档、研究、空目录、混合资料目录；插件已装但未启用 | 无 .codemap，无全库扫描，无语义调用，无 Stop 续跑 |
| 首次构建 | 英文入口、仅预览、无 Git、ignore、长文件、解析失败和空目录 | 预览零写入，逐段读完所有纳入源码，忽略内容不进入 Agent 上下文 |
| 初建 JSON 与恢复 | 漏片段、旧哈希、重复批次、声明歧义、注释补缺、构建中断 | 复用有效回执，拒绝旧批次和歧义，覆盖完整后发布 |
| Cluster 覆盖 | 跨目录分组、重复或漏归属、新增、删除、迁移和空组 | 首建全量唯一覆盖，增量可定位待归类和受影响的源／目标 Cluster |
| 构建期间查询 | generation=0、已有旧版本重建 | 明确 INDEX_BUILDING 或 stale；不返回伪当前行号 |
| 声明与身份 | 重名、嵌套、重载、声明合并、箭头函数、复制与移动 | 唯一匹配保留 ID；歧义时不错误合并 |
| 坐标 | LF／CRLF、BOM、中文、emoji、装饰器、首尾边界 | 行号与 UTF-8 范围均切出正确源码 |
| Region | 条件、循环、try、匿名回调、内部语句与独立函数 | Region 不越界；调用位置与定义不混淆 |
| 静态关系 | 别名、barrel 导出、项目引用、Python 遮蔽／重赋值 | 解析目标正确；无证据目标进入诊断 |
| 增量更新 | 顶部加行、正文改变、删文件、改签名、撤销、未跟踪文件、外部编辑 | 更新位置和所有受影响关系；无悬空边 |
| 并发 | 两会话同步、租约过期接管、旧进程恢复、连续编辑 | 旧 token 不能提交；最多一次重试；不混合版本 |
| 概览与文件浏览 | Cluster 或目录范围、`scope_path` 传文件、`paths` 批量、空导航和跨页 | 概览列文件及用途，详情给重点节点语义，目录与文件参数区分 |
| 节点直连 | 单项和批量 ID、按文件消歧、未注释节点、多处调用和分页 | 每项限一跳，普通节点可留空，证据指向正确源码 |
| 批量与并发 | 混合缺失项、重复键、写入交错、刷新共享、队列和预算 | 同批同版本，逐项错误，旧游标拒绝，超限有界返回 |
| 多跳路径 | 已知 ID 直查、双向、分支汇合、同节点不同调用点、递归和混合关系 | 各路径前缀可重建，环可定位，调用链和关系链类型正确 |
| 路径边界 | 字面布尔死分支、动态调用、仅声明绑定、外部目标、匿名回调、异步、高扇出、深度／步数／字节限制 | 排除已证不可达的调用，返回已知证据和停点。分页可续传，遍历截断可定位 |
| 分层语义 | 初建 JSON、仅格式变化、Cluster／文件／重点节点复核、普通节点和 Region | 注释仅补缺，变化逐层入单，原子提交，Region 保留事实 |
| 适配器扩展 | 新测试适配器、能力缺项、坐标错误、解析器崩溃 | 注册项可独立测试，统一事实校验，查询契约稳定 |
| 文件导航维护 | 首次选择、跨文件或失效 ID、节点重命名／移动／删除、并发和重放 | 当前名称来自索引，删除和移动及时清除无效引用，待复核可见 |
| Hook | 未信任、定义更新、超时、取消、畸形 JSON、重复 Stop、续跑遗漏 | 降级透明；无死循环；不依赖 transcript 内部格式 |
| 路径与权限 | 中文／空格目录、子目录启动、junction、根外路径、worktree、submodule | 不跨根、不共享错误索引、不执行被索引代码 |
| 存储故障 | 只读、磁盘满、损坏、schema 升级失败 | 保留源码和 last good 索引；恢复动作明确 |

协议测试检查每个响应在预算内，且 status、coverage、page、physical_index 与 semantics 一致。目标超过预算时不能丢字段后继续返回 ok。性能报告分别列出枚举哈希、解析、绑定、事务和序列化耗时，避免把文件 I/O 藏在查询外。

## 9. 性能与 Agent 效果验收

### 9.1 索引性能目标

固定参考机：Windows 11、NVMe、至少 8 个逻辑 CPU、16 GiB RAM、Node 固定版本。夹具 A：1,000 个源码文件、10 MiB、约 20,000 个符号；夹具 B：10,000 个源码文件、100 MiB、约 200,000 个符号。TS／Python 各占一半，包含同名、跨文件导入、删除和高扇出用例。

| 指标 | A 的目标 | B 的目标 |
|---|---|---|
| 首次事实解析与绑定 | 不超过 30 秒 | 不超过 180 秒 |
| 无变化的事实检查 P95 | 不超过 1 秒 | 不超过 5 秒 |
| 单文件实现变化增量 P95 | 不超过 3 秒 | 不超过 10 秒 |
| 热路径单项首屏 P95 | 不超过 500 ms | 不超过 750 ms |
| 8 并发混合批量首屏 P95，每批 8 项 | 不超过 1 秒 | 不超过 1.5 秒 |
| 无变化、8 并发且清单校验过期的首屏 P95 | 不超过 2 秒 | 不超过 7 秒 |
| Node 进程峰值 RSS | 不超过 1.5 GiB | 不超过 3 GiB |

v2 每次请求或同批请求完整校验，计入排队、全清单哈希、查询和序列化；不再依赖一秒缓存。并发混合负载交替调用文件详情、节点检查和概览。冷复核统计完整等待时间及实际扫描次数，每进程同一轮仅一次。每项预热 3 轮、至少 20 轮测量。记录超时、限流和错误率。夹具 A 的验收负载内全部请求成功，降级结果单独统计。修改后的同步和首次 Agent 阅读耗时分别记录。

B 是规模验证目标。发布时按实际通过的规模标记支持范围。文件浏览的性能优化须保持清单完整。多跳追踪单独记录分支数、步数、分页和截断开销。

### 9.2 真实 Agent 对照

使用同一个 Codex 模型与设置，运行 20 个成对任务：8 个缺陷定位、6 个小功能修改、6 个调用影响分析。任务有人工确认的答案与必要测试；两组都能正常搜索和读取源码，唯一区别是是否可用 Code Map。每次恢复相同源码快照并使用新会话，执行顺序交错。

统计：任务成功率、错误定位数、读取源码字节数、模型输入／输出 Token、总耗时、地图查询字节数、语义续跑 Token、维护失败次数。将初次必要的模型使用和所有维护成本纳入总数；确定性解析的磁盘 I/O 独立统计。

发布效果门槛以已建图后的任务为口径，任务成功率不低于对照组，定位无新增错误，计入查询和增量维护后任务 Token 中位数至少降低 20%，耗时中位数增加不超过 20%。另报告全量初建 Token、累计净收益和达到盈亏平衡所需任务数。数字为待验收目标。

若未达到 Token 目标，先缩短响应、减少重复表示和非必要语义；不增加一个隐藏 Agent 来“优化地图”。工程测试通过、模拟事件通过和真实 Agent 效果通过，分别记录，不能互相替代。

## 10. 发布、升级和回退

v0.1 和 v0.2 都通过本地仓库／个人 marketplace 安装。首发目标平台为 Windows；其他桌面系统只在完成相同安装、路径和 Hook 验收后声明支持。

发布依次验证清单、依赖、第三方许可、中文和空格路径的本地安装、英文初建入口和四项查询。v0.3 加验 Hook 信任、默认不阻塞与隔离维护闭环。交付安装包、SHA-256 和验收报告。

以根清单为唯一真相。若实际宿主不接受 portable 格式，构建兼容格式的单独发行包并完成相同验收；不能把两份独立配置留给运行时猜测优先级。清单路径必须 `./` 开头且在插件内；mcp.json 的 type=stdio 不能误写为远程 HTTP 类型。

schema 升级前用 SQLite backup API 建立带版本的备份，不直接复制活跃 WAL 文件。升级失败保留旧索引；不兼容旧插件时停用自动维护并恢复匹配的备份。派生事实可重建；Agent 语义只有依赖指纹仍匹配时才能复用，不能跨版本盲目恢复。

回退不触碰业务源码：禁用新插件和 Hook → 安装旧包 → 恢复匹配 schema 的索引备份或重新构建 → 复核根身份与文件哈希。暂停或卸载默认保留索引。清理只删除已核实属于该工作区的 .codemap；移除 .gitignore 项时也只能移除本插件添加且仍相同的那一项。

带生命周期 Hook 的 v0.2 按本地安装流程交付。[打包限制](https://developers.openai.com/plugins/build/plugins)、[桌面提交资格](https://developers.openai.com/plugins/deploy/desktop-only)

## 11. 执行前结论

当前工程实现和事件重放已进入验证。真实桌面接入、实际 Agent 语义维护及更新后的性能与任务效果门槛仍须按验收记录完成。

从 W1 开始，按工作包完成条件交付。数据契约以设计方案第 3、7、9、12 节为准，验收以本方案第 8、9 节为准。
