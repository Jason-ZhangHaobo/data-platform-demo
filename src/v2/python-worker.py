"""Restricted Python data-development runner for synthetic securities rows."""
import ast
import json
import resource
import sys
import time
from decimal import Decimal
from pathlib import Path

ALLOWED_NODES = {
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return,
    ast.Assign, ast.AnnAssign, ast.AugAssign, ast.For, ast.If, ast.IfExp,
    ast.Expr, ast.Call, ast.Name, ast.Load, ast.Store, ast.Constant,
    ast.List, ast.Tuple, ast.Dict, ast.Set, ast.ListComp, ast.DictComp,
    ast.SetComp, ast.GeneratorExp, ast.comprehension, ast.BinOp, ast.Add,
    ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.UnaryOp,
    ast.UAdd, ast.USub, ast.Not, ast.BoolOp, ast.And, ast.Or, ast.Compare,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In,
    ast.NotIn, ast.Is, ast.IsNot, ast.Subscript, ast.Slice, ast.Attribute,
    ast.keyword, ast.Pass, ast.Break, ast.Continue,
}
ALLOWED_CALLS = {
    "abs", "Decimal", "dict", "enumerate", "len", "list", "max",
    "min", "range", "round", "set", "sorted", "sum", "tuple", "zip",
}
ALLOWED_METHODS = {
    "add", "append", "copy", "get", "items", "keys", "setdefault",
    "sort", "values",
}
EXPECTED_FIELDS = {
    "client_id", "holding_market_value", "available_cash", "total_assets",
    "security_count",
}

def bounded_range(*args):
    value = range(*args)
    if len(value) > 10000:
        raise ValueError("range超过10000项限制")
    return value

SAFE_BUILTINS = {
    "abs": abs, "dict": dict, "enumerate": enumerate, "len": len,
    "list": list, "max": max, "min": min, "range": bounded_range,
    "round": round, "set": set, "sorted": sorted, "sum": sum,
    "tuple": tuple, "zip": zip,
}

def validate_code(code):
    if not isinstance(code, str) or not 20 <= len(code) <= 20000:
        raise ValueError("Python代码长度必须在20—20000字符之间")
    tree = ast.parse(code, mode="exec")
    nodes = list(ast.walk(tree))
    if len(nodes) > 1200:
        raise ValueError("Python代码结构超过限制")
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    if len(tree.body) != 1 or len(functions) != 1:
        raise ValueError("Python代码只能定义一个transform函数")
    function = functions[0]
    if (
        function.name != "transform"
        or [item.arg for item in function.args.args] != ["data", "params"]
        or function.decorator_list
        or function.args.vararg
        or function.args.kwarg
        or function.args.defaults
        or function.args.kwonlyargs
    ):
        raise ValueError("transform函数必须只接收data和params两个参数")
    for node in nodes:
        if type(node) not in ALLOWED_NODES:
            raise ValueError("Python代码包含不允许的语法：" + type(node).__name__)
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ValueError("Python代码不能访问内部名称")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_") or node.attr not in ALLOWED_METHODS:
                raise ValueError("Python代码调用了不允许的方法")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id not in ALLOWED_CALLS:
                raise ValueError("Python代码调用了不允许的函数")
            if not isinstance(node.func, (ast.Name, ast.Attribute)):
                raise ValueError("Python代码调用形式不受支持")
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) > 2000:
            raise ValueError("Python字符串常量过长")
    return tree

def table_rows(context):
    result = {}
    for table in context["tables"]:
        names = [column[0] for column in table["columns"]]
        result[table["name"]] = [dict(zip(names, row)) for row in table["rows"]]
    return result

def normalize(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dict):
        return {str(key): normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise ValueError("Python结果包含不支持的值类型")

def verify(rows, expected):
    issues = []
    if not isinstance(rows, list) or len(rows) > 1000:
        return {"passed": False, "issues": ["Python结果必须是最多1000行的列表"]}
    if len(rows) != len(expected):
        issues.append("客户记录数不符")
    if any(not isinstance(row, dict) or set(row) != EXPECTED_FIELDS for row in rows):
        issues.append("输出字段与契约不符")
    actual = {row.get("client_id"): row for row in rows if isinstance(row, dict)}
    if len(actual) != len(rows):
        issues.append("客户记录重复")
    for goal in expected:
        row = actual.get(goal["client_id"])
        if row is None:
            issues.append("缺少客户 " + goal["client_id"])
            continue
        for field in EXPECTED_FIELDS - {"client_id"}:
            try:
                if Decimal(str(row.get(field))) != Decimal(str(goal[field])):
                    issues.append(goal["client_id"] + "." + field + " 结果不符")
            except Exception:
                issues.append(field + " 非有效数值")
    if set(actual) != {row["client_id"] for row in expected}:
        issues.append("结果包含范围外客户或缺少客户")
    return {
        "passed": not issues,
        "issues": issues,
        "assertions": ["客户范围", "客户唯一性", "金额精度", "证券去重", "输出契约"],
    }

def execute(code, context):
    tree = validate_code(code)
    globals_value = {"__builtins__": SAFE_BUILTINS, "Decimal": Decimal}
    exec(compile(tree, "<restricted-python>", "exec"), globals_value, globals_value)
    rows = globals_value["transform"](
        table_rows(context),
        {"advisor_id": context["advisorId"], "business_date": context["businessDate"]},
    )
    return normalize(rows)

def lower_soft_limit(kind, target):
    current_soft, current_hard = resource.getrlimit(kind)
    next_soft = target if current_hard == resource.RLIM_INFINITY else min(target, current_hard)
    try:
        if next_soft > 0 and (current_soft == resource.RLIM_INFINITY or next_soft < current_soft):
            resource.setrlimit(kind, (next_soft, current_hard))
        return True
    except (ValueError, OSError):
        return False

def main():
    payload = json.loads(Path(sys.argv[1]).read_text())
    limits = {
        "cpu": lower_soft_limit(resource.RLIMIT_CPU, 5),
        "addressSpace": lower_soft_limit(resource.RLIMIT_AS, 768 * 1024 * 1024),
        "fileSize": lower_soft_limit(resource.RLIMIT_FSIZE, 2 * 1024 * 1024),
    }
    started = time.monotonic()
    try:
        rows = execute(payload["code"], payload["context"])
        selected = verify(rows, payload["context"]["expected"])
        regressions = [{"contextId": payload["context"]["id"], **selected}]
        for context in payload.get("validationContexts", []):
            if context["id"] == payload["context"]["id"]:
                continue
            checked = verify(execute(payload["code"], context), context["expected"])
            regressions.append({"contextId": context["id"], **checked})
        issues = [
            item["contextId"] + "：" + issue
            for item in regressions
            for issue in item["issues"]
        ]
        result = {
            "status": "SUCCEEDED" if not issues else "VALIDATION_FAILED",
            "engine": "CPython",
            "engineVersion": sys.version.split()[0],
            "rows": rows,
            "validation": {
                "passed": not issues,
                "issues": issues,
                "assertions": selected.get("assertions", []),
                "scope": "SELECTED_AND_REGISTERED_FIXTURES",
                "regressions": regressions,
            },
        }
    except Exception as error:
        result = {"status": "FAILED", "engine": "CPython", "error": str(error)[:1000]}
    result["resourceLimits"] = limits
    result["durationMs"] = round((time.monotonic() - started) * 1000)
    Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
