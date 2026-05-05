# Transformer升级之路：6、旋转位置编码的完备性分析

> **作者**：苏剑林 | **日期**：2022-12-28 | **来源**：[科学空间](https://www.kexue.fm/archives/9403)

在[《Transformer升级之路：2、博采众长的旋转式位置编码》](https://www.kexue.fm/archives/8265)中，笔者提出了旋转位置编码（RoPE），出发点是觉得用绝对位置来实现相对位置是一件"很好玩的事情"。后来，在[《Transformer升级之路：4、二维位置的旋转式位置编码》](https://www.kexue.fm/archives/8397)中，讨论了二维形式的RoPE，并研究了用矩阵指数表示的RoPE的一般解。

既然有了一般解，那么自然就会引出一个问题：我们常用的RoPE，只是一个以二维旋转矩阵为基本单元的分块对角矩阵，如果换成一般解，理论上效果会不会更好呢？本文就来回答这个问题。

## 指数通解

RoPE抽象地定义为任意满足下式的方阵

$$R_m^\top R_n = R_{n-m}$$

矩阵指数形式的解为

$$R_n = \exp nB$$

根据Baker–Campbell–Hausdorff公式推出 $B^\top = -B$，即要求 $B$ 是反对称矩阵。

## 正交通解

进一步地，有 $(\exp B)^\top(\exp B) = I$ 和 $\exp nB = (\exp B)^n$，说明 $\exp B$ 是正交矩阵。更宽泛的结论：

> 对于任意正交矩阵 $O$，$R_n = O^n$ 是满足条件的解。

## 完备分析

我们平时所用的RoPE是如下形式的分块对角矩阵：

$$R_n = \begin{pmatrix}R_{n\theta_0} & 0 & \cdots & 0 \\ 0 & R_{n\theta_1} & \cdots & 0 \\ \vdots & \vdots & \ddots & \vdots \\ 0 & 0 & \cdots & R_{n\theta_{d/2-1}}\end{pmatrix} = \exp n\begin{pmatrix}J_{\theta_0} & 0 & \cdots & 0 \\ 0 & J_{\theta_1} & \cdots & 0 \\ \vdots & \vdots & \ddots & \vdots \\ 0 & 0 & \cdots & J_{\theta_{d/2-1}}\end{pmatrix}$$

其中 $R_\theta = \begin{pmatrix}\cos\theta & -\sin\theta \\ \sin\theta & \cos\theta\end{pmatrix}$，$J_\theta = \begin{pmatrix}0 & -\theta \\ \theta & 0\end{pmatrix}$。

那么完备性问题：分块对角矩阵的特例相比全参数 $\exp nB$，是否有能力上的缺失？

对于任意偶数阶反对称矩阵，它都可以对角化为分块对角矩阵，即存在可逆矩阵 $P$，使得 $B = P\Lambda P^{-1}$，于是

$$\exp nB = P(\exp n\Lambda)P^{-1}$$

在Self Attention中应用RoPE时：

$$q^\top(\exp(n-m)B)k = (P^\top q)^\top(\exp(n-m)\Lambda)(P^{-1}k)$$

由于 $q,k$ 一般是输入 $x$ 经过可学习的线性变换而来，$P^\top, P^{-1}$ 原则上都可以吸收到训练参数中，因此直接设为 $q^\top(\exp(n-m)\Lambda)k$ 理论上不会损失一般性。

所以结论是：对于Self Attention来说，**目前的分块对角型RoPE不会损失一般性**。

---

**转载地址**：https://www.kexue.fm/archives/9403

**引用格式**：

苏剑林. (Dec. 28, 2022). 《Transformer升级之路：6、旋转位置编码的完备性分析》[Blog post]. Retrieved from https://www.kexue.fm/archives/9403

```bibtex
@online{kexuefm-9403,
  title={Transformer升级之路：6、旋转位置编码的完备性分析},
  author={苏剑林},
  year={2022},
  month={Dec},
  url={\url{https://www.kexue.fm/archives/9403}},
}
```
