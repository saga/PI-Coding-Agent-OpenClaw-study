# Transformer升级之路：5、作为无限维的线性Attention

> **作者**：苏剑林 | **日期**：2021-08-06 | **来源**：[科学空间](https://www.kexue.fm/archives/8601)

本文将介绍将标准Attention转换为无限维线性Attention的两种确定性思路。标准Attention可以视作一个无限维的线性Attention。

标准Attention：$a_{i,j} = \frac{e^{q_i\cdot k_j}}{\sum_j e^{q_i\cdot k_j}}$
线性Attention：$a_{i,j} = \frac{\phi(q_i)\cdot \varphi(k_j)}{\sum_j \phi(q_i)\cdot \varphi(k_j)}$

## 泰勒展开方案

$$e^{q\cdot k} = \sum_{m=0}^{\infty}\frac{(q\cdot k)^m}{m!}$$

利用外积（张量积），$(q\cdot k)^m = (\otimes^m q)\cdot(\otimes^m k)$，于是：

$$e^{q\cdot k} \approx \begin{pmatrix}1 \\ q \\ \frac{\otimes^2 q}{\sqrt{2}} \\ \vdots \\ \frac{\otimes^n q}{\sqrt{n!}}\end{pmatrix} \cdot \begin{pmatrix}1 \\ k \\ \frac{\otimes^2 k}{\sqrt{2}} \\ \vdots \\ \frac{\otimes^n k}{\sqrt{n!}}\end{pmatrix}$$

## 指数定义方案

利用 $e^x = \lim_{n\to\infty}(1 + \frac{x}{n})^n$：

$$e^{q\cdot k} \approx \left(1 + \frac{q\cdot k}{n}\right)^n = \left(\begin{pmatrix}1 \\ \frac{q}{\sqrt{n}}\end{pmatrix}\cdot \begin{pmatrix}1 \\ \frac{k}{\sqrt{n}}\end{pmatrix}\right)^n$$

$$= \otimes^n\begin{pmatrix}1 \\ \frac{q}{\sqrt{n}}\end{pmatrix} \cdot \otimes^n\begin{pmatrix}1 \\ \frac{k}{\sqrt{n}}\end{pmatrix}$$

## 实用价值分析

确定性的方案输出维度是 $d^n$ 级别，远超序列长度，做线性Attention效率比标准Attention还差。实用价值不如Performer的随机投影方案，但它们提供了简明视角将标准Attention跟无限维线性Attention等价起来。

这种等价性最直接的启示是关于Attention的秩：线性Attention由于 $\phi(Q),\varphi(K)\in\mathbb{R}^{n\times d}$，Attention矩阵的秩顶多为 $d$（低秩瓶颈）。而标准Attention可视为无限维线性Attention，所以其秩不受限于 $d$。

---

**转载地址**：https://www.kexue.fm/archives/8601

**引用格式**：

苏剑林. (Aug. 06, 2021). 《Transformer升级之路：5、作为无限维的线性Attention》[Blog post]. Retrieved from https://www.kexue.fm/archives/8601

```bibtex
@online{kexuefm-8601,
  title={Transformer升级之路：5、作为无限维的线性Attention},
  author={苏剑林},
  year={2021},
  month={Aug},
  url={\url{https://www.kexue.fm/archives/8601}},
}
```
