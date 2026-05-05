# 浅谈Transformer的初始化、参数化与标准化

> **作者**：苏剑林 | **日期**：2021-08-17 | **来源**：[科学空间](https://www.kexue.fm/archives/8620)

本文梳理一下模型的初始化、参数化和标准化等内容，相关讨论主要围绕Transformer展开。

## 二阶矩稳定性

假定输入均值为0、输入二阶矩为1，初始化权重 $w_{i,j}$ 的均值为0、方差为 $1/m$（$m$ 为输入节点数），则无激活函数全连接层的输出二阶矩也为1，这是LeCun初始化。

对于ReLU激活函数，大致一半的输出被置零，初始化方差只需改为 $2/m$（He初始化）。

## 微调激活函数

对于sigmoid/tanh等无法保持二阶矩不变的激活函数，可以通过微调激活函数来保持二阶矩。例如标准正态输入下sigmoid后的二阶矩为0.293，将输出除以 $\sqrt{0.293}$ 即可。

2017年"轰动一时"的SELU激活函数本质上就是"微调"后的ELU，使其输出均值为0、方差为1。

## NTK参数化

NTK参数化：用"均值为0、方差为1"初始化，但输出结果除以 $\sqrt{m}$：

$$y_j = b_j + \frac{1}{\sqrt{m}}\sum_i x_i w_{i,j}$$

这让所有参数可以用标准方差初始化，量级均为 $O(1)$，可设置较大学习率，更新幅度直观（如 $10^{-2}$ 大约对应1%的参数调整）。

这也解释了Attention为何要除以 $\sqrt{d}$：$q,k$ 内积的二阶矩为 $d$，不除会导致softmax后退化成one-hot，梯度消失。

## Post Norm vs Pre Norm

- **Post Norm**: $x_{t+1} = \text{Norm}(x_t + F_t(x_t))$ — 残差通道权重递减，训练困难需warmup
- **Pre Norm**: $x_{t+1} = x_t + F_t(\text{Norm}(x_t))$ — 残差通道平权，更好优化
- **SkipInit/ReZero**: $x_{t+1} = x_t + \alpha_t F_t(x_t)$，$\alpha_t$ 初始化为0后逐渐增大，最优雅

---

**转载地址**：https://www.kexue.fm/archives/8620

**引用格式**：

苏剑林. (Aug. 17, 2021). 《浅谈Transformer的初始化、参数化与标准化》[Blog post]. Retrieved from https://www.kexue.fm/archives/8620

```bibtex
@online{kexuefm-8620,
  title={浅谈Transformer的初始化、参数化与标准化},
  author={苏剑林},
  year={2021},
  month={Aug},
  url={\url{https://www.kexue.fm/archives/8620}},
}
```
