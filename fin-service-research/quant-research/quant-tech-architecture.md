# 量化平台技术架构专题

> 日期：2026-03-14
> 覆盖：云原生量化平台架构、实时量化信号系统、量化平台安全与合规

---

## 一、云原生量化平台架构

### 1.1 整体架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    用户层                                │
│  JupyterHub  │  Research Portal  │  监控仪表盘           │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  计算编排层                              │
│  Kubernetes (EKS/AKS)  │  Airflow  │  Ray Cluster        │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  数据与存储层                            │
│  S3/ADLS  │  Redshift/Snowflake  │  Redis  │  InfluxDB   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  基础设施层                              │
│  AWS/Azure  │  VPC  │  IAM  │  CloudWatch/Monitor        │
└─────────────────────────────────────────────────────────┘
```

### 1.2 AWS 上的量化平台设计

**核心服务选型**：

| 功能 | AWS 服务 | 说明 |
|------|---------|------|
| 数据湖 | S3 + Glue | Parquet 格式存储历史数据 |
| 数据仓库 | Redshift | 结构化因子数据查询 |
| 回测计算 | AWS Batch + Spot | 大规模并行回测 |
| 实时计算 | Kinesis + Lambda | 流式因子计算 |
| ML 训练 | SageMaker | 模型训练和部署 |
| 编排 | MWAA（托管 Airflow） | 数据管道调度 |
| 容器 | EKS（托管 K8s） | 微服务部署 |
| 监控 | CloudWatch + Grafana | 系统和业务监控 |
| 密钥管理 | AWS Secrets Manager | API Key、数据库密码 |

**Azure 对应方案**（Fidelity 如使用 Azure）：

| AWS | Azure 对应 |
|-----|-----------|
| S3 | Azure Data Lake Storage Gen2 |
| Redshift | Azure Synapse Analytics |
| AWS Batch | Azure Batch |
| SageMaker | Azure ML |
| MWAA | Azure Data Factory |
| EKS | AKS |

### 1.3 成本优化：Spot 实例用于回测

**为什么回测适合 Spot 实例**：
- 回测任务是**可中断、可重试**的批处理任务
- 无需实时响应，可以接受偶发中断
- 计算密集，成本是主要考量

**Spot 实例成本优势**：
- 相比按需实例节省 **70-90%** 成本
- AWS Spot 中断提前 2 分钟通知，足够保存检查点

**回测 Spot 架构设计**：

```python
# AWS Batch + Spot 回测任务设计
job_definition = {
    "jobDefinitionName": "backtest-job",
    "type": "container",
    "containerProperties": {
        "image": "fidelity/backtest-engine:latest",
        "vcpus": 4,
        "memory": 16384,
    },
    "retryStrategy": {
        "attempts": 3,  # Spot 中断后自动重试
        "evaluateOnExit": [
            {"onStatusReason": "Host EC2*terminated", "action": "RETRY"}
        ]
    }
}

# 检查点机制：每完成一个时间段保存进度到 S3
def save_checkpoint(results, period, s3_path):
    checkpoint = {"period": period, "results": results}
    s3.put_object(Body=json.dumps(checkpoint), Bucket=bucket, Key=s3_path)
```

**成本估算（示例）**：
- 1000 个因子 × 10 年回测 × 4 vCPU
- 按需实例：约 $500/次
- Spot 实例：约 $75/次（节省 85%）
- 每月运行 20 次：节省约 $8500/月

### 1.4 多云策略

**为什么考虑多云**：
- 避免单一云厂商锁定
- 监管要求（部分国家要求数据本地化）
- 不同云在不同地区的优势不同（AWS 在美国、Azure 在欧洲）

**Fidelity 建议的多云策略**：

| 工作负载 | 云平台 | 理由 |
|---------|-------|------|
| 核心数据湖 | 主云（AWS/Azure） | 统一管理，降低复杂度 |
| 回测计算 | 主云 Spot | 成本最优 |
| 亚太数据处理 | 阿里云/腾讯云（中国） | 数据本地化合规 |
| 灾备 | 备用云 | 业务连续性 |

**多云数据同步**：使用 Apache Iceberg 格式，支持跨云数据访问，避免数据格式锁定。

---

## 二、实时量化信号系统

### 2.1 低延迟架构设计

**延迟分级**：

| 级别 | 延迟要求 | 典型场景 | 技术方案 |
|------|---------|---------|---------|
| 超低延迟 | < 1ms | 高频交易 | FPGA、内核旁路 |
| 低延迟 | 1ms - 100ms | 日内信号 | C++、内存数据库 |
| 中延迟 | 100ms - 1s | 分钟级信号 | Python + Redis |
| 标准延迟 | 1s - 1min | 日内因子更新 | Kafka + Flink |
| 批处理 | > 1min | 日频因子 | Spark + Airflow |

**Fidelity 的定位**：主要关注中延迟到标准延迟（分钟级到日内），不需要超低延迟基础设施。

### 2.2 流式因子计算架构

```
数据源
├── 实时行情（交易所 Feed）
├── 新闻流（Reuters/Bloomberg API）
├── 另类数据流（卫星、信用卡等）
└── 内部交易数据

        ↓ Kafka（消息队列）

