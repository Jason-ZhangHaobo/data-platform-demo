"""Real Spark SQL runner for allowlisted synthetic fixtures. Local process != production isolation."""
import json, os, sys, time, hashlib
from decimal import Decimal
from pathlib import Path
import sqlglot
from sqlglot import exp

FUNCTIONS = {"SUM","COUNT","COALESCE","CAST","TRY_CAST","ROUND","ABS","MIN","MAX","AVG","IF","CASE","TRIM","UPPER","LOWER","CONCAT","NULLIF","DATE","TO_DATE","DATE_ADD","DATE_SUB"}

def validate_sql(sql, context):
    if not isinstance(sql, str) or not 6 <= len(sql) <= 20000:
        raise ValueError("SQL 长度必须在 6—20000 字符之间")
    for key, value in {"advisor_id": context["advisorId"], "trade_date": context["businessDate"]}.items():
        if not isinstance(value,str) or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in value):
            raise ValueError("运行参数不合法")
        sql = sql.replace("{{"+key+"}}", value)
    trees = sqlglot.parse(sql, read="spark")
    if len(trees) != 1 or not isinstance(trees[0], exp.Select):
        raise ValueError("仅允许单条 SELECT/WITH 查询")
    tree=trees[0]
    base_tables={t["name"] for t in context["tables"]}
    aliases={cte.alias_or_name for cte in tree.find_all(exp.CTE)}
    if "__shuduo_result" in aliases:raise ValueError("内部结果视图名称不可用作CTE别名")
    allowed=base_tables | aliases
    for table in tree.find_all(exp.Table):
        if table.name not in allowed or table.db or table.catalog:
            raise ValueError("SQL 引用了未授权数据表")
    if tree.find(exp.Into) is not None:
        raise ValueError("禁止写入数据")
    for fn in tree.find_all(exp.Func):
        # sqlglot models AND/OR as Func subclasses; these are boolean
        # operators, not external function calls. Still inspect all children.
        if isinstance(fn,(exp.And,exp.Or)):
            continue
        name=(fn.name if isinstance(fn,exp.Anonymous) else fn.sql_name()).upper()
        if name not in FUNCTIONS:
            raise ValueError("不支持的 SQL 函数："+name)
    return sql

def create_spark():
    from pyspark.sql import SparkSession
    return (SparkSession.builder.master("local[1]").appName("ShuduoSyntheticSQL")
      .config("spark.ui.enabled","false").config("spark.sql.shuffle.partitions","1")
      .config("spark.default.parallelism","1").config("spark.driver.memory","768m")
      .config("spark.driver.bindAddress","127.0.0.1").config("spark.driver.host","127.0.0.1")
      .config("spark.sql.warehouse.dir", str(Path.cwd()/"warehouse"))
      .getOrCreate())

def execute(spark, sql, context):
    from pyspark.sql.types import StructType, StructField, StringType
    validated=validate_sql(sql,context)
    accounts=next(t for t in context["tables"] if t["name"]=="accounts")
    allowed_clients={row[0] for row in accounts["rows"] if row[1]==context["advisorId"]}
    for table in context["tables"]:
        name=table["name"]
        if name not in {"accounts","positions","cash"}: raise ValueError("数据表不在允许列表")
        schema=StructType([StructField(c[0],StringType(),True) for c in table["columns"]])
        client_index=[c[0] for c in table["columns"]].index("client_id")
        scoped_rows=[row for row in table["rows"] if row[client_index] in allowed_clients]
        frame=spark.createDataFrame([[None if v is None else str(v) for v in row] for row in scoped_rows],schema)
        for col,kind in table["columns"]:
            if kind not in {"STRING","DECIMAL(18,2)"}: raise ValueError("字段类型不支持")
            frame=frame.withColumn(col,frame[col].cast(kind))
        frame.createOrReplaceTempView(name)
    frame=spark.sql(validated)
    data=frame.limit(1001).collect()
    if len(data)>1000: raise ValueError("查询结果超过 1000 行")
    spark.createDataFrame(data,frame.schema).createOrReplaceTempView("__shuduo_result")
    rows=[{k:format(v,"f") if isinstance(v,Decimal) else v for k,v in row.asDict().items()} for row in data]
    return {"rows":rows,"columns":[{"name":f.name,"type":f.dataType.simpleString()} for f in frame.schema.fields],"engine":"Apache Spark","engineVersion":spark.version}

