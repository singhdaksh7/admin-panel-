import { testDatabaseUrl } from "./globalSetup";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl();
process.env.SESSION_SECRET = "test-only-session-secret-0123456789abcdef0123456789";
process.env.CORS_ORIGINS = "http://localhost:5173";
process.env.PAYMENT_PROVIDER = "MOCK";
process.env.LOG_LEVEL = "silent";
