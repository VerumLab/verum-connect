/**
 * QR scanning, in the hub. Two decoders: BarcodeDetector where native, jsQR
 * bundled for WebViews that lack it.
 */

import jsQR from 'jsqr';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

/** Why scanning is unavailable, or null if it should work. */
function scannerUnavailableReason(): string | null {
  // getUserMedia is gated on a secure context, so a plain-http LAN address has
  // no camera at all. Naming that beats a generic permission error.
  if (globalThis.isSecureContext === false) {
    return 'Scanning needs a secure (https) page. Open the hub over https, or paste the link instead.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not give pages camera access. Paste the pairing link instead.';
  }
  return null;
}

export interface ScanHandle {
  /** Stop decoding and release the camera. Safe to call more than once. */
  stop(): void;
}

export interface ScanOptions {
  video: HTMLVideoElement;
  onResult(text: string): void;
  onError(message: string): void;
}

/** Start the camera and decode until `onResult` fires or `stop()` is called. */
export async function startScanning(options: ScanOptions): Promise<ScanHandle> {
  const { video, onResult, onError } = options;

  let stream: MediaStream | null = null;
  let frame = 0;
  let stopped = false;

  const handle: ScanHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      // Without this the camera indicator stays lit after the sheet closes,
      // which reads as the page still watching.
      for (const track of stream?.getTracks() ?? []) track.stop();
      video.srcObject = null;
    },
  };

  // Named up front, because "could not start the camera" is misleading when the
  // browser never offered one: an insecure origin has no camera API at all, and
  // the fix is the page's address, not a permission.
  const blocked = scannerUnavailableReason();
  if (blocked) {
    onError(blocked);
    return handle;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The QR is on another screen, so the rear camera is the one wanted.
      video: { facingMode: 'environment' },
      audio: false,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    onError(
      name === 'NotAllowedError'
        ? 'Camera access was denied. Allow it in your browser’s settings, or paste the link instead.'
        : name === 'NotFoundError'
          ? 'No camera was found on this device.'
          : 'Could not start the camera. Paste the pairing link instead.',
    );
    return handle;
  }

  if (stopped) {
    for (const track of stream.getTracks()) track.stop();
    return handle;
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', ''); // iOS fullscreens the video without it.
  await video.play().catch(() => {});

  const detector = makeDetector();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  async function tick(): Promise<void> {
    if (stopped) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const text = await readFrame(video, detector, canvas, context);
      if (text) {
        handle.stop();
        onResult(text);
        return;
      }
    }
    frame = requestAnimationFrame(() => void tick());
  }

  frame = requestAnimationFrame(() => void tick());
  return handle;
}

function makeDetector(): BarcodeDetectorLike | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

async function readFrame(
  video: HTMLVideoElement,
  detector: BarcodeDetectorLike | null,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D | null,
): Promise<string | null> {
  if (detector) {
    try {
      const [first] = await detector.detect(video);
      if (first?.rawValue) return first.rawValue;
      return null;
    } catch {
      // A detector that throws once tends to keep throwing; fall through to
      // jsQR rather than failing the whole scan.
    }
  }

  if (!context) return null;

  // Downscale before decoding. jsQR is pure JS and cost scales with pixels; a
  // 640px-wide frame decodes a phone-screen QR comfortably.
  const width = Math.min(video.videoWidth, 640);
  if (width === 0) return null;
  const height = Math.round((video.videoHeight / video.videoWidth) * width);

  canvas.width = width;
  canvas.height = height;
  context.drawImage(video, 0, 0, width, height);

  const image = context.getImageData(0, 0, width, height);
  const result = jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' });
  return result?.data ?? null;
}
