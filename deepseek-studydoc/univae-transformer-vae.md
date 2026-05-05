# UniVAE：基于Transformer的单模型、多尺度的VAE模型

> **作者**：苏剑林 | **日期**：2021-06-29 | **来源**：[科学空间](https://www.kexue.fm/archives/8475)

本文介绍一个UniVAE模型，将VAE做到一个Transformer模型里边，且具备多尺度特性。

## 核心设计

1. **UniAE式Attention Mask**：Decoder只依赖[CLS]向量和当前解码结果，实现AE功能
2. **多尺度结构**：L层Attention的L个[CLS]向量拼接构成完整编码向量，不同层控制不同尺度的生成信息
3. **降维处理**：每层[CLS]用全连接层降/升维，控制编码向量总维度
4. **解耦能力**：前k层用独立式Mask，后(L-k)层用UniAE式Mask，保证隐变量有足够编码能力

## 实验效果（问句训练）

- **随机采样**效果良好（如："我在steam下载的游戏，怎样能在电脑上玩啊？？？"）
- **重构效果**接近原句
- **替换前32维** → 保留主题词（如"牙龈出血" → 牙龈出血相关问答）
- **替换后16维** → 保留句式结构（如变成其他话题的问答）

**GitHub**: https://github.com/bojone/univae

---

**转载地址**：https://www.kexue.fm/archives/8475

```bibtex
@online{kexuefm-8475, title={UniVAE：基于Transformer的单模型、多尺度的VAE模型}, author={苏剑林}, year={2021}, month={Jun}, url={\url{https://www.kexue.fm/archives/8475}}}
```
