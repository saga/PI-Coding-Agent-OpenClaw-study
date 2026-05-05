# Transformer升级之路：21、MLA好在哪里?（下）

> **作者**：苏剑林 | **日期**：2025-07-10 | **来源**：[科学空间](https://www.kexue.fm/archives/11111)

在文章[《Transformer升级之路：20、MLA好在哪里?（上）》](https://www.kexue.fm/archives/10907)中，我们对MLA相比常见MHA、GQA、MQA的一些变化分别做了消融实验，其中的变化包括"增大head_dims"、"Partial RoPE"和"KV共享"，实验的初步结果是这三个变化很可能都是MLA效果优异的原因。

本文我们将从一个更加偏理论的角度出发，来理解MLA的成功之处。

## 部分旋转

首先，我们把最终的断言放在前面：

> 在相同训练成本和推理成本下，MLA可能是效果最好的Full Attention变体。

MLA之所以能够表现出色，有一个非常大的前提，那就是部分旋转的Partial RoPE效果不逊色于甚至可能优于完全体的RoPE。这里的Partial RoPE可以有两种含义：一是我们对Attention的Q、K加RoPE时，可以只对小部份维度加，剩下的维度保持不变；二是我们可以考虑层间RoPE与NoPE交替出现，并且NoPE的层可以占多数。

说白了，RoPE可以只加"一点点"，但不能不加，完全不加的话效果不行。如果需要理论，笔者比较认同[《Transformer升级之路：18、RoPE的底数选择原则》](https://www.kexue.fm/archives/10847)的解释，大致意思是Partial RoPE使得检索结果更兼顾位置与语义。

"Partial RoPE效果不差"的结论，允许我们把Attention的主要计算复杂度放到NoPE部分上，这提供了更大的腾挪空间，MLA便是得益于此。

## 键值共享

Full Attention的变化大致上是从MHA、MQA、GQA然后到MLA，虽然MQA可以看作是GQA的特例，但按时间顺序来说确实是GQA在后。在MLA之后，还出现了MFA、TPA两个变体。这些变体本质上都是在尽量保持效果的前提下，尽可能压榨KV Cache以提高生成速度。

简单来说，Attention模型的复杂度可以分训练、Prefill和Decoding三部分，其中训练和Prefill是相似的，所以本质上是Prefill和Decoding两部分。Decoding是指Token by Token的生成阶段，它可以通过KV Cache机制来加速，但同时也导致了KV Cache大小几乎是Decoding速度的唯一瓶颈。

所以，压缩KV Cache就是提高Decoding速度。现在问大家一个问题：在NoPE背景下，给定KV Cache大小后，效果最好的Attention是什么呢？如果不考虑参数量差异，只在单层MHA/GQA/MQA内讨论，那么答案将会是：

> 一个head_dims等于KV Cache大小、K和V共享的MQA。

看上去是不是让人意外？其实不难理解。因为MHA、MQA都可以看成是GQA的一个特例，所以我们只需要分析GQA，GQA可以重新表示成一个K、V拼接起来的模型：

$$\underbrace{[k_i^{(1)}, \cdots, k_i^{(g)}, v_i^{(1)}, \cdots, v_i^{(g)}]}_{c_i \in \mathbb{R}^{g(d_k + d_v)}} = x_i \underbrace{[W_k^{(1)}, \cdots, W_k^{(g)}, W_v^{(1)}, \cdots, W_v^{(g)}]}_{W_c \in \mathbb{R}^{d \times g(d_k + d_v)}}$$

这里 $g(d_k + d_v)$ 正是单个Token的KV Cache总大小。接着我们算Attention的时候，c到k,v的变换分别吸收到 $W_q$ 和 $W_o$ 那边去，那么就得到了一个K、V都是c的MQA。所以说，"head_dims等于KV Cache大小、K和V共享的MQA"，实际上是给定KV Cache大小后MHA/GQA/MQA的"超集"，那么它自然是理论上效果最好的选择。

## 双重投影

综上所述，如果我们想要在相同Decoding速度下效果最优，那么应该训练一个指定head_dims的、KV共享的MQA，比如约定KV Cache不超过512，那么head_dims=512的、KV共享的MQA就是最佳选择。事实上，MLA在Decoding阶段正是KV共享的MQA（NoPE部分），这就是它走在正确方向上的体现之一。

然而，将head_dims升到512，Decoding是没问题，但训练和Prefill都很难接受，因为它们俩的瓶颈是计算，而影响计算速度的主要因素是num_heads和head_dims。为了保证效果，num_heads变动的空间不大，因此head_dims大小可以说是计算量的唯一指标，head_dims升到512意味着计算量要增加到原来的4倍（相比head_dims=128）。

现在再来问大家一个问题：同样在NoPE背景下，给定num_heads和head_dims后，效果最好的Attention是什么呢？这个问题的答案我相信大家都能接受，那就是MHA，因为它限制最少。所以，单从训练和Prefill成本来看，我们希望的是训练一个head_dims=128的MHA。

怎么调和Prefill与Decoding这两个不同的期望呢？这就是MLA的"大招"了，它通过两步投影得到K、V：先将输入投影到单个512维的向量，然后将该向量投影到多个128维的向量，然后利用"Attention + NoPE"固有的恒等变换性质，可以让模型在MHA-128和MQA-512间自由切换。

## 总而言之

我们将前面的推理逻辑做个总结：

1. **大前提**：Partial RoPE的效果不差于甚至可能优于RoPE，这使得我们可以把主要精力放在NoPE上；
2. **Decoding**主要瓶颈是KV Cache，理论效果最优的模型是head_dims=KV Cache、KV共享的MQA；
3. **训练和Prefill**的主要瓶颈都是head_dims，理论效果最优的模型是head_dims为期望值的MHA；
4. 在NoPE前提下，Attention具有恒等变换性质，可以通过LoRA来尽可能地兼顾两个理想方向，这正好是MLA所做的。

剩下的，就是给K拼接一个共享的低维RoPE，以最小的成本给MLA补充上位置信息，同时还"一箭双雕"：拼接RoPE的做法暗合了"Partial RoPE"，同时也增加了head_dims，这跟上一篇文章的结论相符。换句话说，有意或者无意之中使用了Partial RoPE和增加了head_dims，是MLA在极致压缩之下还能媲美MHA的主要原因。

从MQA的角度看，MLA是给Q加了rank=128的LoRA；从MHA的角度看，MLA是给K、V加了rank=512的LoRA。可以说，MLA是一场NoPE结合LoRA、MHA结合MQA的极致"魔术秀"，成功实现了Prefill和Decoding的"双向奔赴"。

## 补充讨论

前面我们都在围绕MHA、GQA、MQA和MLA讨论，这一节我们来简单聊聊两个比较少谈及的Attention变体：TPA和MFA。

**TPA**全称是Tensor Product Attention，实际上它是一个介乎GQA和MLA的中间产物。我们以目标KV Cache=512为例，TPA先投影得到一个512维向量，然后reshape为(4, 128)，然后分成两个(2,128)分别代表K Cache和V Cache。到目前为止，TPA的做法都跟GQA2-128一致。接下来，TPA借鉴了MLA的思想，将(2,128)的K/V重新投影成Multi-Head，但它不是像MLA那样整个向量投影，而是沿着"2"所在的维度投影。显然，这样TPA的上限是不如MLA直接从整个512维向量出发来投影的。TPA这样设计大体上是为了兼容RoPE，然而在Partial RoPE不逊色甚至还可能更优的背景下，兼容RoPE就有点啼笑皆非的感觉了。

**MFA**全称是"Multi-matrix Factorization Attention"，它实际上就是一个带有Q-LoRA的、head_dims=256的MQA。看到这个配置，是不是有点熟悉？因为这配置跟我们上一篇文章的结论完全吻合——增大head_dims到256来提升MQA的效果，并且KV Cache跟MLA接近，同时通过Q-LoRA来控制参数量。所以，MFA能"打"MLA，笔者并不意外。

## 文章小结

本文在上一篇文章的实验结果基础上，给出一个偏理论的思考过程，以论证MLA在一定范围内的最优性。总的来说，在Partial RoPE的背景下，MLA似乎是一个非常难以超越的Attention变体。

---

**转载地址**：https://www.kexue.fm/archives/11111

**引用格式**：

苏剑林. (Jul. 10, 2025). 《Transformer升级之路：21、MLA好在哪里?（下）》[Blog post]. Retrieved from https://www.kexue.fm/archives/11111

```bibtex
@online{kexuefm-11111,
  title={Transformer升级之路：21、MLA好在哪里?（下）},
  author={苏剑林},
  year={2025},
  month={Jul},
  url={\url{https://www.kexue.fm/archives/11111}},
}
```
