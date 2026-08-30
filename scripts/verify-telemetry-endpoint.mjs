import { readFile } from "node:fs/promises";

const required = process.argv.includes("--required");
const configurationUrl = new URL("../config/telemetry-endpoint.txt", import.meta.url);
const raw = (await readFile(configurationUrl, "utf8")).trim();

if (!raw) {
  if (required) {
    throw new Error("config/telemetry-endpoint.txt is required for a production installer build.");
  }
  console.log("Telemetry endpoint is not configured; this build will not send telemetry.");
  process.exit(0);
}

let endpoint;
try {
  endpoint = new URL(raw);
} catch {
  throw new Error("The configured telemetry endpoint must be a valid URL.");
}

if (endpoint.protocol !== "https:") {
  throw new Error("The configured telemetry endpoint must use HTTPS.");
}
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error("The configured telemetry endpoint must not contain credentials, query parameters, or fragments.");
}
if (endpoint.pathname.replace(/\/$/, "") !== "/api/telemetry/event") {
  throw new Error("The configured telemetry endpoint must end with /api/telemetry/event.");
}

console.log(`Verified telemetry endpoint: ${endpoint.origin}/api/telemetry/event`);
