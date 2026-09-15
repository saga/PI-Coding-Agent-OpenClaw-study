# @earendil-works/pi-server

用于新的持久 Session 和 Agent Harness 接口的实验性本地 server。

当前切片支持 server 范围和 Session 范围的 facet-service 路由，以及多呈现 attachment。`RoutedServerServiceHost.attachClient()` 创建一个连接范围的 server service 端点，并具有狭窄的 attachment 管理能力。`RoutedSessionHandle.attachClient()` 返回一个呈现范围的 Session 能力。其 `invokeService()` 将一个不透明的 service/member envelope 转发到所选的 Session 端点；server 验证 attachment 路由，但不加载 facet 契约。

- server service 调用和订阅通过连接的 `RoutedServerServiceAttachment` 不透明地路由；
- 应用拥有的 `SessionDirectory` 将私有目录投影为复制的、呈现安全的状态；
- 应用拥有的 `SessionManagement` 创建、移除、attach 和 detach Session，而不在业务结果中暴露路由 ID；
- attachment 变更在 router 安装或清除实时路由后以带外方式发布；
- Session service 调用通过 `invokeService` 路由，且没有服务端业务载荷解码；
- service 订阅更新保持限定在发起请求的 attachment 范围内；
- 诸如 transcript 之类的应用观察结果作为普通 service 状态路由，没有 server 拥有的业务 schema。

一个 Session 可以有多个呈现 attachment。从一个连接重复 `attach` 是幂等的；每次成功的 attachment 都有一个由 server 生成的 `attachmentId`，仅作为路由控制数据传递。Session 请求携带 `{ serverId, sessionId, attachmentId }`，server 会拒绝陈旧或不匹配的路由。丢失连接会拒绝其本地响应，但只有在已接纳的 service 调用结算后才会释放其 attachment。宿主决定零呈现需求和 worker 本地 Harness 活动何时允许 worker 退役。Server 关闭会关闭每个已路由的 Session 句柄，释放其 worker 和 Session writer 所有权。

```ts
import { randomUUID } from "node:crypto";
import { MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  type RoutedServerServiceHost,
  type RoutedSessionHandle,
  type ServerHost,
  SessionAmbiguousError,
  SessionNotFoundError,
} from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";

async function startServer(
  serverServices: RoutedServerServiceHost,
  openRoutedSession: (session: Session) => Promise<RoutedSessionHandle>,
) {
  const sessions = new MemorySessionRepo();
  const host: ServerHost = {
    serverServices,
    async resolveSession(sessionId, context) {
      const matches = (await sessions.list(undefined, context))
        .filter((metadata) => metadata.id === sessionId);
      if (matches.length === 0) {
        throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
      }
      if (matches.length > 1) throw new SessionAmbiguousError();
      return matches[0];
    },
    async openSession(metadata, context) {
      const session = await sessions.open(metadata, context);
      try {
        return await openRoutedSession(session);
      } catch (error) {
        try {
          await session.close(context);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Harness creation and Session cleanup failed",
          );
        }
        throw error;
      }
    },
  };

  const serverId = randomUUID();
  const server = createUnixServer(host, {
    serverId,
    path: getUnixSocketPath(serverId, "/run/user/1000/pi"),
  });
  await server.start();
  return server;
}
```

应用程序提供必需的 server service host、有界的 Session 解析器和已路由的 Session 工厂。Session 发现和管理是应用拥有的 service；protocol server 在路由 attachment 时只向解析器询问 metadata。宿主拥有获取 worker 本地 Session 和 Harness 的职责。失败会在该 worker 中清理。无论是打开的 JavaScript Session 还是 Harness 都不会跨越进程边界。

`serverId` 是由启动器提供的逻辑标识，而非 socket 地址。Unix 预设需要显式的物理 `path`；`getUnixSocketPath()` 从调用者选择的目录派生一个。选择一个简短、私有的运行时目录，而不是从无界的 home 目录路径派生路由。长期运行的启动器在替换 server 进程时可以重用相同的 ID 和 path。

`Server` 通过 `ServerListener` 组合传输；对等端认证仍然是应用策略，且未由实验性 Unix 传输实现。Unix 子模块提供 `createUnixListener()` 和 `createUnixServer()`。低层 routed-envelope 验证、CBOR 和 framing 来自 `@earendil-works/pi-protocol`；Chord 拥有 service 控制解析、错误码、snapshot 与更新，以及每个订阅的复制状态 encoder。

Server 和 worker 生命周期在公共 Pi protocol 之外管理。可替换的应用 server 将连接 attachment 转换为私有需求更新；worker 将带代次标记的需求与权威 Harness 活动结合起来。实验性 coordinator 只提供稳定的路由，并报告通用的 server 代次连接变更。
