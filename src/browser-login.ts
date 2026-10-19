import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { createServer } from "node:http";

/**
 * `login` through the browser (docs/architecture.md "The command line"):
 * a listener on 127.0.0.1 (this computer only, a random free port), the
 * web app's /cli/authorize page opened with a random `state` and a
 * one-off public `key`, and the personal access token the page creates
 * sent back by redirecting to /callback, ENCRYPTED to that key
 * (RSA-OAEP, SHA-256). The private key lives only in this process, so the
 * address in the browser's history is useless once login ends. A redirect,
 * not a form POST: Safari warns about any form an https page sends to
 * http, loopback included (2026-10-19). Accepted ONLY with this login's
 * `state`. Resolves with the token; rejects on denial or timeout.
 */
export type BrowserLoginOptions = {
  /** The web app's origin (https://app.<domain>). */
  webOrigin: string;
  /** Shown on the page and in the token's name ("CLI on <computer>"). */
  computer: string;
  /** Opens the URL in the person's browser (best effort). */
  openUrl: (url: string) => void;
  /** Called with the URL so the CLI can print it as a fallback. */
  onUrl: (url: string) => void;
  timeoutMs?: number;
};

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

const MAX_URL = 16 * 1024;

export function browserLogin(options: BrowserLoginOptions): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const decrypt = (sealed: string): string | null => {
    try {
      return privateDecrypt(
        {
          key: privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(sealed, "base64url"),
      ).toString("utf8");
    } catch {
      return null;
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      outcome();
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        req.method !== "GET" ||
        url.pathname !== "/callback" ||
        (req.url ?? "").length > MAX_URL
      ) {
        res.writeHead(404).end();
        return;
      }
      const fields = url.searchParams;
      const send = (status: number, title: string, text: string) =>
        res
          .writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          })
          .end(PAGE(title, text));
      if (fields.get("state") !== state) {
        send(
          400,
          "Not this login",
          "This sign-in did not come from the terminal that is waiting. Run login again.",
        );
        return;
      }
      if (fields.get("error")) {
        send(200, "Sign-in cancelled", "You can close this tab.");
        finish(() => reject(new Error("sign-in was denied in the browser")));
        return;
      }
      const token = decrypt(fields.get("token") ?? "");
      if (!token) {
        send(400, "Something went wrong", "Run login again.");
        return;
      }
      send(
        200,
        "You are signed in",
        "Return to your terminal — you can close this tab.",
      );
      finish(() => resolve(token));
    });

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error("timed out waiting for the browser — run login again"),
          ),
        ),
      options.timeoutMs ?? 5 * 60 * 1000,
    );

    server.on("error", (error) => finish(() => reject(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `${options.webOrigin}/cli/authorize?${new URLSearchParams({
        port: String(port),
        state,
        key,
        name: options.computer,
      })}`;
      options.onUrl(url);
      options.openUrl(url);
    });
  });
}

/**
 * The web app's origin for an API origin: `api.<domain>` → `app.<domain>`,
 * local dev's :8787 → :3000. Null when it cannot be derived (pass --web).
 */
export function webOriginFor(api: string): string | null {
  const url = new URL(api);
  if (url.hostname.startsWith("api.")) {
    url.hostname = `app.${url.hostname.slice(4)}`;
    return url.origin;
  }
  if (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.port === "8787"
  ) {
    url.port = "3000";
    return url.origin;
  }
  return null;
}
