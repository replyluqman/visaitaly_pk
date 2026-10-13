# Support canned responses — DRAFT v0

**Status:** draft for lawyer review (PRD §18, §24). Must exist in the CMS before
support goes live; it is the enforcement mechanism for the §10 scope.
`{placeholders}` are filled by the CMS from the thread context. Every message also
carries the standard disclaimer footer automatically — do not repeat it here.

Tone: warm, short, specific. Never: "we advise", "you are eligible", "guaranteed",
"don't worry, you'll get it", any prediction of a visa or appointment outcome.

---

## Requirement / eligibility questions → link only (scope boundary)

**`req_link`** — topic: any · `requirement_id` required
> Thanks for asking. The details for **{requirement_title}** — what it is, who issues
> it and where to get it — are in your case here: {requirement_deep_link}.
> It was last verified against {source_name} {verified_days_ago} days ago, and the
> official source is linked on that page.
> We can't give advice on individual circumstances, but we're happy to help with
> anything about your order, payment or account.

**`req_out_of_scope`** — topic: any
> We're not able to answer questions about whether an application will succeed or
> what to do in a specific situation — that would be legal advice, which we don't
> provide. Your case shows the requirements published by official sources for your
> applicant category, each with a link to the source. For advice on your personal
> situation, please consult a qualified immigration lawyer.

**`req_presales`** — topic: presales (free user)
> Good question. Premium shows the full list of documents for each applicant's
> category, why each is needed, where to get it, and alerts you when an official
> requirement changes. You can see how we check sources here: {how_we_verify_link}.

## Payment

**`pay_received_within_sla`**
> We've received your payment proof for **{order_ref}**. It will be verified by
> **{verification_due_at}** ({working_hours_text}). You'll get a notification the
> moment it's done.

**`pay_late_apology`**
> Sorry — verification of **{order_ref}** has taken longer than our
> {sla_payment_hours}-working-hour promise. It's now with a team member and you'll
> hear from us today.

**`pay_rejected_explain`**
> Your payment proof for **{order_ref}** couldn't be verified: **{rejection_reason}**.
> You can upload a new proof from the order page: {order_deep_link}. Nothing else
> needs to be redone.

**`pay_bank_details`**
> Bank details are shown on the order page with the reference **{order_ref}**.
> Please include the reference in the transfer note so we can match it quickly.

## Orders & courier

**`order_status`**
> **{order_ref}** is currently **{order_status}**. Full timeline: {order_deep_link}.

**`courier_dispatched`**
> Your translated documents were dispatched with **{courier_name}**, tracking
> reference **{tracking_ref}**.

**`courier_delayed`**
> Sorry about the delay. We've asked {courier_name} for an update on
> **{tracking_ref}** and will reply here as soon as we hear back.

**`appointment_scope`**
> Appointment Assistance is administrative help with the official process. We
> can't guarantee an appointment, a date, or priority access, and we have no
> special connection to any embassy or provider — no one can legitimately offer that.

## Refunds

**`refund_policy`**
> Refund terms for **{service}**: {refund_terms}. If your order is eligible, you can
> request a refund directly from the order page: {order_deep_link}.

**`refund_received`**
> We've received your refund request for **{order_ref}** and will review it within
> {sla_support_hours} working hours.

**`refund_decided`**
> Your refund request for **{order_ref}** was **{decision}**: {decision_reason}.

## Account & app

**`device_limit`**
> Your account can be active on {max_devices} devices. Signing in on a new one signs
> out the oldest. You can see and sign out devices in Account → Devices.

**`app_problem_ack`**
> Thanks for reporting this. Could you tell us your app version (Account → About)
> and, if possible, add a screenshot? We'll look into it.

**`data_request`**
> You can download or delete your data from Account → Privacy. Deletion is
> permanent; financial records we're legally required to keep are retained.

## Closing

**`close_resolved`**
> Glad that's sorted. This conversation is now closed — just send a new message here
> anytime and it will reopen.
