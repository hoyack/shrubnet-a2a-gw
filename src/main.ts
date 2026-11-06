/** Entry point. Config is loaded first so a missing or empty KIMICLAW_TOKEN fails with one clear line. */
import 'reflect-metadata';

async function main() {
  try {
    require('./config');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  const telemetry = require('./telemetry');
  telemetry.setup();
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('./app.module');
  const { bearerAuth, routeGuard } = require('./http');
  const { LOG } = require('./log');

  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(telemetry.telemetryMiddleware, bearerAuth, routeGuard);
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  LOG.info(`listening on ${host}:${port}`);

  const stop = async () => {
    await app.close();
    await telemetry.shutdown(); // flush spans/metrics on graceful stop
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main();
