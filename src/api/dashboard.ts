import { readFile } from "node:fs/promises";

const dashboardFile = new URL("../../public/dashboard.html", import.meta.url);
let cachedDashboard: string | undefined;

export async function loadDashboard(): Promise<string> {
  cachedDashboard ??= await readFile(dashboardFile, "utf8");
  return cachedDashboard;
}
