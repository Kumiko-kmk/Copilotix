import asyncio
import inspect
from pathlib import Path

import pytest
from click.testing import CliRunner

from mineru.cli import common
from mineru.cli.api_request import parse_request_form
from mineru.cli.backend_options import DEFAULT_BACKEND, PUBLIC_BACKEND_CHOICES, normalize_backend
from mineru.cli.client import main as cli_main
from mineru.cli.fast_api import main as api_main
from mineru.cli.gradio_app import main as gradio_main
from mineru.cli.router import main as router_main


def test_public_backend_contract_is_vlm_only():
    assert DEFAULT_BACKEND == "vlm-http-client"
    assert PUBLIC_BACKEND_CHOICES == ("vlm-http-client",)
    for backend in PUBLIC_BACKEND_CHOICES:
        assert normalize_backend(backend) == backend
    for removed in ("pipeline", "hybrid-engine", "hybrid-http-client", "vlm-engine"):
        with pytest.raises(ValueError):
            normalize_backend(removed)


def test_cli_and_api_do_not_expose_removed_options():
    runner = CliRunner()
    help_outputs = []
    for command in (cli_main, api_main, router_main, gradio_main):
        result = runner.invoke(command, ["--help"])
        assert result.exit_code == 0
        help_outputs.append(result.output)
    combined_help = "\n".join(help_outputs)
    for removed in (
        "--method",
        "--lang",
        "--effort",
        "--model-path",
        "--device",
        "--gpu-memory",
        "--enable-vlm-preload",
    ):
        assert removed not in combined_help
    assert "vlm-http-client" in help_outputs[0]
    assert "--url" in help_outputs[0]
    assert set(inspect.signature(parse_request_form).parameters).isdisjoint({"parse_method", "lang_list", "effort"})


def test_read_fn_accepts_pdf_and_images_and_rejects_office(tmp_path, monkeypatch):
    source = tmp_path / "input.bin"
    source.write_bytes(b"payload")
    monkeypatch.setattr(common, "images_bytes_to_pdf_bytes", lambda data: b"pdf:" + data)
    assert common.read_fn(source, "pdf") == b"payload"
    assert common.read_fn(source, "png") == b"pdf:payload"
    with pytest.raises(ValueError, match="only PDF and images"):
        common.read_fn(source, "docx")


def test_sync_and_async_dispatch_use_only_vlm(monkeypatch, tmp_path):
    sync_calls = []
    async_calls = []
    monkeypatch.setattr(common, "_prepare_pdf_bytes", lambda values, *_: values)
    monkeypatch.setattr(common, "_process_vlm", lambda *args, **kwargs: sync_calls.append((args, kwargs)))

    async def fake_async(*args, **kwargs):
        async_calls.append((args, kwargs))

    monkeypatch.setattr(common, "_async_process_vlm", fake_async)
    common.do_parse(str(tmp_path), ["paper"], [b"pdf"], backend="vlm-http-client", server_url="http://server")
    asyncio.run(common.aio_do_parse(str(tmp_path), ["paper"], [b"pdf"], backend="vlm-http-client", server_url="http://server"))
    assert sync_calls[0][0][3] == "vlm-http-client"
    assert async_calls[0][0][3] == "vlm-http-client"
    with pytest.raises(ValueError):
        common.do_parse(str(tmp_path), ["paper"], [b"pdf"], backend="pipeline")
    with pytest.raises(ValueError, match="server_url is required"):
        common.do_parse(str(tmp_path), ["paper"], [b"pdf"])


def test_parse_output_directory_is_stable(tmp_path):
    image_dir, parse_dir = common.prepare_env(tmp_path, "paper")
    assert Path(parse_dir) == tmp_path / "paper" / "vlm"
    assert Path(image_dir) == tmp_path / "paper" / "vlm" / "images"
