"""papers-service：paper-search-mcp 的替代实现，research-proxy 的 /papers/* 上游。

端点形状与 mcpo 暴露的 paper-search-mcp 完全一致（research-proxy 零改动可切）：
  POST /papers/search_{source}            {"query", "max_results"} -> {"papers": [...]}
  POST /papers/get_crossref_paper_by_doi  {"doi"}                 -> paper dict（裸）
  POST /papers/read_{source}_paper        {"paper_id"}            -> {"result": "全文文本"}

检索复用 paper-search 仓库 tool.py 的直连适配器（镜像构建时 ADD 进 /srv/vendor/tool.py，
见 app/toolwrap.py）；read 用本服务自带的轻量实现（app/readers.py），读不了的源/论文
一律 404 → research-proxy 自动落 reach/read_url（reach-mcp 仍在 mcpo 上，不退役）。

错误约定（对齐 shim 的消费方式）：
  未知源/未知工具      404（shim 记 "http 404" 进 sourceErrors 后继续）
  检索适配器抛异常     502 + detail（shim 记错误字符串）
  单源超时（16s）      504
  szlib 登录型         200 + login_required（显式 szlib_login_token 可重试）
"""

from __future__ import annotations

import asyncio
import logging
import os
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from . import downloader, readers, toolwrap

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("papers-service")

app = FastAPI(title="firecrawl-papers-service", docs_url=None, redoc_url=None)

SEARCH_RE = re.compile(r"^search_([a-z0-9_]+)$")
READ_RE = re.compile(r"^read_([a-z0-9_]+)_paper$")


def _szlib_login_payload(e) -> dict:
    """把 tool.py 的 _SzlibLoginRequired 转成与 OWUI tool 一致的 login_required。"""
    code = getattr(e, "code", "") or "AWAITING_LOGIN"
    url = getattr(e, "url", "") or ""
    if code == "AWAITING_LOGIN" and url:
        return {
            "source": "szlib",
            "login_url": url,
            "login_token": getattr(e, "login_token", "") or "",
            "expires_in": int(getattr(e, "expires_in", 300) or 300),
            "notice": "深圳图书馆（读秀）需要先用浏览器登录：打开 login_url 完成，"
                      "然后带同一个 szlib_login_token 重试同样的查询。",
        }
    return {
        "source": "szlib",
        "code": code,
        "notice": "深圳图书馆登录未完成；login_token 是一次性的，"
                  "请不带 szlib_login_token 重新检索获取新链接。",
    }


@app.get("/healthz")
async def healthz() -> dict:
    return {
        "ok": True,
        "toolVersion": toolwrap.TOOL_VERSION,
        "searchSources": sorted(toolwrap.SEARCH_DISPATCH),
        "readSources": sorted(readers.READERS),
    }


