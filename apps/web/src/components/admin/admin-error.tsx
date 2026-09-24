/** Friendly inline state for an upstream `ApiError` on an `/admin` page. */
export function AdminError({ status }: { status: number }) {
  if (status === 410) {
    return (
      <div className="danger-zone-shredded" role="status">
        <p className="danger-zone-shredded-title">This engagement has been crypto-shredded.</p>
        <p className="danger-zone-shredded-body">
          Its data-encryption key was destroyed, so its content is now permanently unreadable —
          there is nothing here to show.
        </p>
      </div>
    );
  }
  const message =
    status === 403
      ? "You don't have access to this engagement's admin settings."
      : status === 404
        ? "This engagement doesn't exist, or isn't visible to you."
        : status === 503
          ? 'This capability is not configured for this deployment yet.'
          : `The request failed (${status}). Try again shortly.`;
  return (
    <p className="notice-banner" role="alert">
      {message}
    </p>
  );
}
