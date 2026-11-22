# Code Map 事实与语义索引维护方案

2026-11-22 接口更新：当前物理版本字段为 `physical_revision`，查询与提交协议为 v3。初建改为单任务、单份语义 JSON，复用 `annotate --apply`。下文保留 v0.3 维护设计背景，现行初建契约见 [设计方案](design.md) 和 [协议](../skills/use-code-map/references/protocol.md)。

拟议方案。现有 v0.2 的查询会校验索引，靠显式 `sync` 或 Stop 更新事实；初建发布还要求所有文件有用途，Stop 会分批要求主 Agent 续跑。本方案替换这些行为。查询与语义更新协议统一升为 v2，不为旧字段另设兼容别名。实现时同步更新 README、AGENTS.md、设计文档、技能、协议和打包检查；这些文件当前仍描述已实现的 v0.2。

```text
可识别的源码写入 ── PostToolUse ──┐
查询发现已纳入源码有变化 ────────┼─→ sync → SQLite 事实版本 + 待复核状态
当前任务回合结束 ── Stop ─────────┘                 │
                                  查询 ←── 事实 + 语义状态
                                                   │
Stop → 工作单 → 主回合结束 → 后台 fork 维护 Agent ─┐
显式主 Agent 降级 ────────────────────────────────┴→ JSON → 统一执行器 → annotate → SQLite
手动维护工具 ────────────────────────────────────────────────────────────┘
```

## 1. 状态与覆盖

| 对象 | 覆盖规则 | 何时进入语义工作单 |
| --- | --- | --- |
| Cluster | 每个纳入的文件恰好属于一个 Cluster；正式 Cluster 默认重要 | 新建，或成员构成、成员相关事实、对外接口及跨 Cluster 依赖的指纹变化 |
| 文件 | Cluster 维护其重要文件名单 | 重要且缺少语义，或影响其用途的事实已变 |
| Node | 所属文件维护其重要节点名单；文件本身可以是普通文件 | 重要且缺少语义，或影响其职责的事实已变 |
| Region | 由解析器维护 | 不生成语义 |

初建继续要求 Agent 读完全部纳入源码，并校验文件归属完整且无重复。发布时要求正式 Cluster、重要文件和重要节点有用途或职责说明。普通文件没有语义也能发布。增量发现的新文件先归到系统管理的「待归类」组，立即可查；归类是结构任务，不要求为普通文件写用途。删除文件或节点时清理失效归属和引用，并保留供受影响上级复核的变更证据。

- `physical_index.physical_revision` 跟踪事实快照，包括索引清单、内容、位置和关系。事实变更和受影响语义状态在同一事务更新。
- `semantic_revision` 跟踪 Agent 提交并被接受的用途、职责、归属、重要性或复核结果。同步造成的待复核或引用清理仅改变事实版本。两者随查询返回；同一批查询读同一版本对。
- **语义基线**保存上次成功接受的语义所对应的相关物理事实，按对象记录指纹，并保留判断成员新增、删除和归属变化所需的结构清单。初建发布时建立基线；普通对象不因此获得语义。只需保留已接受的基线和当前物理状态，不累计各会话的相对增量。
- 已选对象的语义状态为 `reviewed`、`needs_review` 或 `missing`；普通对象是 `not_selected`。状态及工作单均可从语义基线与当前物理状态重新计算。纯行号移动可改变事实版本，但不触发语义复核；改动又撤销时，不留下多余待办。指纹采用与对象有关的规范化事实，保留有意义的语法和关系，忽略纯位置变化。无法可靠比较时，将受影响的重要对象标为待复核。
- 复核指纹不包含语义文案本身，避免提交文案后再次触发复核。归属等结构变化按最终结构更新相关指纹；同一补丁已完成复核的对象绑定最终指纹。

```text
上次成功接受的语义基线 ─┐
当前物理索引 ──────────┴→ 比较相关事实 → 按重要性筛选 → 完整工作单
```

