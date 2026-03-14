# Fidelity Insights Crawler 使用说明

## 概述

这个爬虫脚本用于监控 Fidelity International 网站的研究洞察内容变化，自动抓取以下页面的最新研究：

- [Research Powered Investing](https://professionals.fidelity.co.uk/solutions/research-powered-investing)
- [Equities](https://professionals.fidelity.co.uk/solutions/equities)
- [Fixed Income](https://professionals.fidelity.co.uk/solutions/fixed-income)
- [Multi Asset](https://professionals.fidelity.co.uk/solutions/multi-asset)
- [Sustainable Investing](https://professionals.fidelity.co.uk/solutions/sustainable-investing)
- [Private Assets](https://professionals.fidelity.co.uk/solutions/private-assets)

## 文件说明

| 文件 | 说明 |
|------|------|
| `fidelity-insights-crawler.ts` | TypeScript 版本（类型安全） |
| `fidelity-insights-crawler.py` | Python 版本（推荐，易于使用） |
| `fidelity-crawler-usage.md` | 本使用说明文档 |

## 工作原理

### 爬取流程

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  读取目标   │ →  │  导航页面   │ →  │  等待加载   │ →  │  提取洞察   │
│  URL 列表   │    │  (MCP)      │    │  (MCP)      │    │  (MCP)      │
└─────────────┘    └─────────────┘    └─────────────┘    └──────┬──────┘
                                                                │
                       ┌────────────────────────────────────────┘
                       ▼
              ┌─────────────────┐
              │   保存结果      │
              │  JSON + Markdown│
              └─────────────────┘
```

### 识别的洞察区域

爬虫会查找以下关键词标识的洞察区域：

- "Our latest thinking on"
- "Latest insights"
- "Our latest fixed income insights"
- "Our latest equities insights"
- "Our latest multi-asset insights"
- "Our latest sustainable investing insights"
- "Our latest private assets insights"
- "Our latest insights"

## 使用方法

### 方法 1: 在 Trae IDE 中使用 MCP

由于 Trae IDE 已经配置了 Chrome DevTools MCP，可以直接使用：

1. **打开终端**
   ```bash
   cd fin-service-research
   ```

2. **运行 Python 脚本**
   ```bash
   python fidelity-insights-crawler.py
   ```

3. **查看结果**
   - JSON 文件: `fidelity-insights-YYYYMMDD.json`
   - Markdown 报告: `fidelity-insights-report-YYYYMMDD.md`

### 方法 2: 手动使用 MCP 命令

如果不想使用脚本，可以直接使用 MCP 命令逐个页面抓取：

#### 步骤 1: 导航到页面
```json
{
  "type": "url",
  "url": "https://professionals.fidelity.co.uk/solutions/equities"
}
```

#### 步骤 2: 等待页面加载
```json
{
  "text": ["Our latest", "insights", "Equities"],
  "timeout": 10000
}
```

#### 步骤 3: 获取页面快照
```json
{
  "verbose": true
}
```

#### 步骤 4: 提取洞察链接
从快照中查找包含文章链接的元素，提取：
- 标题
- URL
- 类型（Article/Webcast）
- 日期
- 阅读时间
- 作者
- 标签

### 方法 3: 定时任务（监控变化）

可以设置定时任务，每天/每周自动运行爬虫：

#### Linux/Mac (cron)
```bash
# 每天上午9点运行
0 9 * * * cd /path/to/fin-service-research && python fidelity-insights-crawler.py >> crawl.log 2>&1
```

#### Windows (Task Scheduler)
1. 打开任务计划程序
2. 创建基本任务
3. 设置触发器（每天/每周）
4. 设置操作：启动程序 `python.exe`
5. 参数：`fidelity-insights-crawler.py`
6. 起始于：`D:\temp\PI-Coding-Agent-OpenClaw-study\fin-service-research`

## 输出格式

### JSON 格式

```json
{
  "crawl_time": "2026-03-14T10:30:00",
  "total_pages": 6,
  "total_insights": 15,
  "results": [
    {
      "url": "https://professionals.fidelity.co.uk/solutions/equities",
      "page_title": "Equities at Fidelity",
      "crawl_time": "2026-03-14T10:30:00",
      "insights": [
        {
          "title": "Iran conflict - implications for emerging markets",
          "url": "https://professionals.fidelity.co.uk/articles/...",
          "type": "Article",
          "date": "12/03/2026",
          "read_time": "5 min read",
          "authors": "Multiple authors",
          "tags": ["Emerging Markets"],
          "summary": "In March, tragic and concerning developments..."
        }
      ]
    }
  ]
}
```

### Markdown 格式

```markdown
# Fidelity International 研究洞察报告

**爬取时间**: 2026-03-14T10:30:00

## Equities at Fidelity

**URL**: https://professionals.fidelity.co.uk/solutions/equities

### 最新洞察

#### [Iran conflict - implications for emerging markets](https://professionals.fidelity.co.uk/articles/...)

- **类型**: Article
- **日期**: 12/03/2026
- **阅读时间**: 5 min read
- **作者**: Multiple authors
- **标签**: Emerging Markets

In March, tragic and concerning developments...
```

## 变化检测

要检测内容变化，可以：

1. **保存历史数据**
   ```python
   # 每次爬取保存到不同文件
   filename = f"fidelity-insights-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
   ```

2. **比较差异**
   ```python
   def compare_insights(old_file, new_file):
       with open(old_file) as f:
           old_data = json.load(f)
       with open(new_file) as f:
           new_data = json.load(f)
       
       # 比较洞察数量
       # 比较具体文章
       # 生成差异报告
   ```

3. **发送通知**
   - 邮件通知
   - Slack/钉钉消息
   - 保存到数据库

## 注意事项

1. **遵守 robots.txt**
   - 检查网站是否允许爬虫
   - 控制请求频率（建议间隔 2-5 秒）

2. **处理动态内容**
   - 页面使用 JavaScript 渲染
   - 必须使用 Chrome DevTools 等工具等待内容加载

3. **错误处理**
   - 网络超时
   - 页面结构变化
   - 登录/权限问题

4. **数据存储**
   - 定期清理旧数据
   - 备份重要结果

## 扩展功能

### 1. 添加更多页面

在 `TARGET_PAGES` 列表中添加新页面：

```python
{
    "url": "https://professionals.fidelity.co.uk/solutions/new-page",
    "name": "new-page"
}
```

### 2. 自定义输出格式

修改 `save_results()` 方法，支持：
- CSV 格式
- Excel 格式
- 数据库（SQLite/MySQL）

### 3. 添加过滤条件

```python
def filter_insights(insights, tags=None, date_range=None):
    """按标签或日期范围过滤洞察"""
    filtered = insights
    if tags:
        filtered = [i for i in filtered if any(t in i.tags for t in tags)]
    if date_range:
        # 按日期过滤
        pass
    return filtered
```

### 4. 集成到工作流

- GitHub Actions 定时运行
- Airflow DAG
- Jenkins Pipeline

## 故障排除

### 问题 1: 页面加载超时

**解决**: 增加等待时间
```python
await self._wait_for_page_load(timeout=20000)  # 20秒
```

### 问题 2: 无法找到洞察区域

**解决**: 更新关键词列表
```python
INSIGHT_KEYWORDS = [
    "Our latest thinking on",
    "Latest insights",
    # 添加新的关键词
    "New research",
    "Recent publications"
]
```

### 问题 3: MCP 连接失败

**解决**: 检查 MCP 配置
```bash
# 验证 MCP 服务器是否运行
npx chrome-devtools-mcp@latest --version
```

## 参考文档

- [MCP Chrome DevTools 文档](https://github.com/modelcontextprotocol/servers/tree/main/src/chrome-devtools)
- [Fidelity International 网站](https://professionals.fidelity.co.uk)

---

*文档创建时间: 2026年3月14日*
