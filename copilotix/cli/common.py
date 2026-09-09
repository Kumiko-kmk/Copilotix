# Copyright (c) Opendatalab. All rights reserved.
import json
import os
from pathlib import Path
from typing import Sequence

from loguru import logger

from copilotix.backend.vlm.vlm_analyze import aio_doc_analyze as aio_vlm_doc_analyze
from copilotix.backend.vlm.vlm_analyze import doc_analyze as vlm_doc_analyze
from copilotix.backend.vlm.vlm_middle_json_mkcontent import union_make as vlm_union_make
from copilotix.cli.backend_options import normalize_backend
from copilotix.data.data_reader_writer import FileBasedDataWriter
from copilotix.utils.draw_bbox import draw_layout_bbox, draw_span_bbox
from copilotix.utils.enum_class import MakeMode
from copilotix.utils.guess_suffix_or_lang import guess_suffix_by_bytes
from copilotix.utils.pdf_image_tools import images_bytes_to_pdf_bytes
from copilotix.utils.pdfium_guard import get_loadable_pdfium_page_indices, rewrite_pdf_bytes_with_pdfium

os.environ["TOKENIZERS_PARALLELISM"] = "false"

pdf_suffixes = ["pdf"]
image_suffixes = ["png", "jpeg", "jp2", "webp", "gif", "bmp", "jpg", "tiff"]
MAX_TASK_STEM_BYTES = 200


def utf8_byte_length(value: str) -> int:
    return len(value.encode("utf-8"))


