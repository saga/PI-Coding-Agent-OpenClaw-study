# 熵不变性Softmax的一个快速推导

> **作者**：苏剑林 | **日期**：2022-04-11 | **来源**：[科学空间](https://www.kexue.fm/archives/9034)

在文章[《从熵不变性看Attention的Scale操作》](https://www.kexue.fm/archives/8823)中，我们推导了一版具有熵不变性质的注意力机制：

$$\text{Attention}(Q,K,V) = \text{softmax}\left(\frac{\kappa\log n}{\sqrt{d}} QK^\top\right)V$$

原来的推导比较繁琐，并且做了较多的假设，不利于直观理解，本文为其补充一个相对简明快速的推导。

## 推导过程

设有 $s_1,s_2,\cdots,s_n\in\mathbb{R}$，定义

$$p_i = \frac{e^{\lambda s_i}}{\sum_{i=1}^{n} e^{\lambda s_i}}$$

现在我们算它的熵

$$H = -\sum_{i=1}^{n} p_i\log p_i = \log\sum_{i=1}^{n} e^{\lambda s_i} - \lambda\sum_{i=1}^{n}p_i s_i$$

$$= \log n + \log\frac{1}{n}\sum_{i=1}^{n} e^{\lambda s_i} - \lambda\sum_{i=1}^{n}p_i s_i$$

用"先平均后指数"（平均场）来近似：

$$\log\frac{1}{n}\sum_{i=1}^{n} e^{\lambda s_i} \approx \log\exp\left(\frac{1}{n}\sum_{i=1}^{n}\lambda s_i\right) = \lambda\bar{s}$$

而Softmax侧重于max，有近似 $\lambda\sum_{i=1}^{n}p_i s_i \approx \lambda s_{\max}$。所以

$$H \approx \log n - \lambda(s_{\max} - \bar{s})$$

所谓熵不变性，就是希望尽可能地消除长度 $n$ 的影响，所以需要有 $\lambda\propto\log n$。放到注意力机制中，$s$ 的形式为 $\langle q,k\rangle \propto \sqrt{d}$，所以需要有 $\lambda\propto \frac{1}{\sqrt{d}}$，综合起来就是

$$\lambda \propto \frac{\log n}{\sqrt{d}}$$

## 文章小结

为之前提出的"熵不变性Softmax"构思了一个简单明快的推导。

---

**转载地址**：https://www.kexue.fm/archives/9034

**引用格式**：

苏剑林. (Apr. 11, 2022). 《熵不变性Softmax的一个快速推导》[Blog post]. Retrieved from https://www.kexue.fm/archives/9034

```bibtex
@online{kexuefm-9034,
  title={熵不变性Softmax的一个快速推导},
  author={苏剑林},
  year={2022},
  month={Apr},
  url={\url{https://www.kexue.fm/archives/9034}},
}
```
