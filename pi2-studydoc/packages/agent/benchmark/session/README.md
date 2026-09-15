# Session 基准测试

从 `packages/agent` 运行这些命令。

这些基准测试使用确定性的合成数据，并不声称能重现生产流量。存储和 repository fork 数据集是用户消息条目的线性 Branch，具有固定的 256 字节文本载荷、确定性的 ID 和 250 条目的种子事务。Repository 目录数据集包含确定性的已关闭 session。

## 计时

计时套件对 `storage-targets.ts` 和 `session-repo-targets.ts` 中的每个目标运行场景。读取场景为每个 backend/数据集复用一个不可变 fixture，并在计时前对其结果验证一次。每次预热和被测写入都针对独立准备的 fixture 运行一次，因此条目数、序列号和持久产物都从等价状态开始。各实现注册在同一个 Vitest 套件下，因此额外的 backend 可直接比较。

存储写入涵盖单条消息、一个 100 条消息的事务，以及对一个 1k 条目合成 Branch 的混合 message/register/usage 追加。Repository 场景涵盖创建空 session、打开或删除已关闭的空 session、列出 100、1k 和 10k 个已关闭 session，以及对打开的 1k 和 10k 条目源 session 的当前 Branch 进行 fork。Fixture 准备、事务生成和验证都发生在被测回调之外。

```sh
npm run bench:session:timing
npm run bench:session:timing -- -t "scan latest"
```

## 加载占用

内存 profile 为每个 backend/数据集组合启动一个强制 GC 的全新 Node.js 进程。其基线在生成和摄取数据集之前记录，因此结果包含保留的载荷数据和 backend 结构。临时生成数据应在最终读数之前收集，而 RSS 仍可能反映分配器增长。

```sh
npm run bench:session:memory
```

## 存储分配采样

分配 profile 会预构建所有事务，然后对提交它们期间所做的分配进行采样。这排除了合成载荷生成，并报告估计的累计已分配字节数（包括后来被回收的对象），以及最大的被采样分配点。V8 采样是近似的，不报告精确的对象数量。

```sh
npm run bench:session:allocations
```

计时结果不是 CI 性能门禁。请在原本空闲的机器上运行它们，并比较在相同硬件和 Node.js 版本上产生的结果。