def truncate_to_utf8_bytes(value: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    truncated = encoded[:max_bytes]
    while truncated:
        try:
            return truncated.decode("utf-8")
        except UnicodeDecodeError as exc:
            truncated = truncated[:exc.start]
    return ""


def normalize_task_stem(stem: str, max_bytes: int = MAX_TASK_STEM_BYTES) -> str:
    return truncate_to_utf8_bytes(stem, max_bytes)


def normalize_upload_filename(upload_name: str) -> str:
    sanitized_path = Path(Path(upload_name).name)
    return f"{normalize_task_stem(sanitized_path.stem)}{sanitized_path.suffix}"


def build_task_stem_candidate(stem: str, suffix: str = "", max_bytes: int = MAX_TASK_STEM_BYTES) -> str:
    if utf8_byte_length(f"{stem}{suffix}") <= max_bytes:
        return f"{stem}{suffix}"
    suffix_bytes = utf8_byte_length(suffix)
    if suffix_bytes >= max_bytes:
        return truncate_to_utf8_bytes(suffix, max_bytes)
    return f"{truncate_to_utf8_bytes(stem, max_bytes - suffix_bytes)}{suffix}"


def uniquify_task_stems(stems: Sequence[str]) -> tuple[list[str], list[tuple[str, str]]]:
    normalized_inputs = [normalize_task_stem(stem) for stem in stems]
    raw_keys = {stem.casefold() for stem in normalized_inputs}
    occurrence_counts: dict[str, int] = {}
    assigned_keys: set[str] = set()
    unique_stems: list[str] = []
    renamed: list[tuple[str, str]] = []
    for stem, normalized_stem in zip(stems, normalized_inputs):
        stem_base = normalized_stem or stem
        stem_key = stem_base.casefold()
        seen_count = occurrence_counts.get(stem_key, 0)
        occurrence_counts[stem_key] = seen_count + 1
        if seen_count == 0 and stem_key not in assigned_keys:
            effective_stem = stem_base
        else:
            suffix = seen_count + 1
            while True:
                candidate = build_task_stem_candidate(stem_base, f"_{suffix}")
                candidate_key = candidate.casefold()
                if candidate_key not in raw_keys and candidate_key not in assigned_keys:
                    effective_stem = candidate
                    break
                suffix += 1
        assigned_keys.add(effective_stem.casefold())
        unique_stems.append(effective_stem)
        if effective_stem != stem:
            renamed.append((stem, effective_stem))
    return unique_stems, renamed


def read_fn(path, file_suffix: str | None = None):
    path = path if isinstance(path, Path) else Path(path)
    with open(path, "rb") as input_file:
        file_bytes = input_file.read()
    file_suffix = file_suffix or guess_suffix_by_bytes(file_bytes, path)
    if file_suffix in image_suffixes:
        return images_bytes_to_pdf_bytes(file_bytes)
    if file_suffix in pdf_suffixes:
        return file_bytes
    raise ValueError(f"Unsupported file suffix: {file_suffix}; only PDF and images are supported")


def prepare_env(output_dir, pdf_file_name):
    local_md_dir = os.path.join(output_dir, pdf_file_name, "vlm")
    local_image_dir = os.path.join(local_md_dir, "images")
    os.makedirs(local_image_dir, exist_ok=True)
    os.makedirs(local_md_dir, exist_ok=True)
    return local_image_dir, local_md_dir


def convert_pdf_bytes_to_bytes(pdf_bytes, start_page_id=0, end_page_id=None):
    try:
        rebuilt = rewrite_pdf_bytes_with_pdfium(pdf_bytes, start_page_id=start_page_id, end_page_id=end_page_id)
        if rebuilt:
            return rebuilt
        logger.warning("PDFium rewrite returned empty bytes, trying to skip broken pages.")
    except Exception as exc:
        logger.warning(f"Error in converting PDF bytes with pdfium: {exc}, trying to skip broken pages.")
    try:
        loadable, broken = get_loadable_pdfium_page_indices(pdf_bytes, start_page_id=start_page_id, end_page_id=end_page_id)
        if broken:
            logger.warning(f"Skipped broken PDF pages during PDFium rewrite: {[page + 1 for page in broken]}")
        if not loadable:
            return pdf_bytes
        rebuilt = rewrite_pdf_bytes_with_pdfium(
            pdf_bytes, start_page_id=start_page_id, end_page_id=end_page_id, page_indices=loadable
        )
        return rebuilt or pdf_bytes
    except Exception as exc:
        logger.warning(f"Error in skip-broken-page fallback: {exc}; using original PDF bytes.")
        return pdf_bytes


def _prepare_pdf_bytes(pdf_bytes_list, start_page_id, end_page_id):
    return [convert_pdf_bytes_to_bytes(data, start_page_id, end_page_id) for data in pdf_bytes_list]


def _process_output(pdf_info, pdf_bytes, pdf_file_name, local_md_dir, local_image_dir, md_writer,
                    f_draw_layout_bbox, f_draw_span_bbox, f_dump_orig_pdf, f_dump_md,
                    f_dump_content_list, f_dump_middle_json, f_dump_model_output,
                    f_make_md_mode, middle_json, model_output=None):
    if f_draw_layout_bbox:
        try:
            draw_layout_bbox(pdf_info, pdf_bytes, local_md_dir, f"{pdf_file_name}_layout.pdf")
        except Exception as exc:
            logger.warning(f"Skipping layout bbox visualization for {pdf_file_name}: {exc}")
    if f_draw_span_bbox:
        try:
            draw_span_bbox(pdf_info, pdf_bytes, local_md_dir, f"{pdf_file_name}_span.pdf")
        except Exception as exc:
            logger.warning(f"Skipping span bbox visualization for {pdf_file_name}: {exc}")
    if f_dump_orig_pdf:
        md_writer.write(f"{pdf_file_name}_origin.pdf", pdf_bytes)
    image_dir = os.path.basename(local_image_dir)
    if f_dump_md:
        md_writer.write_string(f"{pdf_file_name}.md", vlm_union_make(pdf_info, f_make_md_mode, image_dir))
    if f_dump_content_list:
        for suffix, mode in (("content_list", MakeMode.CONTENT_LIST), ("content_list_v2", MakeMode.CONTENT_LIST_V2)):
            content = vlm_union_make(pdf_info, mode, image_dir)
            md_writer.write_string(f"{pdf_file_name}_{suffix}.json", json.dumps(content, ensure_ascii=False, indent=4))
    if f_dump_middle_json:
        md_writer.write_string(f"{pdf_file_name}_middle.json", json.dumps(middle_json, ensure_ascii=False, indent=4))
    if f_dump_model_output:
        md_writer.write_string(f"{pdf_file_name}_model.json", json.dumps(model_output, ensure_ascii=False, indent=4))
    logger.debug(f"local output dir is {local_md_dir}")


def _output_args(output_dir, names, data, index):
    name = names[index]
    image_dir, md_dir = prepare_env(output_dir, name)
    return name, image_dir, md_dir, FileBasedDataWriter(image_dir), FileBasedDataWriter(md_dir), data[index]


def _process_vlm(output_dir, names, data, backend, output_flags, server_url=None, **kwargs):
    normalize_backend(backend)
    for index in range(len(data)):
        name, image_dir, md_dir, image_writer, md_writer, pdf_bytes = _output_args(output_dir, names, data, index)
        middle_json, infer_result = vlm_doc_analyze(
            pdf_bytes, image_writer=image_writer, server_url=server_url, **kwargs
        )
        _process_output(middle_json["pdf_info"], pdf_bytes, name, md_dir, image_dir, md_writer,
                        *output_flags, middle_json, infer_result)


async def _async_process_vlm(output_dir, names, data, backend, output_flags, server_url=None, **kwargs):
    normalize_backend(backend)
    for index in range(len(data)):
        name, image_dir, md_dir, image_writer, md_writer, pdf_bytes = _output_args(output_dir, names, data, index)
        middle_json, infer_result = await aio_vlm_doc_analyze(
            pdf_bytes, image_writer=image_writer, server_url=server_url, **kwargs
        )
        _process_output(middle_json["pdf_info"], pdf_bytes, name, md_dir, image_dir, md_writer,
                        *output_flags, middle_json, infer_result)


def _parse_options(formula_enable, table_enable, f_draw_layout_bbox, f_draw_span_bbox,
                   f_dump_orig_pdf, f_dump_md, f_dump_content_list, f_dump_middle_json,
                   f_dump_model_output, f_make_md_mode):
    os.environ["COPILOTIX_VLM_FORMULA_ENABLE"] = str(formula_enable)
    os.environ["COPILOTIX_VLM_TABLE_ENABLE"] = str(table_enable)
    return (f_draw_layout_bbox, False, f_dump_orig_pdf, f_dump_md, f_dump_content_list,
            f_dump_middle_json, f_dump_model_output, f_make_md_mode)


def do_parse(output_dir, pdf_file_names: list[str], pdf_bytes_list: list[bytes], backend="vlm-http-client",
             formula_enable=True, table_enable=True, server_url=None, f_draw_layout_bbox=True,
             f_draw_span_bbox=True, f_dump_md=True, f_dump_middle_json=True, f_dump_model_output=True,
             f_dump_orig_pdf=True, f_dump_content_list=True, f_make_md_mode=MakeMode.MM_MD,
             start_page_id=0, end_page_id=None, image_analysis=True,
             client_side_output_generation=False, **kwargs):
    normalize_backend(backend)
    if not server_url or not str(server_url).strip():
        raise ValueError("server_url is required for vlm-http-client")
    prepared = _prepare_pdf_bytes(pdf_bytes_list, start_page_id, end_page_id)
    flags = _parse_options(formula_enable, table_enable, f_draw_layout_bbox, f_draw_span_bbox,
                           f_dump_orig_pdf, f_dump_md, f_dump_content_list, f_dump_middle_json,
                           f_dump_model_output, f_make_md_mode)
    _process_vlm(output_dir, pdf_file_names, prepared, backend, flags, server_url,
                 image_analysis=image_analysis, client_side_output_generation=client_side_output_generation, **kwargs)


async def aio_do_parse(output_dir, pdf_file_names: list[str], pdf_bytes_list: list[bytes], backend="vlm-http-client",
                       formula_enable=True, table_enable=True, server_url=None, f_draw_layout_bbox=True,
                       f_draw_span_bbox=True, f_dump_md=True, f_dump_middle_json=True, f_dump_model_output=True,
                       f_dump_orig_pdf=True, f_dump_content_list=True, f_make_md_mode=MakeMode.MM_MD,
                       start_page_id=0, end_page_id=None, image_analysis=True,
                       client_side_output_generation=False, **kwargs):
    normalize_backend(backend)
    if not server_url or not str(server_url).strip():
        raise ValueError("server_url is required for vlm-http-client")
    prepared = _prepare_pdf_bytes(pdf_bytes_list, start_page_id, end_page_id)
    flags = _parse_options(formula_enable, table_enable, f_draw_layout_bbox, f_draw_span_bbox,
                           f_dump_orig_pdf, f_dump_md, f_dump_content_list, f_dump_middle_json,
                           f_dump_model_output, f_make_md_mode)
    await _async_process_vlm(output_dir, pdf_file_names, prepared, backend, flags, server_url,
                             image_analysis=image_analysis,
                             client_side_output_generation=client_side_output_generation, **kwargs)
