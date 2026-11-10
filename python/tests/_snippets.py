"""Check the code an agent will copy: every call written in the skill and the
scripting guide is parsed and bound against the real signature.

A call is found in inline code spans (`` `cloud.qsm(fork_symmetry=0.9)` ``) and
in fenced ``python`` blocks. Each call is resolved to the function it names
(a recipe, a ``Cloud``/``Backend`` method, a ``pg.*`` class, a result method)
and its keywords and positional count are bound with
``inspect.Signature.bind_partial``, so a misnamed keyword or a positional
passed to a keyword-only parameter fails here instead of in a user's script.
For tools with a per-method keyword table, a keyword the written ``method``
does not use fails too.
"""
from __future__ import annotations

import ast
import builtins
import inspect
import re
from typing import Callable, Iterator, List, Optional, Tuple

import phytograph as pg
from phytograph import recipes, results

_RESULT_TYPES = (pg.Cloud, pg.Backend, results.QSM, results.Inventory, results.DEM,
                 results.Mesh, results.Skeleton, results.Registration, results.LADResult,
                 recipes.RecipeRecord)
# Names that are not phytograph's: Python builtins and the modules a snippet uses.
_FOREIGN_BASES = {"np", "numpy", "warnings", "json", "Path", "pathlib", "os", "sys"}
# Functions a snippet's reader writes themselves.
_USER_FUNCTIONS = {"callback"}
_OWN_BASES = {"cloud", "be", "backend", "plot", "tree", "plant", "moving", "target", "c", "t",
              "rec", "rec2", "inv", "qsm", "q", "sk", "mesh", "dem", "reg", "res", "work"}


def code_snippets(markdown: str) -> Iterator[Tuple[int, str]]:
    """(line, code) for every fenced python block and every inline span holding a call."""
    fence = re.compile(r"^```python\n(.*?)^```", re.S | re.M)
    for m in fence.finditer(markdown):
        yield markdown[:m.start()].count("\n") + 2, m.group(1)
    stripped = fence.sub(lambda m: "\n" * m.group(0).count("\n"), markdown)
    for m in re.finditer(r"`([^`\n]*\w\([^`\n]*\))`", stripped):
        yield stripped[:m.start()].count("\n") + 1, m.group(1)


def _dotted(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return None if base is None else f"{base}.{node.attr}"
    return None


def _resolve(func: ast.AST) -> Tuple[Optional[Callable], Optional[str]]:
    """(callable, None), (None, None) for a call that is not ours, or (None, why)."""
    if isinstance(func, ast.Name):
        n = func.id
        if n in recipes.__all__:
            return getattr(recipes, n), None
        if hasattr(builtins, n) or n in _USER_FUNCTIONS:
            return None, None
        for owner in (pg.Cloud, pg.Backend):
            if hasattr(owner, n):
                return getattr(owner, n), None
        if hasattr(pg, n):
            return getattr(pg, n), None
        return None, f"{n}() is not a recipe, a Cloud/Backend method or a pg name"
    if not isinstance(func, ast.Attribute):
        return None, None
    base = _dotted(func.value)
    attr = func.attr
    if base is None:
        return None, None             # e.g. a call on a subscript: inv.trees[0].get(...)
    root = base.split(".")[0]
    if root in _FOREIGN_BASES:
        return None, None
    if base == "recipes":
        fn = getattr(recipes, attr, None)
        return (fn, None) if fn else (None, f"recipes.{attr} does not exist")
    if base in ("pg", "phytograph"):
        fn = getattr(pg, attr, None)
        return (fn, None) if fn else (None, f"pg.{attr} does not exist")
    if base.startswith("pg."):
        owner = getattr(pg, base.split(".")[1], None)
        fn = getattr(owner, attr, None) if owner is not None else None
        return (fn, None) if fn else (None, f"{base}.{attr} does not exist")
    if root in ("be", "backend"):
        fn = getattr(pg.Backend, attr, None)
        return (fn, None) if fn else (None, f"Backend.{attr} does not exist")
    for owner in _RESULT_TYPES:
        if hasattr(owner, attr):
            return getattr(owner, attr), None
    if root in _OWN_BASES and "." not in base:
        return None, f"{base}.{attr}() is not a method of any phytograph class"
    return None, None                 # an attribute of a result's dict etc.


def check_snippet(code: str) -> List[str]:
    """Problems with the calls in ``code`` (empty when every call binds)."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        try:
            tree = ast.parse(code.strip(), mode="eval")
        except SyntaxError:
            return []   # not Python (a shell line, a table fragment)
    problems = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn, why = _resolve(node.func)
        label = ast.unparse(node)
        if why:
            problems.append(f"{label}: {why}")
            continue
        if fn is None:
            continue
        # `filter(...)` is prose for "some arguments": nothing to bind.
        if len(node.args) == 1 and isinstance(node.args[0], ast.Constant) \
                and node.args[0].value is Ellipsis and not node.keywords:
            continue
        sig = inspect.signature(fn)
        params = list(sig.parameters)
        is_method = params[:1] == ["self"]
        args = ([None] if is_method else []) + [None] * len(
            [a for a in node.args if not isinstance(a, ast.Starred)])
        kwargs = {k.arg: None for k in node.keywords if k.arg is not None}
        try:
            sig.bind_partial(*args, **kwargs)
        except TypeError as e:
            problems.append(f"{label}: {e} (signature {fn.__qualname__}{sig})")
            continue
        by_method = getattr(fn, "_tool_by_method", None)
        method_arg = getattr(fn, "_tool_method_arg", None)
        if by_method and method_arg:
            written = {k.arg: k.value for k in node.keywords if k.arg}
            m = written.get(method_arg)
            if m is None and method_arg == params[1 if is_method else 0] and node.args:
                m = node.args[0]
            if isinstance(m, ast.Constant):
                method = m.value
            elif m is None:
                method = sig.parameters[method_arg].default
            else:
                continue
            if method not in by_method:
                problems.append(f"{label}: {method_arg}={method!r} is not one of {list(by_method)}")
                continue
            for k in written:
                owners = [mm for mm, ks in by_method.items() if k in ks]
                if owners and method not in owners:
                    problems.append(f"{label}: {k} applies to {method_arg}={owners}, not {method!r}")
    return problems


def check_markdown(markdown: str) -> List[str]:
    out = []
    for line, code in code_snippets(markdown):
        out += [f"line {line}: {p}" for p in check_snippet(code)]
    return out
