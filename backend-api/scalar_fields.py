"""Scalar-field arithmetic, statistics and naming.

Canonical home for the Scalar Fields tool: deriving a new per-point column from
an expression over existing ones, and describing any column numerically.

Everything here is PURE — numpy in, numpy/dict out. No session, no lock, no
HTTP. `main.py` owns the endpoints and the `CloudSession` mutation; this module
owns the maths and the vocabulary, exactly as `normals.py` and `denoise.py` do
for their tools.

Why an AST walker and not `eval`
--------------------------------
`/api/fit/custom` evaluates user formulas with `eval` under a stripped
`__builtins__`. That is a fine precedent for the SYMBOL TABLE and a bad one for
the mechanism: a stripped namespace is not a security boundary. `eval` reaches
attributes, dunders, comprehensions, generator frames and the import machinery,
and every published escape from a "sandboxed eval" walks one of those. There is
no need to take the risk — the grammar a scalar calculator needs is about twenty
node types, so whitelisting them outright is both safer and better at reporting
errors (we know the offending node's column offset, which `eval` will not tell
us).

The two-pass evaluation
-----------------------
`(intensity - mean(intensity)) / std(intensity)` cannot be evaluated in one
elementwise sweep: `mean(intensity)` is a property of the whole column, not of
the row being computed. So `parse` records which aggregate calls appear,
`evaluate` resolves each to a scalar in pass 1, and pass 2 substitutes those
scalars and sweeps the rows in chunks.

Pass 2 is chunked because a large session's columns are numpy memmaps (see
`session_store`): a whole-column temporary per sub-expression would fault the
entire file into RAM and then some. Chunking bounds the transient to
`chunk_rows` per intermediate regardless of cloud size. Pass 1 is NOT chunked
for `mean`/`min`/`max`/`sum`/`count` (numpy streams those itself) but median and
percentile genuinely need the values, so they pay a masked copy of one column.

Statistics are measured over a caller-supplied mask
---------------------------------------------------
`describe` takes values already masked. That is deliberate: the only correct
mask is "alive AND not a sky/miss return", which is `_session_editable_mask_
locked` in main.py, and it is the same mask `_robust_attribute_ranges` is fed.
If a histogram of `z` were computed over raw rows it would be meaningless — a
miss is a ray that hit nothing, projected ~1 km out, so a handful of them set
the entire axis. Keeping the mask in the caller means this module cannot
silently disagree with the colorbar the user is reading beside it.
"""

from __future__ import annotations

import ast
import math
import re
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np


# ── Naming ───────────────────────────────────────────────────────────────────

# A slug becomes a LAS ExtraBytes dimension name, an ASCII column token, a PLY
# `property float <slug>` and an identifier inside a later expression. That
# intersection is what forbids spaces, punctuation and a leading digit.
#
# 32 is laspy's ExtraBytesParams name limit; going over it raises at export
# time, which would be a confusing place to learn a name was too long.
MAX_SLUG_LEN = 32

_SLUG_FIRST = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_")
_SLUG_REST = _SLUG_FIRST | set("0123456789")


class SlugError(ValueError):
    """A proposed scalar-field slug is unusable. Message is user-facing."""


# Canonical import roles a field MAY be named after. A name that import resolves
# to one of these comes back as that measurement, which is what the user meant
# by choosing it: `reflectance` is re-read as the cloud's reflectance channel
# (values intact), exactly as any other file's reflectance column is. Every
# other role feeds a tool BY NAME — `target_index` drives LAD's pulse grouping,
# `row`/`col` the gap-fill raster, `time` the trajectory join — so a field that
# merely shares the name would be mistaken for it after a round trip.
MEASUREMENT_ALIAS_TARGETS = frozenset({"reflectance"})


def normalise_column_name(name: str) -> str:
    """The comparison form import uses to match a column to a canonical role.

    Mirrors `_normalise_column_name` in main.py: drop a bracketed unit, lower
    case, strip everything but letters and digits — so `GPS_Time`, `Time` and
    `time` are one name to the importer, and must be one name here.
    """
    base = re.sub(r'\[.*?\]', '', name)
    return re.sub(r'[^a-z0-9]+', '', base.strip().lower())


