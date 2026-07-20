import { AuthCallback } from "../../../src/auth-callback";

const apiOrigin =
  process.env.NEXT_PUBLIC_REFLO_API_ORIGIN ?? "http://127.0.0.1:3001";

export default function CallbackPage() {
  return (
    <main>
      <section className="app-shell">
        <AuthCallback apiOrigin={apiOrigin} />
      </section>
    </main>
  );
}