基线按对象推进：成功提交的语义更新、结构变更或 `keep` 只推进对应部分；纯归类不自动确认关联的旧语义。失败、冲突、省略和超限项目保留原基线。一次补丁事务成功不代表整张工作单全部完成。只有所有待复核和归类项目都完成时，才可视为整份语义与当前物理状态对齐。删除当前对象及引用时，保留其上级已接受基线中必要的旧成员信息，直到上级完成复核，避免漏掉删除影响。

## 2. 查询与自动更新

保留四个查询。CLI 与可选的独立 MCP 走同一个查询入口。仅已发布并启用的工作区可自动同步；安装、开会话、未初建查询、暂停状态均不触发源码扫描。

1. 在一次查询或同批请求中，按发现规则校验**整个纳入索引的源码集合**，包括新增、删除、内容哈希和影响索引的配置。这样可发现查询范围外改变的引用或模块解析。忽略文件和工作区外文件不在校验范围内。
2. 默认查询发现事实过期时，内部调用一次增量 `sync`，再用可验证的已提交快照查询。复用同一批校验结果，并复查要返回的证据文件。若写锁仍忙，或源码继续变化导致本次无法校验，返回可重试错误；`INDEX_REFRESHING` 表示写入仍在进行，`INDEX_STALE` 表示无法证明结果有效。跨页版本变化时要求从第一页重查。
3. 顶层 `physical_index.status: "valid"` 表示「**物理索引有效**」，即本次校验时索引与纳入的源码和配置相符。新协议不保留 `current`。Cluster、文件和节点各自的 `semantics.status` 表示其语义说明的复核状态。解析覆盖率另行报告。显式 `freshness_mode: "verify"` 仍只校验；需要刷新时使用默认查询或手动 `sync`。

示例：订单创建接口现在要求有效的收件地址。同步后，查询可返回新的代码位置，但此前保存的职责说明仍待复核。以下是 `map_inspect_node` 的响应节选：

```json
{
  "schema_version": 2,
  "workspace_id": "ws_orders",
  "physical_index": {"status": "valid", "physical_revision": 41},
  "semantic_revision": 7,
  "base": "q_41_7",
  "node": {
    "node_id": "00000000-0000-4000-8000-000000000003",
    "definition": {"path": "src/orders/create.ts", "start_line": 18},
    "semantics": {"status": "needs_review", "purpose": "Create an order"}
  }
}
```

`PostToolUse` 只为已知写入工具提早同步。首版匹配 `^apply_patch$`，从可识别的变更项取得旧、新路径，再按索引清单和发现规则确认有实际变化。删除或改名要检查旧路径；排除忽略项和索引自身。命中才调用同一个增量同步，解析器按依赖关系决定影响范围。锁忙或超过 Hook 等待上限时交由下一次查询或 Stop 校验。

不订阅通用 Shell 或所有 MCP 调用。PowerShell 写文件、格式化器、外部编辑器等可能绕过 `apply_patch`；查询校验兜底。`PostToolUse` 只同步事实，不派发 Agent，也不把状态提示加到主聊天。移除仅注入提示的 `SessionStart`；状态由查询和 `doctor` 按需提供。

## 3. 手动与自动共用写入接口

将 `navigate` 改名为 `use-code-map`。从宿主提供的插件根目录，或技能所在目录向上两级，定位随包发布的 `dist/cli.mjs`。使用现有 CLI，不注册新的 MCP 工具。手动刷新事实仍用 `sync --root <工作区>`。

```powershell
$skillFile = '<宿主技能列表中 use-code-map 的 SKILL.md 绝对路径>'
$workspace = 'C:\work\orders'
$cli = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $skillFile) '..\..\dist\cli.mjs')).Path

node $cli annotate --root $workspace --prepare --scope '00000000-0000-4000-8000-000000000003'
# 使用查询或 prepare 返回的 base。以下为示例值。
$reviewBase = 'q_41_7'
& {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  @'
[{"op":"node","id":"00000000-0000-4000-8000-000000000003","purpose":"校验收件地址并创建订单"}]
'@ | node $cli annotate --root $workspace --apply --base $reviewBase --input -
}
```

