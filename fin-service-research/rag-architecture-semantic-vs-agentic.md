# Semantic RAG vs Agentic RAG 详解

> 背景：针对 Fidelity International SuperSearch 平台的技术架构分析
> 日期：2026-03-14

---

## 一、Semantic RAG

### 1.1 核心流程

```
用户问题
    │
    ▼
[Query Encoding]        将问题转成向量
    │
    ▼
[Vector Search]         在 OpenSearch 里找最相似的文档块
    │
    ▼
[Context Assembly]      把 Top-K 个文档块拼成 Prompt
    │
    ▼
[LLM Generation]        生成答案 + 引用来源
    │
    ▼
用户看到答案
```

### 1.2 离线预处理（文档入库）

```
原始文档（PDF / Word / HTML）
    │
    ▼
[Document Parser]           ← 关键：结构感知解析
提取文本、表格、标题层级
    │
    ▼
[Chunking]                  ← 关键：分块策略
切成 512~1024 token 的块
保留：chunk_id, doc_id, page, section_title
    │
    ▼
[Embedding Model]           ← 例如 text-embedding-3-large 或 FinBERT
每个 chunk → 1536 维向量
    │
    ▼
[OpenSearch]
存储：向量 + 原文 + 元数据
同时建全文索引（BM25）
```

### 1.3 在线查询（实时）

```python
def semantic_rag_query(user_question: str) -> Answer:

    # 1. 问题向量化
    query_vector = embedding_model.encode(user_question)

    # 2. Hybrid Search（向量 + 关键词融合）
    results = opensearch.search({
        "knn":   {"vector": query_vector, "k": 20},
        "match": {"text": user_question},
        "hybrid_score": "rrf"   # Reciprocal Rank Fusion
    })

    # 3. Reranking（可选但重要）
    top_chunks = reranker.rerank(user_question, results[:20])[:5]

    # 4. 组装 Prompt
    context = "\n\n".join([c.text for c in top_chunks])
    prompt = f"""
    你是 Fidelity 的研究助手。基于以下文档内容回答问题。
    如果文档中没有相关信息，请明确说明。

    文档内容：
    {context}

    问题：{user_question}

    回答时请注明引用来源（文档名、页码）。
    """

    # 5. LLM 生成
    answer   = llm.generate(prompt)
    citations = [c.metadata for c in top_chunks]

    return Answer(text=answer, citations=citations)
```

### 1.4 Semantic RAG 的局限性

**示例问题**："比较 Fidelity 2023 年和 2024 年对中国市场的投资观点有什么变化？"

Semantic RAG 的处理方式：
1. 把问题向量化
2. 检索出最相似的 5 个文档块
3. 这 5 个块可能来自同一份报告，或者时间混乱
4. LLM 基于这 5 个块生成答案

**问题所在：**
- 无法保证同时检索到 2023 和 2024 的内容
- 无法做跨文档的时间线对比
- 如果答案需要 10 个文档块才能完整，但只取了 5 个，答案就不完整
- 不会主动"再查一次"

---

## 二、Agentic RAG

### 2.1 核心思想

把 RAG 从"单次检索 → 生成"变成"Agent 自主决策的多步骤推理循环"。

```
用户问题
    │
    ▼
┌─────────────────────────────────┐
│           Orchestrator          │  ← 核心 Agent，负责规划和决策
│  "我需要什么信息？怎么找？够了吗？" │
└────────────┬────────────────────┘
             │ 调用工具
    ┌────────┴─────────┐
    │                  │
    ▼                  ▼
[Search Tool]    [Other Tools]
向量检索          日期过滤
关键词检索        结构化查询
跨文档检索        计算 / 对比
    │
    ▼
[Reflection]     ← Agent 自我评估：答案够了吗？
"信息不够，需要再查"
    │
    ▼
[再次检索]        ← 迭代，直到信息充分
    │
    ▼
[Synthesis]      ← 综合所有检索结果生成最终答案
    │
    ▼
用户看到答案 + 完整引用链
```

