/** The command that opens a URL in the user's browser, or null when the URL may not be opened. The URL can come
 *  from the server or the environment: only absolute http(s) URLs are opened, and never through a shell (cmd.exe
 *  would run `&`), so it stays one argument. */
export function browserCommand(url: string, platform: NodeJS.Platform): [string, string[]] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}
