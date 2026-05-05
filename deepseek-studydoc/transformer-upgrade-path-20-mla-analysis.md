# Transformer升级之路：20、MLA好在哪里?（上）

> **作者**：苏剑林 | **日期**：2025-05-04 | **来源**：[科学空间](https://www.kexue.fm/archives/10907)

自从DeepSeek爆火后，它所提的Attention变体MLA（**M**ulti-head **L**atent **A**ttention）也愈发受到关注。MLA通过巧妙的设计实现了MHA与MQA的自由切换，使得模型可以根据训练和推理的不同特性（Compute-Bound or Memory-Bound）选择最佳的形式，尽可能地达到效率最大化。

诚然，MLA很有效，但也有观点认为它不够优雅，所以寻找MLA替代品的努力一直存在，包括我们也有在尝试。然而，经过一段时间的实验，我们发现很多KV Cache相同甚至更大的Attention变体，最终效果都不如MLA。这不得不让我们开始反思：MLA的出色表现背后的关键原因究竟是什么？

接下来，本文将详细介绍笔者围绕这一问题的思考过程以及相关实验结果。

## 观察

MLA提出自[DeepSeek-V2](https://papers.cool/arxiv/2405.04434)，本文假设读者已经熟悉MLA，至少了解之前的博客[《缓存与效果的极限拉扯：从MHA、MQA、GQA到MLA》](https://www.kexue.fm/archives/10091)所介绍的内容，因此MLA自身的细节将不会过多展开。

MLA的主要特点如下：

> 1、MLA在训练阶段是一个qk_head_dims=(128+64)、v_head_dims=128的MHA；
> 
> 2、MLA在解码阶段是一个qk_head_dims=(512+64)、v_head_dims=512、KV-Shared的MQA；
> 
> 3、MLA的[qc, qr]、[kc, kr]拼接，可以理解为一种[Partial RoPE](https://www.kexue.fm/archives/10122#%E9%83%A8%E5%88%86%E6%97%8B%E8%BD%AC)。

## 猜测

MHA、GQA常用的head_dims是128，而对于MLA来说，不管是从训练看的128+64，还是从推理看的512+64，都要大于128，再结合[《突破瓶颈，打造更强大的Transformer》](https://www.kexue.fm/archives/7325)的经验，我们有：

> **猜测1**： 增大head_dims是MLA好的关键之一。

另外，KV-Shared这个特性，可以在同等KV Cache大小下，增大GQA的head_dims或者num_groups，所以有：

> **猜测2**： KV-Shared是MLA好的关键之一。

最后，此前有一些理论和实验显示Partial RoPE可能会对效果有正面帮助（参考[《Transformer升级之路：18、RoPE的底数选择原则》](https://www.kexue.fm/archives/10122#%E9%83%A8%E5%88%86%E6%97%8B%E8%BD%AC)），所以有

> **猜测3**： Partial RoPE是MLA好的关键之一。

## 实验

现在我们通过实验逐一检验以上猜测。

### 设置

所有实验公共部分的超参数如下：

> 1、类似LLAMA3的Dense模型；
> 
> 2、hidden_size=2048，num_layers=12，num_heads=16；
> 
> 3、优化器是[Muon](https://www.kexue.fm/archives/10592)，Attention部分per head更新；
> 
> 4、训练长度为4096，总tokens数为16B，总训练步数为16k；
> 
> 5、所有实验都是只改变Attention，所以参数量不会严格对齐。

### Part I

MLA的KV Cache大小是512+64，约等于GQA2-128（第一个数字是num_groups，第二个数字是head_dims），所以对比的baseline为**GQA2-128**和**GQA1-256**。为了验证Partial RoPE，我们增加了**GQA1-256-PR**，具体做法是将Q、K的256 dims分成192+64两部分，在64上加RoPE，192不加。

结果如下：

| | Params | Loss | Cache |
|---|---|---|---|
| MLA | 894 M | 2.721 | 576 |
| GQA2-128 | 842 M | 2.75 | 512 |
| GQA1-256 | 943 M | 2.72 | 512 |
| GQA1-256-PR | 943 M | 2.711 | 512 |

即

**GQA2-128 < MLA ≲ GQA1-256 < GQA1-256-PR**

初步验证了增大head_dims和Partial RoPE的作用。这样看来，MLA的设计中，RoPE和NoPE拼接这部分看似无奈的设计，极有可能是它效果优异的关键原因！原论文声称MLA甚至优于MHA，大概率也是因为所对比的MHA的head_dims只有128。

### Part II

为了进一步验证增大head_dims的作用，我们另外跑了MHA、GQA2-192、MLA-256三个实验，MHA是head_dims=128的常规MHA，GQA2-192是直接增大GQA2的head_dims到192，MLA-256是将MLA的128+64提升到192+64，对照如下

| | Params | Loss | Cache |
|---|---|---|---|
| MHA | 931 M | 2.721 | 4096 |
| MLA | 894 M | 2.721 | 576 |
| MLA-256 | 989 M | 2.705 | 576 |
| GQA2-128 | 842 M | 2.75 | 512 |
| GQA2-192 | 899 M | 2.729 | 768 |
| GQA1-256 | 943 M | 2.72 | 512 |
| GQA1-256-PR | 943 M | 2.711 | 512 |

可以看到，MHA总参数量更多，KV Cache更是7倍于MLA，但Loss才堪堪追平MLA，这跟DeepSeek-V2里边的结论接近。此外，GQA2-192优于GQA2-128，但不如GQA1-256；MLA的head_dims升到(192+64)后，相比(128+64)也还能进一步提升效果。这些现象都表明，增加head_dims远比增加num_groups更有效。

### Part III

接下来我们验证KV-Shared，即K、V共享全部或大部分dims。这里我们主要考虑的替代品是head_dims不超过256的GQA，并且控制KV Cache的总大小跟MLA接近，所以当KV-Shared时，我们可以至多可以考虑GQA2-256。

由于KV-Shared跟RoPE不完全兼容，参考MLA的做法，我们将256分成192+64两部分，其中

1、192部分不加RoPE，在K、V间共享；

2、64部分加RoPE，只用于K；

3、V另外再投影64 dims，concat到共享的192 dims上去。

这样一来，K、V的head_dims都是256，KV Cache总大小是(192+64+64)*2=640，略大于MLA的512+64=576，这个版本我们简记为"**GQA2-(192+64)-S1**"，其实"S1"是"Shared-1"的缩写。

### Part IV

另外一种KV-Shared的方案是：

1、192部分不加RoPE，在K、V间共享；

2、64部分加RoPE，同样在K、V间共享；

3、做Attention，由于V带RoPE，此时是绝对位置编码效果；

4、为了保证相对位置编码，将输出分成192+64两部分，64部分再加一次逆向RoPE。

这种做法是K、V完全共享，KV Cache大小是(192+64)*2=512，略小于MLA。这个版本我们称为"**GQA2-(192+64)-S2**"，"S2"是"Shared-2"的缩写，背后的原理是笔者新提出的VO-RoPE，参考[《Transformer升级之路：19、第二类旋转位置编码》](https://www.kexue.fm/archives/10862)。

### Part V

另外，根据同样思路补了几个GQA4和GQA1的实验。所有实验结果汇总如下：

| | Params | Loss | Cache | 备注 |
|---|---|---|---|---|
| MLA | 894 M | 2.721 | 576 | |
| MLA-256 | 989 M | 2.705 | 576 | |
| GQA2-(192+64)-S1 | 946 M | 2.714 | 640 | |
| GQA2-(192+64)-S2 | 943 M | 2.708 | 512 | 引入VO-RoPE |
| GQA4-(64+64)-S2 | 842 M | 2.738 | 512 | |
| GQA4-(128+64)-S2 | 899 M | 2.713 | 768 | KV Cache最大 |
| GQA1-(512+64)-S3 | 1171 M | 2.677 | 576 | head_dims最大 |

这里"**GQA1-(512+64)-S3**"是按照MLA的推理形式实现的MQA，形式介乎S1与S2之间，它的主要特点是head_dims大。

结果解读：

1、KV-Shared的GQA自带Partial RoPE；

2、KV-Shared的GQA2-256，也能超过MLA；

3、VO-RoPE的引入，似乎有利于效果（S1 ≲ S2）；

4、同等KV Cache下，head_dims越大越好；

5、GQA2-(192+64)-S2 略微超过 GQA1-256-PR；

6、GQA4-(128+64)-S2 的KV Cache最大，但效果不是最优，再次表明head_dims更关键。

关于KV-Shared，还有两点观察：

1、训练过程中，GQA1-256-PR前期是明显领先GQA2-(192+64)-S2，但后期被追平甚至略微反先，猜测GQA1-256-PR可能有后劲不足的嫌疑；

2、如果没有KV-Shared，GQA顶多是GQA1-256，也就是说head_dims顶天了256，但有KV-Shared的话，GQA可以做到GQA1-512-S，单纯从head_dims看，KV-Shared天花板更高。

### Part VI

由于没有严格对齐参数量，可能读者会有"到底是增加参数量还是增加head_dims更本质"的疑虑，所以这里补充几个对齐参数量的实验。

这里考虑的对齐参数量的方式有三种：

1、**double-heads**：以"GQA2-128 vs GQA1-256"为例，将GQA2-128的num_heads翻倍，可以让GQA2-128的参数量跟GQA1-256相同；

2、**缩减MLP**：缩小FFN的中间层维度，腾出参数给Attention；

3、**增加层数**：保持每层参数量不变，通过增加层数来对齐总参数量。

实验结果如下：

| 对齐方式 | GQA2-128 | GQA1-256 | GQA1-256-PR |
|---|---|---|---|
| 原始 | 2.75 | 2.72 | 2.711 |
| double-heads | 2.737 | 2.72 | 2.711 |
| 缩减MLP | 2.741 | 2.72 | 2.711 |
| 增加层数 | 2.739 | 2.72 | 2.711 |

可以看到，对齐参数量后，GQA1-256依然优于GQA2-128，这说明增大head_dims确实比增加num_groups更本质。

### Part VII

最后，我们考虑一个极端情况：如果head_dims无限大，效果会不会一直提升？

这里我们跑了GQA1-1024-PR的实验，即将head_dims提升到1024，其中896不加RoPE，128加RoPE。结果如下：

| | Params | Loss | Cache |
|---|---|---|---|
| GQA1-256-PR | 943 M | 2.711 | 512 |
| GQA1-512-PR | 1171 M | 2.693 | 1024 |
| GQA1-1024-PR | 1686 M | 2.686 | 2048 |

可以看到，head_dims从256提升到512时，Loss下降明显（2.711→2.693），但从512提升到1024时，Loss下降幅度变小（2.693→2.686），这表明head_dims的提升存在边际效应递减。

## 小结

通过一系列实验，我们初步验证了以下结论：

1、**增大head_dims是MLA好的关键之一**：在同等KV Cache下，head_dims越大效果越好；

2、**Partial RoPE是MLA好的关键之一**：RoPE和NoPE的拼接设计确实有效；

3、**KV-Shared是MLA好的关键之一**：KV-Shared可以在同等KV Cache下实现更大的head_dims。

不过，这些结论都还只是初步的，更多深入的分析将在下篇继续。

---

## 打赏

![微信打赏](images/wx.png)

![支付宝打赏](images/zfb.png)

---

> 本文转载自[科学空间](https://www.kexue.fm/archives/10907)，作者苏剑林。
