/**
 * App-level text-to-speech via the browser Web Speech API (no server, no key,
 * offline). One global utterance at a time (speechSynthesis is global), exposed
 * as a toggle so the same click starts/stops. Also an optional "hands-free"
 * mode that wires Bluetooth/keyboard MEDIA buttons (play/pause) to read the
 * latest agent output — for listening while walking around.
 */
import { fetchTranscript } from './api.js';

let onState: ((speaking: boolean) => void) | null = null;
/** Subscribe to speaking on/off so callers can reflect play/stop in their UI. */
export function onSpeechState(cb: (speaking: boolean) => void): void { onState = cb; }
function emit(on: boolean): void { try { onState?.(on); } catch { /* ignore */ } }

export function isSpeaking(): boolean { try { return !!window.speechSynthesis?.speaking; } catch { return false; } }
export function stopSpeech(): void { try { window.speechSynthesis?.cancel(); } catch { /* ignore */ } emit(false); }

/** Strip markdown + leftover terminal noise so the audio is clean prose. */
function clean(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')        // ANSI escapes
    .replace(/`{1,3}/g, '')
    .replace(/^\s*[#>\-*]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

/** Speak `text`, or stop if already speaking (toggle). */
export function toggleSpeak(text: string): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  if (synth.speaking || synth.pending) { synth.cancel(); emit(false); return; }
  const t = clean(text).slice(0, 32000).trim();
  if (!t) return;
  const u = new SpeechSynthesisUtterance(t);
  u.onend = () => emit(false);
  u.onerror = () => emit(false);
  synth.speak(u);
  emit(true);
}

/** Read the latest assistant message of a session (toggles off if speaking). */
export async function readSession(sessionId: string | null | undefined): Promise<void> {
  if (window.speechSynthesis?.speaking) { stopSpeech(); return; }
  if (!sessionId) return;
  try {
    const entries = await fetchTranscript(sessionId);
    const last = [...entries].reverse().find((e) => e.role === 'assistant' && e.text.trim());
    if (last) toggleSpeak(last.text);
  } catch { /* transcript unavailable */ }
}

// ── hands-free (media-button) mode ───────────────────────────
// Bluetooth headset play/pause buttons reach the page only when it holds an
// audio session, so we loop a near-silent track and register Media Session
// action handlers. Experimental: depends on the browser routing media keys.
let silentAudio: HTMLAudioElement | null = null;
let handsFree = false;
// 0.1s of silent WAV (44-byte header + a few zero samples), base64 data URI.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

export function isHandsFree(): boolean { return handsFree; }

/**
 * Enable hands-free: `resolve` supplies which session to read when a media
 * button fires. Must be called from a user gesture (autoplay policy).
 */
export function enableHandsFree(resolve: () => string | null): boolean {
  try {
    if (!('mediaSession' in navigator)) return false;
    if (!silentAudio) {
      silentAudio = new Audio(SILENT_WAV);
      silentAudio.loop = true;
      silentAudio.volume = 0.01;
    }
    silentAudio.play().catch(() => { /* gesture/autoplay may still reject */ });
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: 'CLD CTRL — read agent output', artist: 'CTRL' });
    const read = () => { readSession(resolve()); };
    ms.setActionHandler('play', read);
    ms.setActionHandler('pause', () => stopSpeech());
    ms.setActionHandler('stop', () => stopSpeech());
    try { ms.setActionHandler('nexttrack', read); } catch { /* optional */ }
    try { ms.setActionHandler('previoustrack', read); } catch { /* optional */ }
    handsFree = true;
    return true;
  } catch { return false; }
}

export function disableHandsFree(): void {
  handsFree = false;
  stopSpeech();
  try { silentAudio?.pause(); } catch { /* ignore */ }
  try {
    const ms = navigator.mediaSession;
    for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'] as const) ms.setActionHandler(a, null);
  } catch { /* ignore */ }
}
