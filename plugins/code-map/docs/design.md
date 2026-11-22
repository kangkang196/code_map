# Code Map 设计方案

修订于 2026-11-22。当前协议为 v3；实施状态见 [初建验收记录](initial-build-acceptance.md) 和 [维护验收记录](index-maintenance-acceptance.md)。

## 1. 目标与边界

Code Map 提供 Cluster 概览、文件与重点节点语义，以及带源码证据的直接关系和静态多跳路径。Agent 可从任务所需的层级开始查询，再制定阅读计划。

成功标准：目标定位准确；修改后索引可刷新；结果可跨层导航；减少探索上下文；任务正确率不下降。节省 Token 的效果必须包含地图查询和语义维护成本一起测量。

首版范围已经用户确认：TypeScript／JavaScript，包括 TSX／JSX，以及 Python；Windows 为主要验收环境。未支持的语言仍列出文件与状态，不生成虚构符号。

工作区默认不启用 Code Map。方案讨论、资料研究、文档项目或尚未形成源码的项目，可以一直保持未启用状态；安装插件不等于为所有打开的目录建图。

v0.1 交付完整初建、四个查询工具和手动增量维护。v0.2 增加 Stop Hook 自动维护和真实任务对照验收。两个版本均提供本地安装包。框架规则属于独立扩展。

首版不包含：图形编辑器、完整运行时追踪、通用跨语言调用解析、向量数据库、后台 LLM 服务、自动修改业务代码、插件生成的 Reading Plan、所有动态调用的完整解析。

## 2. 核心决策

| 决策 | 规则 | 原因 |
|---|---|---|
| 查询粒度 | Cluster → 文件 → 重点节点，按需查看关系和路径 | 小任务可从已知路径或节点 ID 直接定位 |
| Cluster 归属 | 每个纳入的源码文件恰有一个主 Cluster | 覆盖率可校验，增量影响可向上定位 |
| 统一存储 | SQLite 保存事实、语义、Cluster 归属和导航 | 工具共享节点身份和证据 |
| 工具入口 | `map_overview` 浏览全局或文件结构，其余工具负责文件详情、节点和路径 | 查询按需展开 |
| 维护入口 | CLI 负责索引与语义写入 | 查询与维护职责清晰 |
| 事实来源 | 解析器、编译器、受约束规则 | 模型不能创建调用事实 |
| 文件导航 | Agent 选择并维护同文件的重要节点 | 将文件用途与可查询的定义关联起来 |
| 语义来源 | Agent 阅读源码后定义，注释用于补缺 | 按字段保留来源和复核状态 |
| 不确定调用 | 返回未解析位置与原因 | 不提供置信度、概率或猜测边 |
| 交付方式 | 桌面端本地安装 | 满足本地源码访问和 Hook 需求 |

最小可交付版本为 v0.1。首次全量阅读建立语义基线，日常维护按变化范围执行。v0.2 将同一维护协议接入 Stop Hook。

## 3. 架构与数据流

```text
                         Codex 当前 Agent
                     查询 / 自定 Reading Plan
                                |
                        use-code-map Skill → CLI
                                |
     map_overview / map_browse_files / map_inspect_node / map_trace_node_paths
                                |
                    查询服务 + 新鲜度检查
                                |
                 SQLite  Cluster / 文件 / 节点 / 边 / 语义
                                ^
                                |
                  确定性索引器 + 语义写入校验器
                     ^                       ^
                     |                       |
        文件清单 / 内容哈希 / AST      Agent 初建 JSON / 增量补丁
                     ^                       ^
                     |                       |
                 工作区源码          主回合结束后的隔离分支
```

默认安装使用本地 CLI 和 SQLite。查询结果进入当前 Codex 会话；默认隔离维护记录不追加主会话。开发环境可独立启动 stdio MCP 接口。

依赖只向下流动：MCP／CLI／Hook → 应用服务 → 语言适配器／存储。语言适配器不能调用模型；Hook 复用应用服务并在本地事务登记任务；查询层不修改语义文案。

### 3.1 工作区生命周期

```text
未启用：讨论 / 研究 / 不需要索引
   |
   | 用户显式调用 code-map-init
   v
首次构建 ------------------取消 / 失败------> 未完成
   |                                            |
   | 源码阅读、语义校验和归属覆盖完成           | 显式 sync --resume
   v                                            |
可查询 <----------------------------------------+
   |
   +-- 源码改变 --> 确定性增量更新 --> 可查询
   |
   +-- suspend --> 已暂停 -- init --> 复核后可查询
```

| 工作区状态 | 查询行为 | Hook 行为 |
|---|---|---|
| `inactive`：没有启用记录 | 返回 `NOT_ENABLED` 和最短启用方式 | 直接退出；不扫描、不写文件、不要求模型维护 |
| `building`：首次构建中 | 返回 `INDEX_BUILDING`、进度与可恢复状态 | 不重复启动首次构建，不触发语义续跑 |
| `incomplete`：首次构建中断或失败 | 返回 `INDEX_NOT_READY` 与恢复命令 | 保留检查点，不自动重试完整构建 |
| `ready`：已发布事实和初始语义 | 正常查询与新鲜度复核 | 正常增量维护 |
| `suspended`：显式暂停 | 返回 `INDEX_SUSPENDED` | 直接退出；保留缓存 |

`ready` 可以包含明确列出的未支持文件或局部解析失败；是否完整支持由 coverage 表达。构建中间结果不能冒充 ready。暂停不删除索引，恢复时必须比较当前磁盘与旧清单。

不注册 SessionStart 状态注入。文件扩展名、项目目录名和用户正在谈代码，都不能自动触发建图。用户进入编码阶段后可显式启用；用户明确请求使用地图但未启用时，先说明状态和初始化成本，不在查询内部隐式执行全库初建。

### 3.2 首次构建

