# Copyright (c) Opendatalab. All rights reserved.
import itertools
import json
import os
from contextlib import asynccontextmanager
from dataclasses import fields
from typing import Annotated

import click
import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from copilotix.cli.api_request import ParseRequestOptions, parse_request_form
from copilotix.cli.public_http_client_policy import configure_public_http_client_policy, is_public_bind_host
from copilotix.version import __version__

UPSTREAMS_ENV = "COPILOTIX_ROUTER_UPSTREAM_URLS_JSON"


def _configured_upstreams() -> tuple[str, ...]:
    try:
        values = json.loads(os.getenv(UPSTREAMS_ENV, "[]"))
    except json.JSONDecodeError:
        values = []
    if not isinstance(values, list):
        return ()
    return tuple(dict.fromkeys(str(value).rstrip("/") for value in values if str(value).startswith(("http://", "https://"))))


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http_client = httpx.AsyncClient(timeout=httpx.Timeout(600), follow_redirects=True)
    app.state.task_upstreams = {}
    app.state.upstream_cycle = itertools.cycle(_configured_upstreams())
    yield
    await app.state.http_client.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="Copilotix Remote VLM Router", version=__version__, lifespan=lifespan)
    app.state.public_bind_exposed = False
    app.state.allow_public_http_client = False

    async def choose_upstream(request: Request) -> str:
        upstreams = _configured_upstreams()
        if not upstreams:
            raise HTTPException(status_code=503, detail="No remote Parser API upstream is configured")
        for _ in upstreams:
            candidate = next(request.app.state.upstream_cycle)
            try:
                response = await request.app.state.http_client.get(f"{candidate}/health", timeout=10)
                if response.is_success:
                    return candidate
            except httpx.HTTPError:
                continue
        raise HTTPException(status_code=503, detail="No healthy remote Parser API upstream is available")

    async def encode_request(options: ParseRequestOptions):
        data = {}
        for field in fields(options):
            if field.name == "files":
                continue
            value = getattr(options, field.name)
            if value is None:
                continue
            data[field.name] = str(value).lower() if isinstance(value, bool) else str(value)
        uploads = []
        for upload in options.files:
            uploads.append(("files", (upload.filename or "document", await upload.read(), upload.content_type)))
            await upload.close()
        return data, uploads

    async def forward_parse(request: Request, endpoint: str, options: ParseRequestOptions) -> Response:
        upstream = await choose_upstream(request)
        data, uploads = await encode_request(options)
        try:
            response = await request.app.state.http_client.post(f"{upstream}{endpoint}", data=data, files=uploads)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Remote VLM upstream failed: {exc}") from exc
        if endpoint == "/tasks" and response.is_success:
            try:
                task_id = response.json().get("task_id")
            except ValueError:
                task_id = None
            if isinstance(task_id, str) and task_id:
                request.app.state.task_upstreams[task_id] = upstream
        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type"),
        )

    @app.post("/file_parse", summary="Synchronously parse with a remote VLM")
    async def file_parse(request: Request, options: Annotated[ParseRequestOptions, Depends(parse_request_form)]):
        return await forward_parse(request, "/file_parse", options)

    @app.post("/tasks", status_code=202, summary="Submit an asynchronous remote VLM task")
    async def submit_task(request: Request, options: Annotated[ParseRequestOptions, Depends(parse_request_form)]):
        return await forward_parse(request, "/tasks", options)

    async def proxy_task(request: Request, task_id: str, suffix: str = "") -> Response:
        upstream = request.app.state.task_upstreams.get(task_id)
        if not upstream:
            raise HTTPException(status_code=404, detail="Task not found")
        try:
            response = await request.app.state.http_client.get(f"{upstream}/tasks/{task_id}{suffix}")
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Remote VLM upstream failed: {exc}") from exc
        return Response(content=response.content, status_code=response.status_code, media_type=response.headers.get("content-type"))

    @app.get("/tasks/{task_id}")
    async def task_status(task_id: str, request: Request):
        return await proxy_task(request, task_id)

    @app.get("/tasks/{task_id}/result")
    async def task_result(task_id: str, request: Request):
        return await proxy_task(request, task_id, "/result")

    @app.get("/health")
    async def health(request: Request):
        upstreams = _configured_upstreams()
        healthy = []
        for upstream in upstreams:
            try:
                response = await request.app.state.http_client.get(f"{upstream}/health", timeout=10)
                if response.is_success:
                    healthy.append(upstream)
            except httpx.HTTPError:
                pass
        payload = {"status": "healthy" if healthy else "unavailable", "version": __version__, "remote_upstreams": len(upstreams), "healthy_upstreams": len(healthy)}
        return payload if healthy else JSONResponse(status_code=503, content=payload)

    return app


app = create_app()


@click.command()
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=8002, show_default=True, type=int)
@click.option("--reload", is_flag=True)
@click.option("--allow-public-http-client", is_flag=True)
@click.option("--upstream-url", "upstream_urls", multiple=True, required=True,
              help="Remote Copilotix FastAPI base URL; repeat for multiple upstreams.")
def main(host: str, port: int, reload: bool, allow_public_http_client: bool, upstream_urls: tuple[str, ...]) -> None:
    os.environ[UPSTREAMS_ENV] = json.dumps(list(upstream_urls))
    configure_public_http_client_policy(
        app,
        public_bind_exposed=is_public_bind_host(host),
        allow_public_http_client=allow_public_http_client,
    )
    uvicorn.run("copilotix.cli.router:app" if reload else app, host=host, port=port, reload=reload)


if __name__ == "__main__":
    main()