def validate_slug(slug: str, *, existing: Iterable[str] = (),
                  reserved: Iterable[str] = (),
                  aliases: Mapping[str, str] = {}) -> str:
    """Return `slug` if it is a legal, unclaimed scalar-field name, else raise.

    Four distinct rejections, each with its own message, because they need
    different fixes from the user:

      - malformed      → change the characters
      - too long       → shorten it
      - already on this cloud → pick another, or delete that field first
      - reserved / a canonical import alias → pick another

    The alias check is the subtle one. `aliases` is `_CANONICAL_ALIAS_TO_SLUG`
    from main.py: normalised source-column SPELLING -> canonical slug. A field
    named `time` or `elevation` would be silently re-resolved to `timestamp` /
    `z` if the cloud were ever exported and re-imported — it would come back as
    a different field, or collide with a real one. Refusing the name up front is
    the only place that is cheap to explain.

    Matched on the NORMALISED name, because that is what import matches on: an
    exact comparison let `Time` and `GPS_Time` through while still refusing
    `time`. Roles in `MEASUREMENT_ALIAS_TARGETS` are allowed — see there.
    """
    if not slug:
        raise SlugError("Name cannot be empty.")
    if len(slug) > MAX_SLUG_LEN:
        raise SlugError(
            f"Name is {len(slug)} characters; the limit is {MAX_SLUG_LEN}.")
    if slug[0] not in _SLUG_FIRST:
        raise SlugError(
            "Name must start with a letter or underscore.")
    bad = sorted({c for c in slug if c not in _SLUG_REST})
    if bad:
        shown = " ".join(repr(c) for c in bad)
        raise SlugError(
            f"Name may only contain letters, digits and underscores (found {shown}).")
    if slug in set(existing):
        raise SlugError(f"This cloud already has a field named {slug!r}.")
    if slug in set(reserved):
        raise SlugError(
            f"{slug!r} is reserved for a built-in field and cannot be reused.")
    canonical = aliases.get(normalise_column_name(slug))
    if canonical is not None and canonical not in MEASUREMENT_ALIAS_TARGETS:
        raise SlugError(
            f"{slug!r} would be read back as the {canonical!r} column if this "
            "cloud were exported and imported again. Pick another name.")
    return slug


# ── Expression vocabulary ────────────────────────────────────────────────────

def _ifelse(cond, a, b):
    """Elementwise conditional. `cond` is truthy-as-numeric (nonzero == true).

    Exists so a user can build a classification column — `ifelse(curvature >
    0.1, 1, 2)` — without leaving the calculator. `np.where` broadcasts scalars,
    so all three arguments may be columns or constants in any combination.

    Spelled `ifelse` rather than `if` because `if` is a Python keyword: the
    tokenizer sees `if(...)` as the start of a statement, so `ast.parse` rejects
    it as a syntax error before any whitelist gets a say, and the user would get
    "invalid syntax" pointing at a function we had advertised. Python's own
    ternary (`a if cond else b`) parses as `ast.IfExp` and is accepted too, so
    both spellings work.
    """
    return np.where(np.asarray(cond) != 0, a, b)


def _clamp(v, lo, hi):
    return np.clip(v, lo, hi)


# Whitelisted elementwise functions. Every one is closed over numpy so it works
# on a chunk without special-casing scalars.
#
# `log` is the NATURAL log, matching numpy, C and every calculator; `log10` is
# separate. Division by zero and log of a negative produce inf/NaN rather than
# raising — see `evaluate`, which counts them and lets them through instead of
# failing the whole field for one bad row.
FUNCTIONS: Dict[str, Callable] = {
    # core
    "sqrt": np.sqrt, "abs": np.abs, "exp": np.exp,
    "log": np.log, "log10": np.log10, "log2": np.log2,
    "min": np.minimum, "max": np.maximum,
    "floor": np.floor, "ceil": np.ceil, "round": np.round,
    "sign": np.sign, "clamp": _clamp, "ifelse": _ifelse,
    # trig
    "sin": np.sin, "cos": np.cos, "tan": np.tan,
    "asin": np.arcsin, "acos": np.arccos, "atan": np.arctan,
    "atan2": np.arctan2, "sinh": np.sinh, "cosh": np.cosh, "tanh": np.tanh,
    "degrees": np.degrees, "radians": np.radians,
}

