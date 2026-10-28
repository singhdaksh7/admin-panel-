# Customer Authentication & Account Lifecycle

Kash Commerce supports a complete customer authentication lifecycle, supporting both traditional password-based authentication and modern passwordless email OTP authentication.

---

## 1. Authentication Methods

### A. Passwordless / Email OTP (Recommended)

1. **Request Code**:
   - Storefront calls `POST /account/otp/request` with `{ email }` or `commerce.auth.requestOtp(email)`.
   - Security controls:
     - 60-second resend cooldown.
     - 10-minute expiry window.
     - Maximum 5 attempts before code is invalidated.
     - Generic response: `If that email is valid, a login code has been sent` (prevents account enumeration).
     - Secure random 6-digit code.
     - Code is hashed at rest with SHA-256 (`CustomerOtp.codeHash`). The plaintext code is never logged in console, database, or audit trails.
2. **Verify Code**:
   - Storefront calls `POST /account/otp/verify` with `{ email, code }` or `commerce.auth.verifyOtp({ email, code })`.
   - If user does not exist, an account is automatically created with `emailVerified: true`.
   - Existing guest orders matching this verified email address are automatically attached to the account (`claimGuestOrders`).
   - Returns `{ customer, csrfToken, requiresPasswordSetup }`.
   - Sets secure httpOnly cookie session.
3. **Optional Password Setup**:
   - Authenticated user can set an optional password via `POST /account/set-password` or `commerce.account.setPassword(password)`.

### B. Password-Based Registration & Login

1. **Register**: `POST /account/register` with email, password, and optional name/phone. Requires a strong password (minimum length, character classes). Sends welcome email and email verification token.
2. **Login**: `POST /account/login` with email and password. Protected by progressive delay, per-IP rate limiting, and generic error messages on credential failure.
3. **Password Reset**: `POST /account/forgot-password` generates a time-limited HMAC reset token. `POST /account/reset-password` claims the token, updates the password, invalidates all concurrent sessions, and claims earlier guest orders.

---

## 2. Guest Order Claiming

To prevent unauthorized order history exposure, guest orders are never attached to an unverified email registration. 

Only when ownership of the mailbox is cryptographically proven (via OTP verification, email verification token, or password reset) does Kash Commerce atomically execute:

```sql
UPDATE "Order"
   SET "customerId" = :customerId
 WHERE "customerId" IS NULL
   AND "email" = :verifiedEmail;
```

---

## 3. Session Management & CSRF

- **Sessions**: Stored in Postgres (`CustomerSession`) with SHA-256 hashed refresh tokens.
- **Token Rotation**: Sessions are rotated on refresh with family tracking to detect and revoke token replay attacks.
- **Cookie Security**: `HttpOnly`, `SameSite=Lax`, `Path=/api/v1`, and `Secure` (enforced in production).
- **CSRF**: Unsafe state-changing account requests (`POST`, `PATCH`, `DELETE`) require the `x-csrf-token` header matching the active session.
