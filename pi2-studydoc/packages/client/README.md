# @earendil-works/pi-client

用于实验性 Pi service protocol 的传输无关客户端。

```ts
import { Client, type ByteTransportFactory } from "@earendil-works/pi-client";

const transportFactory: ByteTransportFactory = async (handlers) => {
  // Connect using WebSocket, Unix socket, or another ordered byte transport.
  return {
    async send(chunk) {
      // Deliver bytes in invocation order and honor backpressure.
    },
    close() {},
  };
};

const client = await Client.connect({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory,
});
const result = await client.request(
  { serverId: client.hello.serverId },
  { serviceId: "example.service", member: "read", args: [] },
);
```

客户端会验证物理端点报告的正是预期的逻辑 `serverId`。Server 范围的请求携带该 ID，而每个 Session 请求都携带完整的实时目标 `{ serverId, sessionId, attachmentId }`。组合的持久地址可防止跨 server 或跨 session 的错误路由；由 server 生成的 attachment ID 会拒绝切换或重新 attach 之后的延迟帧。

类型化的 server 和 Session API 由应用拥有的 Chord service binding 提供。`createClientServiceTransport()` 将惰性解析的 server 或 Session 路由适配为 Chord 传输；`request()` 和 `subscribeService()` 仍是其低层原语。客户端使用 Chord 的 service 控制解析器和每订阅状态解码器；`pi-protocol` 只验证 routed envelope 和 strict-JSON 边界。一个 service 订阅返回完整的 provider snapshot；binding 安装它，然后调用 `start()` 以释放在 hydration 期间缓冲的更新。`Client` 会按顺序应用带外的 attachment 变更，但有意不构造类型化的 service 代理，也不解释应用契约。

诸如 coding agent 的 `Transcript` 之类的应用观察 API 是普通的 Chord service。客户端不解释它们的 snapshot 或更新。

在断开连接或 dispose 时，挂起的请求会在本地被拒绝，但已接受的工作可能仍在远端完成，之后 attachment 才会被释放。客户端会清除其实时 attachment 路由。它从不自动重连或重放请求。断开连接后，调用 `reconnect()`，再次通过应用的管理 service 进行 attach，并只显式重复已知安全的 operation。

实验性本地 coordinator 只提供稳定的端点并转发流量。可替换的 server 进程在公共客户端 protocol 之外拥有 Session 和 worker 生命周期。

按如下方式调用传输 handler：

- `handlers.onData(chunk)` 用于入站字节；
- `handlers.onClose()` 用于有序的终端关闭；
- `handlers.onError(error)` 用于传输失败。

传输工厂为每次尝试创建一个全新的已认证连接。请求按 ID 关联，server 失败会以 `ServerError` 暴露。

## Unix 域 socket

Node.js 和 Bun 使用者可以使用单独的 Unix 传输：

```ts
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const client = new Client({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory: createUnixTransportFactory({ path: "/tmp/pi.sock" }),
});
await client.connect();
```

Unix 发现会扫描显式的物理路由目录，从其文件名派生每个预期的 server ID，并通过现有的握手验证它：

```ts
import { discoverUnixServers } from "@earendil-works/pi-client/unix";

const routes = await discoverUnixServers({ directory: "/run/user/1000/pi" });
// [{ serverId: "...", path: "/run/user/1000/pi/<serverId>.sock" }]
```

格式错误的条目、非 socket、陈旧或无响应的端点以及 server-ID 不匹配都会被忽略。发现是只读的，并且最多并发探测 16 个 socket。意外的文件系统和 socket 错误会使发现失败。传入 `timeoutMs` 可覆盖默认探测超时。

`ClientOptions.maxFrameLength` 限制 protocol 载荷。`maxPendingBytes` 限制排队的 Unix 传输输出。在两个对等端上配置匹配的限制。