CONSTANTS: Dict[str, float] = {
    "pi": math.pi,
    "e": math.e,
    # Spelled out so `nan` in an expression is a deliberate sentinel rather
    # than something the user has to produce via 0/0.
    "nan": float("nan"),
    "inf": float("inf"),
}

# Whole-field aggregates. These collapse a column to one scalar in pass 1.
# `percentile` takes a second, constant argument (the percentile itself).
AGGREGATES: Dict[str, Callable] = {
    "mean": lambda a: float(np.mean(a)),
    "std": lambda a: float(np.std(a)),
    "median": lambda a: float(np.median(a)),
    "sum": lambda a: float(np.sum(a)),
    "count": lambda a: float(a.size),
    "amin": lambda a: float(np.min(a)),
    "amax": lambda a: float(np.max(a)),
    "percentile": lambda a, q: float(np.percentile(a, q)),
}

# `min`/`max` are elementwise in FUNCTIONS (two-argument, like C's fmin) and
# whole-field in AGGREGATES. That is genuinely ambiguous for a single argument,
# so the one-argument spelling resolves to the aggregate and the two-argument
# spelling to the elementwise function. Users who want the aggregate explicitly
# can write amin/amax.
_ARITY_OVERLOADED = {"min": "amin", "max": "amax"}


class ExpressionError(ValueError):
    """A user expression could not be parsed or is not evaluable.

    `col` is the 0-based column offset of the offending token when known, so the
    panel can point at it rather than just printing a message.
    """

    def __init__(self, message: str, col: Optional[int] = None):
        super().__init__(message)
        self.message = message
        self.col = col


# Node types the grammar allows. Everything else — Attribute, Subscript, Lambda,
# comprehensions, Starred, NamedExpr, IfExp's statement cousins, f-strings — is
# rejected by absence rather than by a blocklist, so a new Python release cannot
# widen the surface behind our backs.
_ALLOWED_NODES: Tuple[type, ...] = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Compare, ast.BoolOp,
    ast.Call, ast.Name, ast.Constant, ast.Load, ast.IfExp,
    # operators
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
    ast.USub, ast.UAdd, ast.Not,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
    ast.And, ast.Or,
)

_BIN_OPS: Dict[type, Callable] = {
    ast.Add: np.add, ast.Sub: np.subtract, ast.Mult: np.multiply,
    ast.Div: np.divide, ast.FloorDiv: np.floor_divide,
    ast.Mod: np.mod, ast.Pow: np.power,
}

_CMP_OPS: Dict[type, Callable] = {
    ast.Eq: np.equal, ast.NotEq: np.not_equal,
    ast.Lt: np.less, ast.LtE: np.less_equal,
    ast.Gt: np.greater, ast.GtE: np.greater_equal,
}


class ParsedExpr:
    """A validated expression plus what it needs to be evaluated.

    `variables` are the column slugs referenced elementwise; `aggregates` are
    the `(func, slug, arg)` triples pass 1 must resolve. A slug can appear in
    both — `intensity - mean(intensity)` needs the column AND its mean.
    """

    __slots__ = ("source", "tree", "variables", "aggregates")

    def __init__(self, source: str, tree: ast.Expression,
                 variables: Set[str],
                 aggregates: List[Tuple[str, str, Optional[float]]]):
        self.source = source
        self.tree = tree
        self.variables = variables
        self.aggregates = aggregates

    @property
    def columns_needed(self) -> Set[str]:
        """Every slug that must be readable, elementwise or aggregated."""
        return set(self.variables) | {slug for _, slug, _ in self.aggregates}


