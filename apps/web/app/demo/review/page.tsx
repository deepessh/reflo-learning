import type { Metadata } from "next";

import { APP_NAME, readPublicEnvironment } from "@reflo/config";

import { EmailQuiz } from "../../../src/email-quiz";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
  title: `Daily review · ${APP_NAME}`,
};

const environment = readPublicEnvironment(process.env.NEXT_PUBLIC_REFLO_ENV);
const apiOrigin =
  process.env.NEXT_PUBLIC_REFLO_API_ORIGIN ?? "http://127.0.0.1:3001";

export default function DemoReviewPage() {
  return (
    <main>
      <EmailQuiz
        apiOrigin={apiOrigin}
        appName={APP_NAME}
        environment={environment}
      />
    </main>
  );
}
