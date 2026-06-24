import { buildApp } from './app';
import { env } from './config/env';

const app = buildApp();

app
  .listen({ port: env.PORT, host: env.HOST })
  .then(() => app.log.info(`API listening on http://${env.HOST}:${env.PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
