你前面的 **repo fingerprint scanner** 其实只能识别：

* repo 类型
* framework
* cloud services
* CI/CD

但很多企业内部 IT inventory 还需要：

```
dependency graph
```

也就是：

```
repo → libraries → frameworks → cloud sdk → infra
```

这就是 **Repo Dependency Graph Scanner**。

像 GitHub 的
GitHub Dependency Graph
本质也是做这件事。

下面给你一个 **企业可落地设计**（非常适合你前面的 fingerprint scanner）。

---

# 一、Dependency Graph Scanner 目标

扫描 repo 并输出：

```
repo
 ├─ language
 ├─ framework
 ├─ libraries
 ├─ cloud sdk
 ├─ database driver
 └─ messaging client
```

例如：

```
portfolio-service

language: java
framework: springboot

dependencies
 ├─ spring-web
 ├─ spring-data-jpa
 ├─ aws-java-sdk-s3
 ├─ postgres-driver
 └─ kafka-client
```

然后你可以得到：

```
enterprise dependency graph
```

例如：

```
SpringBoot → Kafka
SpringBoot → Postgres
Node → DynamoDB
```

---

# 二、架构

在原来的 scanner 中增加一个模块：

```
Repo
 │
 ▼
File Indexer
 │
 ▼
Dependency Extractor
 │
 ▼
Dependency Normalizer
 │
 ▼
Dependency Graph Builder
 │
 ▼
SQLite / JSON
```

模块：

```
scanner/

dependency_scanner.py
dependency_parser.py
dependency_graph.py
```

---

# 三、核心思路

只解析 **dependency files**：

| 语言     | 文件               |
| ------ | ---------------- |
| Java   | pom.xml          |
| Java   | build.gradle     |
| Node   | package.json     |
| Python | requirements.txt |
| Python | pyproject.toml   |
| C#     | *.csproj         |
| Go     | go.mod           |
| Rust   | Cargo.toml       |

你公司 repo 基本都会有这些。

---

# 四、SQLite Schema

新增两个表。

---

## dependencies

```sql
CREATE TABLE dependencies (
 repo_id INTEGER,
 name TEXT,
 version TEXT,
 ecosystem TEXT
);
```

例如：

```
spring-boot-starter-web
aws-java-sdk-s3
react
express
```

---

## dependency_edges

用于 graph。

```sql
CREATE TABLE dependency_edges (
 repo_id INTEGER,
 dependency TEXT,
 type TEXT
);
```

type：

```
framework
database
cloud
messaging
library
```

---

# 五、Dependency Parser

## Java (Maven)

解析 `pom.xml`

Python 示例：

```python
import xml.etree.ElementTree as ET

def parse_maven(pom):

    deps = []

    tree = ET.parse(pom)
    root = tree.getroot()

    for d in root.findall(".//dependency"):

        group = d.find("groupId").text
        artifact = d.find("artifactId").text

        deps.append(group + ":" + artifact)

    return deps
```

输出：

```
org.springframework.boot:spring-boot-starter-web
software.amazon.awssdk:s3
org.postgresql:postgresql
```

---

# 六、Gradle Parser

解析：

```
build.gradle
```

正则提取：

```
implementation 'org.springframework.boot:spring-boot'
```

---

# 七、Node Parser

解析 `package.json`

```python
import json

def parse_package_json(path):

    with open(path) as f:
        data = json.load(f)

    deps = []

    for k in data.get("dependencies", {}):
        deps.append(k)

    return deps
```

输出：

```
react
express
aws-sdk
mongoose
```

---

# 八、Python Parser

解析：

```
requirements.txt
```

示例：

```
fastapi
boto3
pandas
sqlalchemy
```

---

# 九、C# Parser

解析：

```
*.csproj
```

XML：

```
<PackageReference Include="Newtonsoft.Json" Version="13.0.1"/>
```

---

# 十、Dependency Normalization

不同语言 SDK 名字不同，需要 normalize。

例如：

| 原始                 | 标准组件    |
| ------------------ | ------- |
| aws-java-sdk-s3    | aws-s3  |
| boto3              | aws-sdk |
| @aws-sdk/client-s3 | aws-s3  |

规则：

```
normalization_rules.yaml
```

例如：

```
aws-java-sdk-* → aws-sdk
software.amazon.awssdk:* → aws-sdk
boto3 → aws-sdk
```

---

# 十一、Dependency 分类

把 dependency 分类为：

```
framework
database
cloud
messaging
library
```

规则：

### framework

```
spring-boot
react
express
nestjs
django
flask
aspnet
```

---

### database

```
postgres
mysql
mongodb
redis
cassandra
```

---

### cloud

```
aws-sdk
azure-sdk
gcp-sdk
```

---

### messaging

```
kafka
rabbitmq
sqs
sns
```

---

# 十二、Graph 构建

最终 graph：

```
repo → dependency
```

例如：

```
portfolio-service
 ├─ springboot
 ├─ postgres
 ├─ aws-s3
 └─ kafka
```

存入 SQLite。

---

# 十三、企业级 Graph

你可以得到：

```
technology usage graph
```

例如：

```
SpringBoot → Kafka
SpringBoot → Postgres
Node → DynamoDB
Python → S3
```

甚至可以做：

```
blast radius analysis
```

例如：

```
log4j vulnerability
```

查：

```
哪些 repo 用了 log4j
```

---

# 十四、最终 Scanner Pipeline

完整 pipeline：

```
repo scan

1 file index
2 fingerprint detection
3 dependency extraction
4 dependency normalization
5 dependency classification
6 repo classification
7 graph generation
8 store sqlite
```

---

# 十五、输出示例

最终 repo fingerprint：

```
repo: portfolio-service

language: java
framework: springboot
repo_type: microservice

dependencies
 ├─ spring-web
 ├─ spring-data-jpa
 ├─ aws-s3
 ├─ postgres
 └─ kafka

cicd
 └─ github-actions

infra
 └─ terraform
```

---

# 十六、企业规模效果

扫描：

```
800 repos
```

得到：

```
Dependencies detected: 12,000
Unique components: 950
```

Tech usage：

```
SpringBoot 320
React 180
Node 120
Terraform 90
Python 60
.NET 50
```

---

# 十七、一个非常重要的进阶（很多人没想到）

可以做：

```
service dependency graph
```

例如：

```
repo A → kafka topic → repo B
repo B → postgres
repo C → dynamodb
```

这就接近：

```
enterprise architecture map
```

很多大型金融公司内部都会做类似系统。

---

如果你愿意，我可以再给你一个 **非常关键的设计**（这会让你的 scanner 从“玩具级”直接变成“企业级”）：

**Code Pattern Scanner**

用于识别：

```
S3 bucket usage
Kafka topics
SQL tables
REST endpoints
```

准确度会直接提升一个数量级。
