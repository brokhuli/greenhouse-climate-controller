/** Full-screen placeholder shown while the SPA redirects to / returns from Keycloak. */
export function AuthSplash({ error }: { error?: string }) {
  return (
    <div className="bg-surface-1 text-fg-muted flex min-h-screen items-center justify-center">
      <div className="text-center">
        <p className="text-fg-default text-lg font-semibold">Greenhouse Console</p>
        <p className="mt-2 text-sm">
          {error ? `Sign-in failed: ${error}` : "Redirecting to sign in…"}
        </p>
      </div>
    </div>
  );
}
