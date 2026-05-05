# 训练1000层的Transformer究竟有什么困难？

> **作者**：苏剑林 | **日期**：2022-03-04 | **来源**：[科学空间](https://www.kexue.fm/archives/8978)

现在的Transformer越做越大，但这个"大"通常是"宽"而不是"深"，像GPT-3虽然参数有上千亿，但也只是一个96层的Transformer模型。是什么限制了Transformer往"深"发展呢？归根结底还是Transformer固有的训练困难。

近来的一些工作指出，深模型训练的根本困难在于**"增量爆炸"**，即模型越深对输出的扰动就越大。上周的论文《DeepNet: Scaling Transformers to 1,000 Layers》则沿着这个思路进行尺度分析，最终成功训练出了1000层的Transformer模型。

## 增量爆炸

假设损失函数为 $\mathcal{L}(\theta)$，参数由 $\theta$ 变为 $\theta+\Delta\theta$ 时损失函数的增量：

$$\Delta\mathcal{L} \approx \langle\nabla_\theta\mathcal{L}(\theta), \Delta\theta\rangle$$

对于SGD有 $\Delta\theta = -\eta\nabla_\theta\mathcal{L}(\theta)$，那么 $\Delta\mathcal{L} \approx -\eta\|\nabla_\theta\mathcal{L}(\theta)\|^2$。设模型有 $N$ 层，每层平均参数量为 $K$，多数参数梯度是 $O(1)$ 量级，所以 $\Delta\mathcal{L}=O(\eta NK)$。模型越深更新量越大，容易进入不佳的局部最优点。

解决方法：一是用更小的学习率（Warmup）；二是调整初始化使参数梯度为 $O(1/\sqrt{N})$，自动抵消深度影响。

## 量级分析 — DeepNorm

论文保留Post Norm结构，考虑DeepNorm形式：

$$x_{l+1} = \text{LN}(\alpha x_l + F(x_l)) = \text{LN}(x_l + F(x_l)/\alpha)$$

经过FFN和Self Attention层的量级分析，最终结论为：

$$\frac{\partial\mathcal{L}}{\partial\lambda} = O\left(\frac{\lambda}{\alpha}\right)$$

即梯度量级是 $O(\lambda/\alpha)$。需要梯度调整到 $O(1/\sqrt{2N})$，即 $\lambda/\alpha = 1/\sqrt{2N}$。

论文取 $\alpha = (2N)^{1/4}, \lambda = (2N)^{-1/4}$，这既保持梯度缩放到 $O(1/\sqrt{N})$，又让初始学习步伐稍慢，隐式起到Warmup作用。

## 不同优化器的适配

| 优化器 | $\Delta\theta$ | $\alpha$ | $\lambda$ |
|--------|---------------|---------|----------|
| SGD | $-\eta\nabla_\theta\mathcal{L}$ | $(2N)^{1/4}$ | $(2N)^{-1/4}$ |
| Adam | $-\eta\,\text{sign}(\nabla_\theta\mathcal{L})$ | $(2N)^{1/2}$ | $(2N)^{-1/2}$ |
| LAMB | $-\eta\|\theta\|\text{sign}(\nabla_\theta\mathcal{L})$ | $1$ | $(2N)^{-1/2}$ |

经过调整后，初始阶段每个残差分支的权重被缩放到 $\lambda^2/\alpha$ 倍，模型接近恒等函数，因此梯度自然为 $O(1)$，结论自洽。实验显示200层"深而窄"的模型（32亿参数）战胜了48层"浅而宽"的SOTA模型（120亿参数）。

---

**转载地址**：https://www.kexue.fm/archives/8978

**引用格式**：

苏剑林. (Mar. 04, 2022). 《训练1000层的Transformer究竟有什么困难？》[Blog post]. Retrieved from https://www.kexue.fm/archives/8978

```bibtex
@online{kexuefm-8978,
  title={训练1000层的Transformer究竟有什么困难？},
  author={苏剑林},
  year={2022},
  month={Mar},
  url={\url{https://www.kexue.fm/archives/8978}},
}
```
