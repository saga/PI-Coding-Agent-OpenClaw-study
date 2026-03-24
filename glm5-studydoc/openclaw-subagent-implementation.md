# OpenClaw Subagent 实现机制

## 概述

OpenClaw 的子代理（Subagent）系统允许主代理在执行任务过程中动态创建和管理子代理，实现任务分解、并行执行和结果聚合。

## 核心架构

### 1. 子代理创建流程

**文件**: [`subagent-spawn.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-spawn.ts)

#### 创建参数

```typescript
type SpawnSubagentParams = {
  task: string;                              // 任务描述
  label?: string;                            // 标签
  agentId?: string;                          // 代理 ID
  model?: string;                            // 模型指定
  thinking?: string;                         // 思考模式
  runTimeoutSeconds?: number;                // 运行超时
  thread?: boolean;                          // 是否绑定线程
  mode?: "run" | "session";                  // 运行模式
  cleanup?: "delete" | "keep";               // 清理策略
  sandbox?: "inherit" | "require";           // 沙箱模式
  expectsCompletionMessage?: boolean;        // 是否期望完成消息
  attachments?: Array<{                      // 附件
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;                  // 挂载路径
};
```

#### 创建上下文

```typescript
type SpawnSubagentContext = {
  agentSessionKey?: string;          // 主代理会话键
  agentChannel?: string;             // 渠道
  agentAccountId?: string;           // 账户 ID
  agentTo?: string;                  // 目标
  agentThreadId?: string | number;   // 线程 ID
  workspaceDir?: string;             // 工作目录
};
```

#### 创建流程

```typescript
async function spawnSubagent(
  params: SpawnSubagentParams,
  context: SpawnSubagentContext
): Promise<SpawnSubagentResult> {
  // 1. 生成子会话键
  const childSessionKey = crypto.randomUUID();
  
  // 2. 检查深度限制
  const depth = getSubagentDepthFromSessionStore(context.agentSessionKey);
  if (depth >= DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH) {
    return { status: "forbidden", error: "Max subagent depth reached" };
  }
  
  // 3. 解析模型选择
  const resolvedModel = await resolveSubagentSpawnModelSelection({
    cfg,
    agentId,
    requestedModel: params.model,
  });
  
  // 4. 准备附件（如果有）
  const attachmentReceipt = await materializeSubagentAttachments({
    attachments: params.attachments,
    childSessionKey,
    attachMountPath: params.attachMountPath,
  });
  
  // 5. 构建系统提示
  const systemPrompt = await buildSubagentSystemPrompt({
    task: params.task,
    depth,
    requesterContext: await normalizeDeliveryContext(context),
  });
  
  // 6. 注册子代理运行记录
  const runId = registerSubagentRun({
    childSessionKey,
    controllerSessionKey: context.agentSessionKey,
    requesterSessionKey: context.agentSessionKey,
    task: params.task,
    cleanup: params.cleanup ?? "keep",
    spawnMode: params.mode ?? "run",
    runTimeoutSeconds: params.runTimeoutSeconds,
    expectsCompletionMessage: params.expectsCompletionMessage ?? true,
    attachmentsDir: attachmentReceipt?.dir,
  });
  
  // 7. 调用 Gateway 启动子代理
  await callGateway({
    method: "agents.run",
    params: {
      sessionKey: childSessionKey,
      agentId,
      model: resolvedModel,
      task: params.task,
      systemPrompt,
      mode: params.mode ?? "run",
      timeoutMs: params.runTimeoutSeconds 
        ? params.runTimeoutSeconds * 1000 
        : undefined,
    },
  });
  
  return {
    status: "accepted",
    childSessionKey,
    runId,
    mode: params.mode,
    attachments: attachmentReceipt?.summary,
  };
}
```

### 2. 子代理注册表

**文件**: [`subagent-registry.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-registry.ts)

#### 运行记录结构

```typescript
type SubagentRunRecord = {
  runId: string;                      // 运行 ID
  childSessionKey: string;            // 子会话键
  controllerSessionKey?: string;      // 控制器会话键
  requesterSessionKey: string;        // 请求者会话键
  requesterOrigin?: DeliveryContext;  // 请求来源
  requesterDisplayKey: string;        // 显示键
  task: string;                       // 任务描述
  cleanup: "delete" | "keep";         // 清理策略
  label?: string;                     // 标签
  model?: string;                     // 模型
  workspaceDir?: string;              // 工作目录
  runTimeoutSeconds?: number;         // 超时时间
  spawnMode?: "run" | "session";      // 生成模式
  createdAt: number;                  // 创建时间
  startedAt?: number;                 // 开始时间
  sessionStartedAt?: number;          // 会话开始时间（稳定）
  accumulatedRuntimeMs?: number;      // 累计运行时间
  endedAt?: number;                   // 结束时间
  outcome?: SubagentRunOutcome;       // 运行结果
  archiveAtMs?: number;               // 归档时间
  cleanupCompletedAt?: number;        // 清理完成时间
  cleanupHandled?: boolean;           // 清理已完成
  suppressAnnounceReason?: string;    // 抑制通知原因
  expectsCompletionMessage?: boolean; // 期望完成消息
  announceRetryCount?: number;        // 通知重试次数
  lastAnnounceRetryAt?: number;       // 最后重试时间
  endedReason?: SubagentLifecycleEndedReason; // 结束原因
  wakeOnDescendantSettle?: boolean;   // 等待子代完成后唤醒
  frozenResultText?: string | null;   // 冻结的完成结果
  frozenResultCapturedAt?: number;    // 冻结结果捕获时间
  fallbackFrozenResultText?: string;  // 回退结果
  endedHookEmittedAt?: number;        // Hook 触发时间
  attachmentsDir?: string;            // 附件目录
  attachmentsRootDir?: string;        // 附件根目录
  retainAttachmentsOnKeep?: boolean;  // 保留附件
};
```

#### 注册表管理

```typescript
// 内存中的运行记录
const subagentRuns = new Map<string, SubagentRunRecord>();

// 注册运行
export function registerSubagentRun(record: SubagentRunRecord): string {
  subagentRuns.set(record.runId, record);
  persistSubagentRuns(); // 持久化到磁盘
  return record.runId;
}

// 查询运行
export function listControlledSubagentRuns(controllerSessionKey: string) {
  return Array.from(subagentRuns.values())
    .filter(run => run.controllerSessionKey === controllerSessionKey);
}

// 清理运行
async function cleanupSubagentRun(runId: string) {
  const record = subagentRuns.get(runId);
  if (!record) return;
  
  if (record.cleanup === "delete") {
    await callGateway({
      method: "sessions.delete",
      params: { key: record.childSessionKey },
    });
  }
  
  subagentRuns.delete(runId);
  persistSubagentRuns();
}
```

### 3. 子代理通知机制

**文件**: [`subagent-announce.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-announce.ts)

#### 通知流程

```typescript
async function runSubagentAnnounceFlow(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  outcome: SubagentRunOutcome;
}): Promise<boolean> {
  const record = subagentRuns.get(params.runId);
  if (!record) return false;
  
  // 1. 捕获最新助手回复
  const latestText = await readLatestAssistantReply(params.childSessionKey);
  
  // 2. 构建通知消息
  const announceMessage = {
    role: "assistant",
    content: formatSubagentCompletion({
      task: record.task,
      label: record.label,
      resultText: latestText,
      outcome: params.outcome,
    }),
  };
  
  // 3. 解析投递目标
  const deliveryTarget = await resolveConversationDeliveryTarget({
    requesterOrigin: record.requesterOrigin,
    requesterSessionKey: record.requesterSessionKey,
  });
  
  // 4. 投递消息
  try {
    await callGateway({
      method: "messages.send",
      params: {
        ...deliveryTarget,
        message: announceMessage,
        threadBound: record.spawnMode === "session",
      },
    });
    return true;
  } catch (error) {
    if (isTransientAnnounceDeliveryError(error)) {
      // 可重试错误，加入队列
      await enqueueAnnounce({
        runId: params.runId,
        retryCount: (record.announceRetryCount ?? 0) + 1,
      });
      return false;
    }
    throw error;
  }
}
```

#### 通知重试机制

```typescript
const DIRECT_ANNOUNCE_TRANSIENT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000];

