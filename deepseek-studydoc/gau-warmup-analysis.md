# 门控注意力单元（GAU）还需要Warmup吗？

> **作者**：苏剑林 | **日期**：2022-03-11 | **来源**：[科学空间](https://www.kexue.fm/archives/8990)

在[《训练1000层的Transformer究竟有什么困难？》](https://www.kexue.fm/archives/8978)发布之后，很快就有读者问到如果将其用[《FLASH：可能是近来最有意思的高效Transformer设计》](https://www.kexue.fm/archives/8934)中的"门控注意力单元（GAU）"，那结果是怎样的？

## 先说结论

GAU是非常容易训练的模型，哪怕我们不加调整地直接使用"Post Norm + Xavier初始化"，也能轻松训练个几十层的GAU，并且还不用Warmup。

为什么GAU能做到这些？因为在默认设置之下，理论上 $GAU(x_l)$ 相比 $x_l$ 几乎小了两个数量级，所以

$$x_{l+1} = \text{LN}(x_l + GAU(x_l)) \approx x_l$$

因此，GAU配合残差，在标准的初始化之下就已经很接近一个恒等函数，有这种性质的模型是非常容易训练的。相当于自动地包含了上百层模型的DeepNorm操作，理论上可以直接训练上百层的GAU模型。

## 量级分析

标准的GAU运算如下：

$$O = (U\odot AV)W_o, \quad A = \frac{1}{ns}relu^2(\mathcal{Q}(Z)\mathcal{K}(Z)^\top)$$

$$U = \phi(XW_u), \quad V = \phi(XW_v), \quad Z = \phi(XW_z)$$

在LeCun初始化假设下，$X$ 的分量独立服从 $\mathcal{N}(0,1)$，经推导得：

- 对角线：$A_{i,i} \approx s\nu^4/n$
- 非对角线：$A_{i,j} \approx s\mu^4/n$

$a_{i,i}/a_{i,j} \approx \nu^4/\mu^4 \approx 69 \gg 1$，初始阶段的 $A$ 很接近单位阵，所以 $A\approx \frac{s\nu^4}{n}I$。

最终得出 $O$ 的量级是 $O\left(\frac{s\nu^6}{n}\right)$。以常规设置 $s=128, n=512$ 为例，$\frac{s\nu^6}{n}\approx 0.01$，即 $GAU(x_l)$ 出来后大致是 $0.01x_l$ 级别的，小两个数量级。

更疯狂的是，如果所有初始化为标准差的 $\lambda$ 倍，GAU输出将缩小到原来的 $\lambda^7$ 倍！所以按照原论文初始化选择（0.02标准差），理论上可以直接训练上万层的GAU模型。

---

**转载地址**：https://www.kexue.fm/archives/8990

**引用格式**：

苏剑林. (Mar. 11, 2022). 《门控注意力单元（GAU）还需要Warmup吗？》[Blog post]. Retrieved from https://www.kexue.fm/archives/8990

```bibtex
@online{kexuefm-8990,
  title={门控注意力单元（GAU）还需要Warmup吗？},
  author={苏剑林},
  year={2022},
  month={Mar},
  url={\url{https://www.kexue.fm/archives/8990}},
}
```
