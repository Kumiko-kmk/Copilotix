# Copyright (c) Opendatalab. All rights reserved.
from pathlib import Path


VLM_PARSE_DIR_NAME = "vlm"


def build_parse_dir(
    output_dir: str | Path,
    pdf_name: str,
    backend: str,
) -> Path:
    output_root = Path(output_dir)
    if backend.startswith("vlm"):
        return output_root / pdf_name / VLM_PARSE_DIR_NAME
    raise ValueError(f"Unknown backend type: {backend}")


def resolve_parse_dir(
    output_dir: str | Path,
    pdf_name: str,
    backend: str,
) -> Path:
    return build_parse_dir(output_dir, pdf_name, backend)