初建入口为 `code-map-init`，禁止隐式调用。用户显式调用后，直接按工作区配置与忽略规则构建，无需二次确认。`init --dry-run` 仅用于显式预览，不写文件。

```text
code-map-init → init → 物理事实 + 初建任务文件
                              │
              Agent 用宿主读文件、搜索工具读取全部纳入源码
                              │
                       一份语义 JSON
                              │
手动补丁 / Stop 结果 ──→ annotate --apply → 共用校验与事务 → SQLite
```

`init` 返回任务文件路径和原 `base`。任务包含完整文件范围、索引器分配的文件与节点 ID、声明位置、任务指令和自动生成的输出 schema。初建完成前，常规地图查询仍被状态门禁拒绝；Agent 使用宿主普通工具读取源码。

索引器维护文件、节点、位置、物理包含关系、可解析的静态关系、诊断、指纹与版本。Agent 定义 Cluster 归属、重要性及用途职责。Agent 可多次调用阅读工具，最终只提交一份 JSON，不输出物理事实副本。

`sync --resume` 或重新运行 `init` 刷新暂存事实并签发新任务及新 `base`，复用仍有效的对象 ID。旧任务结果不能改绑新基线。已有 ready 索引的重建继续使用独立暂存库和事务导入，保留失败回滚与旧读句柄行为。

### 3.3 首次语义 JSON 契约

初建结果按 `clusters → files → highlights` 表达语义层级。每个 Cluster 有唯一 `key`、名称和用途；每个纳入文件恰好出现一次。普通文件只需文件 ID；重要文件提供 `important: true`、用途和内容；重点节点只需节点 ID 和职责。节点的物理归属与更细的类、方法包含关系由索引器验证和维护。

初建树形结果和增量操作数组共享 `annotate --apply --base BASE --input FILE|-`。初建树先归一化为现有操作模型；共用对象、范围、指纹、版本、幂等、语义基线和租约事务校验。初建要求全文件覆盖并一次发布；增量只推进本次语义提交所处理对象的基线，省略项继续保留待办。这里的提交与 Git commit 无关。

单份初建结果上限 16 MiB，增量操作数组仍为 64 KiB。重要文件与节点遗漏说明时，可从当前注释补缺并保留 `doc_comment` 来源。校验失败整份回滚。成功时在同一事务发布 `physical_revision=1`、`semantic_revision=1`、语义基线与 ready 状态。完整字段及示例见 [v3 协议](../skills/use-code-map/references/protocol.md)。

`base` 绑定初建任务标识，避免暂存物理版本始终为零时接受旧结果。写入前后复核源码清单、配置和适配器。文件归属覆盖校验不等于证明 Agent 已阅读或理解源码；完整阅读通过任务要求与真实执行记录验收。

## 4. 查询粒度与导航

| 粒度 | 回答 | 数据基础 | 导航键 |
|---|---|---|---|
| Cluster | 哪组代码承担该职责 | Cluster 目的和成员文件的路径与语义 | `cluster_id`、`file_id` |
| 文件 | 文件在哪里、负责什么 | 文件 `purpose`、`content` 和重点节点语义 | `file_id`、`node_id` |
| 节点 | 单个定义和它的直接关系是什么 | 节点职责、定义位置、入边与出边 | 两端 `node_id`、`edge_id` |
| 路径 | 从目标节点出发可追踪哪些多跳路径 | 当前版本的节点、边与分支证据 | 每一跳的 `node_id`、`edge_id` |

节点 ID 在工作区内解析。文件 ID 本身也是节点 ID。已知节点 ID 时可直接调用检查或追踪工具。

```text
Cluster 作用 ──► 成员文件路径与用途 ──► 文件内容摘要和重点节点职责
已知文件路径 ─────────────────────► 文件内容摘要和重点节点职责
已知节点 ID ────────────────────────────────► 直接关系 / 多跳路径
```

若文件导航未列出目标，Agent 可在该文件内按名称定位节点。检查工具先解析目标，重名时返回候选 ID。Agent 根据查询证据决定阅读范围。

## 5. Node、Region 和调用位置

### 5.1 建节点的规则

| 实际对象 | 建 Node | 规则 |
|---|---|---|
| 工作区、目录、源码文件 | 是 | 建立完整包含树；包信息是目录属性 |
| 类、函数、方法、接口、类型、枚举、命名空间 | 是 | 必须有可识别声明及作用域 |
| 绑定到名字的箭头函数／lambda | 是 | 按其变量或属性绑定建立可调用节点 |
| 具名嵌套函数、嵌套类 | 是 | `parent_id` 指向实际声明作用域 |
| 导出的常量、类字段 | 是 | 保留接口相关声明；局部普通变量不单独建图节点 |
| 匿名内联回调 | 否 | 作为所属符号的 Region，记录回调上下文 |
| if、循环、try、连续语句段 | 否 | 作为 Region，辅助精确读取 |
| 单次调用表达式 | 否 | 作为 Edge 的调用位置，不重复建立目标定义 |
| 路由、外部包、外部接口 | 资源节点 | 必须有已支持规则或明确引用证据；不展开依赖源码 |

Python 文件节点同时代表其语言模块。文件中的重要模块通过已有声明节点导航。业务领域可用 tags 描述。

### 5.2 create_order 的实际对齐

```text
service.py
  create_order                    Node：声明，L40-L100
    validate(request)             Edge：调用位置，L44
      -> validate                 Node：实际定义，validators.py:L10-L30
    inventory.reserve(items)      Edge：调用位置，L52
      -> Inventory.reserve        Node：实际定义，inventory.py:L70-L95
    if persist_enabled:           Region：分支语句块，L58-L72
    callback = lambda ...         Node：有名字绑定的可调用对象
    submit(lambda item: ...)      Region：匿名回调及其内部调用位置
```

