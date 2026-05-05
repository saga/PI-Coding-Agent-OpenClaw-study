# 线性注意力简史：从模仿、创新到反哺

> **作者**：苏剑林 | **日期**：2025-06-15 | **来源**：[科学空间](https://www.kexue.fm/archives/11033)

在中文圈，本站应该算是比较早关注线性Attention的了，在2020年写首篇相关博客[《线性Attention的探索：Attention必须有个Softmax吗？》](https://www.kexue.fm/archives/7546)时，大家主要讨论的还是BERT相关的Softmax Attention。事后来看，在BERT时代考虑线性Attention并不是太明智，因为当时训练长度比较短，且模型主要还是Encoder，用线性Attention来做基本没有优势。

直到ChatGPT的出世，倒逼大家都去做Decoder-only的生成式模型，这跟线性Attention的RNN形式高度契合。同时，追求更长的训练长度也使得Softmax Attention的二次复杂度瓶颈愈发明显。在这样的新背景下，线性Attention越来越体现出竞争力，甚至出现了"反哺"Softmax Attention的迹象。

## 平方复杂度

首先引入一些记号：

$$q_i, k_i, v_i, o_i \in \mathbb{R}^{d \times 1}, \quad Q = [q_1, q_2, \cdots, q_n]^\top \in \mathbb{R}^{n \times d}$$

一个Attention模型，本质上是一个 $Q, K, V \to O$ 的映射。标准的Softmax Attention：

$$O = \text{softmax}(QK^\top + \log M)V$$

其中 $M \in \mathbb{R}^{n \times n}$ 是下三角掩码矩阵。Softmax Attention的核心是分子部分：

$$O = (\exp(QK^\top) \odot M)V$$

Softmax Attention的标准实现需要把 $n \times n$ 的矩阵 $\exp(QK^\top)$ 算出来，所以空间和时间复杂度都正比于 $n^2$。

## 最初的模样

线性Attention最早的思路主要是模仿和近似Softmax Attention，其中最简单的方案是直接去掉exp：

$$O = (QK^\top \odot M)V$$

为什么这个形式是"线性"Attention的呢？考虑去掉 $\odot M$ 的非Causal版，此时成立 $O = (QK^\top)V = Q(K^\top V)$，计算 $K^\top V$ 的复杂度是 $O(nd^2)$，结果是 $d \times d$ 矩阵，然后跟Q相乘复杂度也是 $O(nd^2)$，所以它复杂度是线性依赖于n。

至于Causal版，我们可以从分量形式理解：

$$o_t = \sum_{j=1}^t v_j(k_j^\top q_t) = \left(\sum_{j=1}^t v_j k_j^\top\right) q_t$$

如果我们记括号部分为 $S_t$，那么有

$$o_t = S_t q_t, \quad S_t = S_{t-1} + v_t k_t^\top$$

由此可见，Causal形式的Attention可以写成一个以 $S_t$ 为State的线性RNN，因此每一步的复杂度是常数，总的复杂度正比于序列长度n。

## 花式遗忘门

从上面的公式我们可以看出，目前的线性Attention本质上就是个cumsum，即将所有历史信息都等权地叠加，不难想象当叠加的token足够多时，每个token的信息占比都会变得极小。

为了缓解这个问题，[RetNet](https://papers.cool/arxiv/2307.08621)给线性Attention引入了遗忘效应：

$$o_t = S_t q_t, \quad S_t = \gamma S_{t-1} + v_t k_t^\top$$

其中衰减因子 $\gamma \in (0,1)$。加入衰减因子后，模型会倾向于遗忘掉更为久远的历史信息，从而至少保证最近token的分辨率。

式(10)的一个简单推广是将 $\gamma$ 更换为位置t的函数 $\gamma_t$。后来，[DFW](https://papers.cool/arxiv/2210.04243)、[Mamba](https://papers.cool/arxiv/2312.00752)、[Mamba2](https://papers.cool/arxiv/2405.21060)等工作，将它推广成跟输入相关，形成了"data-dependent decay"相关的一系列工作。

为什么我们偏爱线性RNN呢？因为线性RNN基本都能找到某种方式来并行训练，这使得它相比Softmax Attention更具竞争力——在训练效率和推理效率上都不逊色。

## 测试时训练

对于线性Attention的设计原则，[TTT（Test Time Training）](https://papers.cool/arxiv/2407.04620)给出了自己的答案，它将序列模型的构建视为一个"在线学习（Online Learning）"问题，并提出用优化器来构建RNN的做法。具体来说，它将K,V视作语料对 $(k_1, v_1), (k_2, v_2), \cdots, (k_t, v_t)$，根据这些语料训练得到一个模型 $v = f(S_t; k)$，最后输出 $o_t = f(S_t; q_t)$，其中 $S_t$ 是模型参数。

TTT所实现的RNN可以统一地写成

$$o_t = f(S_t; q_t), \quad S_t = S_{t-1} - \eta_t \nabla_{S_{t-1}} L(f(S_{t-1}; k_t), v_t)$$

这个形式可以覆盖非常多的RNN模型，比如最早的线性Attention和RetNet都是它的特例。

## 除旧而迎新

更好的目标函数应该是平方损失，即 $\frac{1}{2}\|Sk - v\|^2$，将它代入到TTT的公式得到

$$o_t = S_t q_t, \quad S_t = S_{t-1} - (S_{t-1}k_t - v_t)k_t^\top$$

这便是**DeltaNet**。留意到"先减后加"就是先移除模型对 $k_t$ 的旧认知，然后根据 $(k_t, v_t)$ 补充新认知，达到"除旧迎新"的效果。这个规则称为"[Delta Rule](https://en.wikipedia.org/wiki/Delta_rule)"，正是DeltaNet一词中"Delta"的来源。

## 求逆与推广

DeltaNet之后，[Gated DeltaNet（GDN）](https://papers.cool/arxiv/2412.06464)进一步地将遗忘门引入到DeltaNet之中：

$$S_t = \gamma_t S_{t-1} + \eta_t(v_t - S_{t-1}k_t)k_t^\top$$

它相当于将损失函数取 $\frac{1}{2}\|Sk - v\|^2 + \frac{1-\gamma}{\eta}\|S\|_F^2$。

DeltaNet之后还有另一个推广[DeltaProduct](https://papers.cool/arxiv/2502.10297)，它是将k,v扩展若干倍后再做DeltaNet或者Gated DeltaNet，试图增强模型的状态追踪能力。

## 反哺进行时

说到超越Softmax Attention，开头提到，如今的线性Attention不仅能与Softmax Attention一较高低，甚至开始"反哺"它。

将前面提到的Attention机制都以矩阵形式写出来：

| 公式 | 形式 |
|------|------|
| Softmax Attention | $(\exp(QK^\top) \odot M)V$ |
| 最早的线性Attention | $(QK^\top \odot M)V$ |
| 加入遗忘门后 | $(QK^\top \odot \Gamma)V$ |
| DeltaNet | $(QK^\top \odot M)(I + KK^\top \odot M^-)^{-1}V$ |
| Gated DeltaNet | $((QK^\top \odot M)(I + KK^\top \odot M^-)^{-1} \odot \Gamma)V$ |

其中

$$\Gamma_{i,j} = \begin{cases} \prod_{\tau=j+1}^{i} \gamma_\tau, & i > j \\ 1, & i = j \\ 0, & i < j \end{cases}$$

"反哺"的实现思路是：存在一个映射 $\phi$，将Q,K从 $n \times d$ 映射到 $n \times \infty$，满足 $\exp(QK^\top) = \phi(Q)\phi(K)^\top$，这称为"核技巧"。只需将上述表格中的线性Attention的Q,K换成 $\phi(Q), \phi(K)$，最后再设法恢复exp并归一化，就得到新的Softmax Attention变体了。

例如，代入到遗忘门的公式，我们有

$$(\phi(Q)\phi(K)^\top \odot \Gamma)V = \exp(QK^\top + \log \Gamma)V$$

如果 $\gamma_t$ 取常数，那么其实就是[ALiBi](https://papers.cool/arxiv/2108.09687)的指数版。

代入到DeltaNet的公式，则得到

$$O = \text{softmax}(QK^\top + \log M)(I + \exp(QK^\top) \odot M^-)^{-1}V$$

这就是[RealFormer](https://papers.cool/arxiv/2312.06484)的推广形式。

## 文章小结

本文梳理了线性Attention的发展历程：从最初模仿Softmax Attention的简单形式，到引入遗忘门、Delta Rule、Gated DeltaNet等创新，再到如今开始"反哺"Softmax Attention。线性Attention的核心优势在于其RNN形式天然契合Decoder-only模型，且推理效率不受序列长度限制。

---

**转载地址**：https://www.kexue.fm/archives/11033

**引用格式**：

苏剑林. (Jun. 15, 2025). 《线性注意力简史：从模仿、创新到反哺》[Blog post]. Retrieved from https://www.kexue.fm/archives/11033

```bibtex
@online{kexuefm-11033,
  title={线性注意力简史：从模仿、创新到反哺},
  author={苏剑林},
  year={2025},
  month={Jun},
  url={\url{https://www.kexue.fm/archives/11033}},
}
```
