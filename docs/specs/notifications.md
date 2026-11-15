# Razor account notifications

Recipient profile versions and payment status changes create company and personal notifications in the same database transaction. Company operational notices require the saved financial permission. Personal notices are readable only by their recorded recipient account, including a previous owner whose receiving profile was changed or detached. Personal notices contain no other employee's salary, wallet address or private document.

Profile changes ask finance to review affected unexecuted obligations. Unknown, held, recovery and unfunded statuses say that company action is required. Only the reconciled `paid` status creates a delivery notice. The original receiving profile remains bound to an approved obligation.

Recipients see notices in their personal payment workspace. Company members see operational notices in Activity & reports. Each person can mark personal notices read and opt in to generic email updates from their account notification panel. In-app notices work without an email provider.

## Optional email delivery

Configure `RESEND_API_KEY` and `NOTIFICATION_FROM_EMAIL`, using a verified sender domain. The integration follows the [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email). No email is sent during configuration or local checks.

Account-update email requires an opt-in from an account with a verified email identity. Only events after opt-in are eligible. Each email contains a generic account-update message and a sign-in link. Payment amounts, receiving addresses and documents stay behind authentication. Employee setup invitations use the separate transactional workflow below.

The operations worker queues encrypted recipient addresses and sends at most one message per tick. It rechecks identity email, opt-in and current company permissions before sending. Removing membership, changing the email address or withdrawing consent cancels the queued delivery. A durable lease and stable provider idempotency key preserve the same message across interrupted attempts. Attempts stop after 23 hours rather than retrying outside the provider's deduplication window.

`accepted` means the provider returned a message ID. It does not claim inbox delivery. Ambiguous expired attempts remain `unknown` for review. Local account-update checks replace the provider transport and assert privacy, scoping and one recorded acceptance; no customer inbox delivery is claimed.

## Recipient setup invitations

A payee manager can add a name and email without supplying a receiving wallet. The profile stays pending until the employee verifies the invited email and confirms a valid payout route. Wallet-first setup remains available. Having the invitation link alone never proves the recipient's identity.

Creating or importing an email payee queues a transactional invitation, even if the employee has no Razor account yet. Account-update opt-in is separate. The invitation names the company and links to setup without disclosing amounts or receiving addresses. A configured custom-domain sender and the background worker are required for sending. A shared Resend test sender on a hosted instance is unavailable for invitations; copying a link still works.

Company members with `recipients:manage` can retrieve the same pending link after reloading. Its secret is encrypted at rest and expires after seven days. Renewing an expired or legacy link creates a new one; copying a valid link does not rotate it. Explicit email resend has a one-minute cooldown. Profile edits, archival, revocation and confirmation invalidate the old invitation and cancel pending email. After confirmation, personal workspace access uses the employee's account rather than the invitation.

The invitation outbox uses durable leases and stable provider idempotency keys. Before dispatch it rechecks the profile version, token, email and requesting manager's company permission. Provider rejection, uncertain acceptance and confirmed provider acceptance remain distinct states. No claim of inbox delivery is made from an API acceptance response.
