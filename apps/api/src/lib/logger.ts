import pino from "pino";

export function createLogger(level: string, silent = false) {
  return pino({
    level: silent ? "silent" : level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-csrf-token"]',
        "res.headers['set-cookie']",
        "password",
        "*.password",
        "*.passwordHash",
        "*.token",
        "*.refreshToken",
      ],
      censor: "[redacted]",
    },
  });
}