### 2.2 完整架构图

```
┌──────────────────────────────────────────────────────────┐
│                      用户查询界面                          │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│                     Query Planner                         │
│  输入：用户原始问题                                         │
│  输出：子问题分解 + 检索策略                                 │
│                                                          │
│  例：原问题 →                                              │
│    ["2023年中国观点", "2024年中国观点", "对比分析"]           │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│                    Tool Registry                          │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────┐             │
│  │  semantic_search  │  │  keyword_search   │             │
│  │  (OpenSearch kNN) │  │  (OpenSearch BM25)│             │
│  └──────────────────┘  └──────────────────┘             │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────┐             │
│  │  filter_by_date   │  │  filter_by_author │             │
│  │  (PostgreSQL)     │  │  (PostgreSQL)     │             │
│  └──────────────────┘  └──────────────────┘             │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────┐             │
│  │  get_document     │  │  compare_docs     │             │
│  │  (全文获取)        │  │  (跨文档对比)      │             │
│  └──────────────────┘  └──────────────────┘             │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│                   ReAct Loop（核心）                       │
│                                                          │
│  Thought:    我需要先找 2023 年的中国市场报告               │
│  Action:     semantic_search("中国市场 2023 投资观点")      │
│  Observation: 找到 3 个相关块，来自 Q3 2023 报告            │
│                                                          │
│  Thought:    还需要 2024 年的，再查一次                     │
│  Action:     semantic_search("中国市场 2024 投资观点")      │
│  Observation: 找到 4 个相关块，来自 Q2 2024 报告            │
│                                                          │
│  Thought:    信息够了，可以做对比分析了                      │
│  Action:     synthesize(2023_chunks + 2024_chunks)       │
│  Observation: 生成对比分析                                 │
│                                                          │
│  Thought:    答案完整，输出                                 │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│                  Answer + Citations                       │
│  答案文本 + 每个论点对应的原始文档段落引用                     │
└──────────────────────────────────────────────────────────┘
```

### 2.3 ReAct Loop 代码实现

```python
class AgenticRAG:

    def __init__(self, opensearch, postgres, llm):
        self.tools = {
            "semantic_search":   self.semantic_search,
            "filter_by_date":    self.filter_by_date,
            "get_full_document": self.get_full_document,
        }
        self.max_iterations = 5  # 防止无限循环

    def run(self, user_question: str) -> Answer:
        memory    = []   # 存储所有检索到的 chunks
        iteration = 0

        # Step 1：问题分解
        sub_questions = self.query_planner(user_question)
        # → ["2023年中国市场观点", "2024年中国市场观点"]

        while iteration < self.max_iterations:

            # Step 2：Agent 决策
            action = self.llm.decide(
                question       = user_question,
                sub_questions  = sub_questions,
                memory         = memory,
                available_tools= list(self.tools.keys()),
                prompt         = REACT_PROMPT
            )

            if action.type == "FINISH":
                break

            # Step 3：执行工具
            result = self.tools[action.tool](**action.params)
            memory.extend(result.chunks)

            # Step 4：自我评估（Reflection）
            sufficient = self.llm.evaluate(
                question       = user_question,
                collected_info = memory,
                prompt         = REFLECTION_PROMPT
                # "基于已收集的信息，能完整回答问题吗？"
            )
            if sufficient:
                break

            iteration += 1

        # Step 5：最终综合
        return self.synthesize(user_question, memory)
```

---

## 三、两者核心差异对比

