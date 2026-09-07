# Copyright (c) Opendatalab. All rights reserved.
import asyncio
import atexit
import threading
import time

import pypdfium2 as pdfium
from loguru import logger
from mineru_vl_utils import MinerUClient
from tqdm import tqdm

from mineru.backend.utils.runtime_utils import exclude_progress_bar_idle_time
from mineru.data.data_reader_writer import DataWriter
from mineru.utils.config_reader import get_processing_window_size
from mineru.utils.enum_class import ImageType
from mineru.utils.pdf_image_tools import aio_load_images_from_pdf_bytes_range, load_images_from_pdf_doc
from mineru.utils.pdfium_guard import close_pdfium_document, get_pdfium_document_page_count, open_pdfium_document
from .model_output_to_middle_json import append_page_blocks_to_middle_json, finalize_middle_json, init_middle_json


class ModelSingleton:
    """Cache remote HTTP clients by endpoint and transport options."""

    _instance = None
    _clients = {}
    _lock = threading.RLock()

    def __new__(cls, *args, **kwargs):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    def get_model(self, server_url: str | None, **kwargs) -> MinerUClient:
        if not server_url:
            raise ValueError("server_url is required for the remote VLM backend")
        options = {
            "max_concurrency": kwargs.pop("max_concurrency", 100),
            "http_timeout": kwargs.pop("http_timeout", 600),
            "server_headers": kwargs.pop("server_headers", None),
            "max_retries": kwargs.pop("max_retries", 3),
            "retry_backoff_factor": kwargs.pop("retry_backoff_factor", 0.5),
        }
        if kwargs:
            raise ValueError(f"Unsupported remote VLM options: {', '.join(sorted(kwargs))}")
        key = (server_url, tuple((name, repr(value)) for name, value in options.items()))
        with self._lock:
            if key not in self._clients:
                self._clients[key] = MinerUClient(
                    backend="http-client",
                    server_url=server_url,
                    enable_table_formula_eq_wrap=True,
                    image_analysis=True,
                    enable_cross_page_table_merge=True,
                    **options,
                )
            return self._clients[key]

    def shutdown(self) -> None:
        with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        for client in clients:
            for method_name in ("close", "shutdown"):
                method = getattr(client, method_name, None)
                if callable(method):
                    try:
                        method()
                    except Exception as exc:
                        logger.debug(f"Failed to close remote VLM client: {exc}")
                    break


def shutdown_cached_models() -> None:
    ModelSingleton().shutdown()


atexit.register(shutdown_cached_models)


def _close_images(images_list):
    for image_dict in images_list or []:
        image = image_dict.get("img_pil")
        if image is not None:
            try:
                image.close()
            except Exception:
                pass


def _window_size(page_count: int) -> tuple[int, int]:
    configured = get_processing_window_size(default=64)
    effective = min(page_count, configured) if page_count else 0
    total = (page_count + effective - 1) // effective if effective else 0
    logger.info(f"VLM HTTP processing-window run. page_count={page_count}, window_size={configured}, total_windows={total}")
    return effective, total


def _append_results(middle_json, results, images_list, pdf_doc, image_writer, page_start, progress_bar):
    append_page_blocks_to_middle_json(
        middle_json, results, images_list, pdf_doc, image_writer,
        page_start_index=page_start, progress_bar=progress_bar,
    )


def doc_analyze(pdf_bytes, image_writer: DataWriter | None, predictor: MinerUClient | None = None,
                server_url: str | None = None,
                image_analysis: bool = True, **kwargs):
    client_side_output_generation = bool(kwargs.pop("client_side_output_generation", False))
    predictor = predictor or ModelSingleton().get_model(server_url, **kwargs)
    pdf_doc = open_pdfium_document(pdfium.PdfDocument, pdf_bytes)
    middle_json = init_middle_json()
    results = []
    try:
        page_count = get_pdfium_document_page_count(pdf_doc)
        window_size, total_windows = _window_size(page_count)
        progress_bar = tqdm(total=page_count, desc="Processing pages") if page_count else None
        last_append_end_time = None
        started = time.time()
        try:
            for window_index, window_start in enumerate(range(0, page_count, window_size or 1)):
                window_end = min(page_count - 1, window_start + window_size - 1)
                images_list = load_images_from_pdf_doc(
                    pdf_doc, start_page_id=window_start, end_page_id=window_end,
                    image_type=ImageType.PIL, pdf_bytes=pdf_bytes,
                )
                try:
                    logger.info(f"VLM HTTP window {window_index + 1}/{total_windows}: pages {window_start + 1}-{window_end + 1}")
                    window_results = predictor.batch_two_step_extract(
                        images=[item["img_pil"] for item in images_list], image_analysis=image_analysis,
                    )
                    results.extend(window_results)
                    if progress_bar is not None and last_append_end_time is not None:
                        exclude_progress_bar_idle_time(progress_bar, last_append_end_time, now=time.time())
                    _append_results(middle_json, window_results, images_list, pdf_doc, image_writer, window_start, progress_bar)
                    last_append_end_time = time.time()
                finally:
                    _close_images(images_list)
        finally:
            if progress_bar is not None:
                progress_bar.close()
        logger.debug(f"VLM HTTP inference finished in {round(time.time() - started, 2)}s")
        if not client_side_output_generation:
            finalize_middle_json(middle_json["pdf_info"])
        return middle_json, results
    finally:
        close_pdfium_document(pdf_doc)


async def aio_doc_analyze(pdf_bytes, image_writer: DataWriter | None, predictor: MinerUClient | None = None,
                          server_url: str | None = None,
                          image_analysis: bool = True, **kwargs):
    client_side_output_generation = bool(kwargs.pop("client_side_output_generation", False))
    predictor = predictor or await asyncio.to_thread(ModelSingleton().get_model, server_url, **kwargs)
    pdf_doc = open_pdfium_document(pdfium.PdfDocument, pdf_bytes)
    middle_json = init_middle_json()
    results = []
    try:
        page_count = get_pdfium_document_page_count(pdf_doc)
        window_size, total_windows = _window_size(page_count)
        progress_bar = tqdm(total=page_count, desc="Processing pages") if page_count else None
        last_append_end_time = None
        try:
            for window_index, window_start in enumerate(range(0, page_count, window_size or 1)):
                window_end = min(page_count - 1, window_start + window_size - 1)
                images_list = await aio_load_images_from_pdf_bytes_range(
                    pdf_bytes, start_page_id=window_start, end_page_id=window_end, image_type=ImageType.PIL,
                )
                try:
                    logger.info(f"VLM HTTP window {window_index + 1}/{total_windows}: pages {window_start + 1}-{window_end + 1}")
                    window_results = await predictor.aio_batch_two_step_extract(
                        images=[item["img_pil"] for item in images_list], image_analysis=image_analysis,
                    )
                    results.extend(window_results)
                    if progress_bar is not None and last_append_end_time is not None:
                        exclude_progress_bar_idle_time(progress_bar, last_append_end_time, now=time.time())
                    _append_results(middle_json, window_results, images_list, pdf_doc, image_writer, window_start, progress_bar)
                    last_append_end_time = time.time()
                finally:
                    _close_images(images_list)
        finally:
            if progress_bar is not None:
                progress_bar.close()
        if not client_side_output_generation:
            await asyncio.to_thread(finalize_middle_json, middle_json["pdf_info"])
        return middle_json, results
    finally:
        close_pdfium_document(pdf_doc)
