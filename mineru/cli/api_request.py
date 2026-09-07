# Copyright (c) Opendatalab. All rights reserved.
from dataclasses import dataclass
from typing import Annotated, Optional

from fastapi import File, Form, HTTPException, Request, UploadFile

from mineru.cli.backend_options import (
    BACKEND_SCHEMA_EXTRA,
    DEFAULT_BACKEND,
    validate_backend as validate_public_backend,
)
from mineru.cli.public_http_client_policy import validate_public_http_client_request

SWAGGER_UI_FILE_ARRAY_SCHEMA_EXTRA = {
    # Swagger UI 5 currently fails to render a usable multi-file picker when
    # FastAPI emits OpenAPI 3.1 byte arrays with contentMediaType.
    "items": {"type": "string", "format": "binary"}
}


@dataclass
class ParseRequestOptions:
    """保存公开解析接口共用的表单参数，供 API 与 Router 复用。"""

    files: list[UploadFile]
    backend: str
    formula_enable: bool
    table_enable: bool
    image_analysis: bool
    server_url: Optional[str]
    return_md: bool
    return_middle_json: bool
    return_model_output: bool
    return_content_list: bool
    return_images: bool
    response_format_zip: bool
    return_original_file: bool
    client_side_output_generation: bool
    start_page_id: int
    end_page_id: int


def validate_parse_backend(backend: str) -> str:
    """校验公开 API 允许的解析后端，避免旧入口名进入下游执行链路。"""
    try:
        return validate_public_backend(backend)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def parse_request_form(
    request: Request,
    files: Annotated[
        list[UploadFile],
        File(
            description="Upload PDF or image files for parsing",
            json_schema_extra=SWAGGER_UI_FILE_ARRAY_SCHEMA_EXTRA,
        ),
    ],
    backend: Annotated[
        str,
        Form(
            description="Remote OpenAI-compatible VLM HTTP client.",
            json_schema_extra=BACKEND_SCHEMA_EXTRA,
        ),
    ] = DEFAULT_BACKEND,
    formula_enable: Annotated[
        bool,
        Form(description="Enable formula parsing."),
    ] = True,
    table_enable: Annotated[
        bool,
        Form(description="Enable table parsing."),
    ] = True,
    image_analysis: Annotated[
        bool,
        Form(
            description="Enable image/chart analysis.",
        ),
    ] = True,
    server_url: Annotated[
        Optional[str],
        Form(
            description="OpenAI-compatible server URL for vlm-http-client, e.g. http://127.0.0.1:30000",
        ),
    ] = None,
    return_md: Annotated[
        bool,
        Form(description="Return markdown content in response"),
    ] = True,
    return_middle_json: Annotated[
        bool,
        Form(description="Return middle JSON in response"),
    ] = False,
    return_model_output: Annotated[
        bool,
        Form(description="Return model output JSON in response"),
    ] = False,
    return_content_list: Annotated[
        bool,
        Form(description="Return content list JSON in response"),
    ] = False,
    return_images: Annotated[
        bool,
        Form(description="Return extracted images in response"),
    ] = False,
    response_format_zip: Annotated[
        bool,
        Form(description="Return results as a ZIP file instead of JSON"),
    ] = False,
    return_original_file: Annotated[
        bool,
        Form(
            description=(
                "Include the processed original input file in the ZIP result; "
                "ignored unless response_format_zip=true"
            ),
        ),
    ] = False,
    client_side_output_generation: Annotated[
        bool,
        Form(
            description=(
                "Defer final markdown/content-list generation to the client. "
                "When enabled, the server returns staged middle JSON, model output, and images."
            ),
        ),
    ] = False,
    start_page_id: Annotated[
        int,
        Form(description="The starting page for PDF parsing, beginning from 0"),
    ] = 0,
    end_page_id: Annotated[
        int,
        Form(description="The ending page for PDF parsing, beginning from 0"),
    ] = 99999,
) -> ParseRequestOptions:
    """解析 API/Router 共用的 multipart 表单，并保持 Swagger 参数同源。"""
    backend = validate_parse_backend(backend)
    if not server_url or not server_url.strip():
        raise HTTPException(
            status_code=400,
            detail="server_url is required for vlm-http-client",
        )
    validate_public_http_client_request(
        public_bind_exposed=bool(
            getattr(request.app.state, "public_bind_exposed", False)
        ),
        allow_public_http_client=bool(
            getattr(request.app.state, "allow_public_http_client", False)
        ),
        backend=backend,
        server_url=server_url,
    )
    if client_side_output_generation:
        return_md = False
        return_middle_json = True
        return_model_output = True
        return_content_list = False
        return_images = True

    effective_return_original_file = return_original_file and response_format_zip
    return ParseRequestOptions(
        files=files,
        backend=backend,
        formula_enable=formula_enable,
        table_enable=table_enable,
        image_analysis=image_analysis,
        server_url=server_url,
        return_md=return_md,
        return_middle_json=return_middle_json,
        return_model_output=return_model_output,
        return_content_list=return_content_list,
        return_images=return_images,
        response_format_zip=response_format_zip,
        return_original_file=effective_return_original_file,
        client_side_output_generation=client_side_output_generation,
        start_page_id=start_page_id,
        end_page_id=end_page_id,
    )
