import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#07130f",
    description: "A self-improving tutor built around verified retention.",
    display: "standalone",
    icons: [
      {
        sizes: "any",
        src: "/reflo-mark.svg",
        type: "image/svg+xml",
      },
    ],
    name: "Reflo",
    short_name: "Reflo",
    start_url: "/",
    theme_color: "#07130f",
  };
}
