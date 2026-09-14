"""Independent Spark acceptance cases. This is NOT a live-model benchmark."""
import copy, importlib.util, json, os, sys, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
os.environ.setdefault("JAVA_HOME",str(ROOT/".runtime/java/Contents/Home"))
os.environ["SPARK_LOCAL_IP"]="127.0.0.1"
os.environ["PYSPARK_PYTHON"]=sys.executable
spec=importlib.util.spec_from_file_location("worker",ROOT/"src/v2/worker.py");worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
base=json.loads((ROOT/"fixtures/holdings/context.json").read_text())
sql=(ROOT/"fixtures/holdings/reference.sql").read_text()
cases=[]
def add(name,change=lambda c:None,query=sql,expect="PASS"):
 c=copy.deepcopy(base);change(c);cases.append((name,c,query,expect))
def rows(c,name):return next(t["rows"] for t in c["tables"] if t["name"]==name)
def expected(c,client,**values):next(r for r in c["expected"] if r["client_id"]==client).update(values)
add("标准客户资产")
add("组合 AND OR 条件",query=sql.replace("WHERE advisor_id = '{{advisor_id}}'","WHERE advisor_id = '{{advisor_id}}' AND (client_id = 'CLIENT-001' OR client_id = 'CLIENT-002')"))
add("现金变化改变总资产",lambda c:(rows(c,"cash")[0].__setitem__(1,"800.00"),expected(c,"CLIENT-001",available_cash="800.00",total_assets="2300.00")))
add("重复持仓不重复计金额",lambda c:rows(c,"positions").append(list(rows(c,"positions")[0])))
add("同证券不同持仓只计一个证券",lambda c:(rows(c,"positions").append(["POS-005","CLIENT-001","SEC-DEMO-001","股票","金融","100.00","2026-09-10"]),expected(c,"CLIENT-001",holding_market_value="1600.00",total_assets="1900.00")))
add("无持仓现金客户",lambda c:(rows(c,"accounts").append(["CLIENT-004","ADVISOR-DEMO-A"]),rows(c,"cash").append(["CLIENT-004","100.00","2026-09-10"]),c["expected"].append({"client_id":"CLIENT-004","holding_market_value":"0.00","available_cash":"100.00","total_assets":"100.00","security_count":0})))
add("无现金持仓客户",lambda c:(rows(c,"cash").pop(0),expected(c,"CLIENT-001",available_cash="0.00",total_assets="1500.00")))
add("空持仓金额",lambda c:(rows(c,"positions")[0].__setitem__(5,None),expected(c,"CLIENT-001",holding_market_value="500.00",total_assets="800.00")))
add("空现金金额",lambda c:(rows(c,"cash")[0].__setitem__(1,None),expected(c,"CLIENT-001",available_cash="0.00",total_assets="1500.00")))
add("金额分精度",lambda c:(rows(c,"positions")[0].__setitem__(5,"0.10"),rows(c,"cash")[0].__setitem__(1,"0.20"),expected(c,"CLIENT-001",holding_market_value="500.10",available_cash="0.20",total_assets="500.30")))
add("其他顾问记录隔离",lambda c:rows(c,"positions").append(["POS-009","CLIENT-003","SEC-DEMO-005","股票","其他","999999.00","2026-09-10"]))
add("不同交易日持仓过滤",lambda c:rows(c,"positions").append(["POS-006","CLIENT-001","SEC-DEMO-006","股票","其他","100000.00","2026-09-09"]))
add("不同交易日现金过滤",lambda c:rows(c,"cash").append(["CLIENT-001","100000.00","2026-09-09"]))
add("零持仓市值",lambda c:(rows(c,"positions")[0].__setitem__(5,"0.00"),expected(c,"CLIENT-001",holding_market_value="500.00",total_assets="800.00")))
add("重复归属记录",lambda c:rows(c,"accounts").append(list(rows(c,"accounts")[0])))
add("同客户多现金项分别聚合",lambda c:(rows(c,"cash").append(["CLIENT-001","20.00","2026-09-10"]),expected(c,"CLIENT-001",available_cash="320.00",total_assets="1820.00")))
add("错误结果不能算成功",query="SELECT 'CLIENT-001' AS client_id, 0 AS holding_market_value, 0 AS available_cash, 0 AS total_assets, 0 AS security_count",expect="ASSERTION_FAILURE")
add("缺少归属条件也不能读其他顾问",query="SELECT client_id FROM accounts WHERE advisor_id='ADVISOR-DEMO-B'",expect="NO_ROWS")
add("未知字段返回执行报错",query="SELECT missing_field FROM positions",expect="ENGINE_ERROR")
add("阻断删除语句",query="DROP TABLE positions",expect="REJECTED")
add("阻断多语句",query="SELECT * FROM positions; SELECT * FROM cash",expect="REJECTED")
add("阻断未登记表",query="SELECT * FROM unregistered_data",expect="REJECTED")
add("阻断外部文件表",query="SELECT * FROM parquet.`/tmp/private`",expect="REJECTED")
add("阻断反射调用",query="SELECT reflect('java.lang.Runtime','getRuntime')",expect="REJECTED")
add("逻辑条件内反射仍被阻断",query="SELECT client_id FROM accounts WHERE client_id='CLIENT-001' OR reflect('java.lang.Runtime','getRuntime') IS NOT NULL",expect="REJECTED")

