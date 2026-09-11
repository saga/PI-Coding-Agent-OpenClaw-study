# 决策：不提供显式的 text append/truncate API

**状态：已关闭。** 不要添加 `appendText`、显式 truncate、text 专用的 dirty-node kind，或 proxy-to-tracker 查找机制。

## 为什么曾考虑它

tracker 标记脏路径，并在 `flush()` 时将它们与其已接受的基线比较。对于一个增长中或滚动的字符串，确认这种关系可能会扫描保留下来的字符串，即便生产者已经知道它 append 或逐出了文本。

最初的基准测试让这件事看起来很昂贵，因为它的 append 快速路径使用了 `after.startsWith(before)`。V8 逐字符遍历生产者的 cons string。生产环境的 Chord 现在使用：

```ts
if (after.length > before.length && after.slice(0, before.length) === before) {
  // emit append
}
```

切片会扁平化一次，比较使用原生字符串路径。flush 时脏跟踪也移除了原型中保留 op 的放大效应。

## 本地确认

测量于 2026-09-01，针对 `origin/dev` 的 `1a7bc80e7`，在 Apple M5 Max 上的 Node 26.0.0 下直接使用 `packages/chord/src/delta/index.ts`。每个工作负载使用 3,000 次预热，随后是 11 个样本，每个样本 10,000 次 mutation-plus-flush 迭代；第二个进程复现了该结果。

| 工作负载 | 中位 µs/flush，run 1 | 中位 µs/flush，run 2 |
| --- | ---: | ---: |
| 200 KB assistant 字符串，append 8 个字符 | 18.68 | 17.81 |
| 50 KB 滚动窗口，滑动 32 个多样化字符 | 2.46 | 2.43 |
| Transcript push，一个小 entry | 0.74 | 0.78 |

assistant tracker 从 200,000 个多样化字符开始，append `" abcdef"`，并在每次 append 后 flush。rolling tracker 从 50,000 个多样化字符开始，然后每次 flush 都使用一个不同的 32 字符 `chunk:<base36 index>:durable-stream` 值来赋值 `text.slice(32) + chunk`；每次 flush 都断言发出 `t` + `a`。transcript tracker push `{ id: "e<index>", text: "message <index>" }` 并断言每次 flush 一个 `p`。Setup 和垃圾回收都在每个计时循环之外。

在每秒 100 次 assistant 更新的情况下，增长字符串的情况消耗约 1.8 ms/s，约为一个核心的 0.18%。测得的滚动窗口成本本身太小，不足以证明那个被放弃的显式 API 是合理的。

## 为什么该 API 被拒绝

原型需要 text 专用的 dirty-node 状态、proxy-to-tracker 查找、重复 append/drop 折叠，以及针对后续整值替换的交互规则。它产生了微妙的静默失败：一个实现会落到普通 differ 上而测试仍然通过，另一个在 drop 触及更早的 append 时发生漂移。

这种复杂度不足以证明节省那点微秒是合理的，这些微秒低于周围的 replication、isolation 和 rendering 成本。保留普通的字符串 mutation 和通用的 Chord op 词汇表。

只有当生产 profile 显示 delta flush 时间在真实工作负载中占可观比例时才重新开启。先重新测量通用快速路径；修复那里的回归比添加一个生产者专用的 API 更便宜也更安全。
