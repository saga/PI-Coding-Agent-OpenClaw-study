"""
Step 2 — Citation Context 对象
每次 Agent 从任何数据源取数时，生成一个 CitationContext 并累积到 RunManifest。
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional


SourceType = Literal[
    "snowflake",
    "rds_sqlserver",
    "sec_edgar",
    "mcp_factset",
    "mcp_daloopa",
    "mcp_spglobal",
    "web",
    "user_upload",
]


@dataclass
class CitationContext:
    """单条数据引用记录。"""
    run_id: str
    timestamp: str                      # ISO 8601 UTC
    source_type: SourceType
    source_ref: str                     # 表名 / 文件名 / URL
    query_or_path: str                  # 具体 SQL 或文件路径或 API endpoint
    field_name: str                     # 报告中对应的字段名，如 "Q3_Revenue"
    value: str                          # 实际取到的值（字符串化）
    snowflake_query_id: Optional[str] = None   # Snowflake QUERY_HISTORY.QUERY_ID
    collibra_asset_id: Optional[str] = None    # Collibra 资产 UUID（有则填）
    column_names: list[str] = field(default_factory=list)  # ACCESS_HISTORY 列级血缘

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RunManifest:
    """
    一次报告生成的完整引用清单。
    run_id 全局唯一，用 UUID4 + 时间戳组合防止并发冲突。
    """
    run_id: str = field(default_factory=lambda: f"{uuid.uuid4()}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}")
    report_file: str = ""
    ticker: str = ""
    report_type: str = ""               # "earnings_update" | "initiation" | "morning_note" ...
    generated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    agent_version: str = "pi-coding-agent"
    model_id: str = ""                  # LLM model used, e.g. "claude-3-7-sonnet-20250219"
    citations: list[CitationContext] = field(default_factory=list)
    collibra_report_asset_id: Optional[str] = None  # 回写 Collibra 后填入

    def add(self, citation: CitationContext) -> None:
        self.citations.append(citation)

    def save(self, output_dir: str = "./manifests") -> Path:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        filename = f"{self.run_id}.manifest.json"
        path = Path(output_dir) / filename
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._to_dict(), f, indent=2, ensure_ascii=False)
        return path

    def _to_dict(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def load(cls, path: str) -> "RunManifest":
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        citations = [CitationContext(**c) for c in data.pop("citations", [])]
        manifest = cls(**data)
        manifest.citations = citations
        return manifest
