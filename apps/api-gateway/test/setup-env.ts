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
// Set here rather than inherited from a developer's `.env`, which the suite
// otherwise depended on without saying so — and the auth tests sign with it.
process.env.JWT_SECRET = 'e2e-access-secret-that-is-long-enough';
process.env.CORS_ORIGINS = 'http://localhost:5174';

process.env.THROTTLE_GLOBAL_TTL = '10000';
process.env.THROTTLE_GLOBAL_LIMIT = '10';

// Deliberately unreachable. The suite is broker-less by design — the RBAC
// config never loads, so RBAC denies and a 401 can be told from a 403. Pointed
// at localhost:5672 it depended on whether a developer had the compose stack
// up: with it, the real config loaded, the admin token was allowed, and the
// suite failed on a machine that was working correctly.
process.env.RABBITMQ_URL = 'amqp://guest:guest@127.0.0.1:1';

process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_REGION = 'us-east-1';
process.env.S3_ACCESS_KEY = 'test';
process.env.S3_SECRET_KEY = 'test-secret';
process.env.S3_BUCKET_UPLOADS = 'uploads';
process.env.S3_BUCKET_RESULTS = 'results';

// Small, so the convert suite can cross it without generating megabytes.
process.env.CONVERSION_UPLOAD_MAX_BYTES = '65536';
