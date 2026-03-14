"""
Step 2 — Snowflake 数据获取 + 引用追踪
利用 Enterprise 版本的 QUERY_HISTORY 和 ACCESS_HISTORY 实现列级血缘。
"""
from __future__ import annotations

import re
import time
from typing import Any, Optional

import snowflake.connector
from snowflake.connector import DictCursor

from config.settings import (
    SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD,
    SNOWFLAKE_WAREHOUSE, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA, SNOWFLAKE_ROLE,
)
from src.citation import CitationContext, RunManifest


def _get_connection() -> snowflake.connector.SnowflakeConnection:
    return snowflake.connector.connect(
        account=SNOWFLAKE_ACCOUNT,
        user=SNOWFLAKE_USER,
        password=SNOWFLAKE_PASSWORD,
        warehouse=SNOWFLAKE_WAREHOUSE,
        database=SNOWFLAKE_DATABASE,
        schema=SNOWFLAKE_SCHEMA,
        role=SNOWFLAKE_ROLE,
        session_parameters={"QUERY_TAG": "equity-research-agent"},
    )


def _extract_tables_from_sql(sql: str) -> list[str]:
    """
    简单正则从 SQL 中提取 FROM / JOIN 后的表名。
    生产环境建议替换为 sqlglot 解析器以处理复杂子查询。
    """
    pattern = r"(?:FROM|JOIN)\s+([\w.\"]+)"
    matches = re.findall(pattern, sql, re.IGNORECASE)
    return [m.strip('"') for m in matches]


def _get_access_history(conn: snowflake.connector.SnowflakeConnection,
                        query_id: str) -> list[str]:
    """
    从 ACCESS_HISTORY 获取该 query_id 涉及的列名列表。
    需要 Snowflake Enterprise 版本 + ACCOUNTADMIN 或 GOVERNANCE_VIEWER 角色。
    """
    sql = """
        SELECT DISTINCT
            col.value:columnName::STRING AS column_name,
            col.value:objectName::STRING AS object_name
        FROM snowflake.account_usage.access_history ah,
             LATERAL FLATTEN(input => ah.objects_modified) obj,
             LATERAL FLATTEN(input => obj.value:columns) col
        WHERE ah.query_id = %(query_id)s
        UNION ALL
        SELECT DISTINCT
            col.value:columnName::STRING,
            col.value:objectName::STRING
        FROM snowflake.account_usage.access_history ah,
             LATERAL FLATTEN(input => ah.base_objects_accessed) obj,
             LATERAL FLATTEN(input => obj.value:columns) col
        WHERE ah.query_id = %(query_id)s
    """
    # ACCESS_HISTORY 有约 3 小时延迟，生产中可异步补充
    try:
        cur = conn.cursor(DictCursor)
        cur.execute(sql, {"query_id": query_id})
        rows = cur.fetchall()
        return [f"{r['OBJECT_NAME']}.{r['COLUMN_NAME']}" for r in rows if r["COLUMN_NAME"]]
    except Exception:
        # 权限不足或延迟未就绪时静默降级，不阻断主流程
        return []


def fetch_from_snowflake(
    sql: str,
    field_name: str,
    manifest: RunManifest,
    collibra_asset_id: Optional[str] = None,
) -> Any:
    """
    执行 SQL，返回结果，并将引用记录追加到 manifest。

    用法：
        revenue = fetch_from_snowflake(
            sql="SELECT revenue FROM financials.earnings WHERE ticker='AAPL' AND quarter='Q3_2026'",
            field_name="Q3_Revenue",
            manifest=manifest,
        )
    """
    conn = _get_connection()
    try:
        cur = conn.cursor(DictCursor)
        cur.execute(sql)
        rows = cur.fetchall()
        result = rows[0] if len(rows) == 1 else rows

        # 获取 Snowflake 分配的 query_id
        query_id: str = cur.sfqid  # type: ignore[attr-defined]

        # 尝试获取列级血缘（Enterprise ACCESS_HISTORY，有延迟）
        column_names = _get_access_history(conn, query_id)

        tables = _extract_tables_from_sql(sql)
        source_ref = ", ".join(tables) if tables else "UNKNOWN"

        citation = CitationContext(
            run_id=manifest.run_id,
            timestamp=_utcnow(),
            source_type="snowflake",
            source_ref=source_ref,
            query_or_path=sql.strip(),
            field_name=field_name,
            value=str(result),
            snowflake_query_id=query_id,
            collibra_asset_id=collibra_asset_id,
            column_names=column_names,
        )
        manifest.add(citation)
        return result

    finally:
        conn.close()


def _utcnow() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
