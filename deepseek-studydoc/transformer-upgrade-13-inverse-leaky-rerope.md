# Transformer升级之路：13、逆用Leaky ReRoPE

> **作者**：苏剑林 | **日期**：2023-08-14 | **来源**：[科学空间](https://www.kexue.fm/archives/9728)

上周在[《Transformer升级之路：12、无限外推的ReRoPE？》](https://www.kexue.fm/archives/9708)中，笔者提出了ReRoPE和Leaky ReRoPE，诸多实验结果表明，它们能够在几乎不损失训练效果的情况下免微调地扩展LLM的Context长度，并且实现了"longer context, lower loss"的理想特性，此外跟NTK-aware Scaled RoPE不同的是，其中ReRoPE似乎还有表现出了无限的Context处理能力。

总之，ReRoPE看起来相当让人满意，但美中不足的是会增加推理成本，具体表现为第一步推理需要算两次Attention，以及后续每步推理需要重新计算位置编码。本文试图通过在训练中逆用Leaky ReRoPE的方法来解决这个问题。

## 回顾

让我们不厌其烦地重温一下：RoPE形式上是一种绝对位置编码，但实际达到的效果是相对位置编码，对应的相对位置矩阵是一个下三角矩阵，每个位置的值是 $i-j$。

为了在保留局域性的同时避免Long Context导致位置越界问题，Leaky ReRoPE将推理阶段的相对位置矩阵改为：在窗口 $w$ 内使用步长1，在窗口外使用步长 $1/k < 1$。其中 $w$ 是窗口宽度，大概取训练长度的 $1/4$ 到 $1/2$，$k$ 用来调节可处理的最大长度，一般使得 $w+(L-1-w)/k$ 不超过训练长度的一半为佳。至于ReRoPE，则是直接取了 $k\to\infty$ 的极限：窗口外的所有位置都映射到 $w$。

## 反转

从上一篇的评测结果来看，作为一种免训练的外推方案，ReRoPE和Leaky ReRoPE的效果都是相当让人满意的，既没有损失训练长度内的效果，又实现了"Longer Context, Lower Loss"。唯一美中不足的是，它们的推理速度相比原本的Attention来说是变慢的，并且目前尚不兼容Flash Attention等加速技术。

那么，能否反过来呢？ReRoPE/Leaky ReRoPE在训练阶段是正常速度的RoPE，推理阶段则是变慢了，反过来也就是说：能否让训练阶段变慢，让推理阶段变为常规的RoPE？可能有读者疑惑：为什么会想要让训练阶段变慢？训练成本不是更高吗？这是因为ReRoPE/Leaky ReRoPE是一种长度外推方法，场景是"Train Short, Test Long"，训练速度的变慢是短期的、可控的，推理速度的变慢才是长期的、难顶的，所以相较之下，如果是同等程度的变慢的话，我们更愿意将变慢的部分放到训练阶段。

让我们再看一下Leaky ReRoPE，它在训练阶段的相对位置矩阵是步长为1的，推理阶段则在 $w$ 的窗口内使用1的步长，在窗口外使用 $1/k<1$ 的步长，换句话说，差别是推理阶段窗口外使用更小的步长。如果我们反过来，在训练阶段使用Leaky ReRoPE，并让它窗口外的步长大于1，那么按照"推理阶段窗口外使用更小的步长"的原则，推理阶段窗口外是否就可以使用等于1的步长，从而退化为RoPE了？

笔者将以上想法称之为"InvLeaky ReRoPE（Inverse Leaky ReRoPE）"。事不宜迟，我们马上做实验测试。

## 实验

继续之前的"GAU + Deep Norm + Tiger + 语言模型"实验组合，在训练阶段使用 $k=1/16, w=128$ 的Leaky ReRoPE，在推理阶段使用正常的RoPE，测试结果如下：

| 测试长度 | 512(训练) | 4096(重复) | 4096(不重复) |
|----------|-----------|------------|--------------|
| Baseline | 49.41%    | 24.17%     | 23.16%       |
| Baseline-log n | 49.40% | 24.60% | 24.02%  |
| NTK-RoPE-fixed | 49.41% | 51.86% | 39.61% |
| NTK-RoPE-log n†-fixed | 49.41% | 55.94% | 41.11% |
| NTK-RoPE-log n-fixed | 49.40% | 62.85% | 44.14% |
| NTK-RoPE-mixed | 49.41% | 53.09% | 40.12% |
| NTK-RoPE-log n†-mixed | 49.41% | 59.11% | 42.38% |
| NTK-RoPE-log n-mixed | 49.40% | 68.91% | 45.41% |
| ReRoPE-w256 | 49.41% | 77.90% | 48.48% |
| ReRoPE-w256-log n† | 49.41% | 82.40% | 48.85% |
| ReRoPE-w256-log n | 49.40% | 85.12% | 49.07% |
| InvLeaky ReRoPE-w128-log n | 49.38% | 82.25% | 48.32% |
| InvLeaky ReRoPE-w128-b8-log n | 49.62% | 81.15% | 48.85% |
| HFWA | 48.70% | 80.84% | 48.15% |

其中b8是指RoPE的频率底数从10000换成了80000。可以看到，"Leaky ReRoPE → RoPE"的InvLeaky ReRoPE虽然效果上不如"RoPE → ReRoPE/Leaky ReRoPE"，但依然胜过了HFWA，并且由于推理阶段是常规的RoPE，可以套用现成的加速技术，因此依然是有相当竞争力的。此外，笔者对 $k,w,b$ 等参数做了一些简单的调参，发现最优解基本上就是以上两个组合了，即"$k$ 设置为'扩展倍数的2倍的倒数'、$w$ 设置为训练长度的 $1/4$、$b$ 可选乘以扩展倍数"。

那么，InvLeaky ReRoPE对训练速度有多大影响呢？在上述实验中，模型是1亿参数量，训练长度是512，每1000步的训练时间从330秒增加到了350秒，增加不到10%，当然这里边有GAU的原因，因为GAU是单头的注意力，本就比多头注意力快。如果多头注意力或者训练长度更长的话，增加幅度应该会大一些，但目测应该不超过50%都是可以接受的。

## 小结

本文提出了Leaky ReRoPE的"逆用"做法，通过在训练阶段使用更大步长的Leaky ReRoPE，使得推理阶段可以退回常规的RoPE，从而可以保持推理速度不变，实验结果显示这种做法还是有一定的竞争力的。

---

**转载地址**：https://www.kexue.fm/archives/9728

**引用格式**：

苏剑林. (Aug. 14, 2023). 《Transformer升级之路：13、逆用Leaky ReRoPE》[Blog post]. Retrieved from https://www.kexue.fm/archives/9728

```bibtex
@online{kexuefm-9728,
  title={Transformer升级之路：13、逆用Leaky ReRoPE},
  author={苏剑林},
  year={2023},
  month={Aug},
  url={\url{https://www.kexue.fm/archives/9728}},
}
```
