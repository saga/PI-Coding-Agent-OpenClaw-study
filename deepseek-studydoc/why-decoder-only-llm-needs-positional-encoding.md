# Decoder-only的LLM为什么需要位置编码？

> **作者**：苏剑林 | **日期**：2024-09-01 | **来源**：[科学空间](https://www.kexue.fm/archives/10347)

众所周知，目前主流的LLM，都是基于Causal Attention的Decoder-only模型，而对于Causal Attention，已经有不少工作表明它不需要额外的位置编码（简称NoPE）就可以取得非平凡的结果。然而，事实是主流的Decoder-only LLM都还是加上了额外的位置编码，比如RoPE、ALIBI等。

那么问题就来了：明明说了不加位置编码也可以，为什么主流的LLM反而都加上了呢？这篇文章我们从三个角度给出笔者的看法：

1. 位置编码对于Attention的作用是什么？
2. NoPE的Causal Attention是怎么实现位置编码的？
3. NoPE实现的位置编码有什么不足？

## 位置编码

位置编码最根本的作用是**打破Attention的置换不变性**。什么是置换不变性呢？在BERT时代，我们主要用的是双向Attention，它的基本形式为：

$$y_n = f(q_n; x_1, x_2, \cdots, x_L) = \frac{\sum_{m=1}^L e^{q_n \cdot k_m} v_m}{\sum_{m=1}^L e^{q_n \cdot k_m}}$$

假设 $\sigma_1, \sigma_2, \cdots, \sigma_L$ 是 $\{1, 2, \cdots, L\}$ 的任意排列，那么置换不变性是指

$$y_n = f(q_n; x_1, x_2, \cdots, x_L) = f(q_n; x_{\sigma_1}, x_{\sigma_2}, \cdots, x_{\sigma_L})$$

说白了，就是 $y_n$ 跟key-value的序无关，这跟自然语言的特性不符，所以我们要想办法打破这种不变性。用数据库来类比，没有位置编码的Attention就像是没有时间标签的数据库，检索结果只跟query有关，而位置编码就相当于给数据库的item按顺序打上时间标签，使得检索结果还可以跟item顺序有关。

## 先验认知

位置编码的另一个作用，是加入对Attention的先验认知，或者赋予Attention学习到这些先验认知性质的能力。

比如Sinusoidal位置编码隐含了相近的token应该具有相近的Embedding的先验；BERT的位置编码没有作出相近的假设，但允许模型学到这个性质；相对位置编码的先验假设是"相对位置比绝对位置更重要"；ALIBI隐含了越远的Token平均而言越不重要的假设（远程衰减）。

诸如RNN、CNN之类的模型，本质上就是把"越近的Token越重要"的先验融入到了架构中。然而，先验都是人为的、有偏的，而目前看来LLM的目标是碾压人类而不是模仿人类，这也可以解释为什么主流架构都用Attention了，因为架构先验更少，从而天花板更高。

## 单向注意

双向Attention具有置换不变性，所以需要位置编码来打破它，所以NoPE不适用于双向Attention，它的前提是单向Attention，或者说Causal Attention：

$$y_n = f(q_n; x_1, x_2, \cdots, x_L) = \frac{\sum_{m=1}^n e^{q_n \cdot k_m} v_m}{\sum_{m=1}^n e^{q_n \cdot k_m}}$$

它跟双向Attention的区别，只是求和符号的上限从L改为了n，由此可见它类似于cumsum，结果依赖于 $x_1, x_2, \cdots, x_L$ 的顺序。换句话说，它本身就不具有置换不变性。因此，"Causal + NoPE"的组合原则上不需要位置编码，也能取得非平凡的效果。

## 方差辨位

进一步地，"Causal + NoPE"是通过什么机制来识别位置信息的呢？

直观来看，$y_n$ 就是n个v的（加权）平均，$y_{n+1}$ 就是n+1个v的（加权）平均。我们考虑最简单的均匀分布情形，假设每个v的每个分量，都是从同一个"均值为0、方差为 $\sigma^2$"的分布中独立重复采样出来的。在此假设之下：

$$\frac{1}{d}\sum_{i=1}^d y_{n,i}^2 \approx \mathbb{E}[y_{n,i}^2] = \frac{\sigma^2}{n}$$

第二个等式其实就是RMS Norm中的"MS（Mean Square）"，可以看到它跟位置n有关。由此我们得出，"Causal + NoPE"实际上是将位置信息隐藏在了y的分量方差之中，或者等价地，隐藏在y的l2范数中。

同样的结论也出现在论文[《Latent Positional Information is in the Self-Attention Variance of Transformer Language Models Without Positional Embeddings》](https://papers.cool/arxiv/2305.13571)之中。

## 不足之处

让我们来汇总一下到目前为止的结果：Causal Attention本身不具备置换不变性，所以它原则上不需要位置编码（NoPE）；NoPE主要是通过hidden state向量的方差来表达位置信息的。

为什么基于Causal Attention的Decoder-only模型通常都还会加上位置编码呢？答案——NoPE虽然还行，但加上位置编码更好。原因如下：

1. **NoPE实现的是类似于乘性的绝对位置编码**，并且它只是将位置信息压缩到单个标量中，所以这是一种非常弱的位置编码；
2. **单个标量能表示的信息有限**，当输入长度增加时，位置编码会越来越紧凑以至于难以区分，比如极简例子有 $p(n) \sim 1/\sqrt{n}$，当n足够大时 $1/\sqrt{n}$ 与 $1/\sqrt{n+1}$ 几乎不可分辨；
3. **主流的观点认为相对位置编码更适合自然语言**，既然NoPE实现的是绝对位置编码，所以效率上自然不如再给模型额外补充上相对位置编码；
4. **NoPE既没有给模型添加诸如远程衰减之类的先验**，看上去也没有赋予模型学习到这种先验的能力，当输入长度足够大可能就会出现注意力不集中的问题。

综上所述，NoPE对于长文本可能会存在位置分辨率不足、效率较低、注意力弥散等问题，所以即便是Decoder-only模型，我们仍需要给它补充上额外的位置编码（特别是相对位置编码），以完善上述种种不足之处。

## 文章小结

尽管已经有一些工作表明，Decoder-only模型不加位置编码似乎也能取得不错的结果，但主流的LLM仍然额外加上了额外的位置编码，本文试图对这个现象给出自己的理解：NoPE通过向量方差表达位置信息，这是一种弱的位置编码，在长文本场景下存在分辨率不足、效率较低等问题。

---

**转载地址**：https://www.kexue.fm/archives/10347

**引用格式**：

苏剑林. (Sep. 01, 2024). 《Decoder-only的LLM为什么需要位置编码？》[Blog post]. Retrieved from https://www.kexue.fm/archives/10347

```bibtex
@online{kexuefm-10347,
  title={Decoder-only的LLM为什么需要位置编码？},
  author={苏剑林},
  year={2024},
  month={Sep},
  url={\url{https://www.kexue.fm/archives/10347}},
}
```
