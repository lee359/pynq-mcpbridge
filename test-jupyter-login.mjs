import fs from "node:fs";

const cfg = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter(line => /^[^#\s][^=]*=/.test(line))
    .map(line => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    })
);

const base = cfg.JUPYTER_URL.replace(/\/$/, "");
const cookies = new Map();

function saveCookies(response) {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0];
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

function cookieHeader() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

let response = await fetch(`${base}/login?next=%2Flab`, {
  redirect: "manual"
});
saveCookies(response);

const html = await response.text();
const xsrf = html.match(/name="_xsrf" value="([^"]+)"/)?.[1];

response = await fetch(`${base}/login?next=%2Flab`, {
  method: "POST",
  redirect: "manual",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "Cookie": cookieHeader(),
    "X-XSRFToken": xsrf
  },
  body: new URLSearchParams({
    password: cfg.JUPYTER_PASSWORD,
    _xsrf: xsrf
  })
});
saveCookies(response);

console.log({
  loginPostStatus: response.status,
  hasSessionCookie: [...cookies.keys()].some(k => k.startsWith("username-"))
});

response = await fetch(`${base}/api/contents`, {
  headers: {
    "Cookie": cookieHeader(),
    "X-XSRFToken": cookies.get("_xsrf") ?? ""
  }
});

console.log({ apiContentsStatus: response.status });
