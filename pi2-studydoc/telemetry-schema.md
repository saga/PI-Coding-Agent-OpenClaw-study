# Pi Agent 遥测 schema

<!-- 由 generate-telemetry-docs.ts 生成。请勿手动编辑。 -->

## AI request schema

Schema version: 1

### `pi.ai.request`

一次发往 AI provider 的逻辑请求

- Parents: root 或任意 caller span
- 默认 status：`ok`
- 报错条件：该 operation 抛出异常或返回错误结果

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.ai.operation` | `string` | 是 | stream, fetch_deferred, cancel_deferred, generate_images |  | 逻辑 provider operation |
| `pi.ai.provider` | `string` | 是 |  |  | 选中的 provider id |
| `pi.ai.model` | `string` | 是 |  |  | 请求的 model id |
| `pi.ai.api` | `string` | 是 |  |  | Provider API id |
| `pi.ai.streaming` | `boolean` | 是 |  |  | 该 operation 是否返回 stream |
| `pi.ai.deferred` | `boolean` | 否 |  |  | 该 operation 是否请求或参与 deferred execution |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.ai.response.model` | `string` |  |  | 实际响应 model |
| `pi.ai.response.id` | `string` |  | high cardinality | Provider 响应 id |
| `pi.ai.response.stop_reason` | `string` | stop, length, tool_use, error, aborted, deferred |  | 归一化后的终止响应原因 |
| `pi.ai.http.status_code` | `number` |  |  | 最终 HTTP status |
| `pi.ai.usage.input_tokens` | `number` |  |  | 上报的 input tokens |
| `pi.ai.usage.output_tokens` | `number` |  |  | 上报的 output tokens |
| `pi.ai.usage.cache_read_tokens` | `number` |  |  | 上报的 cache-read tokens |
| `pi.ai.usage.cache_write_tokens` | `number` |  |  | 上报的 cache-write tokens |
| `pi.ai.usage.reasoning_tokens` | `number` |  |  | 上报的 reasoning tokens |
| `pi.ai.usage.total_tokens` | `number` |  |  | 上报的 total tokens |
| `pi.ai.usage.cost` | `number` |  |  | 上报的 total cost |
| `pi.ai.stream.chunk_count` | `number` |  |  | 流式 update chunk 数量 |
| `pi.ai.stream.time_to_first_chunk_ms` | `number` |  |  | 到首个 update chunk 的耗时（毫秒） |
| `pi.ai.error.type` | `string` |  | low cardinality | Provider 或 transport 错误类别 |

#### Events

未声明任何 span 事件。

## Harness schema

Schema version: 1

### `pi.harness.run`

一次被接纳的进程内 run 调用

- Parents: root 或 caller 拥有的外部 span
- 默认 status：`ok`
- 报错条件：该 run 失败或抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.session.id` | `string` | 是 |  | high cardinality | Session id |
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.operation.recovery` | `boolean` | 是 |  |  | 该调用是否恢复持久化工作 |
| `pi.operation.kind` | `string` | 是 | run |  | Run operation 类别 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.operation.outcome` | `string` | completed, aborted, failed, suspended |  | Run 调用结果 |
| `pi.error.code` | `string` |  | low cardinality | 稳定的 operation 错误 code |
| `pi.error.type` | `string` |  | low cardinality | 低基数 operation 错误类别 |

#### Events

未声明任何 span 事件。

### `pi.harness.compaction`

一次被接纳的进程内手动 compaction 调用

- Parents: root 或 caller 拥有的外部 span
- 默认 status：`ok`
- 报错条件：该 compaction 失败或抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.session.id` | `string` | 是 |  | high cardinality | Session id |
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.operation.recovery` | `boolean` | 是 |  |  | 该调用是否恢复持久化工作 |
| `pi.operation.kind` | `string` | 是 | compaction |  | Compaction operation 类别 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.operation.outcome` | `string` | completed, declined, aborted, failed |  | Compaction 调用结果 |
| `pi.error.code` | `string` |  | low cardinality | 稳定的 operation 错误 code |
| `pi.error.type` | `string` |  | low cardinality | 低基数 operation 错误类别 |

#### Events

未声明任何 span 事件。

### `pi.harness.navigation`

一次被接纳的进程内 navigation 调用

- Parents: root 或 caller 拥有的外部 span
- 默认 status：`ok`
- 报错条件：该 navigation 失败或抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.session.id` | `string` | 是 |  | high cardinality | Session id |
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.operation.recovery` | `boolean` | 是 |  |  | 该调用是否恢复持久化工作 |
| `pi.operation.kind` | `string` | 是 | navigation |  | Navigation operation 类别 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.operation.outcome` | `string` | completed, declined, aborted, failed |  | Navigation 调用结果 |
| `pi.error.code` | `string` |  | low cardinality | 稳定的 operation 错误 code |
| `pi.error.type` | `string` |  | low cardinality | 低基数 operation 错误类别 |

#### Events

未声明任何 span 事件。

### `pi.harness.checkpoint`

一次 run checkpoint

- Parents: `pi.harness.run`
- 默认 status：`ok`
- 报错条件：Checkpoint 工作抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.checkpoint.kind` | `string` | 是 | normal, abort_reconcile |  | Checkpoint 用途 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| _none_ | | | | |

#### Events

未声明任何 span 事件。

