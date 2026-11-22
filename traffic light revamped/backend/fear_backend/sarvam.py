"""Sarvam AI client: speech-to-text for voice reports, and JSON-mode chat for
incident triage and the AI dispatch agent.

Every call has a timeout, one retry on 429 / 503, and a local request budget
under the account's rate limit, and raises SarvamError on any failure - callers
always have a rule-based fallback, so an outage degrades FEAR, never stops it.
The API key is read from config and never logged or returned.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from typing import Optional

import httpx

from . import config

logger = logging.getLogger("fear_backend.sarvam")

# Kept under the account's per-API limits (60 requests/minute each for
# speech-to-text and chat) across all the APIs together.
_BUDGET_PER_MIN = 110
_calls: deque = deque()
_client: Optional[httpx.AsyncClient] = None


class SarvamError(Exception):
    pass


def available() -> bool:
    return bool(config.SARVAM_API_KEY)


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=config.SARVAM_BASE_URL, timeout=httpx.Timeout(25.0, connect=6.0))
    return _client


def _take_budget() -> None:
    now = time.monotonic()
    while _calls and now - _calls[0] > 60:
        _calls.popleft()
    if len(_calls) >= _BUDGET_PER_MIN:
        raise SarvamError("Sarvam request budget for this minute is used up")
    _calls.append(now)


async def _post(path: str, *, timeout: float, **kw) -> dict:
    if not available():
        raise SarvamError("no Sarvam API key configured")
    headers = {"api-subscription-key": config.SARVAM_API_KEY}
    for attempt in (0, 1):
        _take_budget()
        try:
            r = await _http().post(path, headers=headers, timeout=timeout, **kw)
        except httpx.HTTPError as e:
            if attempt == 0:
                await asyncio.sleep(0.8)
                continue
            raise SarvamError(f"Sarvam unreachable ({type(e).__name__})") from None
        if r.status_code in (429, 503) and attempt == 0:
            await asyncio.sleep(1.5)
            continue
        if r.status_code != 200:
            try:
                msg = r.json().get("error", {}).get("message") or r.text[:200]
            except ValueError:
                msg = r.text[:200]
            raise SarvamError(f"Sarvam {path} returned {r.status_code}: {msg}")
        try:
            return r.json()
        except ValueError:
            raise SarvamError("Sarvam returned something that isn't JSON") from None
    raise SarvamError("Sarvam unavailable")


async def speech_to_text(audio: bytes, filename: str, content_type: str, mode: str = "translate") -> dict:
    """mode "translate": English text whatever language was spoken;
    "transcribe": the words as spoken. Audio under 30 s (Sarvam's sync limit)."""
    r = await _post("/speech-to-text", timeout=30.0,
                    files={"file": (filename, audio, content_type)},
                    data={"model": config.SARVAM_STT_MODEL, "mode": mode, "language_code": "unknown"})
    return {"transcript": (r.get("transcript") or "").strip(), "language": r.get("language_code"),
            "languageProbability": r.get("language_probability")}


async def transcribe_report(audio: bytes, filename: str, content_type: str) -> dict:
    """English text for triage, plus the original words when the person spoke
    another language (shown to Command next to the translation)."""
    en = await speech_to_text(audio, filename, content_type, "translate")
    original = None
    lang = en.get("language")
    if lang and not str(lang).startswith("en"):
        try:
            original = (await speech_to_text(audio, filename, content_type, "transcribe"))["transcript"] or None
        except SarvamError:
            original = None
    return {"transcript": en["transcript"], "original": original, "language": lang}


async def chat_json(system: str, user: str, schema_name: str, schema: dict, *, max_tokens: int = 700,
                    timeout: float = 20.0) -> dict:
    """One structured-output completion; returns the parsed JSON object.
    Reasoning is switched off - triage has to be fast, and the output is
    checked by the caller's own rules anyway."""
    r = await _post("/v1/chat/completions", timeout=timeout, json={
        "model": config.SARVAM_CHAT_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "reasoning_effort": None,
        "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "schema": schema, "strict": True}},
    })
    try:
        content = r["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise SarvamError("Sarvam returned no answer") from None
    content = content.strip()
    if content.startswith("```"):
        content = content.strip("`").removeprefix("json").strip()
    try:
        out = json.loads(content)
    except ValueError:
        raise SarvamError("Sarvam's answer wasn't valid JSON") from None
    if not isinstance(out, dict):
        raise SarvamError("Sarvam's answer wasn't a JSON object")
    return out


# Languages Bulbul can speak; anything else is spoken in Indian English.
TTS_LANGS = ("bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN")
TTS_MODEL = "bulbul:v3"
TTS_SPEAKER = "priya"


def tts_lang(code) -> str:
    code = (code or "en-IN").replace("or-IN", "od-IN")
    return code if code in TTS_LANGS else "en-IN"


async def text_to_speech(text: str, lang: str) -> bytes:
    """MP3 of `text` spoken in `lang` (one of TTS_LANGS)."""
    import base64

    r = await _post("/text-to-speech", timeout=20.0, json={
        "text": text[:2400], "language_code": tts_lang(lang), "model": TTS_MODEL, "speaker": TTS_SPEAKER,
        "output_audio_codec": "mp3", "speech_sample_rate": 22050, "pace": 1.0,
    })
    try:
        return base64.b64decode(r["audios"][0])
    except (KeyError, IndexError, TypeError, ValueError):
        raise SarvamError("Sarvam returned no audio") from None


async def translate(text: str, target: str, source: str = "en-IN") -> str:
    r = await _post("/translate", timeout=15.0, json={
        "input": text[:1000], "source_language_code": source, "target_language_code": tts_lang(target),
        "model": "mayura:v1", "mode": "formal",
    })
    out = (r.get("translated_text") or "").strip()
    if not out:
        raise SarvamError("Sarvam returned no translation")
    return out