流处理引擎（Apache Flink）
├── 实时价格因子（动量、波动率）
├── 实时情绪因子（新闻 NLP）
├── 实时技术指标（RSI、MACD）
└── 实时风险指标（VaR 更新）

        ↓

因子存储（Redis + InfluxDB）
├── Redis：最新因子值（低延迟读取）
└── InfluxDB：因子时序历史（分析用）

        ↓

信号生成服务
└── 基于实时因子生成交易信号
```

**Flink 流式因子计算示例**：

```python
# Apache Flink 实时动量因子计算
from pyflink.datastream import StreamExecutionEnvironment
from pyflink.datastream.window import SlidingEventTimeWindows
from pyflink.common.time import Time

env = StreamExecutionEnvironment.get_execution_environment()

# 实时价格流
price_stream = env.add_source(KafkaSource("price-topic"))

# 20 分钟滑动窗口动量因子
momentum_stream = (
    price_stream
    .key_by(lambda x: x["ticker"])
    .window(SlidingEventTimeWindows.of(Time.minutes(20), Time.minutes(1)))
    .aggregate(MomentumAggregator())  # 计算窗口内收益率
)

# 写入 Redis
momentum_stream.add_sink(RedisSink("momentum_factor"))
```

### 2.3 实时风险监控

**监控指标体系**：

| 指标 | 更新频率 | 预警阈值 | 处理方式 |
|------|---------|---------|---------|
| 组合 VaR | 实时 | 超过限额 90% | 自动告警 |
| 因子暴露 | 分钟级 | 偏离目标 ±2σ | 触发再平衡检查 |
| 流动性风险 | 日内 | 持仓 > 日均成交量 20% | 人工审核 |
| 模型信号质量 | 实时 | IC 连续 5 天为负 | 模型降权或暂停 |
| 数据质量 | 实时 | 缺失率 > 5% | 数据告警 |

**实时风险仪表盘关键组件**：
- Grafana：可视化展示，支持自定义告警规则
- PagerDuty：告警路由，区分紧急/非紧急
- Slack/Teams：告警通知渠道

---

## 三、量化平台安全与合规

### 3.1 数据访问审计

**审计要求**：金融机构需要对所有数据访问行为留存完整审计日志，满足监管要求（MiFID II、SEC Rule 17a-4 等）。

**审计架构**：

```
用户操作
    ↓
API Gateway（记录所有请求）
    ↓
审计日志服务
├── 记录：用户ID、时间戳、操作类型、数据范围、IP
├── 存储：不可篡改的日志存储（AWS CloudTrail / Azure Monitor）
└── 保留：至少 7 年（监管要求）

审计查询接口
└── 合规团队可查询：谁在何时访问了哪些数据
```

**数据分级访问控制**：

| 数据级别 | 示例 | 访问控制 |
|---------|------|---------|
| 公开数据 | 市场价格、公开财报 | 所有研究员 |
| 内部数据 | 分析师评级、内部预期 | 需要申请，有期限 |
| 敏感数据 | 交易记录、客户持仓 | 严格审批，Chinese Wall |
| 受限数据 | 内幕信息隔离区 | 仅特定人员，全程审计 |

### 3.2 模型可解释性（监管要求）

**监管背景**：
- 欧盟 AI Act（2024 年生效）：高风险 AI 系统需要可解释性
- MiFID II：算法交易需要记录决策逻辑
- 美国 SEC：算法交易策略需要可审计

**可解释性技术方案**：

**因子模型（天然可解释）**：
```
组合收益 = Σ(因子暴露 × 因子收益) + 特异性收益
→ 每个决策都可以分解到具体因子
→ 满足监管的可解释性要求
```

**ML 模型（需要额外解释层）**：
```python
import shap

