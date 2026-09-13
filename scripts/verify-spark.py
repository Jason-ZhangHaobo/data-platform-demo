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
 report={"engine":"Apache Spark","engineVersion":spark.version,"scope":"SPARK_AND_ASSERTION_ACCEPTANCE_NOT_MODEL_E2E","total":len(results),"passed":sum(r["passed"] for r in results),"durationMs":round((time.monotonic()-start)*1000),"cases":results}
finally:spark.stop()
out=ROOT/".v2-artifacts";out.mkdir(exist_ok=True)
(out/"spark-acceptance.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!="cases"},ensure_ascii=False))
sys.exit(0 if report["passed"]==report["total"] else 1)
