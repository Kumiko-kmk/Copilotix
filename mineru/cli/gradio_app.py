# Copyright (c) Opendatalab. All rights reserved.
import os
import shutil
import tempfile
from pathlib import Path

import click
import gradio as gr

from mineru.cli.backend_options import DEFAULT_BACKEND, PUBLIC_BACKEND_CHOICES, normalize_backend
from mineru.cli.common import do_parse, image_suffixes, pdf_suffixes, read_fn
from mineru.utils.guess_suffix_or_lang import guess_suffix_by_path


def parse_document(file_path, backend, server_url, formula_enable, table_enable,
                   image_analysis, start_page_id, end_page_id):
    if not file_path:
        raise gr.Error("Please upload a PDF or image file.")
    backend = normalize_backend(backend)
    suffix = guess_suffix_by_path(file_path)
    if suffix not in pdf_suffixes + image_suffixes:
        raise gr.Error("Only PDF and image files are supported.")
    if backend == "vlm-http-client" and not str(server_url or "").strip():
        raise gr.Error("server_url is required for vlm-http-client.")

    root = Path(tempfile.mkdtemp(prefix="mineru_gradio_"))
    stem = Path(file_path).stem
    try:
        do_parse(
            str(root), [stem], [read_fn(file_path, suffix)], backend=backend,
            server_url=server_url or None, formula_enable=formula_enable,
            table_enable=table_enable, image_analysis=image_analysis,
            start_page_id=int(start_page_id), end_page_id=int(end_page_id) if end_page_id is not None else None,
            f_draw_layout_bbox=False, f_draw_span_bbox=False,
        )
        parse_dir = root / stem / "vlm"
        markdown_path = parse_dir / f"{stem}.md"
        markdown = markdown_path.read_text(encoding="utf-8") if markdown_path.exists() else ""
        archive = shutil.make_archive(str(root / f"{stem}_result"), "zip", root_dir=parse_dir)
        archive_fd, archive_path = tempfile.mkstemp(prefix=f"{stem}_", suffix=".zip")
        os.close(archive_fd)
        durable_archive = Path(archive_path)
        shutil.copyfile(archive, durable_archive)
        return markdown, str(durable_archive)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def create_app() -> gr.Blocks:
    with gr.Blocks(title="MinerU VLM") as app:
        gr.Markdown("# MinerU VLM\nParse PDF and image files through a remote visual-language model.")
        with gr.Row():
            input_file = gr.File(label="PDF or image", file_types=[f".{suffix}" for suffix in pdf_suffixes + image_suffixes], type="filepath")
            with gr.Column():
                backend = gr.Dropdown(list(PUBLIC_BACKEND_CHOICES), value=DEFAULT_BACKEND, label="Backend")
                server_url = gr.Textbox(label="VLM server URL", placeholder="http://127.0.0.1:30000")
                formula = gr.Checkbox(True, label="Formula recognition")
                table = gr.Checkbox(True, label="Table recognition")
                image_analysis = gr.Checkbox(True, label="Image/chart analysis")
                start_page = gr.Number(0, precision=0, label="Start page")
                end_page = gr.Number(None, precision=0, label="End page")
                submit = gr.Button("Parse", variant="primary")
        markdown = gr.Markdown()
        result = gr.File(label="Result ZIP")
        submit.click(
            parse_document,
            inputs=[input_file, backend, server_url, formula, table, image_analysis, start_page, end_page],
            outputs=[markdown, result],
        )
    return app


@click.command()
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=7860, show_default=True, type=int)
@click.option("--share", is_flag=True, default=False)
def main(host: str, port: int, share: bool) -> None:
    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
    create_app().launch(server_name=host, server_port=port, share=share)


if __name__ == "__main__":
    main()
