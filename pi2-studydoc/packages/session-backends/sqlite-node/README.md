# @earendil-works/pi-session-backend-sqlite-node

用于 `@earendil-works/pi-agent-core` 的 Node `node:sqlite` Session backend。

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";

const repository = new SqliteSessionRepo({
  directory: "/var/lib/pi/sessions",
  databaseFactory: createNodeSqliteFactory(),
});

const session = await repository.create({}, BACKGROUND_CONTEXT);
const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
await main.appendMessage(
  { role: "user", content: "hello", timestamp: Date.now() },
  BACKGROUND_CONTEXT,
);
await session.close(BACKGROUND_CONTEXT);
await repository.close(BACKGROUND_CONTEXT);
```

默认布局在 `directory` 下为每个 Session 创建一个文件。仅包含 ASCII 字母、数字、`_` 和 `-` 的 ID 保留 `{sessionId}.sqlite`；其他所有 ID 都使用以其 UTF-16 码元表示的、带 `~` 前缀的 base64url 编码。持久 ID 保持不变，返回/列出的 metadata 包含规范物理路径。传入 `databasePath` 可将多个 Session 放在一个受支持的共享容器中；其父目录会在需要时创建。

数据库工厂区分有意的创建、不创建读写打开和不创建只读打开。Session 的 `open()` 和删除会拒绝配置的 repository 之外的 metadata，并且从不创建缺失的数据库。列出是只读且尽力而为的。Fork 有意允许外部的源 metadata 路径：它以只读方式读取那个确切存在的容器，并且从不替换具有相同 ID 的活动本地 Session。

由宿主生命周期（而非此 backend）保证每个 Session 只有一个可写所有者。在另一个进程中直接打开同一 Session 进行写入是不受支持的。repository 会拒绝一个 ID 上重叠的本地 create/open/fork/delete 所有权，但不实现任何跨进程 lease、lock、fence、heartbeat 或 takeover。宿主必须在删除之前关闭 worker。

对在同一 repository 中打开的源进行 fork 时，会将其 snapshot 排入该源的 commit 队列。任何其他源，包括由活动 Session worker 保持打开的那个，都使用独立的只读连接和一个延迟的 WAL 事务；后续 worker 提交可以在该 snapshot 保持打开时完成。共享容器删除只移除所选 Session 的行。Repository 关闭会等待每一次打开的 Session 清理尝试，然后再报告错误。该 package 不导出 search service 或 FTS 索引；搜索是单独的 S3 投影。