若验证逻辑直接写在 `create_order` 内部，它是 Region。只有实际独立声明的 `validate` 才是 Node。Node 粒度由代码定义决定，不能按模型对业务步骤的划分来改变。

匿名回调内部的调用归属到最近具名符号，同时标记 `execution_context=callback` 和所属 Region。缺少回调触发证据时，追踪在该位置标出执行边界。

### 5.3 Region 规则

Region 是 Node 的附属记录，使用解析器生成的 AST 边界。首版包括：分支、循环、异常处理、上下文管理、匿名回调，以及被明确注释界定的连续语句段。函数整体已经有位置时，不再重复建立 body Region。

每个 Region 记录所属 Node、AST 路径、类型、源码范围和文件哈希。Region 为解析器提供的位置与控制流事实，语义对象从 Node 开始。Region ID 只在当前版本内有效。

Region 可随证据返回。检查工具可按需列出目标自身的 Region。Region 由所属节点引用，跨符号关系仍以节点为端点。

## 6. 标识、位置与版本

`node_id` 是首次识别时分配的 UUID，不含行号、正文哈希或签名。可读的 `symbol_key` 是定位键，不承诺跨重命名稳定。

匹配顺序固定：同文件、同作用域、同种类、同限定名的唯一声明；再处理有唯一证据的移动。改签名或改正文通常保留 Node ID。函数移动只在定义指纹和结构匹配唯一时保留 ID；有歧义时建立新 ID，旧 ID 返回失效状态，不强行拼接身份。

TS 重载和合法声明合并使用一个逻辑符号，保留多条 declaration location；实现范围单独标记。不能把重载序号当作唯一身份。文件纯重命名可按唯一内容哈希关联；复制文件不能冒充移动。

| 位置字段 | 约定 |
|---|---|
| `path` | 工作区相对路径，协议统一使用 `/` |
| `start_line/end_line` | 从 1 开始，首尾均包含，供人和 Agent 阅读 |
| `start_byte/end_byte` | 原始 UTF-8 字节位置，左闭右开 |
| `file_hash` | 原始文件 SHA-256；行号与证据均绑定此哈希 |
| `physical_revision` | 本工作区已提交的事实索引版本 |
| `semantic_revision` | 独立的语义版本；纯语义写入不重建事实图 |

解析器适配器必须显式转换坐标。TS 的 UTF-16 偏移与 Python WASM 解析器返回的偏移不能直接当作 UTF-8 字节偏移。CRLF、BOM、中文和 emoji 都有固定测试。首版索引 UTF-8／UTF-8 BOM；其他编码保留文件节点并返回 `UNSUPPORTED_ENCODING`。

对磁盘中已保存内容负责。首版不接入编辑器未保存缓冲区。读取和编辑源码前，Agent 应使用当前位置；若外部编辑器同时改动，重新查询，不能继续使用旧范围。

## 7. 统一数据模型

### 7.1 表与职责

| 表 | 关键内容 | 约束 |
|---|---|---|
| `workspace_state` | 工作区 ID、根路径、数据库版本、`physical_revision`、`semantic_revision`、构建状态、清单与配置指纹 | 一个索引只属于一个规范根路径 |
| `clusters` | `cluster_id`、名称、`purpose`、类型、语义状态、成员依赖指纹 | Agent 定义正常 Cluster，索引器维护保留的 `pending` Cluster |
| `files` | `file_id`、相对路径、内容哈希、语言、解析状态、`cluster_id` | `file_id` 也是文件节点 ID。`cluster_id` 为非空外键，成员通过该列反查 |
| `nodes` | `node_id`、种类、名称、限定名、`parent_id`、声明签名、`symbol_key`、`meaning_hash` | 节点 ID 在工作区内唯一，父子关系无环 |
| `locations` | 位置 ID、文件 ID、文件哈希、起止行和字节范围、位置类型 | 定义和实现位置关联节点，允许一个节点有多处声明 |
| `regions` | Region ID、所属节点 ID、位置 ID、AST 路径、语法类型 | 范围位于所属声明内部 |
| `edges` | 边 ID、起点和终点节点 ID、关系类型、证据位置 ID、绑定方式、分支与执行上下文 | 同一对节点的不同调用点各有证据 |
| `diagnostics` | 所属节点 ID、诊断码和可用的证据位置 ID | 可定位解析失败或未解析调用 |
| `semantics` | `node_id`、`purpose`、文件 `content`、可选 `tags`、字段来源、依赖指纹、复核状态 | 文件和重点声明各有一条当前记录，声明节点语义可缺省 |
| `file_highlights` | `file_id`、`node_id`、展示顺序、选择时的依赖指纹 | 每文件最多 8 个唯一节点，定义须位于该文件 |
| `semantic_baselines` | 对象已接受的指纹和结构清单 | 不随每次 sync 覆盖 |
| `semantic_tasks` | 工作单、会话、回合、版本对、范围与任务状态 | 同工作区最多一个执行任务 |
| `maintenance` | 已接受请求的规范化哈希与原 base | 幂等重放 |
| 初建任务 | 暂存事实、任务标识、文件与节点引用、原 base 和输出 schema | 一次语义提交；恢复时更换任务，拒绝旧结果 |

当前数据库 schema 3 保留文件重要性、`semantic_baselines` 和 `semantic_tasks`，将物理修订字段统一为 `physical_revision` 并删除旧初建批次表。升级前备份原索引；旧文件用途不自动成为重要性选择。后续迁移保留工作区、Cluster 和节点 ID。多跳路径按请求生成。

查询索引覆盖规范路径、`(cluster_id, path)`、限定名、边的两个端点、诊断所属节点和重点节点的反向导航。入边与出边查询共享 `edges` 表。

