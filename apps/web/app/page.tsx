import { APP_NAME, readPublicEnvironment } from "@reflo/config";
import { AccountShell } from "../src/account-shell";

const environment = readPublicEnvironment(process.env.NEXT_PUBLIC_REFLO_ENV);
const apiOrigin =
  process.env.NEXT_PUBLIC_REFLO_API_ORIGIN ?? "http://127.0.0.1:3001";

export default function Home() {
  return (
    <main>
      <AccountShell
        apiOrigin={apiOrigin}
        appName={APP_NAME}
        environment={environment}
      />
    </main>
  );
}
