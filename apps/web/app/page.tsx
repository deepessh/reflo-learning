import { APP_NAME, readPublicEnvironment } from "@reflo/config";
import type { HealthResponse } from "@reflo/contracts";

import { getHomeCopy } from "../src/home-copy";

const environment = readPublicEnvironment(process.env.NEXT_PUBLIC_REFLO_ENV);
const copy = getHomeCopy(APP_NAME);

const scaffoldStatus: HealthResponse["status"] = "ok";

export default function Home() {
  return (
    <main>
      <section className="shell">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{copy.headline}</h1>
        <p className="lede">{copy.description}</p>
        <div className="status">
          Scaffold {scaffoldStatus} · {environment}
        </div>
      </section>
    </main>
  );
}
