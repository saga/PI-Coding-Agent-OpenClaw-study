# 为什么现在的LLM都是Decoder-only的架构？

> **作者**：苏剑林 | **日期**：2023-03-17 | **来源**：[科学空间](https://www.kexue.fm/archives/9529)

LLM是"Large Language Model"的简写，目前一般指百亿参数以上的语言模型，主要面向文本生成任务。跟小尺度模型（10亿或以内量级）的"百花齐放"不同，目前LLM的一个现状是Decoder-only架构的研究居多。那么，为什么Decoder-only架构会成为LLM的主流选择呢？

知乎上也有同款问题，上面的回答大多数聚焦于Decoder-only在训练效率和工程实现上的优势，那么它有没有**理论上的优势**呢？本文试图从这个角度进行简单的分析。

## 统一视角

任何NLP任务都可以分解为"输入"跟"输出"两部分，我们可以把处理"输入"的模型叫做Encoder，生成"输出"的模型叫做Decoder。

| | Encoder注意力 | Decoder注意力 | 是否共享参数 |
|--|--------------|--------------|------------|
| GPT | 单向 | 单向 | 是 |
| UniLM | 双向 | 单向 | 是 |
| T5 | 双向 | 单向 | 否 |

Google在T5和UL2两篇论文中做了较为充分的对比实验，结果均体现出了Encoder-Decoder架构相比于Decoder-only的优势。但由于模型尺度不大，以及多数的LLM确实都是在做Decoder-only的，所以这个优势能否延续到更大尺度的LLM依然没有答案。

## 对比实验

GPT跟UniLM相比才算是严格控制变量（输入部分的注意力改为双向 vs 单向），GPT跟T5相比则有两个变量：输入部分的注意力改为双向以及参数翻了一倍。

笔者的实验结果显示：**对于同样输入输出进行从零训练**，UniLM相比GPT并无任何优势，甚至某些任务更差。所以：

**输入部分的注意力改为双向不会带来收益，Encoder-Decoder架构的优势很可能只是源于参数翻倍。**

换句话说，在同等参数量、同等推理成本下，Decoder-only架构很可能是最优选择。

## 低秩问题

为什么"输入部分的注意力改为双向不会带来收益"呢？笔者猜测，这很可能是因为**双向注意力的低秩问题带来的效果下降**。

Attention矩阵一般是由一个低秩分解的矩阵加softmax而来。而Decoder-only架构的Attention矩阵是一个下三角阵，三角阵的行列式等于它对角线元素之积，由于softmax的存在对角线必然都是正数，所以Decoder-only架构的Attention矩阵一定是满秩的！满秩意味着理论上有更强的表达能力。

反过来，这个结论可以用来改进像BERT这样的双向注意力模型。在Multi-Head Attention中，一半Head用下三角阵（正向注意力），另一半用上三角阵（反向注意力），这样既保持了双向性，又融合了单向注意力的满秩优点。实验显示正反向混合的注意力在MLM任务上是比全双向注意力模型效果稍微要好点的。

## 文章小结

LLM之所以主要都用Decoder-only架构，除了训练效率和工程实现上的优势外，在理论上是因为Encoder的双向注意力会存在低秩问题，这可能会削弱模型表达能力，就生成任务而言，引入双向注意力并无实质好处。而Encoder-Decoder架构之所以能够在某些场景下表现更好，大概只是因为它多了一倍参数。

---

**转载地址**：https://www.kexue.fm/archives/9529

**引用格式**：

苏剑林. (Mar. 17, 2023). 《为什么现在的LLM都是Decoder-only的架构？》[Blog post]. Retrieved from https://www.kexue.fm/archives/9529

```bibtex
@online{kexuefm-9529,
  title={为什么现在的LLM都是Decoder-only的架构？},
  author={苏剑林},
  year={2023},
  month={Mar},
  url={\url{https://www.kexue.fm/archives/9529}},
}
```
