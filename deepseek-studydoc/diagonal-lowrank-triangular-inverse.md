# "对角+低秩"三角阵的高效求逆方法

> **作者**：苏剑林 | **日期**：2025-07-01 | **来源**：[科学空间](https://www.kexue.fm/archives/11072)

从文章[《线性注意力简史：从模仿、创新到反哺》](https://www.kexue.fm/archives/11033)我们可以发现，DeltaNet及其后的线性Attention模型，基本上都关联到了逆矩阵 $(I + KK^\top \odot M^-)^{-1}$。本文就专门来探讨一下这类具有"对角+低秩"特点的三角矩阵的逆矩阵计算。

## 基本结果

我们将问题一般地定义如下：

> 给定矩阵 $Q, K \in \mathbb{R}^{n \times d}$ 和对角矩阵 $\Lambda \in \mathbb{R}^{n \times n}$，满足 $n \gg d$，定义
>
> $$T = \Lambda + QK^\top \odot M^-$$
>
> 其中 $M^- = M - I$，矩阵M定义为
>
> $$M_{i,j} = \begin{cases} 1, & i \geq j \\ 0, & i < j \end{cases}$$
>
> 现在要求逆矩阵 $T^{-1}$，并且证明其复杂度是 $O(n^2)$。

首先，如果没有 $\odot M^-$ 的下三角阵约束，那么它可以直接由"[Woodbury恒等式](https://en.wikipedia.org/wiki/Woodbury_matrix_identity)"解决：

$$(\Lambda + QK^\top)^{-1} = \Lambda^{-1} - \Lambda^{-1}Q(I + K^\top \Lambda^{-1}Q)^{-1}K^\top \Lambda^{-1}$$

容易验证右端的计算复杂度是 $O(n^2)$ 的。然而，加上 $\odot M^-$ 后，T本身就不再具有"对角+低秩"的结构，因此不能直接由该恒等式解决了。针对下三角矩阵这一特点，一个基本的思路是递归，因为我们有分块矩阵恒等式

$$\begin{bmatrix} A & 0 \\ C & B \end{bmatrix}^{-1} = \begin{bmatrix} A^{-1} & 0 \\ -B^{-1}CA^{-1} & B^{-1} \end{bmatrix}$$

这允许我们将 $T^{-1}$ 转化递归形式

$$T[:l+1,:l+1]^{-1} = \begin{bmatrix} T[:l,:l]^{-1} & 0 \\ -T[l:l+1,l:l+1]^{-1}T[l:l+1,:l]T[:l,:l]^{-1} & T[l:l+1,l:l+1]^{-1} \end{bmatrix}$$

其中主要计算是 $T[l:l+1,:l]T[:l,:l]^{-1}$，它是一个 $1 \times l$ 和 $l \times l$ 矩阵相乘，复杂度是 $O(l^2)$，即每一步迭代的复杂度是平方增长的，所以总复杂度是 $O(n^3)$。

## 低秩结构

当然，这是因为我们还没用上T（$\odot M^-$ 前）的低秩结构，现在我们把它利用起来，那么将会得到 $T[l:l+1,:l] = Q[l:l+1]K[:l]^\top$，代入上式得：

$$T[:l+1,:l+1]^{-1} = \begin{bmatrix} T[:l,:l]^{-1} & 0 \\ -T[l:l+1,l:l+1]^{-1}Q[l:l+1]K[:l]^\top T[:l,:l]^{-1} & T[l:l+1,l:l+1]^{-1} \end{bmatrix}$$

注意 $K[:l]^\top T[:l,:l]^{-1} \in \mathbb{R}^{d \times l}$，如果我们能以它为递归变量，那么每一步迭代的复杂度就只是 $O(l)$，总复杂度就能成功降到 $O(n^2)$。

测试代码如下：

```python
import numpy as np

n, d, c = 1000, 100, 200
Q = np.random.randn(n, d) / d**0.5
K = np.random.randn(n, d) / d**0.5
T = np.tril(Q @ K.T, -1) + np.eye(n)

Y, Z = np.zeros((n, n)), np.zeros((d, n))
for l in range(0, n, c):
    Y[l:l + c, l:l + c] = np.linalg.inv(T[l:l + c, l:l + c])
    Y[l:l + c, :l] = - Y[l:l + c, l:l + c] @ Q[l:l + c] @ Z[:, :l]
    Z[:, :l + c] += K[l:l + c].T @ Y[l:l + c, :l + c]

np.allclose(Y @ T, np.eye(n))
```

## 乘法计算

基于同样的思路，我们还可以证明：

> 对于任意矩阵 $V \in \mathbb{R}^{n \times d}$，计算 $T^{-1}V$ 只需要 $O(n)$ 的复杂度。

证明只需要把前述过程稍微改动一下。首先有

$$(T^{-1}V)[:l+1] = \begin{bmatrix} (T^{-1}V)[:l] \\ T[l:l+1,l:l+1]^{-1}(V[l:l+1] - Q[l:l+1]K[:l]^\top(T^{-1}V)[:l]) \end{bmatrix}$$

然后

$$K[:l+1]^\top(T^{-1}V)[:l+1] = K[:l]^\top(T^{-1}V)[:l] + K[l:l+1]^\top(T^{-1}V)[l:l+1]$$

因此，只需要缓存 $K[:l]^\top(T^{-1}V)[:l] \in \mathbb{R}^{d \times d}$，就可以使得每步的计算复杂度与l无关，因此总复杂度是 $O(n)$。同样，只需要将l+1换成l+c就可以得到chunk格式。

测试代码如下：

```python
import numpy as np

n, d, c = 1000, 100, 200
Q = np.random.randn(n, d) / d**0.5
K = np.random.randn(n, d) / d**0.5
V = np.random.randn(n, d) / d**0.5
T = np.tril(Q @ K.T, -1) + np.eye(n)

Y, Z = np.zeros((n, d)), np.zeros((d, d))
for l in range(0, n, c):
    X = np.linalg.inv(T[l:l + c, l:l + c])
    Y[l:l + c] = X @ (V[l:l + c] - Q[l:l + c] @ Z)
    Z += K[l:l + c].T @ Y[l:l + c]

np.allclose(T @ Y, V)
```

## 文章小结

本文讨论了"对角+低秩"特点的三角矩阵求逆问题，这类矩阵普遍出现在新式线性Attention模型中。

---

**转载地址**：https://www.kexue.fm/archives/11072

**引用格式**：

苏剑林. (Jul. 01, 2025). 《"对角+低秩"三角阵的高效求逆方法》[Blog post]. Retrieved from https://www.kexue.fm/archives/11072

```bibtex
@online{kexuefm-11072,
  title={"对角+低秩"三角阵的高效求逆方法},
  author={苏剑林},
  year={2025},
  month={Jul},
  url={\url{https://www.kexue.fm/archives/11072}},
}
```
