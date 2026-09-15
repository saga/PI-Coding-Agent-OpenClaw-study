# @earendil-works/pi-protocol

用于实验性 Pi protocol 的运行时无关 routed envelope、CBOR 编码和字节流 framing。

Protocol 版本 `8` 定义了：

- 一个识别逻辑 `serverId` 的版本握手；
- 显式的 server 和 Session 请求目标；
- 具有不透明 strict-JSON 载荷的关联请求与响应；
- 请求取消、不透明订阅更新，以及带外的 attachment 变更；
- 非空的不透明错误码和有界的传输消息。

一个 server 目标包含 `{ serverId }`；一个 Session 目标包含 `{ serverId, sessionId, attachmentId }`。组合路由将一个逻辑 server、持久 Session 和实时呈现 attachment 的调用围栏起来。管理 `attach()` 和 `detach()` 不返回路由标识符；server 在带外的 `attachment` 消息中发布所选的实时路由。断开连接只会在已接纳的调用结算后释放该呈现的 attachment。

Chord 拥有这些 envelope 内部携带的载荷语义：`{ serviceId, instance?, member, args }` 调用、`$chord.service` 控制词汇表、service 目录、订阅 snapshot 与更新、service 错误码，以及用于复制状态的独立 Delta 路径 codec。`pi-protocol` 验证每个不透明载荷是 strict JSON，但不验证也不导出其 Chord 语法。客户端和 server 在 service 适配器边界通过 `@earendil-works/chord` 解析这些值。

Session 目录状态、管理结果、transcript、模型、plugin 以及所有其他应用值都保持为不透明的 service 数据。真正的 `Session` 和 `AgentHarness` 保持进程本地。Server 和 Session 调用会不透明地路由到其所属 provider，在那里由 Chord 和应用程序验证并调用它们。

Server 和 worker 生命周期有意位于此公共 protocol 之外。实验性本地 coordinator 只是一个不透明的消息 router；每个可替换的 server 进程拥有私有的生命周期 protocol。

每个线上帧由一个四字节无符号大端载荷长度后跟一个确定长度的 CBOR 项组成。`encodeClientMessage()` 和 `encodeServerMessage()` 验证并编码完整帧。`ClientMessageDecoder` 和 `ServerMessageDecoder` 接受任意的流分片与合并。

```ts
import {
  PROTOCOL_VERSION,
  encodeClientMessage,
  ServerMessageDecoder,
  type ClientHello,
} from "@earendil-works/pi-protocol";

const hello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
transport.send(encodeClientMessage(hello));

const decoder = new ServerMessageDecoder({ maxFrameLength: 1024 * 1024 });
for (const message of decoder.push(incomingChunk)) handleServerMessage(message);
decoder.end();
```

所有 envelope schema 都会拒绝未知的对象属性，并且 codec 会递归地拒绝非 JSON 的不透明载荷，包括非有限数字、字节数组、`undefined`、prototype 和循环。Envelope 违规、格式错误的 CBOR 和无效 framing 都会抛出 `ProtocolValidationError`。特定于载荷的适配器必须在解码后执行自己的语义验证。传输必须保持字节顺序。对等端认证和已认证的 service Context 并未由实验性传输实现。

默认限制为每个 CBOR 载荷/帧 16 MiB、1,000,000 个数组元素或 map 条目，以及 64 层嵌套项级别。该 protocol 是实验性的，不提供兼容性保证。