### `pi.harness.turn`

一次 assistant 响应及其 tool batch

- Parents: `pi.harness.run`
- 默认 status：`ok`
- 报错条件：Turn 工作抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.turn.id` | `string` | 是 |  | high cardinality | 调用局部的 turn id |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| _none_ | | | | |

#### Events

未声明任何 span 事件。

### `pi.harness.step`

一次持久化重试尝试

- Parents: `pi.harness.turn`, `pi.harness.checkpoint`, `pi.harness.compaction`, `pi.harness.navigation`
- 默认 status：`ok`
- 报错条件：该尝试重试、失败或抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.step.kind` | `string` | 是 | assistant, compaction, branch_summary |  | 可重试 step 类别 |
| `pi.step.attempt` | `number` | 是 |  |  | 从 1 开始的持久化尝试次数 |
| `pi.compaction.reason` | `string` | 否 | manual, threshold, overflow |  | Compaction 触发原因 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.step.outcome` | `string` | succeeded, retry, failed, aborted, deferred, overflow |  | 尝试结果 |

#### Events

未声明任何 span 事件。

### `pi.harness.tool`

一次原始的 phase-2 tool 执行

- Parents: `pi.harness.turn`, `pi.harness.run`
- 默认 status：`ok`
- 报错条件：原始 phase-2 执行返回错误

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.turn.id` | `string` | 否 |  | high cardinality | 调用局部的实时 turn id |
| `pi.tool.name` | `string` | 是 |  |  | Tool 名称 |
| `pi.tool.call_id` | `string` | 是 |  | high cardinality | Tool call id |
| `pi.tool.replay` | `string` | 是 | never, safe |  | 声明的 replay 策略 |
| `pi.tool.recovery` | `boolean` | 是 |  |  | 是否为 recovery 执行 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.tool.is_error` | `boolean` |  |  | 原始 phase-2 执行是否返回错误 |

#### Events

未声明任何 span 事件。

### `pi.harness.hook`

一次已注册 hook handler 的调用

- Parents: root 或任意 caller span
- 默认 status：`ok`
- 报错条件：该 handler 抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.lane.name` | `string` | 是 |  | high cardinality | Lane 名称 |
| `pi.operation.id` | `string` | 否 |  | high cardinality | 被接纳时的持久化 operation id |
| `pi.hook.name` | `string` | 是 | before_run, before_drive, before_run_end, transform_context, before_request, before_payload, after_response, before_tool, after_tool, before_compaction, before_navigation |  | Hook 名称 |
| `pi.hook.registration_id` | `string` | 否 |  |  | 可选的 hook 注册元数据 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.hook.outcome` | `string` | completed, skipped, blocked, failed |  | Handler 结果 |

#### Events

未声明任何 span 事件。

### `pi.harness.sleep`

一次重试延迟

- Parents: `pi.harness.run`, `pi.harness.compaction`, `pi.harness.navigation`, `pi.harness.turn`, `pi.harness.checkpoint`
- 默认 status：`ok`
- 报错条件：Sleep 工作抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.operation.id` | `string` | 是 |  | high cardinality | 持久化 operation id |
| `pi.sleep.delay_ms` | `number` | 是 |  |  | 请求的延迟毫秒数 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.sleep.outcome` | `string` | elapsed, aborted |  | 延迟结果 |

#### Events

未声明任何 span 事件。

### `pi.harness.event_handler`

一次被动 event listener 调用

- Parents: root 或任意 caller span
- 默认 status：`ok`
- 报错条件：该 listener 抛出异常

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.event.type` | `string` | 是 | run_start, run_resume, run_suspend, operation_abort, run_end, fault, handler_error, turn_start, turn_end, retry_scheduled, retry_start, retry_end, message_start, message_update, message_end, tool_start, tool_update, tool_end, entry_added, queue_update, value_update, config_update, compaction_start, compaction_end, navigation_start, navigation_end, lane_created, usage | low cardinality | 投递的 harness 事件类型 |
| `pi.lane.name` | `string` | 否 |  | high cardinality | lane 作用域事件的 Lane 名称 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| _none_ | | | | |

#### Events

未声明任何 span 事件。

### `pi.session.write`

一次已提交的 session 事务

- Parents: root 或任意 caller span
- 默认 status：`ok`
- 报错条件：Storage 拒绝该事务

#### Start attributes

| Name | Type | Required | Values | Notes | Description |
|---|---|---:|---|---|---|
| `pi.session.id` | `string` | 是 |  | high cardinality | Session id |
| `pi.lane.name` | `string` | 否 |  | high cardinality | caller 提供时的 Lane 名称 |
| `pi.operation.id` | `string` | 否 |  | high cardinality | caller 提供时的持久化 operation id |
| `pi.session.item_count` | `number` | 是 |  |  | 该事务中的写入数量 |
| `pi.session.item_kinds` | `string[]` | 是 | elements: entry, usage, value, list |  | 该事务中不同的写入类别 |

#### End attributes

所有 end attributes 都是可选的完成补充信息。

| Name | Type | Values | Notes | Description |
|---|---|---|---|---|
| `pi.session.first_seq` | `number` |  |  | 该事务中首个提交的 sequence |
| `pi.session.last_seq` | `number` |  |  | 该事务中最后提交的 sequence |

#### Events

未声明任何 span 事件。
