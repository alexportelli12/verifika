// Removes stale build output so deleted sources never linger in the package.
import { rm } from "node:fs/promises";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
