# Copyright (c) Opendatalab. All rights reserved.

BACKEND_VLM_HTTP_CLIENT = "vlm-http-client"

DEFAULT_BACKEND = BACKEND_VLM_HTTP_CLIENT

HTTP_CLIENT_BACKEND_CHOICES = (
    BACKEND_VLM_HTTP_CLIENT,
)
PUBLIC_BACKEND_CHOICES = HTTP_CLIENT_BACKEND_CHOICES
BACKEND_SCHEMA_EXTRA = {"enum": list(PUBLIC_BACKEND_CHOICES)}


def get_backend_choices(include_http_client: bool = True) -> list[str]:
    """按入口配置返回公开 backend 选项，避免各入口重复维护字符串列表。"""
    return list(HTTP_CLIENT_BACKEND_CHOICES) if include_http_client else []


def normalize_backend(backend: str) -> str:
    """将旧 backend 别名规范为当前公开名称，并校验最终名称是否合法。"""
    if backend not in PUBLIC_BACKEND_CHOICES:
        allowed_values = ", ".join(PUBLIC_BACKEND_CHOICES)
        raise ValueError(f"Invalid backend. Allowed values: {allowed_values}")
    return backend


def validate_backend(backend: str) -> str:
    """校验公开入口允许的 backend 名称，并返回规范后的后端名称。"""
    return normalize_backend(backend)