```text
files.file_id ───────────────────► nodes.node_id
files.cluster_id ────────────────► clusters.cluster_id
nodes.parent_id ─────────────────► nodes.node_id
locations.file_id ───────────────► files.file_id
regions.owner_node_id ───────────► nodes.node_id
edges.from_node_id / to_node_id ─► nodes.node_id
edges.evidence_location_id ──────► locations.location_id
semantics.node_id ───────────────► nodes.node_id
file_highlights ──两个外键───────► files 和 nodes
```

ID、路径、哈希和说明用 `TEXT`，坐标、版本和排序位用 `INTEGER`。标签数组和分支上下文用 JSON 文本，节点归属、边端点和文件导航用独立的外键列。

位置记录提供坐标和对应文件版本，Agent 从工作区按位置读取源码正文。路径结果由当前 `nodes`、`edges` 和诊断即时计算。

### 7.2 Edge 类型与证据

v0.1 支持 `IMPORTS`、`CALLS`、`REFERENCES`、`INHERITS`、`IMPLEMENTS`。包含关系使用 `parent_id`。v0.3 的框架规则可增加 `ROUTES_TO`。

每条边记录源节点、目标节点、关系类型、证据范围、文件哈希、`extractor_id/version` 和 `binding`。同一对节点在不同调用点出现时分别保留证据。`binding` 区分词法绑定、编译器绑定和框架注册绑定。调用边的 `target_role` 标记实现、静态声明或外部资源。`branch_context` 记录相关 Region、分支标识与位置，涵盖条件、异常、循环和回调。

AST 看到 `obj.method()` 只证明这里存在调用表达式。解析器若不能确定目标，记录 `UNRESOLVED_CALLEE` 诊断及原表达式位置，不建立猜测的 CALLS 边。编译器解析到接口方法，只表明静态声明绑定，不能宣称某个实现必然运行。

工具不返回 confidence、概率或模型推测的 possible targets。同名声明的消歧候选属于实际存在的对象列表，不表示动态目标概率。没有返回某条边，也不能据此证明代码间没有运行时关系。

### 7.3 Semantic 的最小集合

Agent 维护 Cluster、文件和重点声明三层语义。目录仍以路径呈现。签名、依赖、Region 和调用位置由事实索引提供。

| 字段 | 限制 |
|---|---|
| Cluster `purpose` | 描述这组文件负责的能力，最多 160 个 Unicode 字符 |
| 文件 `purpose` | 文件的用途，最多 96 个 Unicode 字符 |
| 文件 `content` | 文件包含的主要功能或处理逻辑，最多 240 个 Unicode 字符 |
| 重点节点 `purpose` | 声明承担的职责，最多 96 个 Unicode 字符 |
| `tags` | 最多 4 个；每个最多 24 个 Unicode 字符；去重、排序 |
| 文件重要节点 | 通过独立 Node 操作维护，最多 8 个，降级删除该节点记录 |
| 来源 | `agent` 或 `doc_comment`，文件的 `purpose` 和 `content` 分别记录来源 |

首次建图由 Agent 明确选择重要文件和节点，并编写对应语义。普通文件没有语义也能发布，且可以包含重要节点。补缺使用当前模块文档、文件注释或声明注释。普通节点允许 `purpose=null`。当前高亮项必须附有效职责说明。增量后，已失效且无当前注释的高亮项保留待复核记录，查询返回 `pending_highlight_count` 和其余有效导航。

Agent 按工作单维护新增、变更或待归类的文件、受影响的 Cluster 和失效的重点节点。Agent 根据文件职责、公开入口和模块边界选择高亮，可同时为新选中的节点写入语义。名称和种类从节点表读取。常规节点语义维护仅覆盖 `file_highlights` 引用的节点。

### 7.4 Cluster 覆盖与维护

Cluster 是 Agent 根据业务或技术职责定义的文件组，可跨目录。首版按主职责分组，覆盖所有纳入的源码文件，包括解析失败但可读取的文件。初建校验每个文件恰有一个普通 Cluster，且每个普通 Cluster 有用途和成员。共享文件可归入专门的共用 Cluster。

增量新增文件先进入保留的 `pending` Cluster。`coverage.cluster` 分别报告 `total_files`、`classified_files` 和 `pending_files`。Agent 将待归类文件分配到正常 Cluster。移动归属同时复核源与目标。删除最后一个成员后，空 Cluster 进入待复核，由 Agent 补充成员或移除。每次提交校验全覆盖和成员外键。

Cluster 记录用途，成员通过 `files.cluster_id` 查询。父级导航在同一快照连接文件或节点语义。无需重复保存子级说明。Cluster 与目录边界可以不同，`scope_path` 始终按物理目录筛选。

## 8. 静态路径与证据

追踪以 `target_id` 为起点，根据当前索引版本的节点和边即时展开。目标是在指定方向、深度和关系类型内，覆盖静态证据可支持的调用或执行路径，并标明分析边界。删除具名流程的创建、保存和查询接口。

```text
create_order
  ├─ CALLS  L44 ──► validate
  │                  └─ CALLS  L18 ──► check_quota
  ├─ CALLS  L52 ──► reserve
  │                  └─ CALLS  L76 ──► 外部服务 [外部边界]
  ├─ CALLS  L62 ──► save [persist_enabled 分支]
  └─ L70 动态调用 [未解析目标]
```

路径按父步骤组织。不同调用点、条件分支和静态证据支持的不同目标分别展开。同一调用点有多个可选目标时，按调用点分组并保留各自的绑定证据。适配器排除已证不可达的调用，首版覆盖字面布尔条件的死分支。其余条件保留出处和分支标识，供 Agent 判断可达性。路径层级表示静态连接，运行顺序和分支可行性需要独立的控制流证据。