start=time.monotonic();spark=worker.create_spark();spark.sparkContext.setLogLevel("ERROR");results=[]
try:
 for name,context,query,expect in cases:
  error=None;passed=False
  try:
   worker.validate_sql(query,context)
   result=worker.execute(spark,query,context)
   validation=worker.verify(result["rows"],context["expected"])
   passed=(expect=="PASS" and validation["passed"]) or (expect=="ASSERTION_FAILURE" and not validation["passed"]) or (expect=="NO_ROWS" and not result["rows"])
   if not passed:error=str(validation["issues"])
  except ValueError as e:passed=expect=="REJECTED";error=str(e)
  except Exception as e:passed=expect=="ENGINE_ERROR";error=str(e)[:500]
  results.append({"name":name,"passed":passed,"expected":expect,"detail":error})
  print(("PASS " if passed else "FAIL ")+name,flush=True)
 cash_check=copy.deepcopy(base);cash_check["id"]="cash-change";cash_check["name"]="现金变更"
 rows(cash_check,"cash")[0][1]="800.00"
 expected(cash_check,"CLIENT-001",available_cash="800.00",total_assets="2300.00")
 duplicate_check=copy.deepcopy(base);duplicate_check["id"]="duplicate-position";duplicate_check["name"]="重复持仓"
 rows(duplicate_check,"positions").append(list(rows(duplicate_check,"positions")[0]))
 equal_check=copy.deepcopy(base);equal_check["id"]="equal-value-positions";equal_check["name"]="同额不同持仓"
 rows(equal_check,"positions").append(["POS-DISTINCT"]+list(rows(equal_check,"positions")[0][1:]))
 expected(equal_check,"CLIENT-001",holding_market_value="2500.00",total_assets="2800.00")
 cash_only_check=copy.deepcopy(base);cash_only_check["id"]="cash-only-client";cash_only_check["name"]="仅有现金客户"
 rows(cash_only_check,"accounts").append(["CLIENT-004","ADVISOR-DEMO-A"])
 rows(cash_only_check,"cash").append(["CLIENT-004","100.00","2026-09-10"])
 cash_only_check["expected"].append({"client_id":"CLIENT-004","holding_market_value":"0.00","available_cash":"100.00","total_assets":"100.00","security_count":0})
 matrix=[base,cash_check,duplicate_check,equal_check,cash_only_check]
 for name,query,should_pass in [
   ("同一SQL五场景回归通过",sql,True),
   ("标准数据正确但漏去重不能假通过",sql.replace("SELECT DISTINCT position_id","SELECT position_id"),False),
   ("不能把同证券同金额的不同持仓合并",sql.replace("SELECT DISTINCT position_id, client_id","SELECT DISTINCT client_id"),False),
   ("只以持仓客户为起点会漏现金客户",sql.replace("FROM eligible_clients c","FROM position_totals c"),False),
 ]:
  try:
   checked=worker.execute_with_validation(spark,query,base,matrix)["validation"]
   passed=checked["passed"]==should_pass and checked["selectedPassed"] and len(checked["regressions"])==5
   detail=None if passed else str(checked["issues"])
  except Exception as error:passed=False;detail=str(error)[:500]
  results.append({"name":name,"passed":passed,"expected":"MATRIX_PASS" if should_pass else "MATRIX_REJECT_FALSE_POSITIVE","detail":detail})
  print(("PASS " if passed else "FAIL ")+name,flush=True)
 report={"engine":"Apache Spark","engineVersion":spark.version,"scope":"SPARK_AND_ASSERTION_ACCEPTANCE_NOT_MODEL_E2E","total":len(results),"passed":sum(r["passed"] for r in results),"durationMs":round((time.monotonic()-start)*1000),"cases":results}
finally:spark.stop()
out=ROOT/".v2-artifacts";out.mkdir(exist_ok=True)
(out/"spark-acceptance.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!="cases"},ensure_ascii=False))
sys.exit(0 if report["passed"]==report["total"] else 1)
