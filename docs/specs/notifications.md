# Razor account notifications

Recipient profile versions and payment status changes create company and personal notifications in the same database transaction. Company operational notices require the saved financial permission. Personal notices are readable only by their recorded recipient account, including a previous owner whose receiving profile was changed or detached. Personal notices contain no other employee's salary, wallet address or private document.

Profile changes ask finance to review affected unexecuted obligations. Unknown, held, recovery and unfunded statuses say that company action is required. Only the reconciled `paid` status creates a delivery notice. The original receiving profile remains bound to an approved obligation.

Recipients see notices in their personal payment workspace. Company members see operational notices in Activity & reports. Each person can mark personal notices read and opt in to generic email updates from their account notification panel. In-app notices work without an email provider.

## Optional email delivery

Configure `RESEND_API_KEY` and `NOTIFICATION_FROM_EMAIL`, using a verified sender domain. The integration follows the [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email). No email is sent during configuration or local checks.

Email requires an opt-in from an account with a verified email identity. Only events after opt-in are eligible. Each email contains a generic account-update message and a sign-in link. Payment amounts, receiving addresses and documents stay behind authentication. Invitation links remain copy-link workflows; enabling account updates does not silently start invitation emails.

The operations worker queues encrypted recipient addresses and sends at most one message per tick. It rechecks identity email, opt-in and current company permissions before sending. Removing membership, changing the email address or withdrawing consent cancels the queued delivery. A durable lease and stable provider idempotency key preserve the same message across interrupted attempts. Attempts stop after 23 hours rather than retrying outside the provider's deduplication window.

`accepted` means the provider returned a message ID. It does not claim inbox delivery. Ambiguous expired attempts remain `unknown` for review. No live email evidence has been recorded; local checks replace the provider transport and assert privacy, scoping and one recorded acceptance.
