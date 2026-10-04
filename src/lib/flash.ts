/**
 * Flash toasts across a POST -> redirect -> GET round trip.
 *
 * Forms post normally (so they work without JavaScript and can be tested with a
 * plain HTTP request), then redirect back to a GET with `?notice=<code>`. The
 * code is looked up in a fixed table here, so no user-supplied text ever reaches
 * the page: an unknown code renders nothing.
 */

export type FlashTone = "success" | "danger";

export interface Flash {
  code: string;
  tone: FlashTone;
  message: string;
  title?: string;
}

const FLASHES: Record<string, Flash> = {
  // Profile
  "profile-updated": {
    code: "profile-updated",
    tone: "success",
    title: "Saved",
    message: "Profile updated successfully.",
  },
  "profile-save-failed": {
    code: "profile-save-failed",
    tone: "danger",
    title: "Couldn't save",
    message: "Unable to save your profile. Please try again.",
  },
  "avatar-removed": {
    code: "avatar-removed",
    tone: "success",
    message: "Profile photo removed.",
  },
  // Businesses
  "business-created": {
    code: "business-created",
    tone: "success",
    title: "Created",
    message: "Business created successfully.",
  },
  "business-updated": {
    code: "business-updated",
    tone: "success",
    title: "Saved",
    message: "Business details updated.",
  },
  "business-archived": {
    code: "business-archived",
    tone: "success",
    title: "Archived",
    message: "Business archived. Its QRs and history are preserved.",
  },
  "business-restored": {
    code: "business-restored",
    tone: "success",
    message: "Business restored and is active again.",
  },
  "business-save-failed": {
    code: "business-save-failed",
    tone: "danger",
    title: "Couldn't save",
    message: "Something went wrong. Please try again.",
  },
  // Business context
  "business-switched": {
    code: "business-switched",
    tone: "success",
    message: "Now viewing a different business.",
  },
  // Onboarding
  "onboarding-complete": {
    code: "onboarding-complete",
    tone: "success",
    message: "Your account is ready.",
  },
  // QR claim / registration
  "qr-check-failed": {
    code: "qr-check-failed",
    tone: "danger",
    title: "Check this QR",
    message: "Some details still need fixing.",
  },
  "business-required": {
    code: "business-required",
    tone: "danger",
    title: "Pick a business",
    message: "A QR has to belong to a business. Choose one, or create a new one.",
  },
  "business-selected": {
    code: "business-selected",
    tone: "success",
    message: "Business selected.",
  },
  "qr-invalid": {
    code: "qr-invalid",
    tone: "danger",
    title: "Not a Sqanny code",
    message: "That doesn't look like a Sqanny QR ID. Check the code printed under the stand and try again.",
  },
  "qr-not-recognised": {
    code: "qr-not-recognised",
    tone: "danger",
    title: "Code not recognised",
    message: "We don't have a stand with that QR ID. Double-check the code, or contact us if the stand is new.",
  },
  "qr-already-claimed": {
    code: "qr-already-claimed",
    tone: "danger",
    title: "Already connected",
    message: "This QR is already connected to another Sqanny account.",
  },
  "qr-not-yours": {
    code: "qr-not-yours",
    tone: "danger",
    title: "Not your QR",
    message: "That QR isn't connected to your account.",
  },
  "qr-archived": {
    code: "qr-archived",
    tone: "danger",
    title: "QR retired",
    message: "This QR has been retired and can't be claimed again. Contact us if you think this is a mistake.",
  },
  "qr-already-yours": {
    code: "qr-already-yours",
    tone: "success",
    message: "That QR is already connected to your account.",
  },
  "qr-claim-invalid": {
    code: "qr-claim-invalid",
    tone: "danger",
    title: "Couldn't claim",
    message: "That QR ID isn't valid. Check the code printed under the stand.",
  },
  "qr-claim-not-found": {
    code: "qr-claim-not-found",
    tone: "danger",
    title: "Couldn't claim",
    message: "We couldn't find that QR ID. Check the code, or contact us if the stand is new.",
  },
  "qr-claim-already-claimed": {
    code: "qr-claim-already-claimed",
    tone: "danger",
    title: "Just missed it",
    message: "Another account claimed this QR while you were setting it up.",
  },
  "qr-claim-archived": {
    code: "qr-claim-archived",
    tone: "danger",
    title: "QR retired",
    message: "This QR has been retired and can't be claimed again.",
  },
  "qr-claim-business-forbidden": {
    code: "qr-claim-business-forbidden",
    tone: "danger",
    title: "Couldn't claim",
    message: "You don't have access to that business. Pick one of your own.",
  },
  "qr-claim-not-claimable": {
    code: "qr-claim-not-claimable",
    tone: "danger",
    title: "Couldn't claim",
    message: "This QR is no longer available to claim. Scan it again to see its current status.",
  },
  "qr-claim-unknown": {
    code: "qr-claim-unknown",
    tone: "danger",
    title: "Couldn't claim",
    message: "Something went wrong while claiming this QR. Please try again.",
  },
  // QR management
  // NOTE distinct from the "qr-archived" above, which is a DANGER shown to
  // someone who tried to claim a retired stand. This is the success shown to
  // the owner who just retired one. Same words, opposite situations.
  "qr-retired": {
    code: "qr-retired",
    tone: "success",
    title: "Archived",
    message: "QR archived. Its scans and history are preserved, and it no longer redirects.",
  },
  "qr-restored": {
    code: "qr-restored",
    tone: "success",
    title: "Restored",
    message: "QR is live again.",
  },
  "qr-save-failed": {
    code: "qr-save-failed",
    tone: "danger",
    title: "Couldn't save",
    message: "Your changes weren't saved. Please try again.",
  },
  "qr-saved": {
    code: "qr-saved",
    tone: "success",
    title: "Saved",
    message: "Your changes are live. The printed code on your stand is unchanged.",
  },
  "qr-already-archived": {
    code: "qr-already-archived",
    tone: "success",
    title: "Already retired",
    message: "This stand was already retired.",
  },
  // Batch QR generation
  "batch-created": {
    code: "batch-created",
    tone: "success",
    title: "Batch created",
    message: "Your codes are generated and ready to export.",
  },
  "batch-archived": {
    code: "batch-archived",
    tone: "success",
    title: "Batch retired",
    message: "Every code in this batch has stopped redirecting. The codes and their history are preserved.",
  },
  "batch-restored": {
    code: "batch-restored",
    tone: "success",
    title: "Batch restored",
    message: "Every code in this batch is live again.",
  },
  "batch-regenerated": {
    code: "batch-regenerated",
    tone: "success",
    title: "Assets regenerated",
    message: "Every image was rebuilt from the same codes. Nothing about the codes themselves changed.",
  },
  "batch-regenerate-partial": {
    code: "batch-regenerate-partial",
    tone: "danger",
    title: "Some codes couldn't be rebuilt",
    message:
      "Part of this batch failed to render. The codes are unaffected — try regenerating again, and contact us if it keeps happening.",
  },
  "batch-generate-failed": {
    code: "batch-generate-failed",
    tone: "danger",
    title: "Check the form",
    message: "Some details still need fixing. Nothing was generated.",
  },
  "batch-serials-exist": {
    code: "batch-serials-exist",
    tone: "danger",
    title: "Serial numbers already exist",
    message:
      "Those codes have already been generated. Nothing was created — change the starting sequence or the batch number.",
  },
  "batch-pro-required": {
    code: "batch-pro-required",
    tone: "danger",
    title: "Pro plan required",
    message: "Batch QR generation is available on Pro. Upgrade your plan to generate QR batches.",
  },
  "batch-not-found": {
    code: "batch-not-found",
    tone: "danger",
    title: "Batch not found",
    message: "That batch doesn't exist, or it isn't one of yours.",
  },
};

/** Query-string parameter carrying the flash code. */
export const FLASH_PARAM = "notice";

/** Resolve a `?notice=` value. Unknown codes yield null (render nothing). */
export function readFlash(value: string | undefined | null): Flash | null {
  if (!value) return null;
  return FLASHES[value] ?? null;
}

/** Build the redirect suffix that will show `code` as a toast. */
export function flashSuffix(code: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  params.set(FLASH_PARAM, code);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  return `?${params.toString()}`;
}

/** Append a flash code to an internal path. */
export function withFlash(path: string, code: string): string {
  return `${path}${flashSuffix(code)}`;
}
