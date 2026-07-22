#!/usr/bin/env python3
"""Bounded Piper 1.4.2 worker. Model artifacts must already be mounted."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
import wave

from piper import PiperVoice, SynthesisConfig


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--config", required=True, type=pathlib.Path)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--model", required=True, type=pathlib.Path)
    parser.add_argument("--model-sha256", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--speaking-rate", required=True, type=float)
    return parser.parse_args()


def main() -> int:
    options = arguments()
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    request = json.load(sys.stdin)
    if set(request) != {"narration"} or not isinstance(request["narration"], str):
        raise ValueError("invalid request contract")
    if not 0.75 <= options.speaking_rate <= 1.5:
        raise ValueError("speaking rate outside approved bounds")
    if sha256(options.model) != options.model_sha256:
        raise ValueError("model digest mismatch")
    if sha256(options.config) != options.config_sha256:
        raise ValueError("config digest mismatch")
    options.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    voice = PiperVoice.load(str(options.model), config_path=str(options.config))
    synthesis = SynthesisConfig(length_scale=1 / options.speaking_rate)
    with wave.open(str(options.output), "wb") as target:
        voice.synthesize_wav(request["narration"], target, syn_config=synthesis)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