纯 `CALLS` 链标为 `call`。包含导入、引用、继承等边的链标为 `relation`，并逐跳标明类型。接口或虚方法的声明绑定可定位到调用点与静态声明。实际实现未知时，调用路径在该处停止。外部依赖、动态目标和缺少触发证据的回调均标注边界及位置。已解析的异步调用保留异步上下文。

## 9. 四个查询工具

### 9.1 公共协议

四个工具都以 `root` 指定已登记的工作区绝对路径。

`root` 必须已通过初始化登记，且与索引根一致。ID 只能在该 root 中解析。文件访问经过 realpath 和根边界检查；默认不跟随符号链接、junction 或子模块到根外。

未启用或未完成初建的 root 返回生命周期状态，查询不自动 init。该规则保证研究阶段一次误触查询不会启动项目建图。

| 公共输入 | 规则 |
|---|---|
| `root` | 必填，绝对路径 |
| `freshness_mode` | 默认 `auto`，可选 `verify` 等待一轮完整复核 |
| `cursor` | 可选，只能继续同一 root、版本和参数的结果 |
| `max_bytes` | 默认 24 KiB，范围 4–64 KiB，按整个响应的 UTF-8 大小计算 |

| 公共输出 | 用途 |
|---|---|
| `schema_version` | 协议兼容 |
| `workspace_id`、`physical_index.physical_revision`、`semantic_revision`、`base` | 绑定同一地图版本 |
| `status` | `ok`、`candidates`、`partial`、`error` |
| `focus` 或 `items` | 单目标详情或批量目标各自的状态和结果 |
| `coverage` | 文件发现、解析和 Cluster 归类覆盖率，附排除、失败与未解析计数 |
| `physical_index` | 本次完整校验有效时返回 `status: "valid"` 与事实版本 |
| `page` | total、returned、has_more、next_cursor |
| `diagnostics` | 有界诊断；更多诊断可续页 |

节点、关系和 Region 均附 ID。位置带文件哈希。路径步骤 ID 只用于当前查询结果内的父子引用。`page.has_more=false` 表示当前查询结果已传输完。静态解析覆盖率与路径截断分别报告。

游标绑定 physical_revision、semantic_revision、输入指纹及最后排序键；版本变化时返回 `CURSOR_EXPIRED`。不能静默切换版本，造成重复或遗漏。无效参数、越界路径、未知 ID、过期位置和数据库故障使用固定错误码，并提供最小恢复动作，不返回堆栈或源码内容作为普通错误。

长签名在展示中最多保留 512 个 Unicode 字符，并附 signature_truncated；完整内容通过位置读取。诊断中的表达式最多 160 字符。若单个不可拆分的导航项仍超出预算，返回 `RESPONSE_ITEM_TOO_LARGE`，说明所需字节数和对象 ID；不能生成没有进展的续页游标。

CLI 和独立 MCP 接口共用严格输入校验和查询协议。查询按响应字节上限输出紧凑 JSON，宿主上下文开销按实际传输形式测量。

### 9.2 `map_overview` 浏览 Cluster 和文件结构

| 选择方式 | 返回 |
|---|---|
| 仅 `root` | Cluster 分页列表，含 `cluster_id`、名称、用途、成员数和复核状态 |
| `cluster_id` | 指定 Cluster 的完整成员清单，含 `file_id`、相对路径、文件用途、来源和状态 |
| `scope_path` | 指定目录的文件结构清单，含路径、`file_id`、Cluster 归属和简短用途 |

`cluster_id` 与 `scope_path` 互斥。`scope_path` 是相对 `root` 的**目录路径**，例如 `orders`，`.` 表示根目录。协议统一用 `/`，按路径段筛选，`orders` 不匹配 `orders-old`。拒绝文件路径、绝对路径和越界路径。批量文件路径由下一个工具的 `paths` 指定。

成员列表按路径分页。Agent 可用物理目录找到文件，再查少数目标文件详情。

### 9.3 `map_browse_files` 浏览文件详情

选择器为 `scope_path`、`file_ids`、`paths` 三选一，省略时相当于 `scope_path="."`。目录路径规则同概览。`paths` 是完整的工作区相对文件路径，例如 `orders/service.py`。`file_ids` 和 `paths` 每批 1–32 项。

| 文件项 | 内容 |
|---|---|
| `file_id`、`path` | 可查询的文件节点 ID 和相对路径。路径表达目录结构 |
| `language`、`parse_status` | 语言及解析状态 |
| `cluster_id`、`important`、`semantics` | 文件归属、重要性、用途和主要功能；语义内附来源和复核状态 |
| `highlights`、`navigation_status` | 重点节点含 `node_id`、`name`、`kind` 和 `semantics` |

每项以一个文件为单位。完整文件清单包含解析失败和语言未支持的已纳入文件。重要节点只作简要导航。缺少导航时可用文件 ID 限定节点定位范围。

### 9.4 `map_inspect_node` 检查节点及直接关系

`target_id`、`target_ids`、`query` 三选一。`target_ids` 每批 1–32 项。`query` 按限定名或短名称定位单节点，选填 `file_id` 限定定义所在文件。多个同名节点返回候选 ID 和定义位置。

每个结果包含目标 `purpose`、签名、定义位置、直接入边和出边。普通节点的 `purpose` 可以为空。边保留类型、两端节点 ID 和调用点或引用证据。`include_regions` 默认为 false，可附目标自身的 Region 事实。

单项始终查一跳，批量按输入顺序返回多项。继续分析邻居时，使用其 ID 发起检查或追踪。

### 9.5 `map_trace_node_paths` 追踪节点的多跳路径

| 输入 | 规则 |
|---|---|
| `target_id` | 必填，起点节点 ID |
| `direction` | `upstream`、`downstream`、`both`，默认 `downstream` |
| `max_depth` | 从起点计的最大边数，默认 3，范围 1–8 |
| `relation_types` | 已支持类型的非空列表，默认 `CALLS` |
| `max_steps` | 两个方向合计可返回的路径延伸步数，默认 80，范围 1–200 |