`--input -` 从标准输入接收 UTF-8 JSON，无需先写文件；`--input <文件>` 供回放或复用。两种入口使用同一个数组格式和字节上限。`--prepare` 先确认索引有效，再返回 `base`、对象、已保存的语义和源码位置。查询已返回所需信息时，可跳过 `--prepare`。下面的数组还把新文件归到新建的支付 Cluster，并选中文件和授权节点：

```json
[
  {"op": "node", "id": "00000000-0000-4000-8000-000000000003", "purpose": "校验收件地址并创建订单"},
  {"op": "cluster", "key": "payments", "purpose": "处理订单支付授权"},
  {"op": "file", "id": "00000000-0000-4000-8000-000000000004", "cluster": "payments", "important": true,
   "purpose": "封装订单的支付授权流程"},
  {"op": "node", "id": "00000000-0000-4000-8000-000000000005", "important": true, "purpose": "向支付服务申请授权"}
]
```

| 操作 | 含义 |
| --- | --- |
| `cluster` | 以唯一 `key` 新建或更新 Cluster；新建需提供用途，并在同一补丁分配至少一个文件。可用 `remove: true` 删除最终没有成员的 Cluster。 |
| `file` | 用查询返回的文件 ID，按需修改归属、重要性或用途。仅归类时只填归属，不要求文件用途。移动文件时同步迁移其重要性记录。 |
| `node` | 用查询返回的 Node ID，按需修改重要性或职责；所属文件由索引确定。 |
| `keep` | 确认已有文案仍适用，将其绑定到当前事实指纹。未列出的待办保持原状态。 |

| 责任方 | 提供或生成的数据 |
| --- | --- |
| 维护 Agent 或手动调用者 | 只给操作数组：引用对象 ID，填写要改的用途、归属和重要性，或用 `keep` 确认旧说明。新建 Cluster 时指定其逻辑 `key`。 |
| 统一执行器／手动调用者 | 把读取时取得的 `base` 传给 CLI。手动使用查询或 `--prepare` 发出的基线；两条维护路径都由统一执行器绑定工作单的基线。 |
| 索引器 | 管理工作区 ID、协议版本、两个索引版本和工作单绑定；解析对象和源码位置，计算指纹，生成新 Cluster ID，更新语义状态和版本。 |

查询和 `--prepare` 从已校验的快照生成不需落盘的**提交基线**引用 `base`，绑定协议版本、工作区 ID 和两个版本号；Stop 的提交基线同时绑定工作单及允许变更的范围。它用于拒绝过期补丁，与确定待办的语义基线不同。提交时必须用原 `base`，CLI 不用提交时的版本自动替补。

自动补丁可为受影响范围内未列出的重要对象补语义。允许范围从语义基线与当前物理状态之差、待归类文件及其所属节点推导，不依赖各次 `sync` 的影响集合，无需预填候选。新 Cluster 的成员也须在这一范围内。

需要补充未列对象时，维护 Agent 用只校验的查询（`freshness_mode: "verify"`）取得索引器返回的 UUID，不从名称编造 ID。该查询不更新原工作单的提交基线；若物理索引或源码已变化，最终提交会拒绝过期补丁。

索引器通过对象和已纳入的文件解析源码位置；新 Cluster 可从同一补丁分配给它的文件定位。只有需要引用额外源码时，操作才带可选的 `locations`（每项为 `{path, start_line?, end_line?}`）。补丁不复制源码片段。索引器校验引用和范围；Agent 读取源码或必要的差异后判断说明是否准确。事实查询原有的关系证据仍保留。

普通对象升级时，同一补丁必须提供语义；降级时清除公开语义。每对象最多一条变更，`keep` 不与同对象的写入并用。空数组表示无操作，不推进语义版本。首版沿用 64 KiB 补丁输入预算；工作单大小与补丁预算分开。

