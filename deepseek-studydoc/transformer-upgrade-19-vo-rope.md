# Transformer升级之路：19、第二类旋转位置编码

> **作者**：苏剑林 | **日期**：2025-04-18 | **来源**：[科学空间](https://www.kexue.fm/archives/10862)

持续将"Transformer升级之路"系列关注到本篇的读者，想必都已经对[旋转位置编码（RoPE）](https://www.kexue.fm/archives/8265)有所了解。简单来说，RoPE是施加在Attention的Query（Q）和Key（K）上的旋转变换，形式上属于绝对位置编码，但结合Attention的内积（Dot-Product）特性，能够自动实现相对位置的效果。

那么，RoPE可以加在Value（V）上吗？看上去不可以，因为对V旋转后就不是相对位置编码了。然而事情并没有那么绝对，本文就来讨论加在V上RoPE，我们可以称之为"第二类旋转位置编码"。

## 基础回顾

我们将Dot-Product Attention分解为

$$\mathbf{o}_i = \sum_j a_{i,j} \mathbf{v}_j, \quad a_{i,j} = \frac{e^{s_{i,j}}}{\sum_j e^{s_{i,j}}}, \quad s_{i,j} = \mathbf{q}_i^\top \mathbf{k}_j$$

RoPE应用在 $\mathbf{q}_i, \mathbf{k}_j$ 上：

$$\mathbf{q}_i \to R_i \mathbf{q}_i, \quad \mathbf{k}_j \to R_j \mathbf{k}_j$$

这将导致Attention Logits变成

$$s_{i,j} = (R_i \mathbf{q}_i)^\top (R_j \mathbf{k}_j) = \mathbf{q}_i^\top R_i^\top R_j \mathbf{k}_j = \mathbf{q}_i^\top R_{j-i} \mathbf{k}_j$$

也就是说 $s_{i,j}$ 只依赖于相对位置 $j - i$，从而通过绝对位置形式达到相对位置的效果。这个变换过程利用了旋转矩阵的特性 $R_i^\top R_j = R_{j-i}$。

## 新的用法

如果将RoPE加在 $\mathbf{v}_j$ 上，即 $\mathbf{v}_j \to R_j \mathbf{v}_j$，那又如何呢？显然Attention的结果是

$$\mathbf{o}_i = \sum_j a_{i,j} R_j \mathbf{v}_j$$

这将会导致Attention显式依赖于绝对位置j。如果我们只想要一种位置编码，那么也许问题不大，但如果我们是想要一种相对位置编码，那么它就不能满足我们的目的。

然而，有一个简单的技巧可以解决这个缺陷！我们可以给 $\mathbf{o}_i$ 再加一次逆向的RoPE：

$$\mathbf{o}_i = R_i^\top \left(\sum_j a_{i,j} R_j \mathbf{v}_j\right) = \sum_j a_{i,j} R_i^\top R_j \mathbf{v}_j = \sum_j a_{i,j} R_{j-i} \mathbf{v}_j$$

这样它再次变成了一个相对位置编码！而形式上同样也是两次绝对位置编码，跟已有的RoPE异曲同工，所以我们称之为"第二类旋转位置编码"，也可以更直观地称为"VO-RoPE"，因为它分别在Value和Output都加了一次RoPE，相应地，标准的RoPE我们可以称之为"QK-RoPE"。

## 简单实验

在一个1B左右的类LLAMA模型上快速做了一波实验，对比的几个设置为：

1. NoPE：完全不加位置编码
2. QK-RoPE：标准的旋转位置编码
3. VO-RoPE：本文新提出的第二类旋转位置编码
4. Q/K/V/O-RoPE：单独在Q、K、V、O之一加旋转位置编码
5. QKV-RoPE：Q、K、V都加上旋转位置编码
6. QKVO-RoPE：Q、K、V、O都加上旋转位置编码

大致结论是：

QK-RoPE ≈ QKVO-RoPE > K-RoPE ≈ VO-RoPE > QKV-RoPE > NoPE > Q/V/O-RoPE

具体损失函数差异是：

| 配置 | Loss |
|------|------|
| QK-RoPE | 2.712 |
| QKVO-RoPE | 2.719 |
| K-RoPE | 2.769 |
| VO-RoPE | 2.770 |
| QKV-RoPE | 2.783 |
| NoPE | 2.795 |
| O-RoPE | 2.841 |
| Q-RoPE | 2.851 |
| V-RoPE | 2.856 |

## 一些思考

从上述结果可以看出，VO-RoPE优于NoPE，但不如QK-RoPE，而且VO-RoPE和QK-RoPE叠加并没有增益。这样看来，VO-RoPE似乎没有提出的必要了？

在笔者看来，将RoPE的用法补充完整，回答"RoPE可以加在Value上吗"这个问题，然后实验清楚"没有什么收益"这件事，本身就很有价值。

就当前来看，VO-RoPE也有一个潜在应用场景，它跟[MLA](https://www.kexue.fm/archives/10091)有关。我们知道，MLA在推理阶段约等于一个K、V共享的MQA。然而，这个重要特性与QK-RoPE并不兼容，因为一旦给Attention矩阵里边的 $\mathbf{c}_j$ 加上RoPE，那么就有两种结果：

1. Value这边的 $\mathbf{c}_j$ 不加RoPE，那么K、V就不完全共享了，这就导致了要不KV Cache翻倍，要不K实时注入RoPE（带来了延迟）；
2. 如果Value这边的 $\mathbf{c}_j$ 加RoPE，倒是可以达到K、V共享的效果，但此时就不是相对位置编码了。

MLA为了解决这个问题，采用了"大部分NoPE+小部分RoPE"拼接的做法。但是，从本文的第二类旋转位置编码我们知道，只需要再给Output加一次O-RoPE就行了：

$$\mathbf{o}_i = R_i^\top \sum_{j=1}^{i} a_{i,j} (R_j \mathbf{c}_j), \quad a_{i,j} = \frac{e^{s_{i,j}}}{\sum_{j=1}^{i} e^{s_{i,j}}}, \quad s_{i,j} = (R_i \mathbf{q}_i)^\top (R_j \mathbf{c}_j)$$

不过，这个思路还没完全走通，还无法直接用在MLA的训练形式上，只是先写出来给大家参考。

## 相关工作

事实上，VO-RoPE还巧妙地提供了一个从Attention到复线性RNN（如LRU、RetNet）的中间形式。我们从式(5)出发，考虑Causal场景，然后取一个特殊例子 $a_{i,j} = \gamma^{i-j}$，其中 $0 < \gamma < 1$，那么得到

$$\mathbf{o}_i = \sum_{j=1}^{i} \gamma^{i-j} R_{j-i} \mathbf{v}_j$$

我们知道旋转矩阵 $R_{j-i}$ 用复数形式写其实就是 $e^{I\theta(j-i)}$ 的对角阵，其中I是虚数单位。这样一来，上式相当于

$$\mathbf{o}_i = \sum_{j=1}^{i} \gamma^{i-j} e^{I\theta(j-i)} \mathbf{v}_j = \sum_{j=1}^{i} (\gamma e^{-I\theta})^{i-j} \mathbf{v}_j$$

这其实就是最简单的带有复数Decay的线性RNN。从理论推导来看，这种RNN在理论上比纯实数Decay的RNN更完备。

## 文章小结

本文围绕着"RoPE可以加在V上吗"进行展开，讨论了RoPE的第二种用法——VO-RoPE，通过在Value和Output上分别施加RoPE来实现相对位置编码的效果。

---

**转载地址**：https://www.kexue.fm/archives/10862

**引用格式**：

苏剑林. (Apr. 18, 2025). 《Transformer升级之路：19、第二类旋转位置编码》[Blog post]. Retrieved from https://www.kexue.fm/archives/10862

```bibtex
@online{kexuefm-10862,
  title={Transformer升级之路：19、第二类旋转位置编码},
  author={苏剑林},
  year={2025},
  month={Apr},
  url={\url{https://www.kexue.fm/archives/10862}},
}
```