def parse(expression: str, *, available: Iterable[str]) -> ParsedExpr:
    """Validate `expression` against the whitelist and the cloud's own columns.

    Raises ExpressionError with a column offset for anything malformed,
    disallowed, or referring to a column this cloud does not carry. Nothing is
    evaluated here, so this is safe to call on every keystroke.
    """
    source = (expression or "").strip()
    if not source:
        raise ExpressionError("Enter an expression.")

    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        # SyntaxError's offset is 1-based and may be None.
        col = (exc.offset - 1) if exc.offset else None
        raise ExpressionError(f"Could not parse: {exc.msg}.", col) from None

    available = set(available)
    variables: Set[str] = set()
    aggregates: List[Tuple[str, str, Optional[float]]] = []

    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ExpressionError(
                f"{type(node).__name__} is not allowed in an expression.",
                getattr(node, "col_offset", None))

        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise ExpressionError(
                    "Only plain function calls are allowed.",
                    getattr(node, "col_offset", None))
            name = node.func.id
            if node.keywords:
                raise ExpressionError(
                    f"{name}() does not take keyword arguments.", node.col_offset)
            _check_call(node, name, available, aggregates)

        elif isinstance(node, ast.Name):
            # A Name that is a call target was handled above; skip it here.
            continue

        elif isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, float)) or isinstance(node.value, bool):
                raise ExpressionError(
                    "Only numeric constants are allowed.", node.col_offset)

    # Resolve bare Names in a second pass, now that we know which ones are call
    # targets (a call target is not a variable reference) and which are consumed
    # by an aggregate (pass 1 resolves those to a scalar).
    #
    # Both sets hold NODE IDENTITIES, not names. Matching by name would conflate
    # the two roles a spelling can play in one expression: a cloud may carry a
    # column called `sqrt` (nothing stops an ASCII header saying so), and in
    # `sqrt + sqrt(z)` the first is a field reference and the second a call. A
    # name-keyed set marks the spelling as a call target everywhere and the bare
    # reference is dropped, so the expression is rejected as "Unknown name
    # 'sqrt'" — pointing at the one name the cloud demonstrably has.
    skip_nodes = {id(n.func) for n in ast.walk(tree)
                  if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    skip_nodes |= {id(n.args[0]) for n in ast.walk(tree)
                   if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                   and _agg_name(n) is not None and n.args}

    for node in ast.walk(tree):
        if not isinstance(node, ast.Name) or id(node) in skip_nodes:
            continue
        name = node.id
        if name in CONSTANTS:
            continue
        if name not in available:
            raise ExpressionError(
                f"Unknown field {name!r}.", node.col_offset)
        variables.add(name)

    return ParsedExpr(source, tree, variables, aggregates)


def _agg_name(node: ast.Call) -> Optional[str]:
    """The aggregate this call resolves to, or None if it is elementwise.

    Handles the min/max arity overload: one argument means the whole-field
    aggregate, two means the elementwise pairwise function.
    """
    if not isinstance(node.func, ast.Name):
        return None
    name = node.func.id
    if name in _ARITY_OVERLOADED and len(node.args) == 1:
        return _ARITY_OVERLOADED[name]
    if name in AGGREGATES and name not in FUNCTIONS:
        return name
    return None


def _check_call(node: ast.Call, name: str, available: Set[str],
                aggregates: List[Tuple[str, str, Optional[float]]]) -> None:
    """Validate one call node and record it if it is an aggregate."""
    agg = _agg_name(node)
    if agg is not None:
        if not node.args:
            raise ExpressionError(f"{name}() needs a field.", node.col_offset)
        target = node.args[0]
        if not isinstance(target, ast.Name) or target.id not in available:
            raise ExpressionError(
                f"{name}() must be given a field name, e.g. {name}(intensity).",
                getattr(target, "col_offset", node.col_offset))
        q: Optional[float] = None
        if agg == "percentile":
            if len(node.args) != 2:
                raise ExpressionError(
                    "percentile() takes a field and a number, "
                    "e.g. percentile(intensity, 95).", node.col_offset)
            qn = node.args[1]
            if not isinstance(qn, ast.Constant) or isinstance(qn.value, bool) \
                    or not isinstance(qn.value, (int, float)):
                raise ExpressionError(
                    "The percentile must be a plain number.",
                    getattr(qn, "col_offset", node.col_offset))
            if not (0 <= float(qn.value) <= 100):
                raise ExpressionError(
                    "The percentile must be between 0 and 100.", qn.col_offset)
            q = float(qn.value)
        elif len(node.args) != 1:
            raise ExpressionError(
                f"{name}() takes exactly one field.", node.col_offset)
        aggregates.append((agg, target.id, q))
        return

    if name not in FUNCTIONS:
        raise ExpressionError(f"Unknown function {name!r}.", node.col_offset)
    # Arity for the elementwise set. Anything two-argument is listed; the rest
    # take one. `clamp`/`if` take three.
    two = {"min", "max", "atan2"}
    three = {"clamp", "ifelse"}
    want = 3 if name in three else (2 if name in two else 1)
    if len(node.args) != want:
        raise ExpressionError(
            f"{name}() takes {want} argument{'s' if want > 1 else ''}, "
            f"got {len(node.args)}.", node.col_offset)


# ── Evaluation ───────────────────────────────────────────────────────────────

# Rows per elementwise chunk. Sized so one float64 intermediate is ~4 MB, small
# enough that a dozen nested sub-expressions still fit in cache-friendly memory
# on a memmapped 100 M-point session, large enough that per-chunk overhead is
# negligible.
DEFAULT_CHUNK_ROWS = 500_000


def evaluate(parsed: ParsedExpr,
             columns: Dict[str, np.ndarray],
             *,
             n_points: Optional[int] = None,
             mask: Optional[np.ndarray] = None,
             chunk_rows: int = DEFAULT_CHUNK_ROWS) -> Tuple[np.ndarray, dict]:
    """Evaluate `parsed` over `columns`, returning (values, meta).

    `n_points` is the cloud's row count. Pass it: it is the ONLY thing that
    makes a constant expression work. `pi * 2` and `1.0` are valid grammar and
    reference no column, so a length inferred from `columns` has nothing to
    infer from — and the failure looks arbitrary, because `mean(z) * 0 + 1`
    succeeds (the aggregate pulls `z` into the column set) while `pi * 2` does
    not. Seeding a column with a constant before hand-editing it is a real use.
    Omitting it falls back to the column length, which suits direct unit-test
    calls that always reference a column.

    `columns` maps slug → full-length (N,) array. The result is full-length
    float32, computed for EVERY row including deleted ones — an elementwise
    expression has a defined value on a deleted row, and `reset_edits` can bring
    that row back. (Contrast a neighbourhood statistic like a normal, which is
    genuinely undefined for an absent point; that is why `_session_add_extra_
    column` zero-fills deleted rows and why arithmetic must not use it.)

    `mask` selects the rows AGGREGATES are measured over — alive and non-miss —
    so `mean(intensity)` is the mean the user sees in the Stats tab rather than
    one polluted by deleted rows or by sky returns 1 km away. It does not
    restrict which rows are computed.

    Non-finite results are counted, not raised: one divide-by-zero row must not
    fail a 40 M-point field. `meta` reports `nan_count` / `inf_count` so the
    caller can warn.
    """
    n = int(n_points) if n_points is not None else _column_length(columns)

    env_scalars: Dict[str, float] = dict(CONSTANTS)
    for func, slug, q in parsed.aggregates:
        col = np.asarray(columns[slug])
        sel = col[mask] if mask is not None else col
        finite = sel[np.isfinite(sel)]
        if finite.size == 0:
            raise ExpressionError(
                f"{func}({slug}) is undefined — that field has no finite values "
                "on the visible points.")
        value = (AGGREGATES[func](finite, q) if q is not None
                 else AGGREGATES[func](finite))
        env_scalars[_agg_key(func, slug, q)] = value

    out = np.empty(n, dtype=np.float32)
    # Elementwise pass. numpy's errstate is set to 'ignore' rather than 'raise'
    # deliberately — see the docstring.
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        for start in range(0, n, max(1, int(chunk_rows))):
            stop = min(n, start + chunk_rows)
            env: Dict[str, object] = dict(env_scalars)
            for slug in parsed.variables:
                env[slug] = np.asarray(columns[slug][start:stop], dtype=np.float64)
            chunk = _eval_node(parsed.tree.body, env, parsed)
            out[start:stop] = np.asarray(
                np.broadcast_to(chunk, (stop - start,)), dtype=np.float32)

    nan_count = int(np.count_nonzero(np.isnan(out)))
    inf_count = int(np.count_nonzero(np.isinf(out)))
    return out, {"nan_count": nan_count, "inf_count": inf_count,
                 "aggregates": {k: v for k, v in env_scalars.items()
                                if k not in CONSTANTS}}


def _agg_key(func: str, slug: str, q: Optional[float]) -> str:
    return f"__agg_{func}_{slug}" + ("" if q is None else f"_{q!r}")


def _column_length(columns: Dict[str, np.ndarray]) -> int:
    lengths = {int(np.asarray(v).shape[0]) for v in columns.values()}
    if not lengths:
        # Only reachable when the caller omitted `n_points` AND the expression
        # references no column. Callers that own a cloud always know its row
        # count and should pass it — see `evaluate`.
        raise ExpressionError(
            "This expression references no field, so there is nothing to size "
            "the result against.")
    if len(lengths) != 1:
        raise ExpressionError(
            "Internal error: source columns have differing lengths "
            f"({sorted(lengths)}).")
    return lengths.pop()


def _eval_node(node: ast.AST, env: Dict[str, object], parsed: ParsedExpr):
    """Recursively evaluate a whitelisted node against `env`."""
    if isinstance(node, ast.Constant):
        return node.value

    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        raise ExpressionError(f"Unknown name {node.id!r}.", node.col_offset)

    if isinstance(node, ast.BinOp):
        op = _BIN_OPS.get(type(node.op))
        if op is None:
            raise ExpressionError("Unsupported operator.", node.col_offset)
        return op(_eval_node(node.left, env, parsed),
                  _eval_node(node.right, env, parsed))

    if isinstance(node, ast.UnaryOp):
        val = _eval_node(node.operand, env, parsed)
        if isinstance(node.op, ast.USub):
            return np.negative(val)
        if isinstance(node.op, ast.UAdd):
            return val
        if isinstance(node.op, ast.Not):
            return np.logical_not(np.asarray(val) != 0).astype(np.float64)
        raise ExpressionError("Unsupported unary operator.", node.col_offset)

    if isinstance(node, ast.Compare):
        # Chained comparisons (0 < x < 1) fold to an AND of the links, matching
        # Python's own semantics rather than C's (0 < x) < 1.
        left = _eval_node(node.left, env, parsed)
        result = None
        for op, right_node in zip(node.ops, node.comparators):
            fn = _CMP_OPS.get(type(op))
            if fn is None:
                raise ExpressionError("Unsupported comparison.", node.col_offset)
            right = _eval_node(right_node, env, parsed)
            link = fn(left, right)
            result = link if result is None else np.logical_and(result, link)
            left = right
        return np.asarray(result).astype(np.float64)

    if isinstance(node, ast.BoolOp):
        vals = [np.asarray(_eval_node(v, env, parsed)) != 0 for v in node.values]
        combine = np.logical_and if isinstance(node.op, ast.And) else np.logical_or
        acc = vals[0]
        for v in vals[1:]:
            acc = combine(acc, v)
        return np.asarray(acc).astype(np.float64)

    if isinstance(node, ast.IfExp):
        return _ifelse(_eval_node(node.test, env, parsed),
                   _eval_node(node.body, env, parsed),
                   _eval_node(node.orelse, env, parsed))

    if isinstance(node, ast.Call):
        name = node.func.id  # parse() guaranteed a plain Name
        agg = _agg_name(node)
        if agg is not None:
            slug = node.args[0].id
            q = float(node.args[1].value) if agg == "percentile" else None
            return env[_agg_key(agg, slug, q)]
        fn = FUNCTIONS[name]
        return fn(*[_eval_node(a, env, parsed) for a in node.args])

    raise ExpressionError(
        f"{type(node).__name__} is not allowed.",
        getattr(node, "col_offset", None))


# ── Statistics ───────────────────────────────────────────────────────────────

# Histogram bin bounds. Below the floor a distribution is unreadable; above the
# ceiling the bars are sub-pixel in a 260 px panel and the payload grows for
# nothing.
MIN_BINS = 16
MAX_BINS = 256

# The span the histogram is binned over, as percentiles. Same constants as
# `_EXTENT_LOW_PERCENTILE` / `_EXTENT_HIGH_PERCENTILE` in main.py, and the same
# reasoning as the colorbar's: binning over raw min/max lets one spike put every
# real value in bin 0, which is exactly the washout `_robust_attribute_ranges`
# exists to prevent. The points outside the span are not discarded — they are
# counted into `below_count` / `above_count` so the histogram stays honest about
# what it is not showing.
HIST_LOW_PERCENTILE = 1.0
HIST_HIGH_PERCENTILE = 99.0


def describe(values: np.ndarray, *, bins: Optional[int] = None) -> dict:
    """Summary statistics + a histogram for one already-masked column.

    `values` must already be restricted to the points that count (alive, not a
    sky/miss return) — see the module docstring. Non-finite entries are excluded
    from every statistic and reported separately, because a NaN is a real thing
    to know about a derived field but must not poison its mean.

    Returns {} for an empty or wholly non-finite column rather than emitting
    NaNs the UI would have to special-case at every field.
    """
    a = np.asarray(values)
    if a.ndim != 1:
        a = a.reshape(-1)
    total = int(a.size)
    if total == 0:
        return {}

    finite_mask = np.isfinite(a)
    finite = a[finite_mask]
    nan_count = int(np.count_nonzero(np.isnan(a)))
    inf_count = int(total - finite.size - nan_count)
    if finite.size == 0:
        return {"count": total, "finite_count": 0,
                "nan_count": nan_count, "inf_count": inf_count}

    f = finite.astype(np.float64, copy=False)
    q = np.percentile(f, [HIST_LOW_PERCENTILE, 5, 25, 50, 75, 95,
                          HIST_HIGH_PERCENTILE])
    lo, p5, p25, median, p75, p95, hi = (float(v) for v in q)
    vmin, vmax = float(np.min(f)), float(np.max(f))

    out = {
        "count": total,
        "finite_count": int(f.size),
        "nan_count": nan_count,
        "inf_count": inf_count,
        "min": vmin,
        "max": vmax,
        "mean": float(np.mean(f)),
        "std": float(np.std(f)),
        "median": median,
        "p1": lo, "p5": p5, "p25": p25, "p75": p75, "p95": p95, "p99": hi,
        "unique_estimate": None,
    }
    out["histogram"] = _histogram(f, lo, hi, vmin, vmax, bins)
    return out


def _histogram(f: np.ndarray, lo: float, hi: float,
               vmin: float, vmax: float, bins: Optional[int]) -> dict:
    """Bin `f` over [lo, hi], counting what falls outside separately."""
    # A constant column has no span to bin. Report the single value rather than
    # inventing a degenerate axis numpy would reject.
    if not (hi > lo):
        lo, hi = vmin, vmax
    if not (hi > lo):
        return {"bin_edges": [vmin, vmin], "counts": [int(f.size)],
                "below_count": 0, "above_count": 0, "degenerate": True}

    n = bins if bins is not None else _auto_bins(f, lo, hi)
    n = int(max(MIN_BINS, min(MAX_BINS, n)))
    inside = f[(f >= lo) & (f <= hi)]
    counts, edges = np.histogram(inside, bins=n, range=(lo, hi))
    return {
        "bin_edges": [float(e) for e in edges],
        "counts": [int(c) for c in counts],
        "below_count": int(np.count_nonzero(f < lo)),
        "above_count": int(np.count_nonzero(f > hi)),
        "degenerate": False,
    }


def _auto_bins(f: np.ndarray, lo: float, hi: float) -> int:
    """Freedman-Diaconis bin count, falling back to Sturges.

    FD (bin width 2·IQR/n^(1/3)) adapts to spread and is robust to the tails,
    which is what we want for LiDAR scalars whose distributions are routinely
    skewed. Its failure mode is a zero IQR — a column where over half the points
    share one value, which is common for a quantised intensity or a mostly-zero
    derived field — and there it divides by zero, so Sturges takes over.
    """
    n = int(f.size)
    if n < 2:
        return MIN_BINS
    p25, p75 = np.percentile(f, [25, 75])
    iqr = float(p75 - p25)
    if iqr > 0:
        width = 2.0 * iqr / (n ** (1.0 / 3.0))
        if width > 0:
            return int(math.ceil((hi - lo) / width))
    return int(math.ceil(math.log2(n) + 1))
