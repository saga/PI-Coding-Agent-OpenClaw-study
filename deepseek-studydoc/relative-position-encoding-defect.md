# 相对位置编码Transformer的一个理论缺陷与对策

> **作者**：苏剑林 | **日期**：2022-06-07 | **来源**：[科学空间](https://www.kexue.fm/archives/9105)

目前相对位置编码几乎都是在Softmax之前的Attention矩阵上进行操作的，这种施加方式实际上都存在一个理论上的缺陷，使得Transformer无法成为"万能拟合器"。本文就来分析这个问题，并探讨一些解决方案。

## 无法胜任

笔者构思过一个简单的探针实验：

> 对于一个有识别位置能力的模型，应该有能力准确实现如下映射
>
> 输入：$[0,0,\cdots,0,0] \longrightarrow$ 输出：$[1,2,\cdots,n-1,n]$

也就是说，输入 $n$ 个0，能有序地输出位置编号 $1\sim n$。绝对位置由于是直接施加在输入上的，很容易能够完成探针测试。然而，除了经典相对位置编码外，其余所有相对位置编码（包括RoPE）都只修改了Softmax前的Attention矩阵，那么带有相对位置信息的Attention矩阵依然是一个概率矩阵（即每一行求和等于1）。

对于Transformer，Token之间交互的唯一来源是 $o_i = \sum_j a_{i,j}v_j$。相同的输入意味着每个 $v_j$ 都是相同的，所以

$$o_i = \sum_j a_{i,j}v_j = \sum_j a_{i,j}v = \left(\sum_j a_{i,j}\right)v = v$$

这意味着每个 $o_i$ 也是相同的，模型根本不可能输出各不相同的 $[1,2,\cdots,n-1,n]$。

## 对策

问题出在Attention矩阵的每一行求和等于1。解决方案包括：

1. **加参数矩阵**：$O = (A\odot C)V$，其中 $C$ 为Toeplitz矩阵，$c_{i,j} = g(i-j)$

2. **去掉分母**：GAU用relu²激活然后除以 $n$ 归一化，避免了概率归一化

3. **换用 $l_2$ 归一化**：$a_{i,j} = e^{b_{i,j}} / \sqrt{\sum_j e^{2b_{i,j}}}$，能成功完成探针实验

笔者实验显示：对于标准的Attention+FFN组合，$l_2$ 归一化略差于常规的 $l_1$ 归一化；对于全GAU架构，$l_2$ 归一化略优于常规 $l_1$ 归一化。

## 峰回路转

如果输入不是全0，比如像BERT那样补充标记Token（[CLS]、[SEP]），那么即使不修改相对位置编码Transformer的其他部分，也能够完成探针实验。这说明BERT添加的特殊Token还有辅助定位的作用！这不禁让人想起CNN是通过padding来识别绝对位置的结论。

---

**转载地址**：https://www.kexue.fm/archives/9105

**引用格式**：

苏剑林. (Jun. 07, 2022). 《相对位置编码Transformer的一个理论缺陷与对策》[Blog post]. Retrieved from https://www.kexue.fm/archives/9105

```bibtex
@online{kexuefm-9105,
  title={相对位置编码Transformer的一个理论缺陷与对策},
  author={苏剑林},
  year={2022},
  month={Jun},
  url={\url{https://www.kexue.fm/archives/9105}},
}
```
