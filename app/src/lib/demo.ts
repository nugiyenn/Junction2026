import { HttpError } from '@/lib/http';

/** Demo actions delete or alter records, so they are refused in production unless ALLOW_DEMO_RESET=true. */
export function assertDemoAllowed(): void {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_RESET !== 'true') {
    throw new HttpError(403, 'Demo actions are disabled here. Set ALLOW_DEMO_RESET=true to allow them.');
  }
}
