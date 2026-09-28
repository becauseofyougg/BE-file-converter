# File Converter — Email notifications

**Status:** implemented — see §9 for where the code lives
**Date:** 2026-09-28
**Owning service:** `notification-service`
**Related:** [ARCHITECTURE.md §4](ARCHITECTURE.md#4-messaging-design-rabbitmq) · [REGISTRATION.md](REGISTRATION.md) · [AUTHENTICATION.md](AUTHENTICATION.md) · [PROFILE-UPDATE.md](PROFILE-UPDATE.md) · [ACCOUNT-DELETION.md](ACCOUNT-DELETION.md)

---

## 1. Scope

The notification service turns domain events into email. Before this change it was subscribed to
`domain.events` with no handlers, so every flow that ends in an emailed code or link — verifying an
address, confirming a sign-in, changing an address, erasing an account — could be started and never
finished.

Nobody calls this service. It has no RPC surface and the gateway holds no client for it: identity
writes an event to its outbox in the same transaction as the change it describes, the relay
publishes it, and this service reacts. That is what lets a mail provider being down fail nothing but
the mail.

In-app notifications and the SSE push are the next step and are not here.

---

## 2. What is sent

| Event | To | Mail | Expires |
|---|---|---|---|
| `user.registered` | the address that registered | code or link to verify it — **nothing** when confirmation is off | yes |
| `user.verification_resent` | same | same mail, new code | yes |
| `user.registration_attempted` | the existing account's owner | "someone tried to register with your address" | — |
| `user.login_confirmation_requested` | the account | code or link, plus the device and IP it came from | yes |
| `user.email_change_requested` | the **new** address | code or link — proving the new mailbox can be read is the point | yes |
| `user.email_changed` | the **old** address | "your address was changed" — the only mailbox a takeover does not control | — |
| `user.deletion_requested` | the account | code or link to confirm erasure | yes |
| `user.deleted` | the address the account had | "your account has been deleted", the last mail it will get | — |

The `email_changed` notice deliberately does not name the new address: its reader may be the victim
of a takeover, but may equally be someone who no longer owns that mailbox.

Not sent, deliberately: `user.email_verified` (the user is looking at the result), `rbac.updated`
(not for people), `conversion.*` (next step), `user.password_reset_requested` (no publisher exists
yet, so there is no flow to write a mail for).

---

## 3. The pipeline

```
event ─► validate ─► render ─► open send-log row ─► already settled? ─► expired? ─► SMTP
            │           │              │                  │                │         │
         rejected    skipped       (idempotency)       duplicate        expired   sent / retry / failed
         → DLQ       → ack                              → ack            → ack
```

Every message is settled explicitly. The consumer runs with `noAck: false` and `prefetchCount: 1`,
so a message a handler forgets to ack sits on the channel forever and takes the only prefetch slot
with it.

**Validation.** An event from another service is as untrusted as a request from a browser. The
envelope and the payload are validated with class-validator against DTOs that `implements` the
contract interfaces, so a renamed field breaks the build rather than production. Unknown fields are
stripped, not refused: a publisher adding a field is a compatible change, and a consumer that has not
been redeployed yet must keep working.

---

## 4. Idempotency

The outbox relay is at-least-once, so the same event can arrive twice. The send log —
`notifications`, one row per event per channel — is what stops a second mail.

| Column | Meaning |
|---|---|
| `ref_id` | the event's `eventId`. A redelivery carries the same one; a **resend** is a new event with a new code and gets its own row |
| `status` | `PENDING` → `SENT` \| `RETRYING` \| `FAILED` \| `EXPIRED` |
| `attempts` | counted here, not in the message, so a redelivery after a crash does not reset it |
| `last_error` | SMTP code and first reply line, with addresses masked |

`UNIQUE (ref_id, channel)` decides who got there first. The row is opened by insert-then-read rather
than read-then-insert: two replicas handed the same redelivery would both pass a `SELECT`, and only
the index settles it. A row already `SENT`, `FAILED` or `EXPIRED` is acked without sending.

**What the table does not hold: the address or the code.** Both travel in the event and go straight
into the rendered mail. Storing them would put a second copy of every one-time code in a database,
and an address this service would then have to erase on `user.deleted`. What is left — who, what
kind, when, whether it worked — answers "did the mail go out", which is the question the table
exists for.

---

## 5. Failures and retries

### 5.1 Classification

| Failure | Retry? | Why |
|---|---|---|
| SMTP `4xx` | yes | the server saying "not now" |
| SMTP `5xx` | **no** | the server saying "not ever" — `550 no such mailbox` will be refused identically forever |
| connection, timeout, DNS, TLS | yes | the socket never got as far as the message |
| `EAUTH` — even with its `535` | **yes** | our configuration, not the message. Treating it as permanent would discard every mail until someone fixed the password |
| malformed message, invalid envelope | no | a retry reproduces it exactly |
| database down, or a bug | yes | not the message's fault |

### 5.2 The retry ladder

A transient failure is retried **through the broker**, not by sleeping in the handler. With
`prefetchCount: 1`, a handler waiting ten minutes on one greylisted recipient would hold up every
message behind it.

| Step | Queue | Waits |
|---|---|---|
| 1 | `notification.events.retry.1` | 30 s |
| 2 | `notification.events.retry.2` | 2 min |
| 3 | `notification.events.retry.3` | 10 min |
| 4 | `notification.events.retry.4` | 30 min |
| — | `notification.events.dlq` | until an operator looks |

Each retry queue has an `x-message-ttl` and dead-letters through the default exchange straight back
to `notification.events`, so the message reappears on the work queue and nowhere else. The body is
copied byte for byte — Nest dispatches on the pattern inside it, not on the routing key — and an
`x-retry-count` header records the step. The copy is confirmed by the broker **before** the original
is acked, so a crash in between duplicates the message rather than losing it.

That makes five attempts over roughly 42 minutes, which is longer than any code lives. That is fine,
because of §5.3.

The ladder lives in [`libs/core/src/messaging/rmq-retry.ts`](../libs/core/src/messaging/rmq-retry.ts)
and is not specific to mail; the conversion workers' `conversion.retry.<n>` ladder is the same shape.

### 5.3 Expiry

A confirmation carries its `expiresAt`. Past it, the mail is dropped, the row is marked `EXPIRED`, and
a warning is logged. A late code is worse than none: the user types it, it fails, and they conclude
the product is broken. A warning rather than info, because it means mail is running further behind
than a code lives — a backlog someone should be looking at. Notices that carry no code are sent
however late they are.

### 5.4 Where a message ends up

| Outcome | Message |
|---|---|
| sent, duplicate, skipped, expired, failed | acked |
| retry | copied to the next retry step, then acked |
| retry with the ladder spent | moved to the DLQ |
| rejected (malformed) | moved to the DLQ — a malformed event is a publisher bug, and the message is the evidence |
| the broker refuses the copy or the ack | left unacked; comes back when the channel reopens |

---

## 6. Templates and links

Plain TypeScript, no template engine: one method per mail on `TemplatesService`, each taking only
what that mail shows — never a whole event — so what can reach an inbox is visible from the
signature. Every mail has a text and an HTML body.

**Everything interpolated is escaped.** The login mail shows the requester's User-Agent, which is
whatever the caller put in the header; rendered raw it would be markup in the victim's inbox. Escaping
happens in one place, `compose()`, which takes only plain strings — a template cannot forget it. Link
URLs are additionally refused unless they are `http(s)`.

**Links point at the frontend, not the API.** The page reads the token and posts it. A link that
called the API directly would be confirmed by any mail scanner that prefetches links.

| Purpose | Page | Which then calls |
|---|---|---|
| verify address | `/verify-email?token=` | `POST /auth/verify-email` |
| confirm sign-in | `/login/confirm?token=` | `POST /auth/confirm` |
| confirm new address | `/account/email/confirm?userId=&token=` | `POST /users/:userId/email-change/confirm` |
| confirm erasure | `/account/delete/confirm?userId=&token=` | `POST /users/:userId/deletion/confirm` |

These paths are a contract with the frontend; they live in one place, `FRONTEND_ROUTES`. Links are
built against `APP_PUBLIC_URL` and keep its base path, so an app served from `/app` gets
`/app/verify-email`.

Lifetimes are written relative ("expires in 10 minutes"), because the mail cannot know the reader's
time zone and a relative time is what they need to act on anyway.

---

## 7. Configuration

| Variable | Notes |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | a pooled transport; connect and greeting time out at 10 s, an idle socket at 30 s — nodemailer's own defaults are two and ten *minutes*, long enough to hold the consumer |
| `SMTP_USER`, `SMTP_PASSWORD` | optional — Mailhog takes anonymous SMTP, a real provider does not |
| `SMTP_FROM` | an address. Validated without a TLD check: the compose default `no-reply@file-converter.local` was refused by one, and the service did not boot on its own defaults |
| `APP_PUBLIC_URL` | the **frontend** origin links are built against — see §10 |

SMTP is deliberately not a health probe: a provider that is briefly refusing connections should
send mail up the retry ladder, not take the replica out of rotation.

---

## 8. Logging

Every line carries `eventName`, `eventId`, `userId` and `correlationId`. None carries the address or
the code; a test asserts it.

| Event | Level | Notes |
|---|---|---|
| `notification.sent` | info | with `attempts` |
| `notification.duplicate` | info | a redelivery of something already settled |
| `notification.skipped` | debug | the event needs no mail |
| `notification.retrying` | warn | with the masked SMTP reason |
| `notification.expired` | warn | mail is running behind code lifetimes |
| `notification.failed` | error | permanent, or out of attempts |
| `notification.rejected` | error | names the fields that failed validation, never their values |
| `notification.dead_lettered` | error | the ladder ran out |
| `notification.handler_failed` · `.settle_failed` | error | database, broker, or a bug |

---

## 9. Where it lives

| Concern | File |
|---|---|
| handlers, settling | [`notifications.controller.ts`](../apps/notification-service/src/modules/notifications/notifications.controller.ts) |
| event → recipient, expiry, mail | [`notification.definitions.ts`](../apps/notification-service/src/modules/notifications/notification.definitions.ts) |
| validate → render → record → send | [`notifications.service.ts`](../apps/notification-service/src/modules/notifications/notifications.service.ts) |
| send log | [`notification-log.service.ts`](../apps/notification-service/src/modules/notifications/notification-log.service.ts) · [`schema.prisma`](../apps/notification-service/prisma/schema.prisma) |
| event DTOs | [`dto/event.dto.ts`](../apps/notification-service/src/modules/notifications/dto/event.dto.ts) |
| SMTP, failure classification | [`mailer/`](../apps/notification-service/src/modules/mailer/) |
| wording, layout, links | [`templates/`](../apps/notification-service/src/modules/templates/) |
| retry ladder | [`libs/core/src/messaging/rmq-retry.ts`](../libs/core/src/messaging/rmq-retry.ts) |
| queue names, delays | [`libs/contracts/src/messaging/topology.ts`](../libs/contracts/src/messaging/topology.ts) |

---

## 10. Still open

1. **Not run against the real stack.** Docker is unavailable in the environment used so far. The
   mailer and templates have been exercised through Nest DI over a real SMTP conversation with an
   in-process server — all seven mails delivered as multipart, the User-Agent escaped, a `550`
   classified as permanent with the address masked — but not against Postgres, RabbitMQ or Mailhog.
   The retry queues in particular (quorum queues with `x-message-ttl`, which needs RabbitMQ ≥ 3.10;
   compose runs 4) have only been tested against a mocked channel.
2. **`APP_PUBLIC_URL` defaults to the gateway** (`http://localhost:3000`) in both
   `docker-compose.yml` and `.env.example`. Links built against it open an API route with no `GET`
   handler. It should be the frontend's origin, and the four pages in §6 have to exist there.
3. **Delivery is at-least-once, not exactly-once.** A crash after the SMTP server accepts a mail but
   before the row is marked `SENT` sends it again on redelivery, and two replicas racing the same
   redelivered `RETRYING` row can both send. Closing that would need a lease on the row; one
   duplicate mail in a crash is the accepted price.
4. **The identity outbox keeps every code in plaintext.** `verification_tokens` stores only a hash,
   but the event carrying the code is written to `outbox.payload`, and published rows are never
   deleted or cleared. The same goes for the address in `user.deleted`, which outlives the erasure it
   announces. The fix is in identity: clear the payload once published, or prune published rows after
   a short window.
5. **English only.** The wording is in one place so a locale lookup can replace it, but there is no
   locale on the user yet to look up.
6. The `email_changed` notice tells the reader to "contact support" without saying how: there is no
   support address in configuration.
