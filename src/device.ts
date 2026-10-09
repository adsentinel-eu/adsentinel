/** The browser device flow behind `adsentinel login` (surface v1 § Keys, plan 6c): two keyless API calls. */
import { ApiError, type Api } from "./api.ts";

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  /** Seconds. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
}

export type DevicePoll =
  | { status: "pending"; interval: number }
  | { status: "approved"; apiKey: string; key: { name: string; prefix: string } }
  | { status: "denied" }
  | { status: "expired" };

export async function startDevice(api: Api, name: string): Promise<DeviceStart> {
  const d = JSON.parse((await api.call("POST", "/v1/device/code", { accept: "json", body: { name } })).text) as Partial<DeviceStart>;
  const text = (v: unknown): v is string => typeof v === "string" && v !== "";
  const seconds = (v: unknown): v is number => typeof v === "number" && v > 0;
  if (!text(d.deviceCode) || !text(d.userCode) || !text(d.verificationUriComplete) || !seconds(d.expiresIn) || !seconds(d.interval)) {
    // an answer this client doesn't know (a proxy's page, a newer API)
    throw new ApiError("internal", `unexpected answer from ${api.baseUrl}/v1/device/code`, "Run `adsentinel login` again; if it persists, update the CLI.", 0);
  }
  return d as DeviceStart;
}

export async function pollDevice(api: Api, deviceCode: string): Promise<DevicePoll> {
  return JSON.parse((await api.call("POST", "/v1/device/token", { accept: "json", body: { deviceCode } })).text) as DevicePoll;
}
