# Copyright (c) Opendatalab. All rights reserved.
from pathlib import Path

from loguru import logger
from magika import Magika

DEFAULT_LANG = "txt"
PDF_SIG_BYTES = b"%PDF"
magika = Magika()


def _normalize_text_for_language_guess(code: str) -> str:
    if not code:
        return ""
    normalized = []
    index = 0
    while index < len(code):
        current_char = code[index]
        current_ord = ord(current_char)
        if 0xD800 <= current_ord <= 0xDBFF and index + 1 < len(code):
            next_char = code[index + 1]
            if 0xDC00 <= ord(next_char) <= 0xDFFF:
                normalized.append((current_char + next_char).encode("utf-16", "surrogatepass").decode("utf-16"))
                index += 2
                continue
        if not 0xD800 <= current_ord <= 0xDFFF:
            normalized.append(current_char)
        index += 1
    return "".join(normalized)


def guess_language_by_text(code):
    normalized_code = _normalize_text_for_language_guess(code)
    if not normalized_code:
        return DEFAULT_LANG
    try:
        lang = magika.identify_bytes(normalized_code.encode("utf-8", errors="replace")).prediction.output.label
    except Exception:
        return DEFAULT_LANG
    return lang if lang != "unknown" else DEFAULT_LANG


def guess_suffix_by_bytes(file_bytes, file_path=None) -> str:
    suffix = magika.identify_bytes(file_bytes).prediction.output.label
    if file_path and suffix in {"ai", "html"} and Path(file_path).suffix.lower() == ".pdf" and file_bytes[:4] == PDF_SIG_BYTES:
        return "pdf"
    return suffix


def guess_suffix_by_path(file_path) -> str:
    file_path = file_path if isinstance(file_path, Path) else Path(file_path)
    suffix = magika.identify_path(file_path).prediction.output.label
    if suffix in {"ai", "html"} and file_path.suffix.lower() == ".pdf":
        try:
            with open(file_path, "rb") as source:
                if source.read(4) == PDF_SIG_BYTES:
                    return "pdf"
        except Exception as exc:
            logger.warning(f"Failed to read file {file_path} for PDF signature check: {exc}")
    return suffix