| 维度 | Semantic RAG | Agentic RAG |
|------|-------------|-------------|
| 检索次数 | 固定 1 次 | 动态多次，按需迭代 |
| 问题复杂度 | 单跳（Single-hop） | 多跳（Multi-hop） |
| 跨文档对比 | 弱（靠运气检索到） | 强（主动规划检索策略） |
| 时间线分析 | 弱 | 强（可按时间分批检索） |
| 延迟 | 低（1–3 秒） | 高（5–30 秒，多次 LLM 调用） |
| 成本 | 低 | 高（多次 LLM 调用） |
| 实现复杂度 | 低 | 高 |
| 幻觉风险 | 中 | 低（有 Reflection 自检） |
| 适合场景 | "这份报告说了什么" | "分析过去两年的趋势变化" |

---

## 四、针对 Fidelity SuperSearch 的具体建议

### 4.1 查询分层路由（两种模式都要）

不是所有查询都需要 Agentic RAG，成本太高。按复杂度分层：

```
用户查询
    │
    ▼
[Query Classifier]
    │
    ├── 简单查询（"这份报告的结论是什么"）
    │       └── Semantic RAG（快，便宜）
    │
    ├── 中等查询（"找所有关于 ESG 的报告"）
    │       └── Semantic RAG + 过滤器
    │
    └── 复杂查询（"比较 2023 vs 2024 的中国市场观点"）
            └── Agentic RAG（慢，贵，但准确）
```

### 4.2 OpenSearch + PostgreSQL 职责划分

```
PostgreSQL（结构化元数据）
├── 文档表：doc_id, title, author, date, type, fund, region
├── 权限表：doc_id, team_id, access_level   ← Chinese Wall 关键
├── 版本表：doc_id, version, superseded_by
└── 标签表：doc_id, tag（ESG/Macro/Equity/FixedIncome）

OpenSearch（搜索引擎）
├── 向量索引：chunk_id → embedding（1536 维）
├── 全文索引：chunk_id → text（BM25）
├── 元数据字段：doc_id, date, author（用于过滤）
└── 权限过滤：document-level security（与 PostgreSQL 同步）
```

### 4.3 金融文档分块策略（最容易被低估的问题）

金融文档（年报、研究报告、监管文件）结构特殊，表格、图表、脚注、跨页引用如果用简单固定长度分块，很容易切断完整的财务数据表格。

```python
# 普通分块（不推荐）
chunks = split_by_tokens(text, size=512)  # 可能切断表格

# 结构感知分块（推荐）
def financial_chunker(document):
    chunks = []
    for section in document.sections:
        if section.type == "TABLE":
            # 表格整体作为一个 chunk，不切断
            chunks.append(Chunk(
                text     = table_to_markdown(section),
                type     = "table",
                metadata = {"section": section.title}
            ))
        elif section.type == "TEXT":
            # 按段落分块，保留 section 标题作为上下文前缀
            for para in section.paragraphs:
                chunks.append(Chunk(
                    text = f"[{section.title}]\n{para}",
                    type = "text"
                ))
    return chunks
```

### 4.4 最关键的风险：权限控制（Chinese Wall）

```
场景：股票研究团队的分析师查询 "Fidelity 对 TSMC 的看法"

如果权限控制没做好：
- RAG 可能检索到固定收益团队的内部信用分析
- 或者检索到尚未发布的研究报告
- 这在金融机构是严重的合规问题

正确做法：
1. 每个 chunk 在 OpenSearch 里打上 team_id 和 access_level 标签
2. 查询时强制加入权限过滤器（不能让用户绕过）
3. PostgreSQL 里的权限表是 source of truth
4. 定期审计：哪些查询触发了跨权限检索
```

---

## 五、总结

- **Semantic RAG**：一次性检索 + 生成，适合简单问答，快但浅。
- **Agentic RAG**：Agent 自主规划多轮检索 + 推理，适合复杂分析，慢但深。

对 Fidelity SuperSearch 的研究场景，两者都需要。关键是做好**查询分类路由**，让简单问题走快路径，复杂问题走 Agentic 路径。权限控制（Chinese Wall）是整个系统最不能妥协的部分。

---

*参考：OpenSearch RAG 文档、Forrester Agentic AI in Financial Services 2026、Bloomberg ASKB 架构分析*
