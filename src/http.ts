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

/** Route table as the Python app exposes it: exact paths only. HEAD is not routed (Python returns 405 for it). */
const ROUTES: Record<string, string[]> = {
  '/': ['GET', 'POST'],
  '/.well-known/agent.json': ['GET'],
  '/healthz': ['GET'],
  '/readyz': ['GET'],
  '/docs': ['GET'],
  '/redoc': ['GET'],
  '/openapi.json': ['GET'],
};

export function routeGuard(req: any, res: any, next: () => void) {
  const allowed = ROUTES[req.path];
  if (!allowed) return sendJson(res, 404, { detail: 'Not Found' });
  if (!allowed.includes(req.method)) {
    res.setHeader('allow', allowed.join(', '));
    return sendJson(res, 405, { detail: 'Method Not Allowed' });
  }
  next();
}
