'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Pill } from '@/components/page';
import type { IntakeResult } from '@/types';
import { call } from './api';

/** Mirrors the server: the host limits bodies to 4.5 MB, so the photo is downscaled and refused over 3 MB. */
const MAX_BYTES = 3_000_000;
const MAX_SIDE = 1280;

/** Shrinks a photo to at most 1280 px on the long side as a JPEG data URL (quality 0.8). Honours the camera's rotation. */
async function downscale(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Could not open this file as an image. Try a jpeg, png or webp photo.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize the photo.');
  ctx.fillStyle = '#fff'; // transparent png areas would turn black in a jpeg
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL('image/jpeg', 0.8);
  if ((url.length * 3) / 4 > MAX_BYTES) throw new Error('The photo is still over 3 MB after resizing. Take a simpler or closer photo.');
  return url;
}

/** The slice of the Web Speech API used here (not in TypeScript's DOM types). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
const speechCtor = () =>
  typeof window === 'undefined'
    ? undefined
    : ((window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition);
const noSubscribe = () => () => {};

const LANGS = [
  { code: 'en-GB', label: 'EN' },
  { code: 'fi-FI', label: 'FI' },
];

/**
 * Starts an order from a photo (Nemotron vision reads it into lines) or a dictated sentence. Nothing is ordered here:
 * tapping a line only puts its text in the request box, and the normal pipeline runs when the person sends it.
 */
export function Intake({ onPick, disabled }: { onPick: (text: string) => void; disabled?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [lang, setLang] = useState(LANGS[0].code);
  // Feature-detected after hydration: the server renders no Dictate button, the browser adds it where it can listen.
  const canDictate = useSyncExternalStore(noSubscribe, () => Boolean(speechCtor()), () => false);

  async function readPhoto(file: File) {
    setError(null);
    setResult(null);
    setPicked(null);
    setReading(true);
    try {
      setResult(await call<IntakeResult>('/api/intake', { image: await downscale(file) }));
    } catch (err) {
      setError({ title: 'Photo not read', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setReading(false);
    }
  }

  function dictate() {
    if (listening) return recognition.current?.stop();
    const Ctor = speechCtor();
    if (!Ctor) return;
    setError(null);
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const heard = Array.from(e.results, (r) => r[0].transcript).join(' ').trim();
      if (heard) onPick(heard);
    };
    rec.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        const message = e.error === 'not-allowed' ? 'Microphone access was refused.' : `The browser could not listen (${e.error}).`;
        setError({ title: 'Dictation failed', message });
      }
    };
    rec.onend = () => setListening(false);
    recognition.current = rec;
    setListening(true);
    rec.start();
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          aria-label="Photo of a list, shelf or delivery note"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // the same photo can be chosen again
            if (file) void readPhoto(file);
          }}
        />
        <Button variant="outline" className="h-11 px-4" disabled={disabled || reading} onClick={() => fileInput.current?.click()}>
          {reading ? 'Reading photo…' : 'Photo'}
        </Button>
        {canDictate && (
          <>
            <Button variant={listening ? 'default' : 'outline'} className="h-11 px-4" disabled={disabled || reading} onClick={dictate}>
              {listening ? 'Listening… tap to stop' : 'Dictate'}
            </Button>
            <div role="group" aria-label="Dictation language" className="flex gap-1">
              {LANGS.map((l) => (
                <Button
                  key={l.code}
                  variant={lang === l.code ? 'secondary' : 'ghost'}
                  className="h-11 min-w-11 px-3"
                  aria-pressed={lang === l.code}
                  disabled={listening}
                  onClick={() => setLang(l.code)}
                >
                  {l.label}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{error.title}</AlertTitle>
          <AlertDescription className="break-words">{error.message}</AlertDescription>
        </Alert>
      )}

      {result && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium break-all text-foreground">Read by {result.readBy}</span>
            {result.lines.length > 0 && <span>Tap a line to use it. One product per request.</span>}
          </div>
          {result.lines.map((l, i) => (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => {
                setPicked(i);
                onPick(l.text);
              }}
              className={cn(
                'flex min-h-11 w-full items-center justify-between gap-3 rounded-[10px] border bg-card px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50',
                picked === i && 'border-primary ring-2 ring-ring/40'
              )}
            >
              <span className="break-words">{l.text}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {l.confidence !== 'high' && <Pill tone={l.confidence === 'low' ? 'bad' : 'warn'}>{l.confidence === 'low' ? 'Check' : 'Unsure'}</Pill>}
                {l.amount !== null && l.amountUnit && (
                  <Pill>
                    {l.amount} {l.amountUnit === 'unit' ? 'units' : l.amountUnit}
                  </Pill>
                )}
              </span>
            </button>
          ))}
          {result.note && <p className="m-0 text-xs text-muted-foreground">{result.note}</p>}
        </div>
      )}
    </div>
  );
}
