import { ScanConfig } from "../config/scanConfig";
import { Driver } from "./types";
import { createWebDriver } from "./web/webDriver";

export async function createDriver(config: ScanConfig): Promise<Driver> {
  const platform = config.platform ?? "web";
  switch (platform) {
    case "web":
      return createWebDriver(config.baseUrl);
    default:
      throw new Error(
        `Platform "${platform}" has no driver yet. Only "web" is supported.`,
      );
  }
}
