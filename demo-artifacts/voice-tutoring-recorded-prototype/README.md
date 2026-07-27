# Recorded voice tutoring prototype

This directory is the non-runtime Demo Day artifact for issue #58.

The WAV says its own label aloud: **“Recorded prototype, not live voice
tutoring.”** It contains one frozen, source-backed question and answer for the
synthetic staff-controlled Flow B course and cites the `Evidence and retention`
source span. It does not use learner data.

The artifact does **not** prove or enable streaming chat, live tutor-answer
generation, runtime tracing, Piper production activation, or external learner
readiness. `p1.tutor.voice` remains default-off and ineligible while its P0,
audio, privacy/security/quality, and capacity prerequisites are not current.
The manifest preserves those non-claims and the checked-in Piper blockers.

Regenerate the WAV and manifest from the pinned development-only Piper profile:

```sh
corepack pnpm demo:voice-clip
```

Generated files are not hand-edited.