@app.post("/papers/{tool}")
async def papers_tool(tool: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"detail": "invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"detail": "JSON object body required"}, status_code=400)

    if tool == "get_crossref_paper_by_doi":
        doi = str(body.get("doi") or "").strip()
        if not doi:
            return JSONResponse({"detail": "doi required"}, status_code=400)
        item = await toolwrap.crossref_by_doi(doi)
        if item is None:
            return JSONResponse({"detail": f"doi not found: {doi}"}, status_code=404)
        return item  # shim: data.get("result") or data —— 裸 dict 即可

    if tool == "search_papers":
        # 聚合端点（mcpo/paper-search-mcp 形状）：一次请求多源并发，按源隔离错误。
        # OWUI tool.py 的安全网分支消费 {papers, source_results, errors}；
        # research-proxy 不用这个（它只调单源 search_{source}）。
        query = str(body.get("query") or "").strip()
        if not query:
            return JSONResponse({"detail": "query required"}, status_code=400)
        sources_raw = str(body.get("sources") or "").strip()
        try:
            limit = max(1, min(int(body.get("max_results_per_source") or 5), 50))
        except (TypeError, ValueError):
            limit = 5
        if sources_raw.lower() == "all":
            names = sorted(s for s in toolwrap.SEARCH_DISPATCH
                           if s not in toolwrap.EXPLICIT_ONLY_SOURCES)
        else:
            names = [s.strip() for s in sources_raw.split(",") if s.strip()]
        names = [s for s in dict.fromkeys(names) if s in toolwrap.SEARCH_DISPATCH]
        if not names:
            return JSONResponse({"detail": "no valid sources"}, status_code=400)

        login_required = None
        # szlib 要真实浏览器（可能 20-60s，登录时更久），不能套 16s 的通用预算；
        # 其余源沿用 shim 给的 18s 里留 2s 余量的 16s。
        session = str(body.get("session") or "default")
        login_token = str(body.get("login_token") or "")

        async def _one(name: str):
            tmo = (330 if login_token else 180) if name == "szlib" else 16
            try:
                return name, await asyncio.wait_for(
                    toolwrap.search(name, query, limit,
                                    session=session, login_token=login_token),
                    timeout=tmo
                ), None
            except toolwrap.tool_mod._SzlibLoginRequired as e:
                return name, [], e
            except asyncio.TimeoutError:
                # 显式记超时：空 TimeoutError 的 str 是 ""，会被下面的 `if err` 当成功吞掉
                return name, [], f"timeout after {tmo}s"
            except Exception as e:
                # 异常 message 可能为空（如某些连接错误）→ 至少留下类型名，别静默成 0 命中
                return name, [], str(e) or type(e).__name__

        results = await asyncio.gather(*(_one(n) for n in names))
        papers, source_results, errors = [], {}, {}
        for name, hits, err in results:
            if isinstance(err, toolwrap.tool_mod._SzlibLoginRequired):
                source_results[name] = 0
                login_required = _szlib_login_payload(err)
                continue
            source_results[name] = len(hits)
            if err:
                errors[name] = str(err)[:300]
            else:
                papers.extend(hits)
        body = {"papers": papers, "source_results": source_results, "errors": errors}
        if login_required is not None:
            body["login_required"] = login_required
        return body

    if tool == "download_with_fallback":
        source = str(body.get("source") or "")
        paper_id = str(body.get("paper_id") or "")
        doi = str(body.get("doi") or "")
        title = str(body.get("title") or "")
        if not (paper_id or doi or title):
            return JSONResponse(
                {"detail": "need at least one of paper_id / doi / title"}, status_code=400
            )
        use_scihub = bool(body.get("use_scihub", False))
        scihub_base = str(body.get("scihub_base_url") or "").strip()
        try:
            data, via, errors = await asyncio.wait_for(
                downloader.download_with_fallback(
                    source, paper_id, doi, title, use_scihub, scihub_base
                ),
                timeout=110,
            )
        except asyncio.TimeoutError:
            return JSONResponse({"detail": "download timed out"}, status_code=504)
        if data is None:
            return JSONResponse(
                {"detail": "no PDF obtained", "attempts": errors}, status_code=404
            )
        fname = re.sub(r"[^A-Za-z0-9._-]+", "_", title)[:80] or "paper"
        return Response(
            content=data,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{fname}.pdf"', "X-Download-Via": via[:120]},
        )

    m = SEARCH_RE.match(tool)
    if m:
        source = m.group(1)
        if source not in toolwrap.SEARCH_DISPATCH:
            return JSONResponse({"detail": f"unknown search source: {source}"}, status_code=404)
        query = str(body.get("query") or "").strip()
        if not query:
            return JSONResponse({"detail": "query required"}, status_code=400)
        try:
            limit = max(1, min(int(body.get("max_results") or 10), 50))
        except (TypeError, ValueError):
            limit = 10
        try:
            papers = await toolwrap.search(
                source, query, limit,
                session=str(body.get("szlib_session") or "default"),
                login_token=str(body.get("szlib_login_token") or ""),
            )
        except toolwrap.tool_mod._SzlibLoginRequired as e:
            return {"papers": [], "login_required": _szlib_login_payload(e)}
        except asyncio.TimeoutError:
            return JSONResponse({"detail": f"{source} search timed out"}, status_code=504)
        except Exception as e:
            log.warning("search %s failed: %s", source, e)
            return JSONResponse(
                {"detail": f"{source}: {type(e).__name__}: {e}"}, status_code=502
            )
        return {"papers": papers}

    m = READ_RE.match(tool)
    if m:
        source = m.group(1)
        fn = readers.READERS.get(source)
        if fn is None:
            return JSONResponse(
                {"detail": f"read not supported for {source}"}, status_code=404
            )
        pid = str(body.get("paper_id") or "").strip()
        if not pid:
            return JSONResponse({"detail": "paper_id required"}, status_code=400)
        try:
            text = await asyncio.wait_for(fn(pid), timeout=80)
        except asyncio.TimeoutError:
            log.warning("read %s/%s timed out", source, pid)
            text = None
        except Exception as e:
            log.warning("read %s/%s failed: %s", source, pid, e)
            text = None
        if not text:
            return JSONResponse(
                {"detail": f"no full text for {source}:{pid}"}, status_code=404
            )
        return {"result": text}

    return JSONResponse({"detail": f"unknown tool: {tool}"}, status_code=404)
