const { createHash, createHmac, randomBytes: cryptoRandomBytes, timingSafeEqual } = require("node:crypto");

const OPERATOR_COOKIE = "operator_session";
const OPERATOR_SESSION_MS = 12 * 60 * 60 * 1000;

function safeEqual(left, right) {
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function createOperatorAuth({
  password = "",
  secureCookie = false,
  now = Date.now,
  randomBytes = cryptoRandomBytes,
} = {}) {
  const configuredPassword = String(password || "");
  const signingKey = createHmac("sha256", configuredPassword)
    .update("operator-session-v1")
    .digest();

  function signature(payload) {
    return createHmac("sha256", signingKey).update(payload).digest("base64url");
  }

  function passwordMatches(provided) {
    return configuredPassword.length > 0
      && typeof provided === "string"
      && safeEqual(configuredPassword, provided);
  }

  function makeSessionToken() {
    const expiresAt = now() + OPERATOR_SESSION_MS;
    const nonce = randomBytes(18).toString("base64url");
    const payload = `${expiresAt}.${nonce}`;
    return `${payload}.${signature(payload)}`;
  }

  function sessionTokenIsValid(token) {
    if (!configuredPassword || typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !parts[1] || !parts[2]) return false;
    const expiresAt = Number(parts[0]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    return safeEqual(signature(payload), parts[2]);
  }

  function attributes() {
    return ["HttpOnly", "SameSite=Strict", "Path=/", ...(secureCookie ? ["Secure"] : [])];
  }

  function sessionCookie(token) {
    const expiresAt = Number(String(token).split(".", 1)[0]);
    return [
      `${OPERATOR_COOKIE}=${token}`,
      `Max-Age=${OPERATOR_SESSION_MS / 1000}`,
      `Expires=${new Date(expiresAt).toUTCString()}`,
      ...attributes(),
    ].join("; ");
  }

  function clearCookie() {
    return [
      `${OPERATOR_COOKIE}=`,
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      ...attributes(),
    ].join("; ");
  }

  function cookieToken(cookieHeader) {
    for (const part of String(cookieHeader || "").split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1 || part.slice(0, separator).trim() !== OPERATOR_COOKIE) continue;
      return part.slice(separator + 1).trim();
    }
    return "";
  }

  return {
    configured: configuredPassword.length > 0,
    passwordMatches,
    makeSessionToken,
    sessionTokenIsValid,
    sessionCookie,
    clearCookie,
    cookieToken,
  };
}

module.exports = {
  OPERATOR_COOKIE,
  OPERATOR_SESSION_MS,
  createOperatorAuth,
};