提交在租约下复查事实、版本、归属、选择范围和引用。先校验最终结构，再提交语义及复核绑定；整份补丁一次提交。以原基线和规范化操作数组识别重复请求：已应用的相同请求返回成功且不再写入，其余请求按版本校验；版本不符返回 `VERSION_CONFLICT` 并拒绝整份补丁。新结构影响了其他语义时，由同一事务更新其复核状态。工作区升级保留原索引备份；旧的文件用途不自动等同于重要性，重要性待明确选择。

## 4. Stop 与隔离对话

本方案所说的 SessionStop 对应 Codex 的 `Stop`，处理**当前任务回合结束**；不是归档或关闭聊天时的 `SessionEnd`。语义维护默认异步：主回合只等待有时限的本地事实校验、必要同步和工作单登记，不等待维护 Agent 推理、读取或提交。语义维护使用可调用工具的 Agent，通过 fork 继承历史。

Hook 做最终事实同步，再生成一份完整工作单：`reviews` 放待复核的重要对象，`unassigned_files` 放待归类文件，`candidates` 留空。Agent 可为有意义的新增重要对象补语义。

现有同步将受影响对象记为 `content_or_binding`、`cluster_affected` 等机器标签；新版不以这些逐次维护记录作为工作单来源。每次 Stop 直接比较语义基线与当前物理状态，跨会话累积的未处理变化自然包含在差异中。同步的影响集合只优化事实重算。工作单用 `semantics` 携带已保存的说明及状态，不生成 `change` 文案。Agent 读相关源码，必要时读可取得的差异。Cluster 给相关成员位置；文件给路径，节点给路径和行号。

订单示例的工作单节选。对象 ID 是索引器生成的 UUID，和文件名无关；例如结尾为 `0004` 的 ID 对应 `src/orders/payment.ts`。路径供 Agent 读取，ID 供更新接口定位对象。

```json
{
  "schema_version": 2,
  "workspace_id": "ws_orders",
  "worklist_id": "wl_41_7",
  "base": "w_wl_41_7",
  "session_id": "session_1",
  "turn_id": "turn_8",
  "base_physical_revision": 41,
  "base_semantic_revision": 7,
  "reviews": [
    {"kind": "cluster", "id": "00000000-0000-4000-8000-000000000001", "key": "orders",
     "semantics": {"status": "needs_review", "purpose": "Handle order creation"},
     "locations": [{"path": "src/orders/create.ts"}]},
    {"kind": "file", "id": "00000000-0000-4000-8000-000000000002",
     "semantics": {"status": "needs_review", "purpose": "Implement order creation"},
     "location": {"path": "src/orders/create.ts"}},
    {"kind": "node", "id": "00000000-0000-4000-8000-000000000003",
     "semantics": {"status": "needs_review", "purpose": "Create an order"},
     "location": {"path": "src/orders/create.ts", "start_line": 18, "end_line": 30}}
  ],
  "unassigned_files": [
    {"id": "00000000-0000-4000-8000-000000000004", "location": {"path": "src/orders/payment.ts"}}
  ],
  "candidates": []
}
```

Agent 可以更新 `createOrder` 的职责、保留仍准确的旧说明，并给支付文件分配 Cluster。若只做归类，文件和其中的节点仍可保持普通对象。

