# 让研究人员绞尽脑汁的Transformer位置编码

> **作者**：苏剑林 | **日期**：2021-02-03 | **来源**：[科学空间](https://www.kexue.fm/archives/8130)

本文汇总Transformer中各种位置编码设计方案。

## 绝对位置编码

- **训练式**（BERT/GPT）：直接将位置编码当作可训练参数（512×768矩阵）。缺点：无外推性，但层次分解可缓解
- **三角式（Sinusoidal）**：$p_{k,2i}=\sin(k/10000^{2i/d})$。特点：显式生成规律，有一定外推性，可表达相对位置
- **递归式（FLOATER）**：用ODE $dp_t/dt = h(p_t,t)$ 建模位置编码，ICML 2020
- **相乘式**：$x_k \otimes p_k$（逐位相乘），可能优于相加

## 相对位置编码

- **经典式**（NEZHA）：相对位置向量 $\mathbf{R}_{i,j} = \mathbf{p}[\text{clip}(i-j, p_{\min}, p_{\max})]$
- **XLNET式**：展开 $q_i k_j^\top$ 后替换位置项，引入可训练向量 $\mathbf{u},\mathbf{v}$
- **T5式**：简化为 $\mathbf{x}_i W_Q W_K^\top \mathbf{x}_j^\top + \beta_{i,j}$（分桶策略）
- **DeBERTa式**：保留"输入-位置"和"位置-输入"交互项，去掉"位置-位置"

## 融合式（后来发展为RoPE）

将 $\mathbf{q}_m, \mathbf{k}_n$ 分别乘以 $e^{im\theta}, e^{in\theta}$：
$$\langle \mathbf{q}_m e^{im\theta}, \mathbf{k}_n e^{in\theta}\rangle = \text{Re}[\mathbf{q}_m \mathbf{k}_n^* e^{i(m-n)\theta}]$$
内积只依赖相对位置！用绝对位置操作达到了相对位置效果。

---

**转载地址**：https://www.kexue.fm/archives/8130

```bibtex
@online{kexuefm-8130, title={让研究人员绞尽脑汁的Transformer位置编码}, author={苏剑林}, year={2021}, month={Feb}, url={\url{https://www.kexue.fm/archives/8130}}}
```
