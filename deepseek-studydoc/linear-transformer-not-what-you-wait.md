# 线性Transformer应该不是你要等的那个模型

> **作者**：苏剑林 | **日期**：2021-08-09 | **来源**：[科学空间](https://www.kexue.fm/archives/8610)

本文要说的是：**标准Attention到线性Attention的转换应该远远达不到你的预期，而BERT那么慢的原因也并不是因为标准Attention的平方复杂度。**

## 评估计算量

设 $n$ 为序列长度，$d$ 为head_size，$h$ 为head数目。

SA总计算量：$4nh^2d^2 + 2n^2hd$
FFN总计算量：$8nh^2d^2$

**SA计算量 > FFN 的条件**：$n > 2hd$，对于base版($h=12,d=64$)而言即 $n > 1536$

**二次项占主导的条件**：$n > 6hd$，即 $n > 4608$

结论：对base版，序列长度不超过1536时Transformer几乎是线性的；超过4608才真正以二次项为主。而BERT的max_len一般不超过512，远低于上述界限。

> **BERT之所以慢，主要是因为它真的大，而不是因为Attention的平方复杂度。**

## 线性Attention的真实处境

线性Attention需要更大的 $d$（一般是原来的4倍）才能保留大致相同的效果。在此情况下，线性Attention要比标准Attention快需要 $n > 16d$，即 $n > 1024$。

且占主导计算量的还是FFN等线性运算，换了线性Attention也无法感觉到明显的速度提升。

> 你要不是成千上万的序列长度，就不要想着换线性Attention了。

---

**转载地址**：https://www.kexue.fm/archives/8610

**引用格式**：

苏剑林. (Aug. 09, 2021). 《线性Transformer应该不是你要等的那个模型》[Blog post]. Retrieved from https://www.kexue.fm/archives/8610

```bibtex
@online{kexuefm-8610,
  title={线性Transformer应该不是你要等的那个模型},
  author={苏剑林},
  year={2021},
  month={Aug},
  url={\url{https://www.kexue.fm/archives/8610}},
}
```