1. 工作单是基线差异的可重建快照；任务元数据仍落盘，记录会话、回合、版本对和执行状态，用于结果绑定、幂等和恢复，不保存会话级相对增量。同一回合和版本对的重复事件幂等，同一工作区最多运行一个语义任务。生成工作单后释放事务和租约，不在 Agent 执行期间持锁。若本地同步或登记失败，不推进语义基线，主回合照常结束。
2. 同步 Stop 登记任务后返回，不在正常路径返回 `decision: "block"`。主回合结束后，后台宿主适配器收到 `turn/completed`，用 `thread/fork` 指定 `ephemeral: true`、`excludeTurns: true` 和该源回合的 `lastTurnId`，接着用 `turn/start` 派发维护任务。同步 Hook 不等源回合完成；它返回前源回合不能完成，而未完成的回合不能作为 `lastTurnId`。
3. 分支使用同一工作区的只读权限，可读源码或差异，返回一份 JSON 操作数组。后台适配器把结果和原工作单交给统一执行器；执行器经标准输入调用 `annotate --apply --root <工作区> --base <原基线> --input -`，复用手动维护的校验与写入规则。维护 Agent 不自行同步或应用补丁，也不再派发维护任务。若父线程带有自动目标续跑，分支创建时延迟该续跑，再清除分支的目标，避免执行父任务。执行器完成或失败后关闭分支。
4. fork 继承指定回合为止仍保存的历史；对话、工具结果和已读入的 Skill 文本可能包括压缩后的摘要，不保证恢复压缩前的全文。`excludeTurns` 只省略 API 响应里的回合列表。分支的新提示、工具结果和最终输出不合并到主会话，也不作为通知注入主会话上下文；后续主会话查询仍能读到 SQLite 中的新语义。实际可用工具、Skill 目录及权限取决于分支运行配置，需验收源码和所需 Skill 的可读性。`thread/sample` 和实验预测模式均不用于本流程。
5. 默认在隔离入口不可用时保留待办，主回合照常结束；不自动改用主 Agent 续跑。主 Agent 续跑保留为显式选择的降级路径：若用户已选择且当前仍在 Stop 时点，可用 `decision: "block"` 续跑一次。主 Agent 也只返回 JSON 数组，由下一次 Stop 用 `last_assistant_message` 接收，交给同一个统一执行器。这条路径会延后主回合结束，并把维护记录追加到主聊天。同一工作单的执行路径互斥。
6. Stop 接收结果时，先核对已登记的维护任务、会话、回合和基线，只解析该任务的返回。缺少结果、JSON 无效或版本冲突时不写入；不能把普通聊天的 JSON 当成补丁。此次 Stop 只接收和提交结果，不重新派发维护；执行结果由执行器记录，Agent 不提前宣称更新成功。
7. 隔离入口不可用时不推进语义基线。后续每次正常 Stop 比较同一已接受基线与当前物理状态；入口恢复后，用该差异生成新工作单并异步派发，不要求有新的代码变更。被取代的旧工作单停止派发。已有 JSON 补丁仍受原提交基线约束，不能换上新 `base` 继续提交；手动维护也可随时处理待办。
8. 任务超限、实际执行失败或写入冲突时，保留未完成项目；不在源回合结束后尝试返回 Stop 决策。用户可在后台维护期间开始下一任务；若源码或语义版本已变化，旧补丁按原提交基线校验，拒绝覆盖新状态。工作单不按 20 项拆分；超出单次输入预算可分段读取，超出提交预算的项目仍待复核。已实际执行失败或超限的同一提交基线任务不自动反复重跑；有新的相关版本或手动请求时再处理。

统一执行器是插件内部共用的结果提交模块，不新增工具或独立服务。后台适配器和 Stop Hook 是两个结果入口，均把操作交给它；两类 Agent 都只生成操作。手动调用现有 CLI 仍使用相同的底层校验与写入规则。

这里的异步是宿主适配器在回合结束后执行持久化任务，不是单纯给原生 Hook 设置 `async: true`。原生后台 Hook 在整个会话结束时可能被取消。若应用退出导致执行器停止，任务恢复为可处理的待办；下次具备执行条件时先校验原提交基线，不能把旧结果套到新版本。

普通插件 Hook 的事件输入不提供 App Server 调度能力。隔离路径必须先完成宿主适配器及真实桌面验收，不能只凭 `thread/fork` 接口存在就宣称已可用。宿主适配器负责监听完成事件、执行分支工具循环、接收结果及关闭分支。

| 路径 | 主回合是否等待语义维护 | Agent 的输出与写入 |
| --- | --- | --- |
| 默认后台 fork | 不等待；维护记录不进入主聊天 | 分支返回 JSON 数组；后台适配器接收，统一执行器调用写入接口 |
| 显式主 Agent 降级 | 等待一次续跑；记录进入主聊天 | 主 Agent 返回同格式 JSON 数组；Stop 接收，统一执行器调用写入接口 |