def verify(rows,expected):
    issues=[]
    if len(rows)!=len(expected):issues.append("客户记录数不符")
    keys={"client_id","holding_market_value","available_cash","total_assets","security_count"}
    if any(set(row)!=keys for row in rows):issues.append("输出字段与契约不符")
    actual={r.get("client_id"):r for r in rows}
    if len(actual)!=len(rows):issues.append("客户记录重复")
    for goal in expected:
        row=actual.get(goal["client_id"])
        if row is None: issues.append("缺少客户 "+goal["client_id"]);continue
        for field in keys-{"client_id"}:
            try:
                if Decimal(str(row.get(field)))!=Decimal(str(goal[field])):issues.append(goal["client_id"]+"."+field+" 结果不符")
            except Exception:issues.append(field+" 非有效数值")
    if set(actual)!={r["client_id"] for r in expected}:issues.append("结果包含范围外客户或缺少客户")
    return {"passed":not issues,"issues":issues,"assertions":["客户范围","客户唯一性","持仓去重","现金独立聚合","金额精度","证券代码去重","输出契约"]}

def execute_test_sql(spark,test_sql,context):
    scope={"advisorId":context["advisorId"],"businessDate":context["businessDate"],"tables":[{"name":"__shuduo_result"}]}
    query=validate_sql(test_sql,scope)
    frame=spark.sql(query)
    values=frame.limit(2).collect()
    passed=frame.columns==["passed"] and len(values)==1 and values[0]["passed"] is True
    return {"passed":passed,"sqlHash":hashlib.sha256(test_sql.encode()).hexdigest(),"rowCount":len(values),"columns":frame.columns}

def execute_with_validation(spark,sql,context,validation_contexts=None,test_sql=None):
    result=execute(spark,sql,context)
    result["mainSqlExecuted"]=True
    test_check=None
    if test_sql is not None:
        try:test_check=execute_test_sql(spark,test_sql,context)
        except Exception as error:
            test_check={"passed":False,"sqlHash":hashlib.sha256(test_sql.encode()).hexdigest(),"error":str(error)[:3000]}
    selected=verify(result["rows"],context["expected"])
    regressions=[{"contextId":context["id"],"name":context["name"],**selected}]
    if validation_contexts is not None and (not isinstance(validation_contexts,list) or len(validation_contexts)>5):
        raise ValueError("回归上下文数量不合法")
    seen={context["id"]}
    for check_context in validation_contexts or []:
        if check_context["id"] in seen:continue
        seen.add(check_context["id"])
        actual=execute(spark,sql,check_context)
        checked=verify(actual["rows"],check_context["expected"])
        regressions.append({"contextId":check_context["id"],"name":check_context["name"],**checked})
    issues=[check["name"]+"："+issue for check in regressions for issue in check["issues"]]
    if test_check is not None and not test_check["passed"]:issues.append("tests.sql："+test_check.get("error","没有得到唯一的 passed=true 结果"))
    result["validation"]={
        "passed":not issues,"issues":issues,"assertions":selected["assertions"],
        "selectedPassed":selected["passed"],"scope":"SELECTED_AND_REGISTERED_FIXTURES","regressions":regressions,
    }
    result["status"]="SUCCEEDED" if result["validation"]["passed"] else "VALIDATION_FAILED"
    if test_check is not None:result["testSqlValidation"]=test_check
    return result

if __name__=="__main__":
    payload=json.loads(Path(sys.argv[1]).read_text())
    started=time.monotonic();spark=None
    try:
        validate_sql(payload["sql"],payload["context"])
        spark=create_spark();spark.sparkContext.setLogLevel("ERROR")
        result=execute_with_validation(spark,payload["sql"],payload["context"],payload.get("validationContexts",[]),payload.get("testSql"))
    except Exception as error:
        result={"status":"FAILED","error":str(error)[:5000],"engine":"Apache Spark"}
    finally:
        if spark is not None:spark.stop()
    result["durationMs"]=round((time.monotonic()-started)*1000)
    Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False))
