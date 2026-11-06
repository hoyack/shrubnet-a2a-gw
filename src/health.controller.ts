/** Liveness/readiness probes and the docs. /healthz is public; everything else here needs the token. */
import * as fs from 'fs';
import * as path from 'path';
import { Controller, Get, Res } from '@nestjs/common';
import { parse } from 'yaml';
import { BASE_DIR } from './config';
import { sendJson } from './http';

/** The shared spec, copied verbatim from kimiclaw-a2a-gateway's openapi.yaml. */
export const OPENAPI = parse(fs.readFileSync(path.join(BASE_DIR, 'openapi.yaml'), 'utf8'));

/** shutil.which("openclaw") */
function onPath(bin: string): boolean {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try {
      const p = path.join(dir || '.', bin);
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch { return false; }
  });
}

const page = (title: string, body: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">${body}</html>`;

@Controller()
export class HealthController {
  @Get('healthz')
  healthz(@Res() res: any) {
    sendJson(res, 200, { status: 'ok' });
  }

  @Get('readyz')
  readyz(@Res() res: any) {
    if (!onPath('openclaw')) return sendJson(res, 503, { status: 'not ready', reason: 'openclaw binary not found on PATH' });
    sendJson(res, 200, { status: 'ready' });
  }

  @Get('openapi.json')
  openapi(@Res() res: any) {
    sendJson(res, 200, OPENAPI);
  }

  @Get('docs')
  docs(@Res() res: any) {
    res.type('html').send(page('Kimiclaw A2A Gateway - Swagger UI',
      '<link type="text/css" rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head><body>'
      + '<div id="swagger-ui"></div><script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>'
      + '<script>SwaggerUIBundle({url: "/openapi.json", dom_id: "#swagger-ui"})</script></body>'));
  }

  @Get('redoc')
  redoc(@Res() res: any) {
    res.type('html').send(page('Kimiclaw A2A Gateway - ReDoc',
      '</head><body><redoc spec-url="/openapi.json"></redoc><script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script></body>'));
  }
}
