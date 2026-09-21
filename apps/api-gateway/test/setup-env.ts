/**
 * `ConfigModule.forRoot()` validates the environment at import time, so these
 * have to be in place before `app.module` is loaded — hence a jest `setupFiles`
 * entry rather than a `beforeAll`.
 */
process.env.NODE_ENV = 'test';
process.env.SERVICE_NAME = 'api-gateway';
process.env.PORT = '3000';
process.env.LOG_LEVEL = 'error';
process.env.HEALTH_CHECK_ENABLED = 'true';

process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.CORS_ORIGINS = 'http://localhost:5174';

process.env.THROTTLE_GLOBAL_TTL = '10000';
process.env.THROTTLE_GLOBAL_LIMIT = '10';

process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';

process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_REGION = 'us-east-1';
process.env.S3_ACCESS_KEY = 'test';
process.env.S3_SECRET_KEY = 'test-secret';
process.env.S3_BUCKET_UPLOADS = 'uploads';
process.env.S3_BUCKET_RESULTS = 'results';
