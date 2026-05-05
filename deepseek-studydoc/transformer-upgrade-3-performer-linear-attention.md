# Transformer升级之路：3、从Performer到线性Attention

> **作者**：苏剑林 | **日期**：2021-04-22 | **来源**：[科学空间](https://www.kexue.fm/archives/8338)

本文从Performer出发，反向思考线性Attention的最佳设计。

## 激活函数选择

Performer的核心是将标准Attention线性化：$e^{\boldsymbol{q}\cdot\boldsymbol{k}} \approx \tilde{\boldsymbol{q}}\cdot\tilde{\boldsymbol{k}}$。简化后等价于将 $\boldsymbol{q},\boldsymbol{k}$ 通过全连接层映射到 $m$ 维后加上 $\exp$ 激活。

结论：**线性Attention的最佳激活函数是 $\exp$**。

## 低秩问题

标准Attention矩阵（$e^{QK^\top}$）有"升秩"潜力（指数可提高矩阵秩），而线性Attention矩阵（$\tilde{Q}\tilde{K}^\top$）的秩一定不超过 $m$（一般为key_size）。所以线性Attention需要更大的 key_size（Performer用 $m=4d$）。

## 稀疏性

标准Attention通过 $e^x$ 放大差距，有潜力"集中注意力"（稀疏化）。线性Attention缺少这一放大，注意力偏稠密。实验验证：强行截断线性Attention为局部形式后效果明显提升，印证了稀疏性的重要性。语言模型（下三角矩阵）比双向MLM效果好，也因为下三角矩阵更稀疏且满秩。

## 结论

有效的Attention应当具备**更高的秩**和**更大的稀疏性**。线性Attention需用指数激活函数、更大key_size。

---

**转载地址**：https://www.kexue.fm/archives/8338

```bibtex
@online{kexuefm-8338, title={Transformer升级之路：3、从Performer到线性Attention}, author={苏剑林}, year={2021}, month={Apr}, url={\url{https://www.kexue.fm/archives/8338}}}
```
