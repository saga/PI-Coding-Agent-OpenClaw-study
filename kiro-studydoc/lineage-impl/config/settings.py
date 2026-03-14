"""
配置管理 — 从环境变量读取，不硬编码任何凭证
"""
import os
from dotenv import load_dotenv

load_dotenv()

# Snowflake
SNOWFLAKE_ACCOUNT   = os.environ["SNOWFLAKE_ACCOUNT"]       # e.g. xy12345.us-east-1
SNOWFLAKE_USER      = os.environ["SNOWFLAKE_USER"]
SNOWFLAKE_PASSWORD  = os.environ["SNOWFLAKE_PASSWORD"]
SNOWFLAKE_WAREHOUSE = os.environ.get("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH")
SNOWFLAKE_DATABASE  = os.environ.get("SNOWFLAKE_DATABASE",  "RESEARCH_DB")
SNOWFLAKE_SCHEMA    = os.environ.get("SNOWFLAKE_SCHEMA",    "FINANCIALS")
SNOWFLAKE_ROLE      = os.environ.get("SNOWFLAKE_ROLE",      "SYSADMIN")

# AWS RDS SQL Server
RDS_SERVER   = os.environ["RDS_SERVER"]    # e.g. mydb.xxxx.us-east-1.rds.amazonaws.com
RDS_PORT     = int(os.environ.get("RDS_PORT", "1433"))
RDS_DATABASE = os.environ["RDS_DATABASE"]
RDS_USER     = os.environ["RDS_USER"]
RDS_PASSWORD = os.environ["RDS_PASSWORD"]

# Collibra
COLLIBRA_BASE_URL    = os.environ["COLLIBRA_BASE_URL"]   # e.g. https://myorg.collibra.com
COLLIBRA_USERNAME    = os.environ["COLLIBRA_USERNAME"]
COLLIBRA_PASSWORD    = os.environ["COLLIBRA_PASSWORD"]
COLLIBRA_COMMUNITY   = os.environ.get("COLLIBRA_COMMUNITY", "Equity Research")
COLLIBRA_DOMAIN_NAME = os.environ.get("COLLIBRA_DOMAIN_NAME", "Research Reports")

# OpenLineage (Marquez or Collibra endpoint)
OPENLINEAGE_URL      = os.environ.get("OPENLINEAGE_URL", "http://localhost:5000")
OPENLINEAGE_NAMESPACE = os.environ.get("OPENLINEAGE_NAMESPACE", "equity-research-agent")

# 报告输出目录
REPORTS_OUTPUT_DIR   = os.environ.get("REPORTS_OUTPUT_DIR", "./reports")
MANIFEST_OUTPUT_DIR  = os.environ.get("MANIFEST_OUTPUT_DIR", "./manifests")
