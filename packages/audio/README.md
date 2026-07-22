# `@reflo/audio`

Queue-driven chapter audio generation for `media.tts.v1`.

- Plans one opaque `media.audio.generate` command per chapter in chapter order.
- Uses Qwen-TTS first and the approved Piper CPU fallback only after a known
  non-acceptance caused by transient capacity, quota, rate-limit, or availability.
- Validates one WAV/PCM-S16LE/mono payload contract before a trusted finalizer
  assigns the private OSS key and commits the `Asset` row.
- Persists retry, lease, status, source-span, narration-script, model, voice,
  engine, settings, payload-hash, and authorized-delivery metadata.

The checked-in Piper manifest is deliberately `blocked`. It is a reproducible
candidate, not production evidence. Activation still requires a final image
digest and SBOM, human GPL deployment clearance, target-environment capacity,
the 30-script/five-course benchmark for both paths, private range playback, and
two-reviewer listening results at 1.0x and 1.5x.
