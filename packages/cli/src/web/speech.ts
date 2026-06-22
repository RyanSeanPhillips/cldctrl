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

// ── trickle auto-read (listen mode) ──────────────────────────
// While listen mode is on, speak each NEW assistant reply of the target session
// as it lands — so you hear the running feedback hands-free. Triggered off the
// overview's assistantTurns counter so we only fetch a transcript when a turn
// actually completes; never interrupts an in-progress read.
const lastTurns = new Map<string, number>();
let listenSeeded = false;
function resetAutoRead(): void { lastTurns.clear(); listenSeeded = false; }

export async function autoRead(target: { id: string | null; assistantTurns: number } | null): Promise<void> {
  if (!handsFree || !target?.id) return;
  if (!listenSeeded) { lastTurns.set(target.id, target.assistantTurns); listenSeeded = true; return; } // skip the reply that already existed when you put headphones on
  const prev = lastTurns.get(target.id);
  if (prev === undefined) { lastTurns.set(target.id, target.assistantTurns); return; } // first time seeing this session
  if (target.assistantTurns <= prev) return; // nothing new
  if (isSpeaking()) return;                   // busy — catch the latest next tick (prev stays old)
  lastTurns.set(target.id, target.assistantTurns);
  await readSession(target.id);
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

/** Build a real (looping) silent WAV — needs actual samples so the browser
 *  treats it as playing media and hands us the media-button events. */
function makeSilenceUrl(seconds = 1): string {
  const sr = 8000, n = Math.floor(sr * seconds), dataLen = n * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, dataLen, true); // samples are already 0 = silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export function isHandsFree(): boolean { return handsFree; }

/**
 * Enable hands-free: `resolve` supplies which session to read when a media
 * button fires. Must be called from a user gesture (autoplay policy).
 */
export function enableHandsFree(resolve: () => string | null): boolean {
  try {
    if (!('mediaSession' in navigator)) return false;
    if (!silentAudio) {
      silentAudio = new Audio(makeSilenceUrl(1));
      silentAudio.loop = true;
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
    resetAutoRead(); // don't blurt out the reply that was already on screen
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