| 输出 | 内容 |
|---|---|
| `path_steps` | 每步含 `step_id`、`parent_step_id`、`node_id`、`edge_id`、`depth`、`direction`、`path_kind`。第一跳的父步骤为空。环边附回指的祖先步骤，回到起点时标记 `target_id` |
| `nodes`、`edges` | 按 ID 去重的定义与证据表。每条边保留原方向、类型、调用或引用位置、绑定方式和分支上下文 |
| `frontier` | 各路径的停点，含步骤或起点引用、方向、节点 ID、原因及可用的证据位置 |
| `traversal_status` | `complete` 表示在已索引事实和请求范围内完成。出现分析边界或遍历预算截断时标为 `partial` |

`both` 从起点分别展开入边和出边。上游的步骤从目标向调用方排列，边仍保留源码中的方向。遍历按层扩展，并以边类型、路径、位置和 ID 稳定排序。汇合节点保留各自的路径前缀。当前路径回到祖先时保留环边并引用祖先步骤，随后结束该分支。

停点原因使用 `leaf`、`cycle`、`external`、`declaration_only`、`unresolved_call`、`unknown_callback_trigger`、`depth_limit` 和 `step_limit`。未解析调用保留所属节点与调用位置。达到遍历预算时，以最后已展开的节点和路径前缀报告待扩展分支。高扇出截断按父步骤归并，保留可用的下一边证据。

响应字节上限控制分页。页内步骤附节点和边证据，父步骤可以引用之前页面。游标绑定同一版本和查询参数。翻页继续传输该次查询范围内的结果。深度或步数限制需调整参数重新追踪。下游调用追踪在涉及的节点报告未解析调用。上游只追踪已绑定入边，无法归属给目标的动态调用计入覆盖说明。

### 9.6 批量、并发和物理校验

CLI 与 stdio MCP 通过同一入口校验整个纳入源码集合，包括新增、删除、内容和索引配置。默认查询发现过期时同步一次；`freshness_mode: "verify"` 只校验。同进程同批请求共享正在执行的校验，不复用跨请求的一秒时间窗。查询使用已提交的同一版本对，并再次核对返回证据的文件哈希。

`physical_index.status: "valid"` 只说明物理索引已校验；对象的 `semantics.status` 独立报告语义复核状态，解析覆盖率另行报告。锁忙返回 `INDEX_REFRESHING`，无法证明当前结果有效返回 `INDEX_STALE`，版本变化使游标失效。

MCP 每进程最多 4 个读取任务，队列上限 16，校验等待上限 8 秒。全量校验、同步和批量查询分别测量；现有性能门槛继续保留，v3 需要重新实测。

## 10. 可扩展语言适配器

索引器使用内置注册表按语言和扩展名选择适配器。注册项包含 `language_id`、扩展名、配置入口、适配器版本和能力。适配器执行发现配置、解析文件、解析引用和计算受影响范围，并输出统一的声明、位置、Region、边、依赖指纹和诊断。索引核心分配 ID、校验输出、计算失效范围并提交 SQLite。