async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  let retryIndex = 0;
  for (;;) {
    try {
      return await params.run();
    } catch (err) {
      const delayMs = DIRECT_ANNOUNCE_TRANSIENT_RETRY_DELAYS_MS[retryIndex];
      if (delayMs == null || !isTransientAnnounceDeliveryError(err)) {
        throw err;
      }
      retryIndex += 1;
      await waitForAnnounceRetryDelay(delayMs, params.signal);
    }
  }
}
```

### 4. 子代理深度控制

**文件**: [`subagent-depth.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-depth.ts)

#### 深度计算

```typescript
export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig; store?: Record<string, SessionDepthEntry> }
): number {
  const cache = new Map<string, Record<string, SessionDepthEntry>>();
  const visited = new Set<string>();
  
  const depthFromStore = (key: string): number | undefined => {
    if (visited.has(key)) return undefined;
    visited.add(key);
    
    const entry = resolveEntryForSessionKey({
      sessionKey: key,
      cfg: opts?.cfg,
      store: opts?.store,
      cache,
    });
    
    const storedDepth = normalizeSpawnDepth(entry?.spawnDepth);
    if (storedDepth !== undefined) {
      return storedDepth;
    }
    
    const spawnedBy = normalizeSessionKey(entry?.spawnedBy);
    if (!spawnedBy) return undefined;
    
    const parentDepth = depthFromStore(spawnedBy);
    if (parentDepth !== undefined) {
      return parentDepth + 1;
    }
    
    return getSubagentDepth(spawnedBy) + 1;
  };
  
  return depthFromStore(sessionKey) ?? getSubagentDepth(sessionKey);
}
```

