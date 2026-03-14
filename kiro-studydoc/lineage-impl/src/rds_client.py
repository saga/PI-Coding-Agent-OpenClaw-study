"""
Step 2 — AWS RDS SQL Server 数据获取 + 引用追踪
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import pyodbc

from config.settings import RDS_SERVER, RDS_PORT, RDS_DATABASE, RDS_USER, RDS_PASSWORD
from src.citation import CitationContext, RunManifest


def _get_connection() -> pyodbc.Connection:
    conn_str = (
        f"DRIVER={{ODBC Driver 18 for SQL Server}};"
        f"SERVER={RDS_SERVER},{RDS_PORT};"
        f"DATABASE={RDS_DATABASE};"
        f"UID={RDS_USER};"
        f"PWD={RDS_PASSWORD};"
        "Encrypt=yes;TrustServerCertificate=no;"
    )
    return pyodbc.connect(conn_str)


def fetch_from_rds(
    sql: str,
    field_name: str,
    manifest: RunManifest,
    collibra_asset_id: Optional[str] = None,
) -> Any:
    """
    执行 SQL Server 查询，返回结果，并将引用记录追加到 manifest。
    """
    conn = _get_connection()
    try:
        cur = conn.cursor()
        cur.execute(sql)
        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchall()
        result = dict(zip(columns, rows[0])) if len(rows) == 1 else [dict(zip(columns, r)) for r in rows]

        citation = CitationContext(
            run_id=manifest.run_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            source_type="rds_sqlserver",
            source_ref=f"{RDS_DATABASE} ({RDS_SERVER})",
            query_or_path=sql.strip(),
            field_name=field_name,
            value=str(result),
            collibra_asset_id=collibra_asset_id,
        )
        manifest.add(citation)
        return result
    finally:
        conn.close()
