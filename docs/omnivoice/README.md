# OmniVoice GitHub Pages frontend

This static frontend is always available from GitHub Pages. It routes TTS requests as follows:

- up to 90 counted characters: Tailscale LOCAL first, then Modal on timeout/error;
- more than 90 counted characters: Modal directly.

No API key, model file, reference audio, or private credential is included in this folder.