#### 深度限制

```typescript
// 默认最大深度
const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 3;

// 创建时检查
if (depth >= DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH) {
  return { 
    status: "forbidden", 
    error: `Max subagent depth (${DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH}) reached` 
  };
}
```

### 5. 子代理控制工具

**文件**: [`subagents-tool.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/tools/subagents-tool.ts)

#### 工具定义

```typescript
export function createSubagentsTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description: "List, kill, or steer spawned sub-agents",
    parameters: Type.Object({
      action: optionalStringEnum(["list", "kill", "steer"]),
      target: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      recentMinutes: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    execute: async (_toolCallId, args) => {
      const action = args.action ?? "list";
      
      if (action === "list") {
        return listControlledSubagentRuns(controller);
      }
      
      if (action === "kill") {
        return killControlledSubagentRun(target);
      }
      
      if (action === "steer") {
        return steerControlledSubagentRun(target, message);
      }
    },
  };
}
```

#### 控制操作

```typescript
// 列出子代理
function buildSubagentList(params: {
  cfg: OpenClawConfig;
  runs: SubagentRunRecord[];
  recentMinutes: number;
}): SubagentListResult {
  const now = Date.now();
  const recentThreshold = now - recentMinutes * 60_000;
  
  const active = runs.filter(run => isActiveSubagentRun(run));
  const recent = runs.filter(run => 
    run.createdAt >= recentThreshold && !active.includes(run)
  );
  
  return {
    total: runs.length,
    active: active.map(formatRunView),
    recent: recent.map(formatRunView),
    text: formatSubagentListText(active, recent),
  };
}

// 终止子代理
async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: SubagentController;
  entry: SubagentRunRecord;
}): Promise<KillResult> {
  await callGateway({
    method: "agents.kill",
    params: { sessionKey: entry.childSessionKey },
  });
  
  updateSubagentRun(entry.runId, {
    suppressAnnounceReason: "killed",
  });
  
  return {
    status: "ok",
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    text: `Killed subagent "${entry.label || entry.runId}"`,
  };
}

// 指导子代理
async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: SubagentController;
  entry: SubagentRunRecord;
  message: string;
}): Promise<SteerResult> {
  await callGateway({
    method: "messages.send",
    params: {
      sessionKey: entry.childSessionKey,
      message: { role: "user", content: message },
    },
  });
  
  return {
    status: "ok",
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    text: `Sent guidance to subagent "${entry.label || entry.runId}"`,
  };
}
```

## 生命周期事件

### Hook 支持

OpenClaw 为子代理生命周期提供专用 Hook：

```typescript
type PluginHookName =
  | "subagent_spawning"        // 子代理创建中
  | "subagent_delivery_target"  // 投递目标确定
  | "subagent_spawned"         // 子代理已创建
  | "subagent_ended";          // 子代理结束
```

#### subagent_spawning

```typescript
type PluginHookSubagentSpawningEvent = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  threadRequested: boolean;
};

type PluginHookSubagentSpawningResult =
  | { status: "ok"; threadBindingReady?: boolean; }
  | { status: "error"; error: string; };
```

#### subagent_ended

```typescript
type PluginHookSubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: "subagent" | "acp";
  reason: string;
  sendFarewell?: boolean;
  accountId?: string;
  runId?: string;
  endedAt?: number;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};
