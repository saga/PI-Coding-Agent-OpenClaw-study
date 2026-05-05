# 为什么DeltaNet要加L2 Normalize？

> **作者**：苏剑林 | **日期**：2025-12-23 | **来源**：[科学空间](https://www.kexue.fm/archives/11486)

在文章[《线性注意力简史：从模仿、创新到反哺》](https://www.kexue.fm/archives/11033)中，我们介绍了DeltaNet，它把Delta Rule带进了线性注意力中，成为其强有力的工具之一，并构成[GDN](https://papers.cool/arxiv/2412.06464)、[KDA](https://papers.cool/arxiv/2510.26692)等后续工作的基础。不过，那篇文章我们主要着重于DeltaNet的整体思想，并未涉及到太多技术细节——这篇文章我们来讨论其中之一：DeltaNet及其后续工作都给Q、K加上了L2 Normalize，这是为什么呢？

## 基本解释

DeltaNet的递归格式是

$$S_t = S_{t-1} - \eta_t (S_{t-1} k_t - v_t) k_t^\top = S_{t-1}(I - \eta_t k_t k_t^\top) + \eta_t v_t k_t^\top$$

从TTT的角度看，这是用SGD优化器、以 $\eta_t$ 的学习率对损失 $\frac{1}{2}\|Sk - v\|^2$ 做在线优化（训练参数是S）。我们知道优化器往往对学习率比较敏感，尤其是SGD这种非自适应学习率优化器，而在DeltaNet中则表现为对转移矩阵 $I - \eta_t k_t k_t^\top$ 的一些额外要求。

具体来说，由于不同时间的转移矩阵在递归过程中是连乘起来的，所以为了避免数值爆炸，转移矩阵不能出现大于1或小于-1的特征值。而对于矩阵 $I - \eta_t k_t k_t^\top$ 来说，它的特征值有一个是 $1 - \eta_t \|k_t\|^2$、剩下都是1，由此我们可以得到约束

$$-1 \leq 1 - \eta_t \|k_t\|^2 \leq 1$$

为了实现该约束，常见做法是给 $k_t$ 加L2 Normalize、给 $\eta_t$ 加Sigmoid，这样全体特征值就都在 $(0,1]$ 内了，这便是K加L2 Normalize的来源。至于Q的L2 Normalize本质上不是必要的，更多是出于对称性考虑"顺手"加上的，这跟Short Conv的情况类似，给K加Short Conv才是最关键的[[参考](https://www.kexue.fm/archives/11320)]。

## 补充说明

顺便提一下，在很长时间内，大家习惯了让特征值都在 $(0,1]$ 内，所以选择给 $\eta_t$ 加Sigmoid，后来[《Unlocking State-Tracking in Linear RNNs Through Negative Eigenvalues》](https://papers.cool/arxiv/2411.12537)指出负特征值能增强DeltaNet的状态跟踪能力，于是提出将DeltaNet改为

$$S_t = S_{t-1}(I - 2\eta_t k_t k_t^\top) + \eta_t v_t k_t^\top$$

然后还是给 $k_t$ 加L2 Normalize、给 $\eta_t$ 加Sigmoid，这样转移矩阵 $I - 2\eta_t k_t k_t^\top$ 的特征值范围就扩大到 $(-1,1]$ 了。不过，状态跟踪是一个偏向于特殊语法（比如代码）的能力，因此如果我们修改之后只是在自然语言上训练和测试，那么不见得能测出明显的变化。

还有一个要注意的细节，就是当 $\eta_t = 1$ 时，转移矩阵 $I - 2k_t k_t^\top$ 是正交矩阵，理论上没问题，但实际上不行，因为出于效率考虑，我们在实现中通常都至少使用BF16计算，而BF16精度较低，导致 $I - 2k_t k_t^\top$ 的特征值有概率小于-1，在长期累乘之下依然有爆炸风险，所以还需要控制 $\eta_t$ 不能太接近于1。

事实上，上面的解释已经很完整了，也不复杂，所以对它的挑刺主要是出于个人的审美：实现条件(2)的方式并不是唯一的，比如还可以像[Longhorn](https://papers.cool/arxiv/2407.14207)那样引入类似[Capsule](https://www.kexue.fm/archives/4819)的Squash操作，因此我们无法自然地导出L2 Normalize，只能说它是一个可用的方案。

## 连续视角

接下来介绍论文[《Error-Free Linear Attention is a Free Lunch: Exact Solution from Continuous-Time Dynamics》](https://papers.cool/arxiv/2512.12602)的思路，笔者认为它也是一条很优雅的推导途径。它将式(1)看成是如下微分方程在 $[t-\eta_t, t]$ 区间内的欧拉离散化：

$$\frac{d}{dt} S_t = \underbrace{S_t(-k_t k_t^\top)}_{A_t} + \underbrace{v_t k_t^\top}_{B_t}$$

然后指出之所以会出现数值爆炸的异常，是因为离散化格式的精度不够高，所以提出直接用求解微分方程来构建递归，而不是近似地离散化。因为 $[t-\eta_t, t]$ 区间内 $A_t$ 和 $B_t$ 都是常量，所以求从 $t-\eta_t$ 到t的递归形式相当于解一个常系数线性微分方程，一般结果是

$$S_t = S_{t-\eta_t} e^{\eta_t A_t} + B_t A_t^{-1}(e^{\eta_t A_t} - I)$$

重新将 $S_{t+\eta_t}$ 换回记号 $S_{t-1}$，然后代入 $A_t, B_t$ 的表达式，化简得到

$$S_t = S_{t-1}\left(I - \frac{1 - e^{-\eta_t \|k_t\|^2}}{\|k_t\|^2} k_t k_t^\top\right) + \frac{1 - e^{-\eta_t \|k_t\|^2}}{\|k_t\|^2} v_t k_t^\top$$

这便是要推的最终结果，原论文称之为"EFLA（Error-Free Linear Attention）"，它相当于将 $\eta_t$ 换成了 $\frac{1 - e^{-\eta_t \|k_t\|^2}}{\|k_t\|^2}$，$\|k_t\|^2$ 自然地出现在了分母中，跟 $k_t k_t^\top$ 相乘正好表现为对K的L2 Normalize。

## 数学细节

上一节的核心结果是式(5)，它是微分方程 $dS_t/dt = SA + B$ 的解。如果 $B=0$，那么直接可以写出 $S_t = S_0 e^{tA}$，其中 $e^{tA}$ 是[矩阵指数](https://en.wikipedia.org/wiki/Matrix_exponential)；当 $B \neq 0$ 时，将方程改写成 $d(S_t + BA^{-1})/dt = (S_t + BA^{-1})A$，然后利用 $B=0$ 时的解即得

$$S_t = (S_0 + BA^{-1})e^{tA} - BA^{-1} = S_0 e^{tA} + BA^{-1}(e^{tA} - I)$$

现在再次聚焦式(5)，对于DeltaNet有 $A_t = -k_t k_t^\top$ 是一个秩1矩阵，这提供了进一步的化简空间：

$$f(xy^\top) = \sum_{n=0}^{\infty} a_n (xy^\top)^n = a_0 I + \sum_{n=1}^{\infty} a_n (xy^\top)^n = f(0)I + x\underbrace{\sum_{n=1}^{\infty} a_n (y^\top x)^{n-1}}_{\frac{f(y^\top x) - f(0)}{y^\top x}} y^\top$$

注意 $y^\top x$ 是一个标量，所以化简的要义是将矩阵函数变成了标量函数，由此可得

$$e^{\eta_t A_t} = I - \frac{1 - e^{-\eta_t \|k_t\|^2}}{\|k_t\|^2} k_t k_t^\top, \quad B_t A_t^{-1}(e^{\eta_t A_t} - I) = \frac{1 - e^{-\eta_t \|k_t\|^2}}{\|k_t\|^2} v_t k_t^\top$$

## 个人思考

到这里，我们对EFLA的介绍就结束了，原论文还有一些实验内容，显示EFLA相比原始DeltaNet有一些优势。但从式(6)可以看出，EFLA仍然是DeltaNet的形式，所以原则上不能期望它会"突飞猛进"，那为什么EFLA普遍稍好一些呢？DeltaNet通过L2 Normalize直接舍去K的模长，而式(6)的 $v_t k_t^\top$ 是依赖于 $\|k_t\|$ 的，所以EFLA实际多了一个自由度，理论上限会更高一些。

此外，EFLA中用微分方程精确解来构造递归的做法不是新的，我们在[《重温SSM（二）：HiPPO的一些遗留问题》](https://www.kexue.fm/archives/10137)中介绍SSM时就提到过，关键结果式(5)在[HiPPO](https://papers.cool/arxiv/2008.07669)中就已经出现了。EFLA主要是针对DeltaNet这个特例做了展开计算，得到了简化可用的结果。

一个更值得思考的问题是，微分方程作为出发点有什么好处？不难看出，式(6)的转移矩阵特征值自动在 $(0,1]$ 内，也就说求解微分方程(4)得到的递归形式，天然有更好的稳定性。因为微分方程伴随着连续性约束，加上矩阵 $-k_t k_t^\top$ 是一个半负定矩阵，根据微分方程的相关理论，它的解是稳定的。

数学建模上有个经典例子是Logistic方程 $dx/dt = \alpha x - \beta x^2$，它的解很简单，就是Logistic函数，但对应的差分方程 $x_{t+1} - x_t = \alpha x_t - \beta x_t^2$ 却会在某些设置下出现混沌行为（对初值极其敏感以至于不可预测）。所以，以微分方程为出发点，能自动规避一些异常行为。

## 文章小结

这篇文章围绕DeltaNet的L2 Normalize进行讨论，主要介绍了以微分方程为出发点对DeltaNet重新参数化的思路，它也可以视作DeltaNet中K的L2 Normalize运算的一种解释。

---

**转载地址**：https://www.kexue.fm/archives/11486

**引用格式**：

苏剑林. (Dec. 23, 2025). 《为什么DeltaNet要加L2 Normalize？》[Blog post]. Retrieved from https://www.kexue.fm/archives/11486

```bibtex
@online{kexuefm-11486,
  title={为什么DeltaNet要加L2 Normalize？},
  author={苏剑林},
  year={2025},
  month={Dec},
  url={\url{https://www.kexue.fm/archives/11486}},
}
```
