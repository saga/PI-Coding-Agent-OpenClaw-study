# 从熵不变性看Attention的Scale操作

> **作者**：苏剑林 | **日期**：2021-12-21 | **来源**：[科学空间](https://www.kexue.fm/archives/8823)

当前Transformer架构用的最多的注意力机制，全称为"Scaled Dot-Product Attention"，其中"Scaled"是因为在 $Q,K$ 转置相乘之后还要除以一个 $\sqrt{d}$ 再做Softmax：

$$\text{Attention}(Q,K,V) = \text{softmax}\left(\frac{QK^\top}{\sqrt{d}}\right)V$$

本文从"熵不变性"的角度来理解这个缩放操作，并得到一个新的缩放因子。在MLM的实验显示，新的缩放因子具有**更好的长度外推性能**。

## 熵不变性

将Scaled Dot-Product Attention改写为

$$o_i = \sum_{j=1}^{n} a_{i,j}v_j, \quad a_{i,j} = \frac{e^{\lambda q_i\cdot k_j}}{\sum_{j=1}^{n} e^{\lambda q_i\cdot k_j}}$$

其中 $\lambda$ 是缩放因子，目前主流的是 $\lambda=1/\sqrt{d}$。

核心观点：**为了使模型结果能够更好地泛化到未知长度，Attention机制的设计应该使得 $a_{i,j}$ 尽量具备熵不变性。**

$a_{i,j}$ 的熵为 $\mathcal{H}_i = -\sum_{j=1}^{n} a_{i,j}\log a_{i,j}$。熵不变性是指 $\mathcal{H}_i$ 应该对长度 $n$ 不敏感——引入新的token后，已有的token依旧能同样地聚焦到原来的token上，而不希望新token的引入过多地"分摊"了原有的注意力。

## 新的缩放因子

根据熵不变性及合理假设，得到新的Scaled Dot-Product Attention：

$$\text{Attention}(Q,K,V) = \text{softmax}\left(\frac{\kappa\log n}{\sqrt{d}} QK^\top\right)V$$

其中 $\kappa$ 是超参数。由于当前主流预训练长度为512，当 $n=512$ 时让上式退化为普通版本，即 $\frac{\kappa\log 512}{\sqrt{d}} = \frac{1}{\sqrt{d}}$，推出 $\kappa = \frac{\sqrt{d}}{\log 512}$，最终：

$$\text{Attention}(Q,K,V) = \text{softmax}\left(\frac{\log_{512} n}{\sqrt{d}} QK^\top\right)V$$

## 实验结果

| 测试长度 | n=64 | n=128 | n=256 | n=512 | n=1024 |
|---------|------|-------|-------|-------|--------|
| Attention-O | 43.27 | 36.53 | 23.02 | 15.12 | 11.54 |
| **Attention-E** | **43.11** | **41.17** | **34.04** | **20.15** | **13.58** |

在训练长度 $n=64$ 时两者效果接近，但外推到更长度时差距明显，$n=256$ 时Attention-E高出10个百分点以上。

---

**转载地址**：https://www.kexue.fm/archives/8823

**引用格式**：

苏剑林. (Dec. 21, 2021). 《从熵不变性看Attention的Scale操作》[Blog post]. Retrieved from https://www.kexue.fm/archives/8823

```bibtex
@online{kexuefm-8823,
  title={从熵不变性看Attention的Scale操作},
  author={苏剑林},
  year={2021},
  month={Dec},
  url={\url{https://www.kexue.fm/archives/8823}},
}
```