```

## 运行模式

### 1. Run 模式（默认）

```typescript
{
  mode: "run",
  cleanup: "delete" | "keep"
}
```

- 一次性任务执行
- 完成后根据 `cleanup` 策略处理会话
- 适用于独立任务

### 2. Session 模式

```typescript
{
  mode: "session",
  thread: true
}
```

- 保持会话活跃
- 支持后续对话
- 线程绑定（可选）
- 适用于持续交互场景

## 附件传递

```typescript
async function materializeSubagentAttachments(params: {
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  childSessionKey: string;
  attachMountPath?: string;
}): Promise<AttachmentReceipt | undefined> {
  if (!params.attachments?.length) return undefined;
  
  const baseDir = path.join(
    OPENCLAW_HOME,
    "subagent-attachments",
    params.childSessionKey
  );
  
  await fs.mkdir(baseDir, { recursive: true });
  
  const files: Array<{
    name: string;
    bytes: number;
    sha256: string;
  }> = [];
  
  let totalBytes = 0;
  
  for (const attachment of params.attachments) {
    const content = attachment.encoding === "base64"
      ? Buffer.from(attachment.content, "base64")
      : Buffer.from(attachment.content, "utf8");
    
    const filePath = path.join(baseDir, attachment.name);
    await fs.writeFile(filePath, content);
    
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    
    files.push({
      name: attachment.name,
      bytes: content.length,
      sha256: hash,
    });
    
    totalBytes += content.length;
  }
  
  return {
    dir: baseDir,
    summary: {
      count: files.length,
      totalBytes,
      files,
      relDir: path.basename(baseDir),
    },
  };
}
```

## 清理机制

### 自动清理

```typescript
async function cleanupSubagentRun(runId: string) {
  const record = subagentRuns.get(runId);
  if (!record || record.cleanupHandled) return;
  
  try {
    if (record.cleanup === "delete") {
      // 删除会话
      await callGateway({
        method: "sessions.delete",
        params: {
          key: record.childSessionKey,
          emitLifecycleHooks: true,
          deleteTranscript: true,
        },
      });
      
      // 删除附件
      if (record.attachmentsDir) {
        await fs.rm(record.attachmentsDir, { recursive: true, force: true });
      }
    }
    
    record.cleanupCompletedAt = Date.now();
    record.cleanupHandled = true;
    persistSubagentRuns();
  } catch (error) {
    log.error(`Cleanup failed for run ${runId}:`, error);
  }
}
```

### 孤儿恢复

```typescript
// subagent-orphan-recovery.ts
async function recoverOrphanedSubagents() {
  const runs = await loadSubagentRunsFromDisk();
  const activeGatewaySessions = await callGateway({
    method: "sessions.list",
    params: { active: true },
  });
  
  for (const run of runs) {
    if (!run.endedAt) {
      const sessionExists = activeGatewaySessions.some(
        s => s.key === run.childSessionKey
      );
      
      if (!sessionExists) {
        // 会话已不存在，标记为孤儿
        await markRunAsOrphaned(run.runId);
      }
    }
  }
}
```

## 状态管理

### 内存 + 磁盘持久化

```typescript
// 内存缓存
const subagentRuns = new Map<string, SubagentRunRecord>();

// 磁盘路径
const RUNS_FILE = path.join(OPENCLAW_HOME, "subagent-runs.json");

// 持久化
function persistSubagentRuns() {
  const data = JSON.stringify(Array.from(subagentRuns.values()), null, 2);
  fs.writeFileSync(RUNS_FILE, data);
}

// 恢复
function restoreSubagentRunsFromDisk(): Map<string, SubagentRunRecord> {
  try {
    const data = fs.readFileSync(RUNS_FILE, "utf8");
    const runs = JSON.parse(data) as SubagentRunRecord[];
    return new Map(runs.map(run => [run.runId, run]));
  } catch {
    return new Map();
  }
}
```

## 总结

OpenClaw 的子代理系统具有以下特点：

1. **分层管理**: 通过注册表统一管理所有子代理运行
2. **深度控制**: 防止无限嵌套（默认最大深度 3）
3. **灵活清理**: 支持 `delete`/`keep` 两种策略
4. **可靠通知**: 带重试机制的结果投递
5. **运行时控制**: 支持 list/kill/steer 操作
6. **附件传递**: 安全的文件传递机制
7. **生命周期 Hook**: 完整的插件扩展点
8. **持久化**: 内存 + 磁盘双重保障
9. **孤儿恢复**: 自动检测和清理孤儿运行

## 参考文件

- [`src/agents/subagent-spawn.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-spawn.ts) - 子代理创建
- [`src/agents/subagent-registry.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-registry.ts) - 注册表管理
- [`src/agents/subagent-announce.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-announce.ts) - 通知机制
- [`src/agents/subagent-depth.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-depth.ts) - 深度控制
- [`src/agents/tools/subagents-tool.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/tools/subagents-tool.ts) - 控制工具
- [`src/agents/subagent-registry.types.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-registry.types.ts) - 类型定义
- [`src/agents/subagent-orphan-recovery.ts`](file:///d:/temp/PI-Coding-Agent-OpenClaw-study/open-claw-source-code/openclaw/src/agents/subagent-orphan-recovery.ts) - 孤儿恢复