新增语言通过注册适配器及其测试加入。坐标先转换为统一的行号和 UTF-8 字节范围。缺少引用解析能力时保留文件与可解析的声明，覆盖信息列出缺失能力。影响范围无法证明时重建该语言的受影响项目。适配器异常按文件或项目记录诊断。[解析器实测](evidence.md#5-解析器和存储可用性实测)

| 语言 | 实现 | 可以承诺 | 不能承诺 |
|---|---|---|---|
| TS／JS／TSX／JSX | 固定版本 TypeScript Compiler API | 声明、签名、导入、别名、静态声明绑定关系 | 动态属性、运行时 DI、所有插件式模块解析 |
| Python | Tree-sitter Python WASM + 词法／导入绑定器 | 声明、嵌套作用域、静态导入、可证明的直接调用 | 任意对象方法、反射、装饰器运行效果、完整类型推导 |

TS 配置按实际 tsconfig／jsconfig 和项目引用读取。没有配置时建立受控 inferred project。索引库自行提供编译器，不执行项目脚本，不加载项目 TS 插件，不安装依赖、不执行 emit。已有依赖声明可用于只读类型解析，但 node_modules 不进入项目结构树。根外 tsconfig extends 默认不读取并给出诊断。

Python 适配器从语法树建立模块和函数作用域，绑定具名函数及静态导入别名。工作区内的模块按 `.py` 或包的 `__init__.py` 定位，显式相对导入从所在包解析。仅在目标文件及声明唯一、可见绑定未重赋值或遮蔽时建立 `CALLS`。先收集整个词法作用域的名称绑定，再判定调用，避免漏掉后置赋值导致的遮蔽。无法解析的对象方法、继承分派和动态导入保留诊断。

首版保持一个 TypeScript／Node 运行时；Python 语法通过随包 WASM 解析，不要求用户安装 Python、编译器或 Language Server。

## 11. 事实同步与语义基线

```text
默认查询 / 已识别 apply_patch / Stop → 同一个增量 sync
    → 发现清单和配置 → 按语言重算事实 → 复用身份 → 租约事务提交
已接受语义基线 + 当前规范化事实 → 状态与完整工作单
```

事实提交同时更新 physical_revision 和受影响语义状态，不推进 semantic_revision。同步的影响集合只优化事实重算，不是工作单来源。TS／JS 使用固定版本编译器，Python 使用 Tree-sitter 与静态绑定；不执行项目代码。完整重建先校验独立暂存库，再用 active 库事务导入，旧读事务继续读取旧快照。

每个对象保存上次被接受的规范化事实指纹。指纹包含有意义的语法、关系和结构，不含位置或语义文案。无法可靠解析时使用内容哈希保守复核。Cluster 指纹包含成员 ID、路径、事实和重要性；文件维护重要节点名单。纯位置移动不产生语义待办，改动撤销后状态可回到 reviewed。

状态为 reviewed、needs_review、missing、not_selected。初建为所有对象建立结构基线，但普通对象不因此获得语义。仅成功更新、keep 或对应结构操作推进相关基线；纯分类不确认关联旧语义。删除后的旧成员信息保留在上级已接受基线中，直到上级被复核。

## 12. Stop、执行器与宿主

```text
Stop → 有时限的本地 sync → 完整工作单登记 → 主回合结束
    → 宿主收到 turn/completed → 只读 ephemeral fork → Agent JSON
    → 统一执行器 → annotate --apply --base 原基线 --input - → SQLite
显式主 Agent 降级 → 一次 block → 绑定的 last_assistant_message ──┘
```

正常 Stop 不阻塞主回合。工作单包含 reviews、unassigned_files 与空 candidates，按会话、回合和版本对幂等登记，不按 20 项拆分。同步或登记失败时保留旧基线。没有宿主适配器时保留 pending；后续 Stop 可基于同一已接受基线重新登记，无需新代码变化。

`MaintenanceAdapter` 接入宿主已有 App Server 连接，核对源 thread 的 sessionId 与工作单会话，用源回合 lastTurnId 创建 ephemeral、excludeTurns 的只读 fork。分支禁用 Hook，并由宿主禁用可写插件。活动父目标需要宿主提供原子延迟续跑；缺少能力时保持待办。分支可读源码和 Skill，返回操作数组，由执行器绑定原工作单并调用同一个 CLI。执行期不持事实租约。新提示和结果不写回主聊天。

宿主接入与真实桌面验收是独立门槛。当前模块不能通过普通插件 Hook 获得宿主调度连接；不能把事件重放成功写成桌面已启用。详见 [维护验收记录](index-maintenance-acceptance.md)。

只有显式设置 maintenance_mode=main 才允许一次 Stop block。维护 Agent 不编辑源码、不直接写索引、不派发任务，只返回 JSON。Stop 仅接收已登记、同会话及同回合的续跑结果；普通聊天 JSON 不进入写入器。无效、缺失、超限和冲突结果保留待办；实际失败的相同版本任务不自动重跑。

补丁协议为 cluster、file、node、keep 操作数组。文件与标准输入共享 UTF-8 格式和 64 KiB 上限。base 绑定工作区、协议和两个版本，自动任务还绑定工作单范围。先校验最终结构，整份事务提交；已复核对象绑定最终指纹，省略项保持原基线。相同规范数组和原 base 可幂等重放；其余旧版本请求返回 VERSION_CONFLICT。完整字段见 [v3 协议](../skills/use-code-map/references/protocol.md)。

## 13. 存储、配置与安全边界

每个已启用工作区使用 `.codemap/state.json` 保存本机启用标记，`.codemap/index.sqlite` 保存派生事实，附工作单与短期日志。state.json 保存 schema、规范根路径、workspace_id、enabled 和可选的显式 maintenance_mode，不复制数据库中的构建状态。无标记即 inactive；enabled=false 即 suspended。`.codemap/` 默认排除自身索引并加入工作区忽略规则。初始化创建这些派生文件；业务源码和 AGENTS.md 不自动改写。可选配置文件是根目录 `.codemap.json`，使用严格 JSON Schema，不执行 JS／Python 配置。

配置只暴露 `languages`、`include`、`exclude` 和 `max_file_bytes`。默认 TS／JS／Python。`max_file_bytes` 是解析预算，默认 2 MiB。超过预算的已纳入源码仍列入清单、分段阅读和归类。清单排除 `.git`、依赖与生成目录、二进制和忽略规则匹配的文件。事实解析、初建阅读和 Cluster 覆盖共享该清单。

Code Map 对已跟踪和未跟踪文件统一应用忽略规则与显式排除。有 Git 时用 NUL 分隔的 `git ls-files --cached --others --exclude-standard -z` 枚举，再用 `git check-ignore --no-index -z --stdin` 复核已跟踪项。无 Git 时遍历并应用同目录层级的忽略规则。根外链接和子模块只记录边界。每个 worktree 有独立的 `.codemap` 和工作区 ID。

SQLite 使用 WAL、外键约束和 5 秒 busy timeout。同工作区写入租约保存在数据库中，包含 owner nonce、单调递增 fencing token 和到期时间；租期 45 秒，每 5 秒续租。提交事务必须核对 token 与有效租约。租约被接管后，旧进程无权提交，即使它恢复运行。MCP 与 CLI 使用相同更新路径。读事务只返回一个已提交 physical_revision。

查询按第 9.6 节共享清单检查，定位结果输出前复核所用文件。连续变化超过一次重试时返回 `WORKTREE_BUSY`。新鲜度表示检查时点。

不执行被索引项目的脚本、插件或导入代码；不自动下载依赖；不将注释当成指令。语义补丁字段按数据解析，不插入 shell 命令。日志默认只有阶段、耗时、数量、错误码，不记录源码、用户提示或密钥。

## 14. Codex 插件封装

源码以根 `plugin.json` 为清单。Codex 本地包从该清单生成 `.codex-plugin/plugin.json`，并包含 `skills/`、`hooks/` 和 `assets/`。当前 Codex 加载器跳过 portable 清单的 Hook，因此包内只放兼容清单。插件目录视为只读。索引写入目标工作区的 `.codemap/`。[Codex 加载器](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs)

Agent 按需读 `use-code-map`，通过 `dist/cli.mjs query NAME --root ROOT [--input FILE]` 选一项查询。默认包不注册 MCP。源码中的 stdio 接口用于独立调用及回归测试，与 CLI 共用参数校验和查询实现。

`skills/code-map-init/SKILL.md` 定义显式初建、完整阅读、JSON 提交与恢复。`agents/openai.yaml` 将菜单名设为 `code-map-init`，关闭隐式调用。`use-code-map` Skill 负责查询选择、定点阅读及增量补丁协议。详细协议放在 `references`。[Skill 规范](https://developers.openai.com/plugins/build/skills) · [调用策略](https://learn.chatgpt.com/docs/build-skills#optional-metadata)

Hook 使用 `./hooks/hooks.json`。Windows 在 Node 中读取 `PLUGIN_ROOT` 并解析脚本路径。命令从 stdin 读事件 JSON，向 stdout 写结果 JSON，日志到 stderr。

非托管 Hook 由用户检查并信任，定义改变后需重新信任。v0.3 注册 PostToolUse（仅 apply_patch）和 Stop，不注入 SessionStart。隔离宿主与真实 Agent 分别验收。Hook 禁用或未信任时报告降级状态，并通过手动 `sync` 刷新事实。[Hook 信任规则](https://learn.chatgpt.com/docs/hooks)

本方案通过仓库或个人 marketplace 本地安装。带生命周期 Hook 的插件受公共目录提交限制。[桌面插件提交要求](https://developers.openai.com/plugins/deploy/desktop-only)

## 15. 最脆弱前提与降级

首次全量语义构建的主要成本是 Agent 阅读。Agent 自行安排工具读取，最后交付一份语义结果。结果超限时明确失败并保留暂存事实，不静默截断。发布门槛要求覆盖全部纳入文件。自动维护依赖受信任的 Hook 与拥有源 thread 的宿主连接；缺少隔离能力时保留待办，手动维护使用当前 v3 接口。

大仓库分别测量文件哈希、TS 项目重分析和高扇出追踪成本。文件浏览保持清单完整，节点导航和路径输出分别遵循各自的预算。

执行步骤、测试矩阵、发布门槛与回退见 [实施方案](implementation-plan.md)。来源和当前真实验证范围见 [依据记录](evidence.md)。

## 16. 同一个订单功能的存储与 Agent 操作示例

示例工作区是 `D:/work/orders`。`C1`、`F1`、`N1` 等为展示用的缩写。下表省略部分字段，例如字节坐标和完整 SHA-256。

| 表 | 示例记录 |
|---|---|
| `clusters` | `C1` 名为「订单处理」，用途为「校验并保存订单」。成员由文件表查询 |
| `files` | `F1` 对应 `orders/service.py`，语言 `python`，文件哈希 `h1`，解析成功，归属 `C1` |
| `nodes` | `F1` 是文件节点。`N1` 是函数 `create_order`，父节点为 `F1`。`N2` 是 `validators.py` 中的 `validate` |
| `locations` | `L1` 是 `N1` 在 `F1` 的定义范围 40–100 行。`L2` 是同文件第 44 行的调用证据。两条位置均绑定 `h1` |
| `regions` | `R1` 属于 `N1`，记录 `if persist_enabled` 的 AST 锚点和 58–72 行范围 |
| `edges` | `E1` 从 `N1` 指向 `N2`，类型为 `CALLS`，证据引用 `L2`，目标是已解析的实现 |
| `diagnostics` | `N1` 中另一个动态调用保留 `UNRESOLVED_CALLEE` 与该调用点位置 |
| `semantics` | `F1` 的 `purpose` 为「提供订单创建入口」，`content` 为「校验请求并按配置保存订单」。`N1` 有职责，普通节点 `N2` 可留空 |
| `file_highlights` | `F1` 的第一项是 `N1`，查询从节点表取得名称 `create_order` |
| `workspace_state`、`maintenance` | 前者记录已发布事实版本与语义版本。后者记录维护批次状态和已提交的补丁摘要 |

### 16.1 初次构建

用户选择 `code-map-init`。索引器生成暂存事实和任务。Agent 读取 3 个纳入文件，用已有 ID 一次输出 Cluster、文件和重点节点的语义 JSON。统一写入器校验覆盖、引用和原基线，在事务中发布修订对 `(1,1)`。2 个排除文件不参与任务。

### 16.2 日常查询

| Agent 输入 | Agent 看到的结果 |
|---|---|
| `map_overview`，传 `root` 和 `cluster_id=C1` 或 `scope_path=orders` | 文件结构、用途和 `file_id`。`orders` 是工作区相对目录 |
| `map_browse_files`，传 `root` 和 `paths=[orders/service.py, orders/validators.py]` | 同批文件职责和内容，以及 `F1` 中 `create_order` 的 ID 与职责 |
| `map_inspect_node`，传 `root` 和 `target_ids=[N1,N2]` | 同一快照中的两个节点及各自直接边。`E1` 的证据在 `service.py` 第 44 行。`N2` 的定义可定位，职责为空 |
| `map_trace_node_paths`，传 `root`、`target_id=N1`、`direction=downstream`、`max_depth=2`、`relation_types=[CALLS]` | `create_order` 到 `validate` 的第一跳，若 `validate` 已绑定 `check_quota`，则继续返回第二跳。每跳附证据，动态目标以停点表示 |

已知 `N1` 时直接检查或追踪。导航为空时可用 `file_id=F1` 加 `query=create_order` 定位。Agent 根据返回的位置读取所需源码。查询阶段的索引刷新由索引器处理，Agent 的语义写入走维护接口。

### 16.3 增量维护

订单接口增加地址校验。默认查询自动同步事实，返回新位置和 needs_review 的旧职责。Stop 比较已接受基线与当前事实，登记 Cluster、重要文件和节点的完整工作单。宿主可在主回合完成后派发只读分支；分支返回 node 更新、keep 或文件归类操作。执行器携带原 base 统一提交。期间若源码或语义版本变化，旧结果被拒绝；省略项仍待复核。
