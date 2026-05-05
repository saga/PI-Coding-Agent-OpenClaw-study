# Transformer升级之路：1、Sinusoidal位置编码追根溯源

> **作者**：苏剑林 | **日期**：2021-03-08 | **来源**：[科学空间](https://www.kexue.fm/archives/8231)

本文介绍对Google在《Attention is All You Need》中提出来的Sinusoidal位置编码的新理解：

$$p_{k,2i} = \sin(k/10000^{2i/d}), \quad p_{k,2i+1} = \cos(k/10000^{2i/d})$$

## 泰勒展开推导

纯Attention模型是全对称的（$f(x,y)=f(y,x)$），无法识别位置。打破对称性的方式是在每个位置加不同编码向量：$\tilde{f}(x_m+p_m, x_n+p_n)$。泰勒展开到二阶：

$$\tilde{f} \approx f + p_m^\top\frac{\partial f}{\partial x_m} + p_n^\top\frac{\partial f}{\partial x_n} + \cdots + p_m^\top \mathcal{H} p_n$$

最后一项 $p_m^\top \mathcal{H} p_n$ 是第一个同时包含 $p_m,p_n$ 的交互项，希望它表达相对位置信息。

## 二维推导

假设 $\mathcal{H}=I$，则交互项为 $\langle p_m, p_n\rangle$。借助复数表示，设 $p_m = e^{im\theta}$，得到 $p_m p_n^* = e^{i(m-n)\theta}$，从而 $\langle p_m, p_n\rangle = \cos((m-n)\theta)$ —— **只依赖于相对位置**。

推广到高维：$p_m = (\cos m\theta_0, \sin m\theta_0, \cos m\theta_1, \sin m\theta_1, \cdots)$

## 远程衰减

选择 $\theta_i = 10000^{-2i/d}$ 后，内积 $\langle p_m, p_n\rangle$ 随着 $|m-n|$ 增大趋于零。原理是高频振荡积分的渐近趋零性：

$$\langle p_m, p_n\rangle \sim \frac{d}{2}\cdot\text{Re}\left[\int_0^1 e^{i(m-n)\cdot 10000^{-t}}dt\right]$$

但几乎所有单调光滑的 $\theta_t$ 都能实现远程衰减，$10000^{-t}$ 只是折中选择。

---

**转载地址**：https://www.kexue.fm/archives/8231

```bibtex
@online{kexuefm-8231, title={Transformer升级之路：1、Sinusoidal位置编码追根溯源}, author={苏剑林}, year={2021}, month={Mar}, url={\url{https://www.kexue.fm/archives/8231}}}
```
