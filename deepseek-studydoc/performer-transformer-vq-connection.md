# 我在Performer中发现了Transformer-VQ的踪迹

> **作者**：苏剑林 | **日期**：2023-11-29 | **来源**：[科学空间](https://www.kexue.fm/archives/9862)

前些天我们在[《VQ一下Key，Transformer的复杂度就变成线性了》](https://www.kexue.fm/archives/9844)介绍了"Transformer-VQ"，这是通过将Key序列做VQ（Vector Quantize）变换来实现Attention复杂度线性化的方案。诚然，Transformer-VQ提供了标准Attention到线性Attentino的一个非常漂亮的过渡，给人一种"大道至简"的美感，但熟悉VQ的读者应该能感觉到，当编码表大小或者模型参数量进一步增加时，VQ很可能会成为效果提升的瓶颈，因为它通过STE（Straight-Through Estimator）估计的梯度大概率是次优的（[FSQ](https://www.kexue.fm/archives/9826)的实验结果也算是提供了一些佐证）。此外，Transformer-VQ为了使训练效率也线性化所做的梯度截断，也可能成为将来的效果瓶颈之一。

为此，笔者花了一些时间思考可以替代掉VQ的线性化思路。从Transformer-VQ的$\exp(QC^\top)$形式中，笔者联想到了[Performer](https://www.kexue.fm/archives/7921)，继而"顺藤摸瓜"地发现原来Performer可以视为Soft版的Transformer-VQ。进一步地，笔者尝试类比Performer的推导方法来重新导出Transformer-VQ，为其后的优化提供一些参考结果。

## 前情回顾

首先，让我们花一些时间回顾一下Transformer-VQ。设$Q,K\in\mathbb{R}^{n\times d_k}, V\in\mathbb{R}^{n\times d_v}$，Transformer-VQ的关键，是对$K$做了如下VQ近似：

$$K \approx \hat{K} \triangleq \Delta C$$

这里的$\Delta\in\{0,1\}^{n\times c}, C\in\mathbb{R}^{c\times d_k}$都是矩阵，其中$C$是可训练的参数，$\Delta$则定义为：

$$\Delta_{i,j} = \begin{cases}1, & j = \arg\min_{k=1,2,\cdots,c}\|K_i - C_k\| \\ 0, & \text{其他}\end{cases}$$

说白了，VQ就是用与$K_i$最相近的那个$C_j$来近似$K_i$。在这个近似之下，我们有（简单起见，以Encoder为例）

$$\exp(Q\hat{K}^\top)V = \exp(QC^\top\Delta^\top)V = \exp(QC^\top)\Delta^\top V = \exp(QC^\top)(\Delta^\top V)$$

了解线性Attention的读者很容易认出来，最后一个式子的运算就是线性复杂度的，它就是本文的主角之一Transformer-VQ（的分子，还有分母同理）。

没有很复杂的推导，线性Attention就出来了，这就给我们一种感觉，仿佛我们是在对Key做近似的"不经意间"就将Attention的复杂度降为了线性，美感十足。因此，再次回到了我们已经提过多次的评价——Transformer-VQ提供了标准Attention到线性Attentino的一个非常漂亮的过渡。

## 似曾相识

Transformer-VQ的$\exp(QC^\top)$让笔者联想到了之前的文章[《Transformer升级之路：3、从Performer到线性Attention》](https://www.kexue.fm/archives/8338)。在那篇文章中，笔者对Performer的结果做了一些简化，然后断言线性Attention的Q,K的最佳激活函数是$\exp$，而Transformer-VQ同样出现了$\exp$，所以它们之间也许有着某种相关性。

为了挖掘这种联系，让我们请出Performer，它基于一个漂亮的近似：

$$e^{q\cdot k} = E_{\omega\sim\mathcal{N}(\omega;0,\frac{1}{d}I)}[e^{\omega\cdot q - \|q\|^2/2}e^{\omega\cdot k - \|k\|^2/2}] \approx \frac{1}{m}\underbrace{\begin{pmatrix}e^{\omega_1\cdot q - \|q\|^2/2} \\ e^{\omega_2\cdot q - \|q\|^2/2} \\ \vdots \\ e^{\omega_m\cdot q - \|q\|^2/2}\end{pmatrix}}_{\tilde{q}} \cdot \frac{1}{m}\underbrace{\begin{pmatrix}e^{\omega_1\cdot k - \|k\|^2/2} \\ e^{\omega_2\cdot k - \|k\|^2/2} \\ \vdots \\ e^{\omega_m\cdot k - \|k\|^2/2}\end{pmatrix}}_{\tilde{k}}$$

由于最后还要对所有$k$的注意力归一化，所以去掉上式中的$1/m$、$-\|q\|^2/2$都不会影响最终结果，同时，如果假设$\omega_1,\omega_2,\cdots,\omega_m$的模长都相等（参考[JL引理](https://www.kexue.fm/archives/8679)），那么$k$的指数都减去$\|\omega_i\|^2/2$也不会影响结果。于是，Performer等价于用以下的格式做$\tilde{q}, \tilde{k}$：

$$\underbrace{\begin{pmatrix}e^{\omega_1\cdot q} \\ e^{\omega_2\cdot q} \\ \vdots \\ e^{\omega_m\cdot q}\end{pmatrix}}_{\tilde{q}} \cdot \underbrace{\begin{pmatrix}e^{-\|k-\omega_1\|^2/2} \\ e^{-\|k-\omega_2\|^2/2} \\ \vdots \\ e^{-\|k-\omega_m\|^2/2}\end{pmatrix}}_{\tilde{k}} \propto \underbrace{\begin{pmatrix}e^{\omega_1\cdot q} \\ e^{\omega_2\cdot q} \\ \vdots \\ e^{\omega_m\cdot q}\end{pmatrix}}_{\tilde{q}} \cdot \underbrace{\text{softmax}\begin{pmatrix}e^{-\|k-\omega_1\|^2/2} \\ e^{-\|k-\omega_2\|^2/2} \\ \vdots \\ e^{-\|k-\omega_m\|^2/2}\end{pmatrix}}_{\tilde{k}}$$

对比最后一个式子和Transformer-VQ的式(3)，就会发现它们有诸多相似之处：$\omega_1,\omega_2,\cdots,\omega_m$不就相当于编码表$C$？$\tilde{q}$不就相当于$\exp(QC^\top)$？至于最后的$\tilde{k}$，它以$-\|k-\omega_i\|^2/2$为logits做softmax，突出的不就是与$k$最相近的那个$\omega_i$？而softmax的极限就是one hot，所以这不正好对应着Transformer-VQ的$\Delta$矩阵？因此，这不能说一模一样，但也有六七分相似了。

## 依样葫芦

当然，上述结果更多的是一种形象的类比而不是等价性，因为Performer本质上基于完全不同的近似思路，比如它里边的$\omega_1,\omega_2,\cdots,\omega_m$是随机采样并固定下来的，这意味它们作为中心向量的近似程度其实是很差的。但这种类似引发了一个思考：能否模仿Performer的思路来重新推导一遍Transformer-VQ呢？即像式(4)一样，先构造一个精确相等的结果，然后再转化为采样近似来得到线性版本。

经过几天的思考，笔者发现了一种可以构造出期望推导的方案。首先，我们借助[狄拉克函数](https://www.kexue.fm/archives/1870)写出

$$e^{q\cdot k} = \int e^{q\cdot\omega}\delta(\omega - k)d\omega$$

这是纯粹由狄拉克函数的定义给出的恒等式，还没涉及到任何精巧的运算或者近似。然而，当我们将它代入Attention（的分子）时，出现了一些有意思的结果：

$$\sum_j e^{q\cdot k_j}v_j = \sum_j v_j \int e^{q\cdot\omega}\delta(\omega - k_j)d\omega = \int e^{q\cdot\omega}\left[\sum_j \delta(\omega - k_j)v_j\right]d\omega$$

最后一个等号，不就正好是线性Attention的形式？！当然，由于需要对$\omega$积分，所以上式跟[《Transformer升级之路：5、作为无限维的线性Attention》](https://www.kexue.fm/archives/8601)一样，都是"无限维"的线性Attention，暂时只有形式上的价值。

通常来说，我们会将$\delta(\omega - k_j)$理解为正态分布$\mathcal{N}(\omega; k_j, \sigma^2 I)$在$\sigma\to 0$的极限，这也意味着$\delta(\omega - k_j)$具有条件分布$p(\omega|k_j)$的意义。不过，从生成模型的角度来看，狄拉克函数就是单点分布，说白了就是把训练集背下来，所以它没有抽象和泛化能力。为了缓解这一点，我们将$p(\omega|k_j)$用GMM（Gaussian Mixture Model，高斯混合模型）来近似：

$$p(\omega|k_j) \approx \sum_{y=1}^m \mathcal{N}(\omega; c_y, \sigma^2 I)p(y|k_j)$$

代入上式，然后取$\sigma\to 0$的极限，我们就得到

$$\sum_j e^{q\cdot k_j}v_j \approx \sum_{y=1}^m e^{q\cdot c_y}\left[\sum_j p(y|k_j)v_j\right]$$

这就得到一个有限维的线性Attention。如果将$p(y|k_j)$对齐Transformer-VQ的one hot分布$\Delta$的定义，那么得到的结果就是Transformer-VQ的式(3)。

## 文章小结

本文介绍了笔者的一个发现：早期的线性Attention工作"Performer"可以视为一个"Soft"版的Transformer-VQ。然后，在这个观察上进一步得到了Transformer-VQ的一个新推导：利用狄拉克函数将标准Attention转化为无限维线性Attention，然后加上GMM近似就可以得到Transformer-VQ。

---

**转载地址**：https://www.kexue.fm/archives/9862

**引用格式**：

苏剑林. (Nov. 29, 2023). 《我在Performer中发现了Transformer-VQ的踪迹》[Blog post]. Retrieved from https://www.kexue.fm/archives/9862

```bibtex
@online{kexuefm-9862,
  title={我在Performer中发现了Transformer-VQ的踪迹},
  author={苏剑林},
  year={2023},
  month={Nov},
  url={\url{https://www.kexue.fm/archives/9862}},
}
```
