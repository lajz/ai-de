/** Friendly inline state for an upstream `ApiError` on an `/admin` page. */
export function AdminError({ status }: { status: number }) {
  const message =
    status === 403
      ? "You don't have access to this engagement's admin settings."
      : status === 503
        ? 'This capability is not configured for this deployment yet.'
        : `The request failed (${status}). Try again shortly.`;
  return (
    <p className="admin-error" role="alert">
      {message}
    </p>
  );
}
