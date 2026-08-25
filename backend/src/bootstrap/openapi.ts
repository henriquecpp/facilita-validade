import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { createApp } from './app.js';
import { describeResponses } from './response-schemas.js';
import { APP_NAME } from '../shared/domain/app.js';
const context = await createApp({ jwtSecret: 'documentation-only-do-not-use-for-authentication' });
try {
  const document = describeResponses(
    SwaggerModule.createDocument(
      context.app,
      new DocumentBuilder()
        .setTitle(APP_NAME)
        .setVersion('0.1.0')
        .addBearerAuth()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'integration')
        .build(),
      { operationIdFactory: (controller, method) => `${controller}_${method}` },
    ),
  );
  const json = JSON.stringify(document, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if ((await readFile('../contracts/openapi.json', 'utf8')) !== json)
      throw new Error('OpenAPI desatualizado. Execute pnpm contracts:generate.');
  } else {
    await mkdir('../contracts', { recursive: true });
    await writeFile('../contracts/openapi.json', json);
  }
  console.log('OpenAPI validado.');
} finally {
  await context.app.close();
  await context.database.close();
}
