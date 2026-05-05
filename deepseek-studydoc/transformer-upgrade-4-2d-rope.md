# Transformer升级之路：4、二维位置的旋转式位置编码

> **作者**：苏剑林 | **日期**：2021-05-10 | **来源**：[科学空间](https://www.kexue.fm/archives/8397)

RoPE在CV领域的二维推广。二维位置不能简单展平为一维（$(x+1,y)$ 和 $(x,y+1)$ 与 $(x,y)$ 的距离应该一样）。

## 二维RoPE的解

经过矩阵指数推导，二维RoPE的一个解为：

$$R_{x,y} = \begin{pmatrix}\cos x\theta & -\sin x\theta & 0 & 0 \\ \sin x\theta & \cos x\theta & 0 & 0 \\ 0 & 0 & \cos y\theta & -\sin y\theta \\ 0 & 0 & \sin y\theta & \cos y\theta\end{pmatrix}$$

它将输入向量分为两半，一半施加 $x$ 的一维RoPE，一半施加 $y$ 的一维RoPE。满足两个关键性质：

1. **相对性**：$R_{x_1,y_1}^\top R_{x_2,y_2} = R_{x_2-x_1, y_2-y_1}$，实现绝对位置到相对位置的转换
2. **可逆性**：可从 $R_{x,y}$ 反解出 $(x,y)$，位置信息无损

## 推导历程

尝试了四元数（因非交换性行不通）和矩阵指数两种推导路径。矩阵指数路径：设 $R_{x,y}=\exp(xB_1+yB_2)$，从相对性条件推导出约束 $B_1^\top=-B_1, B_2^\top=-B_2, B_1B_2=B_2B_1$。通过4×4矩阵求解得到最终形式。

---

**转载地址**：https://www.kexue.fm/archives/8397

```bibtex
@online{kexuefm-8397, title={Transformer升级之路：4、二维位置的旋转式位置编码}, author={苏剑林}, year={2021}, month={May}, url={\url{https://www.kexue.fm/archives/8397}}}
```
