# 从JL引理看熵不变性Attention

> **作者**：苏剑林 | **日期**：2023-04-10 | **来源**：[科学空间](https://www.kexue.fm/archives/9588)

在[《从熵不变性看Attention的Scale操作》](https://www.kexue.fm/archives/8823)、[《熵不变性Softmax的一个快速推导》](https://www.kexue.fm/archives/9034)中笔者提出了熵不变性Softmax，简单来说就是往Softmax之前的Attention矩阵多乘上一个 $\log n$，理论上有助于增强长度外推性，其中 $n$ 是序列长度。$\log n$ 这个因子让笔者联系到了JL引理（Johnson-Lindenstrauss引理），因为JL引理告诉我们编码 $n$ 个向量只需要 $O(\log n)$ 的维度就行了，大家都是 $\log n$，这两者有没有什么关联呢？

## 熵不变性

我们知道，熵是不确定性的度量，用在注意力机制中，我们将它作为"集中注意力的程度"。所谓熵不变性，指的是不管序列长度 $n$ 是多少，我们都要将注意力集中在关键的几个token上，而不要太过分散。为此，我们提出的熵不变性Attention形式为

$$\text{Attention}(Q,K,V) = \text{softmax}\left(\frac{\log_{512} n}{\sqrt{d}} QK^\top\right)V$$

这里 $Q,K\in\mathbb{R}^{n\times d}$。跟常规的Attention相比，就是scale的因子多了个 $\log_{512} n$。

这个形式的原理也很直观，当 $n$ 增大时，意味着有更多的token去平摊了注意力，导致注意力不集中，此时我们乘上一个关于 $n$ 单调递增的因子，softmax之后它实际上就相当于原来概率的幂运算，由于概率都小于1，所以概率越小幂运算之后会变得更小，这样注意力重新变得集中起来。

## JL引理

JL引理是关于向量嵌入的一个重要结论，简单来说它就是告诉我们"要塞下 $n$ 个向量，只需 $O(\log n)$ 维空间"，详细介绍可以参考[《让人惊叹的Johnson-Lindenstrauss引理：理论篇》](https://www.kexue.fm/archives/8679)。

有意思的是，早在笔者知道JL引理之前，就在[《最小熵原理（六）：词向量的维度应该怎么选择？》](https://www.kexue.fm/archives/7695)推导过同样的、甚至更具体的结果——嵌入 $n$ 个词向量，大致上需要 $8\log n$ 维空间就行了。

另外，JL引理还可以用来解释注意力机制的多头性。如果代入 $n=512$，那么 $8\log n\approx 50$，这跟Attention的Q、K常用的投影维度（key_size，BERT里边是64）很接近，这就告诉我们，如果序列长度是512，那么算Attention的Q、K的维度在50这个量级就够了，没必要用全部的hidden_size，省下来的维度可以转而用来做多头注意力。

## 联系起来

现在，我们就可以尝试JL引理跟熵不变性Attention联系起来了。

我们将Q、K的key_size记为 $d$，那么JL引理告诉我们，$d$ 的最佳选择应该是 $d_n = \lambda\log n$。假设我们选定了一个固定的 $d$，并且假设这个 $d$ 是为训练长度512设计的，那么可以得出

$$d_n = \frac{d}{\log 512}\log n = d\log_{512} n$$

对于 $n\neq 512$，理想情况下应该用 $d_n$ 维的投影维度，但实际用了 $d$ 维。直觉上来看，如果每一项的贡献接近，那么我们将结果乘以 $\frac{d_n}{d}$ 后，能够让结果更接近 $d_n$ 项求和的理想情况，所以我们就得出，应当往 $\langle q,k\rangle$ 中乘上因子

$$\frac{d_n}{d} = \log_{512} n$$

来弥补实际情况与理想情况的差距。而常规的Scaled-Dot Attention乘上 $\log_{512} n$ 后，正好是熵不变性Attention。

这样，我们就将JL引理跟熵不变性Attention联系了起来。注意这只是个直观的、定性的理解过程，很难从定量角度将它进一步严格化，事实上也没有必要进一步定量化了，因为JL引理本身更多也只是一个定性的结论。

## 文章小结

本文构建了JL引理与熵不变性Attention之间的一个简单联系。

---

**转载地址**：https://www.kexue.fm/archives/9588

**引用格式**：

苏剑林. (Apr. 10, 2023). 《从JL引理看熵不变性Attention》[Blog post]. Retrieved from https://www.kexue.fm/archives/9588

```bibtex
@online{kexuefm-9588,
  title={从JL引理看熵不变性Attention},
  author={苏剑林},
  year={2023},
  month={Apr},
  url={\url{https://www.kexue.fm/archives/9588}},
}
```
