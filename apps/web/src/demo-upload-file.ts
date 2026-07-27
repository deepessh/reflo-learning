const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const DEMO_UPLOAD_FILE_ACCEPT = "application/pdf,.pdf";

export function isDemoPdfSelection(file: {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}): boolean {
  return (
    file.size >= 1 &&
    file.size <= MAX_UPLOAD_BYTES &&
    fileExtension(file.name) === "pdf" &&
    (file.type === "" || file.type === "application/pdf")
  );
}

function fileExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name.trim().toLowerCase());
  return match?.[1] ?? "";
}
