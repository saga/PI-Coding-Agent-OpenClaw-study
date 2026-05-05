# DeltaNet的核心逆矩阵的元素总是在[-1, 1]内

> **作者**：苏剑林 | **日期**：2026-01-26 | **来源**：[科学空间](https://www.kexue.fm/archives/11563)

从[《线性注意力简史：从模仿、创新到反哺》](https://www.kexue.fm/archives/11033)中我们可以看到，DeltaNet的并行形式涉及到了形如 $(I+KK^\top \odot M^-)^{-1}$ 的逆矩阵。近日读者 @Arch123 提出，通过实验可观察到该逆矩阵的元素总是在 $[-1,1]$ 内，问是否可以从数学上证实或证伪它。

在这篇文章中，我们将通过两种不同的方式证明这个结论是严格成立的。

## 问题描述

首先，我们准确地重述一下问题。设有矩阵 $K = [k_1, k_2, \cdots, k_n]^\top \in \mathbb{R}^{n \times d}$，其中每个 $k_i \in \mathbb{R}^{d \times 1}$ 是模长不超过1的列向量，$M \in \mathbb{R}^{n \times n}$ 是一个下三角的掩码矩阵，定义为

$$M_{i,j} = \begin{cases} 1, & i \geq j \\ 0, & i < j \end{cases}$$

I是单位阵，$M^- = M - I$。我们要证明的是：

$$(I + KK^\top \odot M^-)^{-1} \in [-1,1]^{n \times n}$$

记 $X = I + KK^\top \odot M^-$，它的逆矩阵记为Y，将X显式写出来是

$$X = I + KK^\top \odot M^- = \begin{pmatrix} 1 & 0 & 0 & \cdots & 0 & 0 \\ k_1^\top k_2 & 1 & 0 & \cdots & 0 & 0 \\ k_1^\top k_3 & k_2^\top k_3 & 1 & \cdots & 0 & 0 \\ \vdots & \vdots & \vdots & \ddots & \vdots & \vdots \\ k_1^\top k_{n-1} & k_2^\top k_{n-1} & k_3^\top k_{n-1} & \cdots & 1 & 0 \\ k_1^\top k_n & k_2^\top k_n & k_3^\top k_n & \cdots & k_{n-1}^\top k_n & 1 \end{pmatrix}$$

由于每个 $k_i$ 的模长都不超过1，显然X的每个元素都在 $[-1,1]$ 内，我们要证明的是 $Y = X^{-1}$ 的每个元素也都在 $[-1,1]$ 内。

## 数学归纳

既然这个逆矩阵出现在DeltaNet中，那么它肯定是有明显的模型背景的，结合这些背景也许能帮助我们更快地证明它，这部分我们留到下一节。这一节我们还是将它当作一个纯粹的数学问题去思考。

### 对角性质

在[《"对角+低秩"三角阵的高效求逆方法》](https://www.kexue.fm/archives/11072)我们已经体会过，下三角矩阵有一些优良性质，首先它对矩阵乘法封闭，其次它满足"逆矩阵的对角线等于对角线的逆"，这还可以推广到块下三角矩阵，即"逆矩阵的对角块等于对角块的逆"。

由此，我们有 $Y[:n-1,:n-1] = (X[:n-1,:n-1])^{-1}$ 以及 $Y[1:,1:] = (X[1:,1:])^{-1}$，其中切片按Numpy理解。这一性质启发我们可以对n使用数学归纳法。假设结论对任意满足条件的 $(n-1) \times d$ 的K矩阵成立，那么对于矩阵X，我们只需要考虑如下两种分块方式，然后根据 $Y[:n-1,:n-1] = (X[:n-1,:n-1])^{-1}$ 和 $Y[1:,1:] = (X[1:,1:])^{-1}$，就可以证明Y除左下角的 $Y_{n,1}$ 外的所有元素都在 $[-1,1]$ 内，所以只需要补充证明 $Y_{n,1} \in [-1,1]$。

### 伴随矩阵

为证 $Y_{n,1} \in [-1,1]$，我们考虑用[伴随矩阵](https://en.wikipedia.org/wiki/Adjugate_matrix)将 $X^{-1}$ 显式表示出来。由于X是一个下三角矩阵并且对角线都是1，所以它的行列式为1，于是根据伴随矩阵的求逆公式，我们有

$$Y_{n,1} = (-1)^{n+1} \det\begin{pmatrix} k_1^\top k_2 & 1 & 0 & \cdots & 0 & 0 \\ k_1^\top k_3 & k_2^\top k_3 & 1 & \cdots & 0 & 0 \\ \vdots & \vdots & \vdots & \ddots & \vdots & \vdots \\ k_1^\top k_{n-1} & k_2^\top k_{n-1} & k_3^\top k_{n-1} & \cdots & k_{n-2}^\top k_{n-1} & 1 \\ k_1^\top k_n & k_2^\top k_n & k_3^\top k_n & \cdots & k_{n-2}^\top k_n & k_{n-1}^\top k_n \end{pmatrix}$$

这是在下三角矩阵的基础上将次对角线元素都变成了1，所以行列式的计算更为复杂一些，但也不算特别复杂，因为最后一列只有两个非零元素，因此按照最后一列来展开行列式计算，它就转化成了两个 $n-1$ 阶的行列式相减，这一特点依然将我们向数学归纳法引导。

### 连乘形式

我们可以尝试手算前几个结果：

$$Y_{2,1} = -k_1^\top k_2$$

$$Y_{3,1} = \det\begin{pmatrix} k_1^\top k_2 & 1 \\ k_1^\top k_3 & k_2^\top k_3 \end{pmatrix} = k_1^\top k_2 k_2^\top k_3 - k_1^\top k_3 = -k_1^\top (I - k_2 k_2^\top) k_3$$

$$Y_{4,1} = -k_1^\top (I - k_2 k_2^\top)(I - k_3 k_3^\top) k_4$$

由此可以猜测

$$Y_{n,1} = -k_1^\top (I - k_2 k_2^\top)(I - k_3 k_3^\top) \cdots (I - k_{n-1} k_{n-1}^\top) k_n$$

请大家自行通过数学归纳法证明这个猜测。假设大家已经完成了这个猜测的证明，那么接着根据条件 $\|k_i\| \leq 1$，可得 $\|(I - k_i k_i^\top)x\|_2 = \|x\|_2 + (k_i^\top x)^2(\|k_i\|_2^2 - 2) \leq \|x\|_2$，因此

$$|Y_{n,1}| \leq \|k_1\| \times \|(I - k_2 k_2^\top)(I - k_3 k_3^\top) \cdots (I - k_{n-1} k_{n-1}^\top) k_n\| \leq \|k_1\| \times \|k_n\| \leq 1$$

这就完成了 $Y_{n,1} \in [-1,1]$ 的证明，继而由数学归纳法知 $Y \in [-1,1]^{n \times n}$ 恒成立。

## 双重计算

上一节的直接证明显得比较"暴力"，后来FLA群的 @zhxlin 同学提醒，我们可以回到该逆矩阵的原始背景——DeltaNet，用两种不同的方式对DeltaNet进行计算，通过对照结果得出逆矩阵的显式表达式，从而完成一个相对比较简洁的证明。

### 逆阵形式

我们知道，DeltaNet的递归形式是

$$S_t = S_{t-1}(I - k_t k_t^\top) + v_t k_t^\top = S_{t-1} + (v_t - S_{t-1} k_t) k_t^\top$$

其中 $S_0 = 0$。先看第二个等号，定义 $u_t = v_t - S_{t-1} k_t$，那么

$$S_t = S_{t-1} + u_t k_t^\top = \sum_{i=1}^{t} u_i k_i^\top$$

所以

$$u_t = v_t - S_{t-1} k_t = v_t - \left(\sum_{i=1}^{t-1} u_i k_i^\top\right) k_t = v_t - \sum_{i=1}^{t-1} u_i (k_i^\top k_t)$$

定义 $U = [u_1, u_2, \cdots, u_n]^\top, V = [v_1, v_2, \cdots, v_n]^\top$，上式等价于 $U = V - (KK^\top \odot M^-)U$，或 $U = (I + KK^\top \odot M^-)^{-1}V$，这便是逆矩阵 $(I + KK^\top \odot M^-)^{-1}$ 的来源，它是DeltaNet及其后续工作如GDN、KDA等并行计算的关键。

### 递推展开

再看第一个等号，直接逐次展开得

$$S_t = v_1 k_1^\top H_{2 \to t} + \cdots + v_{t-1} k_{t-1}^\top H_{t \to t} + v_t k_t^\top = \sum_{i=1}^{t} v_i k_i^\top H_{i+1 \to t}$$

这里 $H_{r \to t} \triangleq (I - k_r k_r^\top)(I - k_{r+1} k_{r+1}^\top) \cdots (I - k_t k_t^\top)$，并约定 $H_{t+1 \to t} = I$。

将上式代入 $u_t$ 的定义得

$$u_t = v_t - S_{t-1} k_t = v_t - \sum_{i=1}^{t-1} v_i k_i^\top H_{i+1 \to t-1} k_t$$

### 对比结果

仍记 $Y = (I + KK^\top \odot M^-)^{-1}$，那么 $U = YV$ 给出 $u_t = \sum_{i=1}^{n} Y_{t,i} v_i$，对照上式可以读出

$$Y_{t,i} = \begin{cases} 0, & i > t \\ 1, & i = t \\ -k_i^\top H_{i+1 \to t-1} k_t, & i < t \end{cases}$$

因此只需要证明 $|k_i^\top H_{i+1 \to t-1} k_t| \leq 1$，这由 $\|k_i\| \leq 1$ 以及第一个证明证得的 $\|(I - k_i k_i^\top)x\| \leq \|x\|$ 立马可得

$$|k_i^\top H_{i+1 \to t-1} k_t| \leq \|k_i\| \times \|H_{i+1 \to t-1} k_t\| \leq \|k_i\| \times \|k_t\| \leq 1$$

因此待证结论成立。

## 文章小结

本文给出了DeltaNet中的核心逆矩阵的有界性的两个证明。

---

**转载地址**：https://www.kexue.fm/archives/11563

**引用格式**：

苏剑林. (Jan. 26, 2026). 《DeltaNet的核心逆矩阵的元素总是在[-1, 1]内》[Blog post]. Retrieved from https://www.kexue.fm/archives/11563

```bibtex
@online{kexuefm-11563,
  title={DeltaNet的核心逆矩阵的元素总是在[-1, 1]内},
  author={苏剑林},
  year={2026},
  month={Jan},
  url={\url{https://www.kexue.fm/archives/11563}},
}
```
