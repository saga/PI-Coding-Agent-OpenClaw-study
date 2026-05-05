# 《为什么现在的LLM都是Decoder-only的架构？》FAQ

> **作者**：苏剑林 | **日期**：2023-03-20 | **来源**：[科学空间](https://www.kexue.fm/archives/9547)

上周笔者写了[《为什么现在的LLM都是Decoder-only的架构？》](https://www.kexue.fm/archives/9529)，总结了一下我在这个问题上的一些实验结论和猜测。在几个平台上，陆陆续续收到了读者的一些意见或者疑问，总结了其中一些有代表性的问题，做成了本篇FAQ。

## 回顾

在原文中，笔者对GPT和UniLM两种架构做了对比实验，猜测了如下结论：

1. 输入部分的注意力改为双向不会带来收益，Encoder-Decoder架构的优势很可能只是源于参数翻倍；
2. 双向注意力没有带来收益，可能是因为双向注意力的低秩问题导致效果下降。

所以基于这两点推测，我们得到结论：**在同等参数量、同等推理成本下，Decoder-only架构是最优选择。**

## 问答

**问题1：** $n\gg d$ 似乎不成立？

**答：** $n$ 是序列长度，$d$ 是head_size不是hidden_size，在多头注意力中，head_size = hidden_size / heads，比如BERT base中head_size = 768/12 = 64，而预训练长度 $n$ 一般为512，所以 $n\gg d$ 大致上都是成立的。

**问题2：** BERT和初代GPT参数量一样，为什么BERT在理解任务上更好呢？

**答：** BERT和GPT不仅架构不一样，预训练任务也不一样，无法公平比较。原文最后笔者已经给出了一个利用GPT的思想改进BERT的思路，并且初步的实验显示它很可能会优于BERT。

**问题3：** "双向注意力的低秩问题带来的效果下降"波及范围也太广了吧？

**答：** 我们并没有说"双向注意力在任何任务上都非常糟糕"。原文的实验结论是"在生成任务上的Encoder引入双向注意力似乎不会带来收益"，结论的条件是很明确的。

**问题4：** decoder模型和encoder-decoder模型都有的现象，跟原文结论不矛盾。我们只是初步推测"在生成任务上的Encoder引入双向注意力似乎不会带来收益"，并没有说Encoder带来的参数翻倍不会带来收益。

**问题5：** 你的结论跟T5、UL2的结论似乎矛盾？

**答：** UL2的结论是Encoder-Decoder效果更好，但Encoder-Decoder和Decoder-only不是同等参数量的。跟T5的实验结果（Table 2）确实有些冲突，但对T5的实验结果也存疑，因为差距实在太大感觉不合理。

**问题8：** 会不会还有一个原因，下三角或上三角mask更能够把位置编码的信息处理得更好？

**答：** 这确实是一个很新颖的观点。三角形mask除了带来秩的提升外，确确实实也带来了位置识别上的优势，它打破了transformer的置换不变性，直接引入了从左往右的序，所以甚至不加位置编码都行。也许两者都是起作用的原因。

## 小结

本文对上一篇文章部分读者提出的一些疑问做了回答。

---

**转载地址**：https://www.kexue.fm/archives/9547

**引用格式**：

苏剑林. (Mar. 20, 2023). 《《为什么现在的LLM都是Decoder-only的架构？》FAQ》[Blog post]. Retrieved from https://www.kexue.fm/archives/9547

```bibtex
@online{kexuefm-9547,
  title={《为什么现在的LLM都是Decoder-only的架构？》FAQ},
  author={苏剑林},
  year={2023},
  month={Mar},
  url={\url{https://www.kexue.fm/archives/9547}},
}
```