实际发给维护 Agent 的英文 Stop Prompt 示例。`location` 指示读取位置，不附源码片段。已保存的语义按原文传入。工作单 ID、版本、基线和指纹由调用方保留。

```text
Maintain the Code Map worklist below. Read relevant source at the listed locations.
Inspect the relevant diff if needed and available.
Update semantics only where needed. Use keep if the description still applies.
Omit an item if you cannot verify it. Assign unassigned files to a Cluster.
You may add significant objects with a brief semantic description.
Use read-only tools. Do not edit source files or write the index yourself.

Return exactly one JSON array matching the supplied operation schema.
Use cluster, file, node, or keep operations. Include only changed fields.
Return [] if there are no operations. Do not add prose or Markdown.

Worklist:
{
  "reviews": [
    {"kind":"cluster","id":"00000000-0000-4000-8000-000000000001","key":"orders",
     "semantics":{"status":"needs_review","purpose":"Handle order creation"},
     "locations":[{"path":"src/orders/create.ts"}]},
    {"kind":"file","id":"00000000-0000-4000-8000-000000000002",
     "semantics":{"status":"needs_review","purpose":"Implement order creation"},
     "location":{"path":"src/orders/create.ts"}},
    {"kind":"node","id":"00000000-0000-4000-8000-000000000003",
     "semantics":{"status":"needs_review","purpose":"Create an order"},
     "location":{"path":"src/orders/create.ts","start_line":18,"end_line":30}}
  ],
  "unassigned_files": [
    {"id":"00000000-0000-4000-8000-000000000004","location":{"path":"src/orders/payment.ts"}}
  ],
  "candidates": []
}
```

调用方附上由统一 Zod schema 生成的操作格式，并在接收结果后再校验；较大的工作单可改传文件路径。两条维护路径使用相同的任务约束和数组格式，都不由 Agent 写入。显式主 Agent 降级可使用英文交接提示：“Read the worklist at `<path>`. Return only a JSON array matching the supplied operation schema. Do not edit source files or apply the operations. The executor will validate and apply your response.”

## 5. 实施顺序与验收

1. **事实与查询。** 先完成共享查询校验和同步，再接 `PostToolUse`。验收：同一回合内用补丁和 PowerShell 分别修改、新增、删除已纳入文件；下一次默认查询返回当前事实。只读工具、忽略文件和未启用工作区不触发自动同步。校验锁冲突、过期分页和解析覆盖提示。
2. **语义状态与接口。** 调整初建覆盖、重要性、基线和补丁校验，再更新技能文档。验收：普通文件无用途仍可发布；位置移动或变更撤销不留下无效待办；跨多个会话的变化无需增量日志也能重建完整待办；部分提交只推进对应对象；删除影响不丢失；标准输入和文件中的同一 UTF-8 数组产生相同状态；归类、新建 Cluster、对象升级一致；过期提交基线、错误工作区及并发冲突不能覆盖新语义。
3. **Stop 与宿主。** 先交付完整工作单及手动维护，再接入异步宿主适配器；主 Agent 续跑仅作为显式降级。接入并校验可空的 `last_assistant_message`，让两条维护路径共用执行器。Windows 桌面验收应覆盖主回合先于维护结束、下一回合可开始、指定回合历史、分支对源码和 Skill 的可读性、父目标不续跑、超过 20 项、重复 Stop、入口恢复后的无新变更重试、应用退出与待办恢复、隔离记录不追加主聊天、显式降级保留记录、普通聊天不被解析成补丁、两条路径相同 JSON 的提交结果，以及版本冲突；分别记录事件重放与真实 Agent 结果。

现有实现入口：[查询协议](../src/query/protocol.ts)、[事实同步](../src/index/sync.ts)、[初建发布](../src/index/bootstrap.ts)、[语义写入](../src/semantic/apply.ts)、[Stop](../src/hooks/stop.ts)。宿主约定见 [Codex Hook 工具覆盖](https://learn.chatgpt.com/docs/hooks#tool-coverage)、[Stop](https://learn.chatgpt.com/docs/hooks#stop)和 [App Server](https://learn.chatgpt.com/docs/app-server)。
