"""
Step 2 — 外部数据源（MCP / SEC EDGAR / Web）引用追踪
MCP 服务没有 Collibra 资产对应，只记录 manifest，不回写 Collibra。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from src.citation import CitationContext, RunManifest

ExternalSourceType = Literal["mcp_factset", "mcp_daloopa", "mcp_spglobal", "sec_edgar", "web", "user_upload"]


def record_external_citation(
    source_type: ExternalSourceType,
    source_ref: str,
    query_or_path: str,
    field_name: str,
    value: Any,
    manifest: RunManifest,
) -> None:
    """
    外部数据源不经过 Snowflake，无法自动获取 query_id 或列血缘。
    只记录 manifest，供报告脚注和审计使用。

    用法（MCP FactSet）：
        record_external_citation(
            source_type="mcp_factset",
            source_ref="FactSet Consensus Estimates",
            query_or_path="https://mcp.factset.com/consensus?ticker=AAPL&period=Q3_2026",
            field_name="Consensus_EPS",
            value="$1.60",
            manifest=manifest,
        )
    """
    citation = CitationContext(
        run_id=manifest.run_id,
        timestamp=datetime.now(timezone.utc).isoformat(),
        source_type=source_type,
        source_ref=source_ref,
        query_or_path=query_or_path,
        field_name=field_name,
        value=str(value),
        collibra_asset_id=None,  # 外部源无 Collibra 资产
    )
    manifest.add(citation)