# SHAP 值解释 XGBoost 模型
explainer = shap.TreeExplainer(model)
shap_values = explainer.shap_values(X_test)

# 生成解释报告
# → 每个预测的特征贡献度
# → 满足"为什么买这只股票"的解释需求
```

**模型卡（Model Card）规范**：
每个上线模型必须附带：
- 模型目的和适用范围
- 训练数据描述（时间范围、数据源）
- 性能指标（样本内/样本外）
- 已知局限性和风险
- 审批记录和版本历史

### 3.3 算法交易合规框架

**合规检查清单**：

**交易前检查（Pre-trade）**：
- [ ] 信号是否使用了内幕信息？（Chinese Wall 检查）
- [ ] 持仓是否超过监管限制（5%/10% 持股比例）？
- [ ] 是否触发市场操纵规则（如 Spoofing 检测）？
- [ ] 交易成本是否在合理范围内？

**交易中监控（Intra-day）**：
- [ ] 实时监控异常交易行为
- [ ] 大额交易自动触发人工审核
- [ ] 市场冲击监控（避免影响市场价格）

**交易后审查（Post-trade）**：
- [ ] 最优执行（Best Execution）报告
- [ ] 交易归因分析
- [ ] 合规报告生成（MiFID II Transaction Reporting）

**算法交易备案**：
- 所有量化策略需要在合规部门备案
- 策略重大变更需要重新审批
- 定期压力测试（模拟极端市场条件下的行为）

### 3.4 数据安全架构

**核心安全原则**：

| 原则 | 实现方式 |
|------|---------|
| 最小权限 | IAM 角色精细化，按需授权 |
| 数据加密 | 静态加密（AES-256）+ 传输加密（TLS 1.3） |
| 网络隔离 | VPC 私有子网，禁止公网直接访问数据层 |
| 密钥管理 | AWS KMS / Azure Key Vault，定期轮换 |
| 数据脱敏 | 开发/测试环境使用脱敏数据 |
| 入侵检测 | AWS GuardDuty / Azure Defender |

**Chinese Wall 技术实现**：
```
信息屏障（Information Barrier）数据库
├── 记录每个用户的"隔离状态"
├── 实时检查：用户 A 是否被隔离于公司 X 的信息？
└── 自动拦截：隔离用户无法访问相关数据

实现方式：
- 数据标签（每条数据打上公司/项目标签）
- 访问控制矩阵（用户 × 数据标签 → 允许/拒绝）
- 审计日志（所有访问尝试，包括被拒绝的）
```

---

## 四、架构选型总结与 Fidelity 建议

### 4.1 技术栈推荐

| 层次 | 推荐技术 | 备选 |
|------|---------|------|
| 数据湖 | S3 + Apache Iceberg | Azure ADLS + Delta Lake |
| 数据仓库 | Snowflake | Redshift / BigQuery |
| 流处理 | Apache Flink | Kafka Streams |
| 批处理 | Apache Spark | Dask |
| 编排 | Apache Airflow | Prefect |
| ML 平台 | MLflow + SageMaker | Azure ML |
| 容器编排 | Kubernetes (EKS) | AKS |
| 监控 | Grafana + Prometheus | Datadog |
| 消息队列 | Apache Kafka | AWS Kinesis |

### 4.2 建设路线图

**阶段一（0-6 个月）：基础设施**
- 建立数据湖（S3 + Iceberg）
- 部署 Airflow 数据管道
- 搭建 JupyterHub 研究环境
- 实现基础审计日志

**阶段二（6-18 个月）：核心能力**
- 回测引擎迁移到云端（Spot 实例）
- MLflow 实验追踪
- 实时因子计算（Kafka + Flink）
- 完整的访问控制和 Chinese Wall

**阶段三（18-36 个月）：高级能力**
- Agentic AI 因子发现流水线
- 多云策略（亚太数据本地化）
- 实时风险监控系统
- 完整的算法交易合规框架

---

*文档最后更新：2026-03-14*
