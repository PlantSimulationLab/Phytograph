"""HTTP transport: auth header, error mapping, streaming runs, cancel, cost gate."""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, Optional, Tuple, Union

import httpx
import numpy as np

from . import _frames
from .errors import Canceled, CostWarning, PhytographError

ProgressFn = Callable[[Optional[float], str], None]
StreamResult = Union[Dict[str, Any], Tuple[Dict[str, Any], Dict[str, np.ndarray]], None]

TOKEN_HEADER = "X-Phytograph-Token"


def _detail(resp: httpx.Response) -> Any:
    try:
        body = resp.json()
    except ValueError:
        return resp.text
    return body.get("detail", body) if isinstance(body, dict) else body


def _message(detail: Any) -> str:
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    if isinstance(detail, list):  # pydantic validation errors
        return "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detail)
    return str(detail)


class Transport:
    def __init__(self, base_url: str, token: Optional[str], *,
                 progress: Optional[ProgressFn] = None, confirm_costly: bool = True,
                 timeout: float = 60.0):
        headers = {TOKEN_HEADER: token} if token else {}
        # `timeout` bounds GETs and DELETEs, which are cheap reads. POSTs get no
        # read timeout: some session edits (extract, transform) are synchronous
        # and can run minutes on a large cloud with no keepalives, and a client
        # that gave up would leave the backend to COMMIT the edit anyway — a
        # retry would then apply it twice. Ctrl-C is the way out of a long call.
        self._client = httpx.Client(base_url=base_url, headers=headers,
                                    timeout=httpx.Timeout(timeout, connect=10.0))
        self._post_timeout = httpx.Timeout(None, connect=10.0)
        self.base_url = base_url
        self.progress = progress
        self.confirm_costly = confirm_costly

    def close(self) -> None:
        self._client.close()

    # -- plain calls -------------------------------------------------------
    def _check(self, resp: httpx.Response, path: str) -> httpx.Response:
        if resp.status_code >= 400:
            d = _detail(resp)
            raise PhytographError(f"{path}: {_message(d)}", status=resp.status_code, detail=d)
        return resp

    def get_json(self, path: str, **params: Any) -> Any:
        return self._check(self._client.get(path, params=params or None), path).json()

    def get_bytes(self, path: str, **params: Any) -> httpx.Response:
        return self._check(self._client.get(path, params=params or None), path)

    def delete(self, path: str) -> Any:
        return self._check(self._client.delete(path), path).json()

    def post_json(self, path: str, body: Dict[str, Any]) -> Any:
        return self._with_cost_gate(path, body, lambda b: self._check(
            self._client.post(path, json=b, timeout=self._post_timeout), path).json())

    def post_bytes(self, path: str, content: bytes, *, params: Optional[Dict[str, Any]] = None) -> Any:
        """POST a raw binary body (e.g. an .npz archive); JSON response."""
        resp = self._client.post(path, content=content, params=params or None,
                                 headers={"Content-Type": "application/octet-stream"},
                                 timeout=self._post_timeout)
        return self._check(resp, path).json()

    # -- streaming runs ----------------------------------------------------
    def post_stream(self, path: str, body: Dict[str, Any]) -> StreamResult:
        """POST to a streaming endpoint and return its payload: a JSON value, or
        ``(meta, buffers)`` for a PHB1 frame.

        Progress markers go to ``self.progress``. A KeyboardInterrupt posts
        ``/api/cancel/{run_id}`` (when the run announced one) and closes the
        connection, which the backend also treats as a cancel, then re-raises."""
        return self._with_cost_gate(path, body, lambda b: self._stream_once(path, b))

    def _stream_once(self, path: str, body: Dict[str, Any]) -> StreamResult:
        parser = _frames.StreamParser()
        markers = []
        run_id: Optional[str] = None
        with self._client.stream("POST", path, json=body, timeout=self._post_timeout) as resp:
            if resp.status_code >= 400:
                resp.read()
                self._check(resp, path)
            try:
                for chunk in resp.iter_bytes():
                    for m in parser.feed(chunk):
                        markers.append(m)
                        if m.get("run_id"):
                            run_id = m["run_id"]
                        elif self.progress is not None and not (m.get("error") or m.get("canceled")):
                            self.progress(m.get("progress"), m.get("message") or "")
            except KeyboardInterrupt:
                if run_id:
                    try:
                        self._client.post(f"/api/cancel/{run_id}", timeout=5.0)
                    except httpx.HTTPError:
                        pass
                raise
        term = _frames.terminal_marker(markers)
        if term is not None:
            if term.get("canceled"):
                raise Canceled(f"{path}: canceled")
            raise PhytographError(f"{path}: {term['error']}", detail=term)
        payload = parser.payload()
        if _frames.is_frame(payload):
            return _frames.decode_frame(payload)
        if not payload.strip():
            raise PhytographError(f"{path}: the stream ended with no result")
        return json.loads(payload.decode("utf-8"))

    # -- the 409 cost gate ---------------------------------------------------
    def _with_cost_gate(self, path: str, body: Dict[str, Any], send: Callable[[Dict[str, Any]], Any]) -> Any:
        """Heavy session tools answer 409 ``{cost_warning}`` above the backend's
        cost guideline. A script has no dialog to ask in, so by default it
        re-sends with ``acknowledge_cost: true``; ``confirm_costly=False`` raises
        ``CostWarning`` instead."""
        try:
            return send(body)
        except PhytographError as e:
            warning = e.detail.get("cost_warning") if (e.status == 409 and isinstance(e.detail, dict)) else None
            if warning is None:
                raise
            if not self.confirm_costly:
                raise CostWarning(f"{path}: {_message(e.detail)}", status=409, detail=warning) from None
            return send({**body, "acknowledge_cost": True})
