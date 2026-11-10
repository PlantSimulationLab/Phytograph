"""Keyword checking for the analysis tools.

The backend's request models ignore keys they do not know, so a misspelled
parameter used to run the tool on its default and say nothing. Every tool now
has an explicit signature; :func:`checked_tool` makes a wrong keyword a fatal
Python error that names the valid ones, and rejects a parameter given to a
method that does not use it.
"""
from __future__ import annotations

import difflib
import functools
import inspect
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Tuple, TypeVar

F = TypeVar("F", bound=Callable[..., Any])


def checked_tool(*, method_arg: Optional[str] = None,
                 by_method: Optional[Mapping[str, Iterable[str]]] = None) -> Callable[[F], F]:
    """Wrap a tool so that:

    * an unknown keyword raises :class:`TypeError` listing every valid one
      (with a "did you mean" when one is close);
    * when ``by_method`` is given, ``method_arg`` must name one of its keys,
      and a keyword passed explicitly that belongs only to OTHER methods
      raises :class:`ValueError` naming the method(s) that use it.

    ``by_method`` maps each method to the keywords only it uses; keywords in
    no entry apply to every method. The signature is preserved for ``help()``.
    """
    def deco(fn: F) -> F:
        sig = inspect.signature(fn)
        params = sig.parameters
        keywords = [n for n, p in params.items()
                    if n != "self" and p.kind in (p.KEYWORD_ONLY, p.POSITIONAL_OR_KEYWORD)]
        name = fn.__qualname__
        owners: Dict[str, Tuple[str, ...]] = {}
        if by_method:
            for m, ks in by_method.items():
                for k in ks:
                    if k not in params:
                        raise AssertionError(f"{name}: by_method names unknown keyword {k!r}")
                    owners[k] = owners.get(k, ()) + (m,)

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            unknown = [k for k in kwargs if k not in keywords]
            if unknown:
                hints = []
                for k in unknown:
                    close = difflib.get_close_matches(k, keywords, n=1)
                    hints.append(f"{k!r}" + (f" (did you mean {close[0]!r}?)" if close else ""))
                raise TypeError(f"{name}() got unknown keyword argument(s) {', '.join(hints)}. "
                                f"Valid keywords: {', '.join(keywords)}. "
                                f"See help(pg.{name}).")
            if by_method and method_arg:
                try:
                    bound = sig.bind(*args, **kwargs)
                except TypeError as e:
                    raise TypeError(f"{name}(): {e}. Tuning parameters are keyword-only, "
                                    f"e.g. {method_arg}=...") from None
                method = bound.arguments.get(method_arg, params[method_arg].default)
                if method not in by_method:
                    raise ValueError(f"{name}(): {method_arg} must be one of "
                                     f"{', '.join(repr(m) for m in by_method)}, not {method!r}")
                wrong = [k for k in kwargs if k in owners and method not in owners[k]]
                if wrong:
                    parts = [f"{k} applies to {method_arg}="
                             + "/".join(repr(m) for m in owners[k]) for k in wrong]
                    raise ValueError(f"{name}({method_arg}={method!r}) does not use: "
                                     + "; ".join(parts) + ". Remove it or change "
                                     f"{method_arg}; it would be ignored.")
            return fn(*args, **kwargs)

        wrapper.__signature__ = sig  # type: ignore[attr-defined]
        wrapper._tool_by_method = dict(by_method or {})  # type: ignore[attr-defined]
        wrapper._tool_method_arg = method_arg  # type: ignore[attr-defined]
        return wrapper  # type: ignore[return-value]
    return deco


def body_for(by_method: Optional[Mapping[str, Iterable[str]]], method: Optional[str],
             values: Mapping[str, Any]) -> Dict[str, Any]:
    """The request fields to send: every value that is not ``None``, minus the
    keywords that belong only to other methods (the backend would ignore them,
    and a recorded body should say what actually applied)."""
    foreign = set()
    if by_method:
        own = set(by_method.get(method, ()))
        for m, ks in by_method.items():
            foreign |= set(ks)
        foreign -= own
    return {k: v for k, v in values.items() if v is not None and k not in foreign}
