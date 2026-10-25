/** Express-level pieces that must run before Nest routing, in the same order as the Python middleware:
 * telemetry (outermost, so 401s are recorded) -> bearer auth -> FastAPI-style 404/405. */
import { timingSafeEqual } from 'crypto';
import { TOKEN } from './config';

export function sendJson(res: any, status: number, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  res.status(status);
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', raw.length);
  res.end(raw);
}

const PUBLIC_PATHS = new Set(['/.well-known/agent.json', '/healthz']);

/** Constant-time exact match of the whole Authorization header against "Bearer <token>". */
function authorized(header: string): boolean {
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${TOKEN}`);
  if (got.length !== want.length) {
    timingSafeEqual(want, want);
    return false;
  }
  return timingSafeEqual(got, want);
}

export function bearerAuth(req: any, res: any, next: () => void) {
  if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(req.path)) return next();
  if (!authorized(req.headers.authorization ?? '')) return sendJson(res, 401, { error: 'unauthorized' });
  next();
}

/** Route table as FastAPI exposes it: GET routes also answer HEAD; exact paths only. */
const ROUTES: Record<string, string[]> = {
  '/': ['GET', 'HEAD', 'POST'],
  '/.well-known/agent.json': ['GET', 'HEAD'],
  '/healthz': ['GET', 'HEAD'],
  '/readyz': ['GET', 'HEAD'],
  '/docs': ['GET', 'HEAD'],
  '/redoc': ['GET', 'HEAD'],
  '/openapi.json': ['GET', 'HEAD'],
};

export function routeGuard(req: any, res: any, next: () => void) {
  const allowed = ROUTES[req.path];
  if (!allowed) return sendJson(res, 404, { detail: 'Not Found' });
  if (!allowed.includes(req.method)) {
    res.setHeader('allow', allowed.filter((m) => m !== 'HEAD').join(', '));
    return sendJson(res, 405, { detail: 'Method Not Allowed' });
  }
  next();
}
