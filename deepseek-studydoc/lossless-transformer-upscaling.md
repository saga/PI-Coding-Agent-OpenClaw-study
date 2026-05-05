# 我们可以无损放大一个Transformer模型吗（一）

> **作者**：苏剑林 | **日期**：2021-06-02 | **来源**：[科学空间](https://www.kexue.fm/archives/8444)

能否先训练一个同样层数的小模型，然后放大后继续训练？本文从理论上分析这个问题。

"无损放大"的含义：通过某种确定性的权重变换，把小模型直接变换成大模型，且输出完全不改变。

以"将一个BERT放大为2倍"为例（仅扩大隐层维度）：

**核心变换原则：重复再除以 $\sqrt{2}$**

- **Embedding**: $\tilde{x}_i = \frac{1}{\sqrt{2}} x_{\lceil i/2\rceil}$
- **LayerNorm**: $\tilde{\beta}_i = \frac{1}{\sqrt{2}}\beta_{\lceil i/2\rceil}, \tilde{\gamma}_i = \frac{1}{\sqrt{2}}\gamma_{\lceil i/2\rceil}$
- **FFN**: 若激活函数为ReLU，用 $\tilde{w}_{i,j} = \frac{1}{2}w_{\lceil i/2\rceil,\lceil j/2\rceil}$；若为GeLU，需在第一层用 $\frac{1}{\sqrt{2}}$ 在第二层用 $\frac{1}{2\sqrt{2}}$
- **Attention**: Q/K需多除一个 $\sqrt[4]{2}$（因为有scale因子 $\sqrt{d}$ 的影响）
- **输出**: 乘以Embedding转置即可

**结论**：对于BERT（ReLU激活）可直接无损放大；GPT/T5无论什么激活函数都可实现。但若使用了RoPE，需调整重复方案为 $[x_1,x_2,x_1,x_2,\cdots]$ 形式，且不能完全保证结果一致。

---

**转载地址**：https://www.kexue.fm/archives/8444

**引用格式**：苏剑林. (Jun. 02, 2021). 《我们可以无损放大一个Transformer模型吗（一）》[Blog post]. Retrieved from https://www.kexue.fm/archives/8444

```bibtex
@online{kexuefm-8444,
  title={我们可以无损放大一个Transformer模型吗（一）},
  author={苏剑林}, year={2021}, month={Jun},
  url={\url{https://www.kexue.fm/archives/8444}},
}
```
